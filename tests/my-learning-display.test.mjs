import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as display from '../my-learning-display.js';

const NOW = Date.parse('2026-09-14T12:00:00Z');
const entitlement = (overrides = {}) => ({
  status: 'active', entitlement_type: 'membership', start_at: '2026-01-01T00:00:00Z',
  end_at: '2030-01-01T00:00:00Z', ...overrides,
});
const enrollment = (overrides = {}) => ({
  project_id: 'project-icu', project_title: '重症肾内科项目', cohort_id: null, cohort_title: null,
  enrollment_status: 'confirmed', approval_status: 'approved', product_title: '原订单报名版',
  source_order_id: 'order-original', specialty_id: 'specialty-icu',
  access_start_at: '2026-01-01T00:00:00Z', access_end_at: '2030-01-01T00:00:00Z',
  is_access_active: true, access_status: 'active', ...overrides,
});

test('lifetime membership wins over finite renewals; future and invalid grants never show active', () => {
  const finite = entitlement();
  const lifetime = entitlement({ end_at: null });
  assert.equal(display.currentLearningMembership([finite, lifetime], NOW), lifetime);
  assert.equal(display.currentLearningMembership([lifetime, finite], NOW), lifetime);
  assert.equal(display.entitlementDisplayState(lifetime, NOW).label, '长期有效');
  for (const invalid of [
    entitlement({ start_at: '2031-01-01', end_at: null }),
    entitlement({ start_at: 'not-a-date', end_at: null }),
    entitlement({ end_at: 'bad' }), entitlement({ end_at: '' }),
    entitlement({ end_at: '2026-02-31' }), entitlement({ end_at: '2030-13-01' }),
    entitlement({ start_at: '2031-01-01', end_at: '2030-01-01' }),
  ]) assert.equal(display.entitlementDisplayState(invalid, NOW).active, false);
  assert.equal(display.currentLearningMembership([entitlement({ start_at: '2031-01-01', end_at: null })], NOW), null);
  assert.equal(display.formatLearningDate('bad'), '日期待核实');
  assert.equal(display.formatLearningDate('2026-09-14'), '2026-09-14');
  assert.equal(display.formatLearningDate('2026-09-14T16:00:00Z'), '2026-09-15');
});

test('expiry uses the exact instant and all revoked/refunded/missing statuses fail closed', () => {
  for (const delta of [-1000, 0]) assert.equal(display.entitlementDisplayState(entitlement({ end_at: new Date(NOW + delta).toISOString() }), NOW).active, false);
  assert.equal(display.entitlementDisplayState(entitlement({ end_at: new Date(NOW + 1000).toISOString() }), NOW).days, 1);
  for (const status of ['revoked', 'refunded', 'cancelled', 'expired', undefined]) {
    assert.equal(display.entitlementDisplayState(entitlement({ status, end_at: null }), NOW).active, false);
  }
});

test('course links use supported video filters and never infer specialty from project or product title', () => {
  assert.deepEqual(display.learningCourseLink(entitlement({ entitlement_type: 'project_access', specialty_id: 'sp/1' })), { href: 'videos.html?specialty=sp%2F1', label: '进入课程' });
  assert.equal(display.learningCourseLink(entitlement({ entitlement_type: 'project_access', project_id: 'project-icu', product_title: '重症报名版' })), null);
  assert.equal(display.learningCourseLink(entitlement({ status: 'revoked', specialty_id: 'sp-1' })), null);
});

test('confirmed enrollment alone cannot supply access or reuse another order entitlement', () => {
  for (const entry of [enrollment({ is_access_active: false }), enrollment({ is_access_active: undefined }),
    enrollment({ access_status: 'ambiguous' }), enrollment({ access_status: 'refunded' }), enrollment({ approval_status: 'rejected' }),
    enrollment({ enrollment_status: 'cancelled' }), enrollment({ access_start_at: '2031-01-01', access_end_at: null }),
    enrollment({ access_end_at: 'bad' }), enrollment({ access_end_at: new Date(NOW).toISOString() }),
  ]) assert.equal(display.enrollmentDisplayState(entry, NOW).active, false);
  assert.equal(display.enrollmentDisplayState(enrollment(), NOW).active, true);
});

const source = (await fs.readFile(new URL('../my-learning.js', import.meta.url), 'utf8'))
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*'[^']+';\n/gm, '')
  .replace(/\ninit\(\);\s*$/, '\n');

function harness() {
  const elements = new Map();
  const proInputs = [];
  const notifications = { select() { return this; }, eq() { return this; }, order() { return this; }, async limit() { return { data: [] }; } };
  const ctx = vm.createContext({
    ...display, fmtDate: display.formatLearningDate,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { innerHTML: '', hidden: true, style: {} });
        return elements.get(id);
      },
      querySelector() { return null; },
    },
    supabase: { from(table) { assert.equal(table, 'notification_jobs'); return notifications; } },
    localStorage: { setItem() {} },
    async canAccessNephroPro(ents) {
      proInputs.push(ents);
      return ents.some(e => ['membership', 'project_access', 'cohort_access', 'atlas_pro'].includes(e.entitlement_type));
    },
  });
  vm.runInContext(source, ctx);
  return { ctx, proInputs, html: id => elements.get(id)?.innerHTML || '' };
}

test('empty membership and Pro stay locked while lifetime status survives all summary renderers', async () => {
  const h = harness();
  await h.ctx.renderEntitlements([]);
  assert.doesNotMatch(h.html('nephroProCard'), /已解锁/);
  assert.match(h.html('membershipCard'), /开通会员/);
  const ents = [entitlement(), entitlement({ end_at: null })];
  await h.ctx.renderEntitlements(ents);
  await h.ctx.renderDashboardSummary({ id: 'test-user' }, ents);
  assert.match(h.html('membershipCard'), /长期有效/);
  assert.match(h.html('dashMembership'), /长期有效/);
  assert.match(h.html('nephroProCard'), /已解锁/);
  await h.ctx.renderEntitlements([entitlement({ start_at: '2031-01-01', end_at: null }), entitlement({ status: 'revoked', end_at: null })]);
  assert.doesNotMatch(h.html('nephroProCard'), /已解锁/);
  assert.equal(h.proInputs.at(-1).length, 0);
});

test('bundles keep distinct purchase terms and legacy video is never presented as FULL registration', async () => {
  const h = harness();
  await h.ctx.renderEntitlements([
    entitlement({ entitlement_type: 'specialty_bundle', specialty_id: 'sp-icu', product_title: '课程订单A' }),
    entitlement({ entitlement_type: 'specialty_bundle', specialty_id: 'sp-icu', product_title: '长期订单B', end_at: null }),
    entitlement({ entitlement_type: 'project_access', product_type: 'project_registration', product_title: '历史回放VIDEO', project_title: '原项目' }),
  ]);
  assert.match(h.html('entList'), /课程订单A/);
  assert.match(h.html('entList'), /长期订单B/);
  assert.match(h.html('entList'), /历史回放VIDEO/);
  assert.doesNotMatch(h.html('entList'), /已报名|完整版|FULL/);
  assert.equal(h.html('enrList'), '');
});

test('enrollment shows exact project, unassigned cohort and terms; only the server-authorized row gets course and group links', () => {
  const h = harness();
  h.ctx.renderEnrollments([enrollment({ group_qr_url: 'https://example.test/group.png' })]);
  let html = h.html('enrList');
  assert.match(html, /重症肾内科项目/);
  assert.match(html, /班期：未指定/);
  assert.match(html, /2026-01-01 至 2030-01-01/);
  assert.match(html, /videos\.html\?specialty=specialty-icu/);
  assert.match(html, /分班后显示对应学习群入口/);
  assert.doesNotMatch(html, /group\.png/);
  h.ctx.renderEnrollments([enrollment({ cohort_id: 'cohort-original', cohort_title: '已分配的班期', group_qr_url: 'https://example.test/group.png' })]);
  html = h.html('enrList');
  assert.match(html, /班期：已分配的班期/);
  assert.match(html, /打开学习群二维码/);
  for (const access_status of ['inactive', 'refunded', 'revoked', 'expired', 'ambiguous']) {
    h.ctx.renderEnrollments([enrollment({ is_access_active: false, access_status, group_qr_url: 'https://example.test/group.png' })]);
    html = h.html('enrList');
    assert.doesNotMatch(html, /ent-badge active|进入项目课程|group\.png/);
  }
});

test('server text and group URLs cannot inject markup or executable links', () => {
  const h = harness();
  h.ctx.renderEnrollments([enrollment({ project_title: '<img src=x onerror=alert(1)>', group_qr_url: 'javascript:alert(1)' })]);
  assert.match(h.html('enrList'), /&lt;img/);
  assert.doesNotMatch(h.html('enrList'), /<img|javascript:/);
  assert.equal(display.safeLearningImageUrl('data:text/html,<script>'), null);
});
