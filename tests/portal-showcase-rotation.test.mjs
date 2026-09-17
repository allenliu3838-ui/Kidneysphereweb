import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../home.js', import.meta.url), 'utf8')
  .replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];\s*/, '')
  .replace(/\nloadHomeShowcase\(\);\s*$/, '\n');

class EventTargetStub {
  listeners = new Map();
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    if (!callbacks.includes(callback)) callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== callback));
  }
  dispatch(type, details = {}) {
    const event = { type, target: this, currentTarget: this, ...details };
    for (const callback of this.listeners.get(type) || []) callback(event);
  }
  listenerCount() {
    return [...this.listeners.values()].reduce((sum, callbacks) => sum + callbacks.length, 0);
  }
}

class ElementStub extends EventTargetStub {
  attributes = {};
  dataset = {};
  hidden = false;
  textContent = '';
  _html = '';
  children = [];
  scrollLeft = 0;
  scrollWidth = 0;
  clientWidth = 940;
  width = 300;
  expanded = false;
  scrolls = [];
  classList = { toggle() {}, contains() { return false; } };
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  get innerHTML() { return this._html; }
  set innerHTML(value) {
    this._html = value;
    this.children = [...value.matchAll(/<article\b[^>]*class="home-showcase-card"/g)]
      .map((_, index) => {
        const child = new ElementStub();
        child.offsetLeft = index * 320;
        child.parentNode = this;
        return child;
      });
    this.scrollWidth = Math.max(this.clientWidth, this.children.length * 320 - 20);
  }
  getBoundingClientRect() { return { width: this.width, top: 100, bottom: 500, height: 400 }; }
  contains(element) { return element === this || this.children.includes(element) || element?.parentNode === this; }
  querySelector(selector) {
    if (selector === '.home-showcase-card') return this.children[0] || null;
    if (/expanded|aria-expanded/.test(selector)) return this.expanded ? {} : null;
    return null;
  }
  querySelectorAll(selector) {
    if (selector === '.home-showcase-card') return this.children;
    return [];
  }
  scrollTo(options) {
    this.scrollLeft = Math.max(0, Math.min(options.left, this.scrollWidth - this.clientWidth));
    this.scrolls.push({ ...options, left: this.scrollLeft });
    this.dispatch('scroll');
  }
  scrollBy(options) { this.scrollTo({ ...options, left: this.scrollLeft + options.left }); }
}

function storageStub(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

function fixture({ reducedMotion = false, count = 7 } = {}) {
  const section = new ElementStub();
  const cards = new ElementStub();
  const prev = new ElementStub();
  const next = new ElementStub();
  const toggle = new ElementStub();
  const rotationStatus = new ElementStub();
  const tabs = ['experts', 'flagship', 'co_building', 'partners'].map(kind => {
    const tab = new ElementStub();
    tab.setAttribute('data-home-showcase-tab', kind);
    return tab;
  });
  const selectors = {
    '[data-home-showcase]': section,
    '[data-home-showcase-cards]': cards,
    '[data-home-showcase-prev]': prev,
    '[data-home-showcase-next]': next,
    '[data-home-showcase-stats]': new ElementStub(),
    '[data-home-showcase-actions]': new ElementStub(),
    '[data-home-showcase-status]': new ElementStub(),
    '[data-home-showcase-autoplay]': toggle,
    '[data-home-showcase-playback]': rotationStatus,
  };
  const document = Object.assign(new EventTargetStub(), {
    baseURI: 'https://www.kidneysphere.com/',
    hidden: false,
    visibilityState: 'visible',
    activeElement: null,
    querySelector: selector => selectors[selector] || null,
    querySelectorAll: selector => selector === '[data-home-showcase-tab]' ? tabs : [],
  });
  const timers = new Map();
  let nextTimer = 0;
  const media = Object.assign(new EventTargetStub(), { matches: reducedMotion });
  let intersection;
  const window = Object.assign(new EventTargetStub(), {
    innerHeight: 900,
    localStorage: storageStub(),
    requestAnimationFrame: callback => { callback(); return 1; },
    getComputedStyle: () => ({ columnGap: '20px', gap: '20px' }),
    matchMedia: () => media,
    setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
  });
  const context = vm.createContext({
    URL, document, window,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    IntersectionObserver: class {
      constructor(callback) { intersection = callback; }
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class { observe() {} disconnect() {} },
    supabase: null, ensureSupabase: async () => {}, isConfigured: () => false,
  });
  vm.runInContext(source, context);
  const rows = Array.from({ length: count }, (_, id) => ({ id: `expert-${id}`, title: `Expert ${id}`, category: 'experts_cn' }));
  const byTab = {
    experts: { rows },
    flagship: { rows: [{ id: 'center', title: 'Center' }] },
    co_building: { rows: [] },
    partners: { rows: [] },
  };
  return {
    context, section, cards, prev, next, toggle, rotationStatus, document, window, media, timers, rows, tabs, byTab,
    start() { context.connectShowcaseTabs(byTab); this.visible(true); },
    visible(isIntersecting) {
      intersection?.([{ target: section, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 }]);
    },
    tick() {
      assert.equal(timers.size, 1, 'Exactly one scheduled advance should exist');
      const [id, { callback }] = timers.entries().next().value;
      timers.delete(id);
      callback();
    },
    focus(element) { document.activeElement = element; cards.dispatch('focusin', { target: element }); },
  };
}

const ids = rows => Array.from(rows, row => row.id);

test('expert starting position cycles through every expert over repeated visits without losing or editing rows', () => {
  const f = fixture();
  const originalIds = ids(f.rows);
  const snapshot = JSON.stringify(f.rows);
  const storage = storageStub();
  const firstIds = [];
  for (let visit = 0; visit < f.rows.length; visit++) {
    const arranged = f.context.chooseExpertStart(f.rows, storage, () => 0.5);
    firstIds.push(arranged[0].id);
    assert.deepEqual(ids(arranged).sort(), [...originalIds].sort());
    assert.notEqual(arranged, f.rows);
  }
  assert.equal(new Set(firstIds).size, f.rows.length, 'Nobody should be pinned to the leading position');
  assert.equal(JSON.stringify(f.rows), snapshot);
});

test('expert rotation remains usable when storage is denied or the directory has zero or one expert', () => {
  const f = fixture();
  const denied = { getItem() { throw new Error('Storage denied'); }, setItem() { throw new Error('Storage denied'); } };
  for (const rows of [[], f.rows.slice(0, 1), f.rows]) {
    const arranged = f.context.chooseExpertStart(rows, denied, () => 0.8);
    assert.deepEqual(ids(arranged).sort(), ids(rows).sort());
  }
  Object.defineProperty(f.window, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
  assert.deepEqual(ids(f.context.expertStartForVisit(f.rows)).sort(), ids(f.rows).sort());
});

test('first visits can lead with different experts while preserving the complete directory', () => {
  const f = fixture();
  const first = f.context.chooseExpertStart(f.rows, storageStub(), () => 0);
  const second = f.context.chooseExpertStart(f.rows, storageStub(), () => 0.75);
  assert.notEqual(first[0].id, second[0].id);
  assert.deepEqual(ids(first).sort(), ids(second).sort());
});

test('scheduled rotation advances one card every six seconds and returns to the start after the last visible page', () => {
  const f = fixture();
  f.start();
  assert.equal(f.cards.getAttribute('aria-live'), 'off');
  assert.equal([...f.timers.values()][0].delay, 6000);
  assert.equal(f.cards.scrollLeft, 0);
  f.tick();
  assert.equal(f.cards.scrollLeft, 320);
  assert.equal(f.cards.scrolls.at(-1).behavior, 'smooth');
  f.tick();
  f.tick();
  f.tick();
  assert.equal(f.cards.scrollLeft, f.cards.scrollWidth - f.cards.clientWidth);
  f.tick();
  assert.equal(f.cards.scrollLeft, 0);
  assert.equal(f.timers.size, 1);
});

test('mouse hover suspends rotation temporarily and leaving starts a fresh delay', () => {
  const f = fixture();
  f.start();
  f.section.dispatch('pointerenter', { pointerType: 'mouse' });
  assert.equal(f.timers.size, 0);
  assert.equal(f.cards.getAttribute('aria-live'), 'polite');
  f.section.dispatch('pointerleave', { pointerType: 'mouse' });
  assert.equal(f.timers.size, 1);
  f.tick();
  assert.equal(f.cards.scrollLeft, 320);
});

test('keyboard focus and a manual touch each pause until the user explicitly starts rotation', () => {
  for (const interact of [
    f => f.focus(f.cards.children[0]),
    f => f.cards.dispatch('pointerdown', { pointerType: 'touch' }),
    f => f.prev.dispatch('focusin'),
  ]) {
    const f = fixture();
    f.start();
    interact(f);
    assert.equal(f.timers.size, 0);
    assert.match(f.toggle.textContent, /开始/);
    f.context.syncShowcaseRotation();
    f.visible(false);
    f.visible(true);
    assert.equal(f.timers.size, 0, 'Viewport changes must not restart a reader-paused carousel');
    f.toggle.dispatch('click');
    assert.equal(f.timers.size, 1);
    f.tick();
    assert.equal(f.cards.scrollLeft, 320);
  }
});

test('manual previous and next buttons move the cards but stop automatic movement', () => {
  const f = fixture();
  f.start();
  f.next.dispatch('click');
  assert.equal(f.cards.scrollLeft, 320);
  assert.equal(f.timers.size, 0);
  f.prev.dispatch('click');
  assert.equal(f.cards.scrollLeft, 0);
  assert.equal(f.timers.size, 0);
  f.toggle.dispatch('click');
  assert.equal(f.timers.size, 1);
});

test('opening a biography stops rotation, keeps it open, and requires explicit restart after closing', () => {
  const f = fixture();
  f.start();
  const description = { hidden: true };
  const button = new ElementStub();
  const card = {
    dataset: { kind: 'experts' },
    querySelector: selector => selector === '.desc' ? description : { textContent: 'Expert 0' },
    classList: { toggle() {} },
  };
  button.parentNode = f.cards;
  button.closest = () => card;
  button.setAttribute('aria-expanded', 'false');
  const target = { closest: () => button };
  f.cards.querySelector = selector => {
    if (selector === '.home-showcase-card') return f.cards.children[0];
    if (/aria-expanded/.test(selector)) return button.getAttribute('aria-expanded') === 'true' ? button : null;
    return null;
  };
  f.cards.dispatch('click', { target });
  assert.equal(description.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(f.timers.size, 0);
  assert.equal(f.toggle.disabled, true);
  f.visible(false);
  f.visible(true);
  assert.equal(description.hidden, false);
  assert.equal(f.timers.size, 0);
  f.cards.dispatch('click', { target });
  assert.equal(description.hidden, true);
  assert.equal(f.toggle.disabled, false);
  assert.equal(f.timers.size, 0);
  f.toggle.dispatch('click');
  f.tick();
  assert.equal(f.cards.scrollLeft, 320);
});

test('hidden pages and offscreen sections never advance and resume only after becoming visible', () => {
  const f = fixture();
  f.start();
  f.document.hidden = true;
  f.document.dispatch('visibilitychange');
  assert.equal(f.timers.size, 0);
  f.document.hidden = false;
  f.document.dispatch('visibilitychange');
  assert.equal(f.timers.size, 1);
  f.visible(false);
  assert.equal(f.timers.size, 0);
  f.visible(true);
  assert.equal(f.timers.size, 1);
  f.window.dispatch('pagehide');
  assert.equal(f.timers.size, 0);
  f.window.dispatch('pageshow');
  assert.equal(f.timers.size, 1);
});

test('reduced motion starts paused and any explicit rotation avoids animated scrolling', () => {
  const f = fixture({ reducedMotion: true });
  f.start();
  assert.equal(f.timers.size, 0);
  assert.match(f.toggle.textContent, /开始/);
  f.toggle.dispatch('click');
  f.tick();
  assert.equal(f.cards.scrollLeft, 320);
  assert.equal(f.cards.scrolls.at(-1).behavior, 'auto');
  f.media.dispatch('change');
  assert.equal(f.timers.size, 0);
});

test('non-expert tabs, a single expert and fully visible cards have no automatic timer', () => {
  for (const count of [0, 1, 3]) {
    const f = fixture({ count });
    f.start();
    assert.equal(f.timers.size, 0);
  }
  const f = fixture();
  f.start();
  for (const tab of f.tabs.slice(1)) {
    tab.dispatch('click');
    assert.equal(f.timers.size, 0);
    assert.equal(f.rotationStatus.hidden, true);
  }
  f.tabs[0].dispatch('click');
  assert.equal(f.timers.size, 1);
  assert.equal(f.rotationStatus.hidden, false);
});

test('repeated carousel setup does not multiply controls, timers or event listeners', () => {
  const f = fixture();
  f.start();
  const targets = [f.cards, f.section, f.prev, f.next, f.toggle, f.document, f.window, f.media];
  const before = targets.map(target => target.listenerCount());
  for (let index = 0; index < 4; index++) {
    f.context.initShowcaseRotation();
    f.context.bindCarouselNav();
    f.context.bindShowcaseExpand();
    f.context.syncShowcaseRotation();
  }
  assert.deepEqual(targets.map(target => target.listenerCount()), before);
  assert.equal(f.timers.size, 1);
  f.tick();
  assert.equal(f.cards.scrollLeft, 320);
});
