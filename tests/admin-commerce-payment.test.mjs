import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { reviewApprovalState, validateProductBinding, canRepairEnrollment, productBindingPolicy } from '../admin-commerce-review.js';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const order = { id: 'order-1', order_no: 'KS-1', user_id: 'user-1', status: 'pending_review', total_amount_cny: 1280,
  order_items: [{ id: 'item-1', product_title: '购买时名称', quantity: 1, amount_cny: 1280 }],
  payment_proofs: [{ id: 'proof-1', amount_cny: 1280, channel: 'wechat' }] };
const fulfillment = { ok: true, order_id: 'order-1', mapping_status: 'ready', review_fingerprint: 'review-snapshot',
  items: [{ order_item_id: 'item-1', product_id: 'product-1', product_code: 'ICU-REG-FULL-2026', variant: 'full',
    project_id: 'project-icu', project_title: '真实项目', cohort_id: 'cohort-icu', cohort_title: '实际班期',
    duration_days: 365, amount_cny: 1280, enrollment_required: true, mapping_source: 'purchase_snapshot',
    expected_start_at: '2026-09-14T00:00:00Z', expected_end_at: '2027-09-14T00:00:00Z' }],
  proof_checks: [{ id: 'proof-1', valid: true, amount_cny: 1280 }] };
const confirmed = [true, true, true, true];

function harness({ storedOrder = order, fulfillmentData = fulfillment, rpcHandler } = {}) {
  const calls = [], notices = [], nodes = new Map(), checks = [];
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML: '', disabled: false, isConnected: true, listeners: {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      querySelectorAll() { return checks; } });
    return nodes.get(id);
  }
  node('ordersTableWrap');
  node('orderFilterStatus').value = 'pending_all';
  const state = { closed: 0, html: '', checks, nodes, calls, notices, node };
  const context = vm.createContext({
    console, reviewApprovalState, validateProductBinding, canRepairEnrollment, productBindingPolicy,
    esc: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])),
    statusDot: value => value,
    formatBeijingDateTime: value => value || '—',
    toast(...args) { notices.push(args); },
    window: {}, confirm: () => true, prompt: () => null,
    document: {
      getElementById: id => nodes.get(id) || null,
      querySelectorAll: () => checks,
    },
    showModal(title, body, footer) {
      state.html = title + body + footer;
      for (const match of state.html.matchAll(/\bid="([^"]+)"/g)) node(match[1]);
      node('modalBody');
      checks.length = 0;
      for (const _match of body.matchAll(/class="review-check"/g)) checks.push({ checked: false });
      if (nodes.has('modalApprove')) node('modalApprove').disabled = true;
    },
    closeModal() { state.closed++; for (const [id, value] of nodes) if (/^(modal|review|repair)/.test(id)) value.isConnected = false; },
    supabase: {
      from(table) {
        calls.push({ table });
        return { select() { return this; }, eq() { return this; }, in() { return this; }, order() { return this; }, limit() { return this; },
          async single() { return { data: storedOrder, error: null }; },
          then(resolve, reject) { return Promise.resolve({ data: [storedOrder], error: null }).then(resolve, reject); },
        };
      },
      async rpc(name, args) {
        calls.push({ name, args });
        if (rpcHandler) { const response = await rpcHandler(name, args); if (response !== undefined) return response; }
        if (name === 'admin_get_order_fulfillment') return { data: fulfillmentData, error: null };
        if (name === 'admin_list_payment_enrollment_issues') return { data: [], error: null };
        return { data: { ok: true }, error: null };
      },
    },
  });
  function load(name) {
    vm.runInContext(read(name).replace(/^import\s+[\s\S]*?\sfrom\s+['"][^'"]+['"];\s*/gm, '')
      .replace(/^export /gm, ''), context, { filename: name });
  }
  load('admin-commerce-orders.js');
  return { ...state, state, context, load };
}

test('approval fails closed for missing server mapping, receipt checks, proof, or stale order identity', () => {
  assert.equal(reviewApprovalState(order, fulfillment, confirmed).allowed, true);
  const blocked = [null, { ...fulfillment, ok: false }, { ...fulfillment, order_id: 'other-order' },
    { ...fulfillment, mapping_status: 'blocked' }, { ...fulfillment, review_fingerprint: '' },
    { ...fulfillment, items: [] }, { ...fulfillment, proof_checks: [{ valid: false }] }];
  for (const data of blocked) assert.equal(reviewApprovalState(order, data, confirmed).allowed, false);
  assert.equal(reviewApprovalState({ ...order, status: 'approved' }, fulfillment, confirmed).allowed, false);
  for (let index = 0; index < 4; index++) {
    const incomplete = [...confirmed]; incomplete[index] = false;
    assert.equal(reviewApprovalState(order, fulfillment, incomplete).allowed, false);
  }
});

test('order list has no direct approval action; detail presents authoritative project, cohort, term and original amount', async () => {
  const h = harness();
  await h.context.loadOrders();
  assert.doesNotMatch(h.node('ordersTableWrap').innerHTML, /data-approve/);
  assert.match(h.node('ordersTableWrap').innerHTML, /data-detail/);
  await h.context.showOrderDetail(order.id);
  assert.ok(h.calls.some(call => call.name === 'admin_get_order_fulfillment' && call.args.p_order_id === order.id));
  for (const text of ['真实项目', 'project-icu', '实际班期', 'cohort-icu', '365 天', '2027-09-14', '¥1280', '实际到账']) {
    assert.ok(h.state.html.includes(text), text);
  }
  assert.equal(h.node('modalApprove').disabled, true);
  h.checks.forEach(check => { check.checked = true; });
  h.node('modalBody').listeners.change();
  assert.equal(h.node('modalApprove').disabled, false);
  await h.node('modalApprove').listeners.click();
  const call = h.calls.find(call => call.name === 'admin_approve_order_verified');
  assert.equal(call.args.p_payment_received, true);
  assert.equal(call.args.p_review_fingerprint, fulfillment.review_fingerprint);
  assert.equal(h.state.closed, 1);
});

test('failed detail RPC cannot produce an approval modal', async () => {
  const h = harness({ rpcHandler: name => name === 'admin_get_order_fulfillment' ? { error: new Error('unavailable') } : undefined });
  await h.context.showOrderDetail(order.id);
  assert.equal(h.state.html, '');
  assert.ok(h.notices.some(notice => notice[0] === '加载失败'));
});

test('fully checked checklist cannot bypass server mapping or invalid proof', async () => {
  for (const data of [{ ...fulfillment, mapping_status: 'blocked', blockers: ['cohort_mismatch'] },
    { ...fulfillment, proof_checks: [{ id: 'proof-1', valid: false, reason: 'amount_mismatch' }] }]) {
    const h = harness({ fulfillmentData: data });
    await h.context.showOrderDetail(order.id);
    h.checks.forEach(check => { check.checked = true; });
    h.node('modalBody').listeners.change();
    assert.equal(h.node('modalApprove').disabled, true);
    await h.node('modalApprove').listeners.click();
    assert.equal(h.calls.filter(call => call.name === 'admin_approve_order_verified').length, 0);
  }
});

test('double approval is suppressed while in flight; idempotent success closes once', async () => {
  let resolveApproval;
  const pending = new Promise(resolve => { resolveApproval = resolve; });
  const h = harness({ rpcHandler: name => name === 'admin_approve_order_verified' ? pending : undefined });
  const first = h.context.approveOrder(order, fulfillment, confirmed);
  await h.context.approveOrder(order, fulfillment, confirmed);
  assert.equal(h.calls.filter(call => call.name === 'admin_approve_order_verified').length, 1);
  resolveApproval({ data: { ok: true, already_approved: true }, error: null });
  await first;
  assert.equal(h.state.closed, 1);
  assert.match(h.notices.at(-1)[1], /无需重复/);
});

test('stale review and unconfirmed RPC outcomes keep review open and permit retry', async () => {
  for (const response of [{ error: new Error('review_changed') }, { data: null }, { data: { ok: false } }]) {
    const h = harness({ rpcHandler: name => name === 'admin_approve_order_verified' ? response : undefined });
    await h.context.showOrderDetail(order.id);
    h.checks.forEach(check => { check.checked = true; });
    await h.context.approveOrder(order, fulfillment, confirmed);
    assert.equal(h.state.closed, 0);
    assert.equal(h.node('modalApprove').disabled, false);
    await h.context.approveOrder(order, fulfillment, confirmed);
    assert.equal(h.calls.filter(call => call.name === 'admin_approve_order_verified').length, 2);
    assert.ok(h.notices.every(notice => notice[2] === 'err'));
  }
});

test('approved enrollment exceptions come from server pagination and block unsafe repair', async () => {
  for (const canRepair of [true, false]) {
    const h = harness({ storedOrder: { ...order, status: 'approved' }, rpcHandler: name =>
      name === 'admin_list_payment_enrollment_issues' ? { data: [{ order_id: order.id, order_no: order.order_no,
        user_id: order.user_id, issue_code: 'missing_enrollment', can_repair: canRepair,
        items: fulfillment.items.map(item => ({ ...item, repair_required: true })) }], error: null } : undefined });
    h.node('orderFilterStatus').value = 'enrollment_issues';
    await h.context.loadOrders();
    assert.equal(h.calls.filter(call => call.table).length, 0);
    assert.equal(h.calls[0].args.p_limit, 100);
    assert.equal(h.calls[0].args.p_offset, 0);
    await h.context.showOrderDetail(order.id);
    assert.equal(h.state.html.includes('id="modalRepairEnrollment"'), canRepair);
    if (canRepair) assert.match(h.state.html, /id="modalRepairEnrollment"[^>]*disabled/);
  }
});

test('repair uses approved active entitlement assessment independently of new-approval proof rules, and rejects changed mapping', () => {
  const approved = { ...order, status: 'approved' };
  const missingProof = { ...fulfillment, mapping_status: 'blocked', proof_checks: [], blockers: ['NO_VALID_PAYMENT_PROOF'] };
  const issue = { order_id: order.id, can_repair: true, items: fulfillment.items.map(item => ({ ...item, repair_required: true })) };
  assert.equal(canRepairEnrollment(approved, missingProof, issue), true);
  assert.equal(canRepairEnrollment(order, missingProof, issue), false);
  assert.equal(canRepairEnrollment(approved, missingProof, { ...issue, can_repair: false }), false);
  assert.equal(canRepairEnrollment(approved, missingProof, { ...issue, items: [{ ...issue.items[0], project_id: 'another-project' }] }), false);
  assert.equal(canRepairEnrollment(approved, missingProof, { ...issue, items: [{ ...issue.items[0], cohort_id: 'another-cohort' }] }), false);
});

test('repair does not claim success on server failure and idempotent completion is safe to repeat', async () => {
  const h = harness({ rpcHandler: name => name === 'admin_repair_order_enrollment' ? { error: new Error('mapping_unknown') } : undefined });
  await h.context.repairOrderEnrollment(order.id);
  assert.equal(h.state.closed, 0);
  assert.ok(h.notices.some(notice => notice[0] === '修复失败'));
  const complete = harness({ rpcHandler: name => name === 'admin_repair_order_enrollment' ? { data: { ok: true, already_complete: true } } : undefined });
  await complete.context.repairOrderEnrollment(order.id);
  assert.equal(complete.state.closed, 1);
  assert.match(complete.notices.at(-1)[1], /无需重复修复/);
});

test('product binding uses IDs and only lists cohorts belonging to the selected project', () => {
  const projects = [{ id: 'project-a', title: '同名项目' }, { id: 'project-b', title: '同名项目' }];
  const cohorts = [{ id: 'cohort-a', project_id: 'project-a', title: 'A期' }, { id: 'cohort-b', project_id: 'project-b', title: 'B期' }];
  const row = { product_type: 'project_registration', project_id: 'project-a', cohort_id: 'cohort-a' };
  assert.equal(validateProductBinding(row, projects, cohorts), '');
  assert.notEqual(validateProductBinding({ ...row, cohort_id: 'cohort-b' }, projects, cohorts), '');
  assert.notEqual(validateProductBinding({ ...row, project_id: null }, projects, cohorts), '');
  assert.notEqual(validateProductBinding({ ...row, project_id: 'unknown' }, projects, cohorts), '');
  assert.equal(validateProductBinding({ ...row, cohort_id: null }, projects, cohorts), '');
  const h = harness();
  h.load('admin-commerce-products.js');
  const options = h.context.cohortOptions('project-a', null, cohorts);
  assert.match(options, /cohort-a/);
  assert.doesNotMatch(options, /cohort-b/);
  const form = h.context.productFormHtml(row, projects, cohorts);
  assert.match(form, /select class="input" name="project_id"/);
  assert.match(form, /select class="input" name="cohort_id"/);
  assert.doesNotMatch(form, /<input[^>]*name="project_id"/);
});

test('admin entry and every mutual import share one version; order writes use transactional RPCs', () => {
  const files = readdirSync(new URL('../', import.meta.url)).filter(name => /^admin-commerce.*\.(js|html)$/.test(name));
  const versions = new Set();
  for (const file of files) {
    for (const match of read(file).matchAll(/admin-commerce(?:-[a-z-]+)?\.js\?v=([\w]+)/g)) versions.add(match[1]);
  }
  assert.deepEqual([...versions], ['20260914_payment1']);
  const source = read('admin-commerce-orders.js');
  assert.doesNotMatch(source, /\.update\(|\.insert\(/);
  assert.doesNotMatch(source, /rpc\('admin_approve_order'/);
  assert.match(source, /admin_revoke_order_approval/);
});

test('all five FULL offers restrict project selection by exact code; retired replay and bundles never require a training binding', () => {
  const h = harness(); h.load('admin-commerce-products.js');
  const specialties = ['GLOM', 'ICU', 'TX', 'PATHO', 'DA'];
  const projects = specialties.map(spec => ({ id: `project-${spec}`, project_code: `PROJ-${spec}-2026`, title: '相同名称' }));
  for (const spec of specialties) {
    const full = { product_code: `${spec}-REG-FULL-2026`, product_type: 'project_registration', project_id: `project-${spec}`, cohort_id: null };
    assert.equal(validateProductBinding(full, projects, []), '');
    const foreign = projects.find(project => project.id !== full.project_id);
    assert.notEqual(validateProductBinding({ ...full, project_id: foreign.id }, projects, []), '');
    const options = h.context.projectOptions(full, projects);
    assert.match(options, new RegExp(`value="project-${spec}"`));
    assert.doesNotMatch(options, new RegExp(`value="${foreign.id}"`));
    for (const product of [
      { product_code: `${spec}-REG-VIDEO-2026`, product_type: 'project_registration', project_id: null, cohort_id: null },
      { product_code: `${spec}-BUNDLE-2026`, product_type: 'specialty_bundle', project_id: null, cohort_id: null },
    ]) {
      assert.equal(validateProductBinding(product, projects, []), '');
      assert.notEqual(validateProductBinding({ ...product, project_id: full.project_id }, projects, []), '');
      assert.doesNotMatch(h.context.projectOptions(product, projects), /value="project-/);
    }
  }
});

test('project enrollment management uses the guarded RPC only for pending manual enrollments', async () => {
  const h = harness(); h.load('admin-commerce-projects.js');
  const manual = { id: 'enrollment-1', enrollment_status: 'pending', approval_status: 'pending', source_order_id: null };
  for (const row of [{ ...manual, source_order_id: order.id }, { ...manual, enrollment_status: 'cancelled' },
    { ...manual, approval_status: 'rejected' }]) {
    await h.context.reviewManualEnrollment(row, true, 'project-icu');
  }
  assert.equal(h.calls.filter(call => call.name === 'admin_review_manual_enrollment').length, 0);
  await h.context.reviewManualEnrollment(manual, true, 'project-icu');
  const call = h.calls.find(call => call.name === 'admin_review_manual_enrollment');
  assert.equal(call.args.p_enrollment_id, manual.id);
  assert.equal(call.args.p_approve, true);
  const source = read('admin-commerce-projects.js');
  assert.doesNotMatch(source, /from\('project_enrollments'\)\s*\.update/);
  assert.match(source, /!e\.source_order_id && e\.enrollment_status === 'pending'/);
});
