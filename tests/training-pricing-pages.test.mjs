import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const commerce = await import('data:text/javascript;base64,' + Buffer.from(read('training-commerce.js')).toString('base64'));

function page(name, nodes = {}) {
  const context = {
    ...commerce,
    document: { getElementById: id => nodes[id] || null, querySelector: () => null },
    console,
  };
  const source = read(name)
    .replace(/^import\s+[\s\S]*?\sfrom\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/\ninit\(\)\.catch[^\n]*;\s*$/, '')
    .replace(/\nloadPrograms\(\);\s*$/, '');
  vm.createContext(context);
  vm.runInContext(source, context, { filename: name });
  return context;
}

function product(code, type, price, extra = {}) {
  return { id: code, product_code: code, product_type: type, price_cny: price, is_active: true, ...extra };
}

function bundleNodes() {
  const price = { textContent: '¥980' }, button = { href: 'checkout.html?product=DA-BUNDLE-2026' };
  const original = { removed: false, remove() { this.removed = true; } };
  return { price, button, original, banner: { querySelector: selector => ({ '.bb-price': price, '.bb-orig': original, '.btn': button })[selector] } };
}

test('academy selects exact FULL and BUNDLE products regardless of recommended flags; excludes replay and inactive offers', () => {
  const academy = page('academy.js');
  const rows = [];
  for(const spec of ['GLOM', 'ICU', 'TX', 'PATHO', 'DA']) {
    rows.push(product(`${spec}-REG-FULL-2026`, 'project_registration', 1580, { recommended: false }));
    rows.push(product(`${spec}-REG-VIDEO-2026`, 'project_registration', 980, { recommended: true }));
    rows.push(product(`${spec}-BUNDLE-2026`, 'specialty_bundle', 1200, { recommended: true }));
  }
  rows.push(product('ICU-REG-FULL-2026', 'membership_plan', 10));
  rows.push(product('TX-REG-FULL-2026', 'project_registration', 10, { is_active: false }));
  const groups = academy.groupTrainingProducts(rows);
  for(const spec of ['glom', 'icu', 'tx', 'patho', 'da']) {
    assert.equal(groups[spec].full.price_cny, 1580);
    assert.equal(groups[spec].bundle.price_cny, 1200);
    assert.equal(groups[spec].video, undefined);
  }
});

test('academy quotes actual database amount, removes early-bird comparison and keeps purchased learning access', () => {
  const container = { innerHTML: '' }, bundle = bundleNodes();
  const academy = page('academy.js', { 'proj-pricing-da': container, 'bundle-da': bundle.banner });
  const full = product('DA-REG-FULL-2026', 'project_registration', 1280, {
    list_price_cny: 1580, early_bird_deadline: '2099-01-01', recommended: false,
  });
  academy.renderPricingCards('da', { full, video: product('DA-REG-VIDEO-2026', 'project_registration', 980) }, new Set());
  assert.match(container.innerHTML, /¥1,280/);
  assert.match(container.innerHTML, /product=DA-REG-FULL-2026/);
  assert.doesNotMatch(container.innerHTML, /REG-VIDEO|早鸟|p-orig|1,580/);
  academy.renderPricingCards('da', { full }, new Set([full.id]));
  assert.match(container.innerHTML, /my-learning\.html/);
  assert.doesNotMatch(container.innerHTML, /checkout\.html/);
  academy.renderBundle('da', product('DA-BUNDLE-2026', 'specialty_bundle', 980, { list_price_cny: 1200 }), new Set());
  assert.equal(bundle.price.textContent, '¥980');
  assert.equal(bundle.original.removed, true);
});

test('academy does not retain static sale links for unavailable products or a failed product fetch', () => {
  const container = { innerHTML: '<a href="checkout.html">old offer</a>' }, bundle = bundleNodes();
  const academy = page('academy.js', { 'proj-pricing-da': container, 'bundle-da': bundle.banner });
  academy.renderPricingCards('da', {}, new Set());
  assert.match(container.innerHTML, /暂未开放报名/);
  assert.doesNotMatch(container.innerHTML, /checkout/);
  academy.renderBundle('da', null, new Set());
  assert.equal(bundle.price.textContent, '暂未开放销售');
  assert.equal(bundle.button.href, 'my-learning.html');
  academy.renderPricingCards('da', {}, new Set(), false);
  assert.match(container.innerHTML, /暂未加载/);
  assert.doesNotMatch(container.innerHTML, /¥|checkout/);
});

test('training list uses the charged product price, not the stale programme price, and suppresses replay-only sale rows', () => {
  const grid = { innerHTML: '' }, home = { innerHTML: '' };
  const programs = page('trainingprograms.js', { trainingProgramsGrid: grid, homeTrainingList: home });
  const rows = [
    { title: '培训报名', product_code: 'ICU-REG-FULL-2026', price_cny: 699, badge: '早鸟优惠', status: 'active' },
    { title: '整套课', product_code: 'ICU-BUNDLE-2026', price_cny: 888, status: 'active' },
    { title: '已取消的回放版', product_code: 'ICU-REG-VIDEO-2026', price_cny: 980, status: 'active' },
  ];
  const products = [
    product('ICU-REG-FULL-2026', 'project_registration', 1580, { recommended: false }),
    product('ICU-BUNDLE-2026', 'specialty_bundle', 1200),
    product('ICU-REG-VIDEO-2026', 'project_registration', 980, { recommended: true }),
  ];
  const resolved = programs.withProgramProducts(rows, products);
  programs.renderGrid(resolved);
  programs.renderHome(resolved);
  assert.match(grid.innerHTML, /立即报名 ¥1,580/);
  assert.match(grid.innerHTML, /购买整套课 ¥1,200/);
  assert.doesNotMatch(grid.innerHTML, /699|888|REG-VIDEO|早鸟/);
  assert.doesNotMatch(home.innerHTML, /回放版|早鸟/);
});

test('training list provides no stale payment quote or checkout entry if product is inactive, missing, or unrelated', () => {
  const grid = { innerHTML: '' };
  const programs = page('trainingprograms.js', { trainingProgramsGrid: grid });
  const rows = [{ title: '项目筹备中', product_code: 'DA-REG-FULL-2026', price_cny: 1280 }];
  for(const products of [[],
    [product('DA-REG-FULL-2026', 'project_registration', 1580, { is_active: false })],
    [product('DA-REG-FULL-2026', 'membership_plan', 1580)],
  ]) {
    programs.renderGrid(programs.withProgramProducts(rows, products));
    assert.match(grid.innerHTML, /项目筹备中/);
    assert.doesNotMatch(grid.innerHTML, /checkout|1280|1,580/);
  }
});
