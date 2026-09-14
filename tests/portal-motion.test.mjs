import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const moduleUrl = new URL('../portal-motion.js', import.meta.url);
const source = readFileSync(moduleUrl, 'utf8');
const { initPortalFeature, initPortalMotion } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

class Element {
  constructor() {
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = new Map();
    this.hidden = false;
    this.textContent = '';
    const classes = new Set();
    this.classList = {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle(value, force) {
        const next = force ?? !classes.has(value);
        if (next) classes.add(value); else classes.delete(value);
        return next;
      },
    };
  }
  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }
  dispatch(name) { for (const handler of this.listeners.get(name) || []) handler({ target: this }); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  querySelector(selector) { return this.children.get(selector) || null; }
  querySelectorAll(selector) { return this.children.get(selector) || []; }
}

function featureFixture(extraKeys = []) {
  const root = new Element(), feature = new Element(), tabs = new Element();
  const title = new Element(), description = new Element(), english = new Element();
  feature.classList.add('portal-feature');
  feature.classList.add('portal-cover--path');
  feature.setAttribute('href', 'training-patho.html');
  feature.setAttribute('aria-label', '了解肾脏病理培训课程');
  title.textContent = '肾脏病理';
  description.textContent = '从形态到临床，让理解更进一步';
  english.textContent = 'RENAL PATHOLOGY';
  feature.children.set('[data-feature-title]', title);
  feature.children.set('[data-feature-description]', description);
  feature.children.set('[data-feature-english]', english);
  const buttons = ['path', 'icu', 'tx', ...extraKeys].map(key => {
    const button = new Element();
    button.dataset.featureTopic = key;
    button.setAttribute('aria-pressed', String(key === 'path'));
    return button;
  });
  tabs.hidden = true;
  tabs.children.set('[data-feature-topic]', buttons);
  root.children.set('[data-portal-feature]', feature);
  root.children.set('[data-feature-tabs]', tabs);
  return { root, feature, tabs, buttons, title, description, english };
}

function motionFixture({ reduced = false, observer = true, hidden = false } = {}) {
  const root = new Element(), hero = new Element(), button = new Element(), preference = new Element();
  root.hidden = hidden;
  preference.matches = reduced;
  button.hidden = true;
  root.children.set('.portal-hero', hero);
  root.children.set('[data-portal-motion]', button);
  let visibility;
  const view = {
    matchMedia(query) {
      assert.equal(query, '(prefers-reduced-motion: reduce)');
      return preference;
    },
  };
  if (observer) view.IntersectionObserver = class {
    constructor(callback) { visibility = callback; }
    observe(element) { assert.equal(element, hero); }
  };
  const visible = value => visibility([{ isIntersecting: value }]);
  const moving = () => hero.classList.contains('portal-background-moving');
  return { root, hero, button, preference, view, visible, moving };
}

test('course showcase switches its real destination, title, description and selected state together', () => {
  const f = featureFixture();
  initPortalFeature(f.root);
  assert.equal(f.tabs.hidden, false);
  const expected = [
    ['icu', 'training-icu.html', '重症肾内科', '围绕 AKI 与肾脏替代治疗，连接知识与实践', 'CRITICAL CARE NEPHROLOGY'],
    ['tx', 'training-tx.html', '肾移植', '从围术期到长期管理，系统理解移植内科', 'TRANSPLANT NEPHROLOGY'],
    ['path', 'training-patho.html', '肾脏病理', '从形态到临床，让理解更进一步', 'RENAL PATHOLOGY'],
  ];
  for (const [key, href, title, description, english] of expected) {
    const selected = f.buttons.find(button => button.dataset.featureTopic === key);
    selected.dispatch('click');
    assert.equal(f.feature.getAttribute('href'), href);
    assert.ok(existsSync(fileURLToPath(new URL(`../${href}`, import.meta.url))), `Missing real training page: ${href}`);
    assert.equal(f.feature.getAttribute('aria-label'), `了解${title}培训课程`);
    assert.equal(f.title.textContent, title);
    assert.equal(f.description.textContent, description);
    assert.equal(f.english.textContent, english);
    assert.equal(f.feature.classList.contains('portal-feature'), true);
    for (const button of f.buttons) {
      assert.equal(button.getAttribute('aria-pressed'), String(button === selected));
      assert.equal(f.feature.classList.contains(`portal-cover--${button.dataset.featureTopic}`), button === selected);
    }
  }
});

test('unknown and inherited topic names cannot replace a valid training destination', () => {
  const f = featureFixture(['unknown', '__proto__', 'constructor', 'https://example.invalid/checkout']);
  initPortalFeature(f.root);
  f.buttons.find(button => button.dataset.featureTopic === 'tx').dispatch('click');
  const snapshot = () => [f.feature.getAttribute('href'), f.feature.getAttribute('aria-label'), f.title.textContent,
    f.description.textContent, f.english.textContent, ...f.buttons.map(button => button.getAttribute('aria-pressed'))];
  const before = snapshot();
  for (const button of f.buttons.slice(3)) {
    button.dispatch('click');
    assert.deepEqual(snapshot(), before);
  }
});

test('visual controls initialize once and safely skip pages without the homepage components', () => {
  const f = featureFixture(), m = motionFixture();
  initPortalFeature(f.root); initPortalFeature(f.root);
  initPortalMotion(m.root, m.view); initPortalMotion(m.root, m.view);
  assert.equal(f.buttons[0].listeners.get('click').length, 1);
  assert.equal(m.button.listeners.get('click').length, 1);
  m.button.dispatch('click');
  assert.equal(m.moving(), false, 'One click must pause rather than toggle twice');
  assert.doesNotThrow(() => initPortalFeature(new Element()));
  assert.doesNotThrow(() => initPortalMotion(new Element(), {}));
});

test('background pause survives offscreen and page-visibility transitions until explicitly resumed', () => {
  const f = motionFixture();
  initPortalMotion(f.root, f.view);
  assert.equal(f.button.hidden, false);
  assert.equal(f.moving(), true);
  f.button.dispatch('click');
  assert.equal(f.moving(), false);
  assert.equal(f.button.textContent, '开启背景动效');
  assert.equal(f.button.getAttribute('aria-pressed'), 'true');
  f.visible(false); f.visible(true);
  f.root.hidden = true; f.root.dispatch('visibilitychange');
  f.root.hidden = false; f.root.dispatch('visibilitychange');
  assert.equal(f.moving(), false);
  f.button.dispatch('click');
  assert.equal(f.moving(), true);
  assert.equal(f.button.textContent, '暂停背景动效');
  assert.equal(f.button.getAttribute('aria-pressed'), 'false');
});

test('background animation stops offscreen and while the browser page is hidden', () => {
  const f = motionFixture({ hidden: true });
  initPortalMotion(f.root, f.view);
  assert.equal(f.moving(), false);
  f.root.hidden = false; f.root.dispatch('visibilitychange');
  assert.equal(f.moving(), true);
  f.visible(false);
  assert.equal(f.moving(), false);
  f.visible(true);
  assert.equal(f.moving(), true);
  f.root.hidden = true; f.root.dispatch('visibilitychange');
  assert.equal(f.moving(), false);
});

test('reduced-motion preference suppresses animation initially and when changed during use', () => {
  const initial = motionFixture({ reduced: true });
  initPortalMotion(initial.root, initial.view);
  assert.equal(initial.moving(), false);
  assert.equal(initial.button.disabled, true);
  assert.equal(initial.button.textContent, '已按系统设置减少动效');
  const changed = motionFixture();
  initPortalMotion(changed.root, changed.view);
  assert.equal(changed.moving(), true);
  changed.preference.matches = true;
  changed.preference.dispatch('change');
  assert.equal(changed.moving(), false);
  assert.equal(changed.button.disabled, true);
  assert.equal(changed.button.textContent, '已按系统设置减少动效');
  changed.preference.matches = false;
  changed.preference.dispatch('change');
  assert.equal(changed.button.disabled, false);
  assert.equal(changed.moving(), true);
});

test('pause and hidden-page behavior remain usable without IntersectionObserver', () => {
  const f = motionFixture({ observer: false });
  initPortalMotion(f.root, f.view);
  assert.equal(f.moving(), true);
  f.root.hidden = true; f.root.dispatch('visibilitychange');
  assert.equal(f.moving(), false);
  f.root.hidden = false; f.root.dispatch('visibilitychange');
  assert.equal(f.moving(), true);
  f.button.dispatch('click');
  assert.equal(f.moving(), false);
});

test('presentation module has no service imports, network calls or account and playback operations', () => {
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b|\bimport\s*\(/);
  assert.doesNotMatch(source, /supabase\s*\.|\.auth\b|play-auth|create[_-]?order|\/api\//i);
});
