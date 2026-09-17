import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { checkoutOrderSummary } from '../training-commerce.js';

const source = await fs.readFile(new URL('../checkout.js', import.meta.url), 'utf8');
const submitSource = source.slice(source.indexOf('let _submittingProof = false;'), source.indexOf('/* ── my orders list'));
class ProofFile {
  constructor(name = 'proof.png', size = 100, type = 'image/png') { Object.assign(this, { name, size, type }); }
}
function harness(options = {}) {
  const fields = { proof: new ProofFile(), paid_amount: '1280.00', contact_wechat: 'receipt-contact', ...options.fields };
  const button = { textContent: '提交凭证', disabled: false };
  const hint = { textContent: '' };
  const contactHint = { style: {} };
  const form = { querySelector() { return button; } };
  const uploads = [], rpcs = [], completed = [];
  let sequence = 0;
  const ctx = vm.createContext({
    File: ProofFile, FormData: class { get(key) { return fields[key] ?? null; } },
    _user: { id: 'user-1' }, _order: { id: 'order-1', order_no: 'KS123' },
    _product: { price_cny: 1280 }, _channel: 'alipay',
    document: { getElementById(id) { return { proofForm: form, proofHint: hint, contactHint }[id]; } },
    crypto: { randomUUID() { return `file-${++sequence}`; } },
    async hashFile(file) { if (options.hashError) throw options.hashError; return `sha-${file.name}`; },
    supabase: {
      from() { throw new Error('direct database writes are forbidden'); },
      storage: { from(bucket) { assert.equal(bucket, 'payment_proofs'); return {
        async upload(...args) { uploads.push(args); return options.upload ? options.upload(...args) : { error: null }; },
      }; } },
      async rpc(name, args) { rpcs.push([name, args]); return options.rpc ? options.rpc(name, args) : { data: { ok: true, status: 'pending_review' } }; },
    },
    showSubmissionDone(status) { completed.push(status); }, toast() {}, async loadMyOrders() {},
  });
  vm.runInContext(submitSource, ctx);
  return { ctx, fields, button, hint, uploads, rpcs, completed, submit: () => ctx.submitProof({ preventDefault() {} }) };
}

test('validation failure always unlocks submit; correcting the form succeeds', async () => {
  for (const fields of [{ proof: null }, { contact_wechat: '' }, { paid_amount: '1580' }, { paid_amount: '1280.001' }]) {
    const h = harness({ fields });
    await h.submit();
    assert.equal(h.button.disabled, false);
    assert.equal(h.button.textContent, '提交凭证');
    assert.equal(h.uploads.length, 0);
    assert.equal(h.rpcs.length, 0);
    Object.assign(h.fields, { proof: new ProofFile(), contact_wechat: 'contact', paid_amount: '1280.00' });
    await h.submit();
    assert.deepEqual(h.completed, ['pending_review']);
  }
});

test('oversized, executable, mismatched MIME and empty files never upload', async () => {
  for (const file of [new ProofFile('p.png', 10 * 1024 * 1024 + 1), new ProofFile('p.exe'), new ProofFile('p.png', 20, 'text/html'), new ProofFile('p.png', 0)]) {
    const h = harness({ fields: { proof: file } });
    await h.submit();
    assert.equal(h.uploads.length, 0);
    assert.equal(h.rpcs.length, 0);
    assert.equal(h.button.disabled, false);
  }
});

test('hash failure is visible and does not silently disable duplicate protection', async () => {
  const h = harness({ hashError: new Error('hash unavailable') });
  await h.submit();
  assert.match(h.hint.textContent, /hash unavailable/);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.button.disabled, false);
});

test('upload failure is retriable and never creates a proof record', async () => {
  let fail = true;
  const h = harness({ upload: async () => ({ error: fail ? new Error('network unavailable') : null }) });
  await h.submit();
  assert.equal(h.rpcs.length, 0);
  assert.equal(h.button.disabled, false);
  fail = false;
  await h.submit();
  assert.equal(h.uploads.length, 2);
  assert.deepEqual(h.completed, ['pending_review']);
});

test('interrupted atomic submission reuses its uploaded object instead of uploading twice', async () => {
  let first = true;
  const h = harness({ rpc: async () => {
    if (first) { first = false; return { error: new Error('response interrupted') }; }
    return { data: { ok: true, status: 'pending_review', reused: true } };
  } });
  await h.submit();
  assert.match(h.hint.textContent, /无需再次付款/);
  assert.equal(h.completed.length, 0);
  await h.submit();
  assert.equal(h.uploads.length, 1);
  assert.equal(h.rpcs.length, 2);
  assert.equal(h.rpcs[0][1].p_proof_path, h.rpcs[1][1].p_proof_path);
  assert.deepEqual(h.completed, ['pending_review']);
});

test('changing proof after a failure uploads the new file, preserving correct proof association', async () => {
  const h = harness({ rpc: async () => ({ error: new Error('retry') }) });
  await h.submit();
  h.fields.proof = new ProofFile('replacement.pdf', 120, 'application/pdf');
  await h.submit();
  assert.equal(h.uploads.length, 2);
  assert.notEqual(h.rpcs[0][1].p_proof_path, h.rpcs[1][1].p_proof_path);
  assert.match(h.rpcs[1][1].p_proof_path, /\.pdf$/);
});

test('double click while submission is in flight sends only one upload and one atomic request', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const h = harness({ upload: () => pending });
  const first = h.submit();
  await Promise.resolve();
  assert.equal(h.button.disabled, true);
  await h.submit();
  finish({ error: null });
  await first;
  assert.equal(h.uploads.length, 1);
  assert.equal(h.rpcs.length, 1);
  assert.equal(h.button.disabled, false);
});

test('only acknowledged approved or pending-review submission displays completion', async () => {
  for (const data of [null, { ok: false, message: 'amount mismatch' }, { ok: true }, { ok: true, status: 'refunded' }]) {
    const h = harness({ rpc: async () => ({ data }) });
    await h.submit();
    assert.equal(h.completed.length, 0);
    assert.equal(h.button.disabled, false);
  }
  const h = harness({ rpc: async () => ({ data: { ok: true, status: 'approved', reused: true } }) });
  await h.submit();
  assert.deepEqual(h.completed, ['approved']);
});

test('atomic request carries actual stored order amount, owned file and entered receipt contact', async () => {
  const h = harness({ fields: { payer_name: ' Example ', ref_last4: '1234', contact_phone: ' 123456 ', note: ' 核对备注 ' } });
  await h.submit();
  const [name, params] = h.rpcs[0];
  assert.equal(name, 'submit_payment_proof');
  assert.equal(params.p_amount_cny, 1280);
  assert.equal(params.p_order_id, 'order-1');
  assert.equal(params.p_channel, 'alipay');
  assert.equal(params.p_contact_phone, '123456');
  assert.equal(params.p_note, '核对备注');
  assert.equal(params.p_payer_name, 'Example');
  assert.match(params.p_proof_path, /^user-1\/order-1\//);
  assert.equal(h.uploads[0][2].upsert, false);
});

test('reused review/approved orders show their state without another payment step', async () => {
  const createSource = source.slice(source.indexOf('let _creatingOrder = false;'), source.indexOf('/* ── show payment step'));
  for (const status of ['pending_review', 'approved']) {
    const button = {};
    const order = { id: 'order-1', order_no: 'KS123', user_id: 'user-1', status,
      order_items: [{ product_id: 'product-1', quantity: 1 }] };
    const query = { select() { return this; }, eq() { return this; }, async single() { return { data: order }; } };
    const shown = [];
    const ctx = vm.createContext({ checkoutOrderSummary, _user: { id: 'user-1' }, _product: { id: 'product-1' }, _order: null, _channel: 'wechat',
      supabase: { async rpc() { return { data: { ok: true, order_id: 'order-1' } }; }, from() { return query; } },
      document: { getElementById() { return button; } }, toast() {}, showSubmissionDone(s) { shown.push(s); },
      showPayStep() { throw new Error('must not ask for another payment'); }, renderSummary() {},
    });
    vm.runInContext(createSource, ctx);
    await ctx.createOrder();
    assert.deepEqual(shown, [status]);
  }
});
