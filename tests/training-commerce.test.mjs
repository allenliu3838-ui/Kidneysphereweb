import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { classifyTrainingProduct, isRetiredTrainingReplay, checkoutOrderSummary } from '../training-commerce.js';

const order = (overrides = {}) => ({
  id: 'order-1', order_no: 'KS123', user_id: 'user-1', status: 'pending_payment',
  total_amount_cny: '1280.00', channel: 'wechat',
  order_items: [{ product_id: 'product-1', product_title: '原订单', quantity: 1, amount_cny: '1280.00' }],
  ...overrides,
});

test('all five specialties distinguish registration, bundles and retired replay without titles or recommendation flags', () => {
  for (const spec of ['GLOM', 'ICU', 'TX', 'PATHO', 'DA']) {
    assert.equal(classifyTrainingProduct({ product_code: `${spec}-REG-FULL-2026`, product_type: 'project_registration', recommended: false }), 'registration');
    assert.equal(classifyTrainingProduct({ product_code: `${spec}-BUNDLE-2026`, product_type: 'specialty_bundle' }), 'bundle');
    assert.equal(classifyTrainingProduct({ product_code: `${spec}-REG-VIDEO-2026`, product_type: 'project_registration', recommended: true }), 'retired_replay');
    assert.equal(isRetiredTrainingReplay({ product_code: `${spec}-REG-VIDEO-2026`, product_type: 'membership_plan' }), true);
  }
  for (const product of [null, { product_code: 'MEMBERSHIP-YEARLY', product_type: 'membership_plan' },
    { product_code: 'ICU-REG-FULL-2026', product_type: 'membership_plan' },
    { product_code: 'UNKNOWN', product_type: 'project_registration', title: '完整版', recommended: true }]) {
    assert.equal(classifyTrainingProduct(product), null);
  }
});

test('existing order keeps agreed amount regardless of current catalog prices or retired status', () => {
  assert.equal(checkoutOrderSummary(order(), 'user-1').price_cny, 1280);
  const oldReplay = order({ total_amount_cny: 780, order_items: [{ product_id: 'retired-product', product_title: '原回放订单', quantity: 1, amount_cny: 780 }] });
  assert.equal(checkoutOrderSummary(oldReplay, 'user-1').price_cny, 780);
  assert.equal(checkoutOrderSummary(order({ status: 'rejected' }), 'user-1').price_cny, 1280);
});

test('invalid, mismatched, unowned and completed orders cannot reach payment', () => {
  for (const invalid of [order({ user_id: 'another-user' }), order({ status: 'approved' }), order({ status: 'refunded' }),
    order({ total_amount_cny: null }), order({ total_amount_cny: 'oops' }), order({ total_amount_cny: -1 }),
    order({ total_amount_cny: 1580 }), order({ order_items: [] }), order({ order_items: [{ product_id: 'p', quantity: 0, amount_cny: 1280 }] })]) {
    assert.throws(() => checkoutOrderSummary(invalid, 'user-1'));
  }
});

const source = await fs.readFile(new URL('../checkout.js', import.meta.url), 'utf8');
const createSource = source.slice(source.indexOf('let _creatingOrder = false;'), source.indexOf('/* ── show payment step'));
function harness(storedOrder, error = null) {
  const button = { disabled: false, textContent: '' };
  const labels = new Map();
  const calls = [];
  const builder = { select() { return this; }, eq(field, value) { calls.push([field, value]); return this; }, async single() { return { data: storedOrder, error }; } };
  const ctx = vm.createContext({
    checkoutOrderSummary, _user: { id: 'user-1' }, _product: { id: 'product-1', price_cny: 1580 }, _order: null,
    supabase: { async rpc() { return { data: { ok: true, order_id: 'order-1', order_no: 'KS123', total_amount_cny: 1580 } }; }, from() { return builder; } },
    _channel: 'wechat', document: { getElementById(id) { if (id === 'btnConfirmOrder') return button; if (!labels.has(id)) labels.set(id, {}); return labels.get(id); } },
    shown: 0, renderSummary() {}, toast(...args) { calls.push(args); },
    showPayStep() { ctx.shown += 1; },
  });
  vm.runInContext(createSource, ctx);
  return { ctx, calls, button };
}

test('create-order flow re-reads owned order and uses its saved amount, not the RPC current-price echo', async () => {
  const h = harness(order());
  await h.ctx.createOrder();
  assert.equal(h.ctx._product.price_cny, 1280);
  assert.equal(h.ctx._order.id, 'order-1');
  assert.equal(h.ctx.shown, 1);
  assert.ok(h.calls.some(call => call[0] === 'user_id' && call[1] === 'user-1'));
});

test('failed amount verification leaves payment hidden and allows retry', async () => {
  for (const stored of [null, order({ total_amount_cny: 1580 }), order({ order_items: [{ product_id: 'another-product', quantity: 1, amount_cny: 1280 }] })]) {
    const h = harness(stored);
    await h.ctx.createOrder();
    assert.equal(h.ctx.shown, 0);
    assert.equal(h.ctx._order, null);
    assert.equal(h.button.disabled, false);
  }
});

test('an unavailable order query does not fall back to the product price', async () => {
  const h = harness(null, new Error('offline'));
  await h.ctx.createOrder();
  assert.equal(h.ctx.shown, 0);
  assert.equal(h.ctx._order, null);
});
