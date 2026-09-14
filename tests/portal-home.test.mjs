import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readProjectFile = name => readFileSync(resolve(projectRoot, name), 'utf8');
const utilitySource = readProjectFile('portal-home.js');
const appSource = readProjectFile('app.js');
const indexHtml = readProjectFile('index.html');
const homeSource = readProjectFile('home.js');
const portalCss = readProjectFile('portal-home.css');

test('portal homepage uses a single document scroller, not a fixed-height scrolling body', () => {
  const css = readProjectFile('portal-home.css');
  assert.match(indexHtml, /<html[^>]+class="portal-document"/);
  assert.match(css, /html\.portal-document\s*\{[^}]*height:\s*auto;[^}]*overflow-x:\s*clip;/);
  assert.match(css, /\.portal-home\s*\{[^}]*height:\s*auto;[^}]*overflow-x:\s*clip;/);
});

// The repository is a static site, not a type:module Node package. A data URL
// tests the actual module exports without changing package metadata or running
// browser initialization (Node has no document).
const {
  conferenceState, updateConferenceStatuses, initContactCopy, portalVideoAccess,
  normalizePortalVideo, mergePortalVideos, filterPortalVideos, selectPortalVideos,
  portalWatchUrl, loadPortalVideoMetadata,
} = await import(
  `data:text/javascript;base64,${Buffer.from(utilitySource).toString('base64')}`
);

const start = '2026-06-05T08:00:00+08:00';
const end = '2026-06-08T00:00:00+08:00';
const startAt = Date.parse(start);
const endAt = Date.parse(end);

test('conferenceState: future conferences round up remaining calendar-sized days', () => {
  assert.deepEqual(conferenceState(start, end, startAt - 2 * 86400000), {
    kind: 'upcoming', label: '2 天后开幕',
  });
  assert.deepEqual(conferenceState(start, end, startAt - 86400001), {
    kind: 'upcoming', label: '2 天后开幕',
  });
  assert.deepEqual(conferenceState(start, end, startAt - 86400000), {
    kind: 'upcoming', label: '即将开幕',
  });
  assert.deepEqual(conferenceState(start, end, startAt - 1), {
    kind: 'upcoming', label: '即将开幕',
  });
});

test('conferenceState: exact start is live', () => {
  assert.deepEqual(conferenceState(start, end, startAt), {
    kind: 'live', label: '会议进行中',
  });
});

test('conferenceState: conference remains live through the final instant before end', () => {
  for (const now of [Date.parse('2026-06-06T12:00:00+08:00'), endAt - 1]) {
    assert.deepEqual(conferenceState(start, end, now), {
      kind: 'live', label: '会议进行中',
    });
  }
});

test('conferenceState: end is exclusive, including exact Beijing end boundary', () => {
  assert.deepEqual(conferenceState(start, end, endAt), {
    kind: 'ended', label: '往期会议 · 已结束',
  });
});

test('conferenceState: June conference is archived on the September 2026 review date', () => {
  assert.deepEqual(conferenceState(start, end, Date.parse('2026-09-13T12:00:00Z')), {
    kind: 'ended', label: '往期会议 · 已结束',
  });
});

test('conferenceState: invalid, missing, equal, or reversed endpoints are unknown', () => {
  for (const [a, b] of [
    ['not-a-date', end], [start, 'not-a-date'], ['', end], [start, ''],
    [undefined, end], [start, undefined], [null, end], [start, null],
    [start, start], [end, start],
  ]) {
    assert.deepEqual(conferenceState(a, b, startAt), {
      kind: 'unknown', label: '查看会议日程',
    }, `Unexpected state for ${String(a)} / ${String(b)}`);
  }
});

test('conferenceState: invalid now values do not accidentally mark a conference live', () => {
  for (const now of [NaN, Infinity, -Infinity, null, '2026-06-06', '0', {}]) {
    assert.deepEqual(conferenceState(start, end, now), {
      kind: 'unknown', label: '查看会议日程',
    });
  }
});

test('updateConferenceStatuses writes labels and states for every matching element', () => {
  const elements = [
    { dataset: { start, end }, textContent: '' },
    { dataset: { start: '2026-12-01T08:00:00+08:00', end: '2026-12-03T00:00:00+08:00' }, textContent: '' },
    { dataset: { start: 'invalid', end }, textContent: '' },
  ];
  const now = Date.parse('2026-09-13T12:00:00Z');
  const root = { querySelectorAll(selector) {
    assert.equal(selector, '[data-conference-status]');
    return elements;
  } };
  updateConferenceStatuses(root, now);
  for (const element of elements) {
    const expected = conferenceState(element.dataset.start, element.dataset.end, now);
    assert.equal(element.textContent, expected.label);
    assert.equal(element.dataset.state, expected.kind);
  }
  assert.equal(elements[0].dataset.state, 'ended');
  assert.equal(elements[1].dataset.state, 'upcoming');
  assert.equal(elements[2].dataset.state, 'unknown');
});

test('updateConferenceStatuses safely handles a page without conference elements', () => {
  assert.doesNotThrow(() => updateConferenceStatuses({ querySelectorAll: () => [] }, startAt));
});

function contactFixture({ withButton = true, withStatus = true } = {}) {
  const listeners = new Map();
  const button = { hidden: true, addEventListener(type, listener) { listeners.set(type, listener); } };
  const status = { textContent: '' };
  const root = { querySelector(selector) {
    if (selector === '[data-copy-contact]') return withButton ? button : null;
    if (selector === '[data-contact-status]') return withStatus ? status : null;
    throw new Error(`Unexpected selector: ${selector}`);
  } };
  return { root, button, status, listeners };
}

test('initContactCopy reveals supported control and confirms an actual successful copy', async () => {
  const fixture = contactFixture();
  const copied = [];
  initContactCopy(fixture.root, { async writeText(value) { copied.push(value); } });
  assert.equal(fixture.button.hidden, false);
  assert.equal(fixture.status.textContent, '');
  assert.deepEqual([...fixture.listeners.keys()], ['click']);
  await fixture.listeners.get('click')();
  assert.deepEqual(copied, ['china@kidneysphere.com']);
  assert.equal(fixture.status.textContent, '邮箱已复制，可粘贴到您的邮件应用。');
});

test('initContactCopy rejection offers manual contact instead of claiming success', async () => {
  const fixture = contactFixture();
  initContactCopy(fixture.root, { async writeText() { throw new Error('Clipboard denied'); } });
  await fixture.listeners.get('click')();
  assert.equal(fixture.status.textContent, '未能自动复制，请手动复制：china@kidneysphere.com');
  assert.doesNotMatch(fixture.status.textContent, /邮箱已复制/);
});

test('initContactCopy leaves the fallback hidden if the clipboard API is unsupported', () => {
  for (const clipboard of [undefined, null, {}]) {
    const fixture = contactFixture();
    assert.doesNotThrow(() => initContactCopy(fixture.root, clipboard));
    assert.equal(fixture.button.hidden, true);
    assert.equal(fixture.listeners.size, 0);
    assert.equal(fixture.status.textContent, '');
  }
});

test('initContactCopy is safe when either optional DOM element is absent', () => {
  for (const options of [{ withButton: false }, { withStatus: false }]) {
    const fixture = contactFixture(options);
    assert.doesNotThrow(() => initContactCopy(fixture.root, { writeText: async () => {} }));
    assert.equal(fixture.button.hidden, true);
    assert.equal(fixture.listeners.size, 0);
  }
});

function sourceSection(startMarker, endMarker) {
  const begin = appSource.indexOf(startMarker);
  const finish = appSource.indexOf(endMarker, begin + startMarker.length);
  assert.ok(begin >= 0 && finish > begin, `Missing app.js section: ${startMarker}`);
  return appSource.slice(begin, finish);
}

function renderNavigation(portal) {
  const header = { innerHTML: '' };
  const source = sourceSection('function injectNav(){', 'function injectTopbarExtraStyles(){');
  const context = {
    document: {
      body: { hasAttribute(name) { assert.equal(name, 'data-portal-home'); return portal; } },
      querySelector(selector) { assert.equal(selector, 'header.nav'); return header; },
    },
    injectTopbarExtraStyles() {},
  };
  vm.runInNewContext(`${source}\ninjectNav();`, context);
  const menu = header.innerHTML.match(/<nav\b[^>]*class="menu"[^>]*>[\s\S]*?<\/nav>/)?.[0];
  assert.ok(menu, 'Primary menu must be rendered');
  return { html: header.innerHTML, menu, hrefs: [...menu.matchAll(/\bhref="([^"]+)"/g)].map(match => match[1]) };
}

test('app.js portal navigation contains only the four learning-focused primary routes', () => {
  const { html, menu, hrefs } = renderNavigation(true);
  assert.deepEqual(hrefs, [
    'index.html', 'videos.html', 'academy.html', 'my-learning.html',
  ]);
  for (const label of ['首页', '视频课程', '培训报名', '我的学习']) {
    assert.ok(menu.includes(`>${label}<`), `Missing portal navigation label: ${label}`);
  }
  assert.doesNotMatch(html, /class="nav-dropdown-menu"/, 'No competing product dropdown on the homepage');
  assert.doesNotMatch(menu, /data-nav-auth-only|\bhidden\b/, 'My Learning stays discoverable when signed out');
  assert.ok(html.includes('href="login.html"'), 'Original login route stays available');
  assert.ok(html.includes('href="register.html"'), 'Original registration route stays available');
});

test('app.js keeps legacy primary navigation on non-portal pages', () => {
  const { hrefs } = renderNavigation(false);
  assert.deepEqual(hrefs, [
    'index.html', 'community.html', 'moments.html', 'learning.html',
    'nephro-pro.html', 'events.html', 'my-learning.html',
  ]);
});

test('app.js explicitly honors hidden on only the relevant auth navigation elements', () => {
  const source = sourceSection('function injectTopbarExtraStyles(){', '// Populate member status badge');
  const styles = [];
  const context = { document: {
    getElementById: () => null,
    createElement(tag) { assert.equal(tag, 'style'); return {}; },
    head: { appendChild(style) { styles.push(style); } },
  } };
  vm.runInNewContext(`${source}\ninjectTopbarExtraStyles();`, context);
  assert.equal(styles.length, 1);
  const css = styles[0].textContent;
  const hiddenRule = css.match(/([^{}]+)\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/);
  assert.ok(hiddenRule, 'Auth hidden state must override author display rules');
  const selectors = hiddenRule[1].split(',').map(selector => selector.trim());
  assert.deepEqual(selectors.sort(), [
    '[data-nav-auth-only][hidden]', '[data-nav-bell][hidden]',
    '[data-nav-bell-badge][hidden]', '[data-nav-member-badge][hidden]',
  ].sort());
  assert.doesNotMatch(css, /(?:^|[,}])\s*\[hidden\]\s*\{/, 'Avoid a broad shared-site hidden override');
});

test('app.js shows or hides both desktop and drawer My links with authentication', async () => {
  const source = sourceSection('async function populateTopbarExtras(){', '// Mark order notifications as seen');
  for (const signedIn of [false, true]) {
    const myLinks = [{ hidden: false }, { hidden: false }];
    const elements = Object.fromEntries([
      '[data-nav-member-badge]', '[data-nav-bell]', '[data-nav-bell-badge]',
    ].map(selector => [selector, { hidden: false, dataset: {} }]));
    const query = {};
    for (const method of ['select', 'eq', 'or', 'order', 'limit', 'gt']) query[method] = () => query;
    query.then = resolveResult => Promise.resolve({ data: [], count: 0 }).then(resolveResult);
    const context = {
      document: {
        querySelector: selector => elements[selector],
        querySelectorAll(selector) { assert.equal(selector, '[data-nav-auth-only]'); return myLinks; },
      },
      isConfigured: () => true,
      getSession: async () => signedIn ? { user: { id: 'regression-test-user' } } : null,
      ensureSupabase: async () => {},
      supabase: { from: () => query },
      localStorage: { getItem: () => null },
      NOTIFY_SEEN_KEY: 'test-only',
      Date,
    };
    vm.runInNewContext(source, context);
    await context.populateTopbarExtras();
    assert.deepEqual(myLinks.map(link => link.hidden), [!signedIn, !signedIn]);
    assert.equal(elements['[data-nav-bell]'].hidden, !signedIn);
  }
});

test('app.js drawer retains auth attributes and focuses its real close button', () => {
  const drawer = sourceSection('function initMobileDrawer(){', 'function escapeAttr(str){');
  assert.match(drawer, /authOnly:\s*a\.hasAttribute\('data-nav-auth-only'\)/);
  assert.match(drawer, /hidden:\s*a\.hidden/);
  assert.match(drawer, /data-nav\$\{badgeAttr\}\$\{authAttr\}\$\{hiddenAttr\}/);
  assert.match(drawer, /querySelector\('button\[data-drawer-close\]'\)\?\.focus\?\.\(\)/);
});

function portalDrawerFixture() {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const bodyClasses = new Set();
  const document = {
    activeElement: null,
    body: { classList: {
      add: value => bodyClasses.add(value),
      remove: value => bodyClasses.delete(value),
    } },
    addEventListener: (type, listener) => documentListeners.set(type, listener),
  };
  const makeElement = () => ({
    attributes: {}, listeners: new Map(), hidden: false, visible: true, disabled: false, tabIndex: 0,
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    getClientRects() { return this.visible ? [{}] : []; },
    closest() { return this.hidden ? this : null; },
    focus() { document.activeElement = this; },
    blur() { if (document.activeElement === this) document.activeElement = null; },
  });
  const toggle = makeElement();
  const brand = makeElement();
  const closeButton = makeElement();
  const firstLink = makeElement();
  const lastLink = makeElement();
  const controls = [closeButton, firstLink, lastLink];
  const panel = { id: '', querySelectorAll: () => controls, contains: value => controls.includes(value) };
  const drawer = Object.assign(makeElement(), {
    dataset: {}, inert: false,
    querySelector: selector => selector === '.drawer-panel' ? panel : closeButton,
    querySelectorAll: () => [closeButton],
    contains: panel.contains,
  });
  const context = {
    document,
    window: { addEventListener: (type, listener) => windowListeners.set(type, listener) },
  };
  vm.runInNewContext(sourceSection('function initPortalMobileDrawer(', 'function escapeAttr(str){'), context);
  context.initPortalMobileDrawer(toggle, drawer, brand);
  const key = (value, shiftKey = false) => {
    const event = { key: value, shiftKey, prevented: false, preventDefault() { this.prevented = true; } };
    documentListeners.get('keydown')(event);
    return event;
  };
  return { document, toggle, brand, closeButton, firstLink, lastLink, controls, panel,
    drawer, bodyClasses, documentListeners, windowListeners, key };
}

test('homepage mobile drawer is inert when closed and restores focus after Escape', () => {
  const f = portalDrawerFixture();
  assert.equal(f.drawer.inert, true);
  assert.equal(f.drawer.attributes['aria-hidden'], 'true');
  assert.equal(f.toggle.attributes['aria-controls'], f.panel.id);
  f.toggle.listeners.get('click')();
  assert.equal(f.drawer.inert, false);
  assert.equal(f.drawer.attributes['aria-hidden'], 'false');
  assert.equal(f.toggle.attributes['aria-expanded'], 'true');
  assert.equal(f.document.activeElement, f.closeButton);
  assert.equal(f.bodyClasses.has('menu-open'), true);
  assert.equal(f.key('Escape').prevented, true);
  assert.equal(f.document.activeElement, f.toggle);
  assert.equal(f.drawer.inert, true);
  assert.equal(f.toggle.attributes['aria-expanded'], 'false');
  assert.equal(f.bodyClasses.has('menu-open'), false);
});

test('homepage mobile drawer traps keyboard focus and skips hidden controls', () => {
  const f = portalDrawerFixture();
  f.toggle.listeners.get('click')();
  f.lastLink.focus();
  assert.equal(f.key('Tab').prevented, true);
  assert.equal(f.document.activeElement, f.closeButton);
  assert.equal(f.key('Tab', true).prevented, true);
  assert.equal(f.document.activeElement, f.lastLink);
  f.lastLink.hidden = true;
  f.closeButton.focus();
  f.key('Tab', true);
  assert.equal(f.document.activeElement, f.firstLink);
  f.documentListeners.get('focusin')({ target: f.brand });
  assert.equal(f.document.activeElement, f.closeButton);
});

test('homepage mobile drawer closes when resized to desktop or following a real link', () => {
  const f = portalDrawerFixture();
  f.toggle.listeners.get('click')();
  f.toggle.visible = false;
  f.windowListeners.get('resize')();
  assert.equal(f.drawer.inert, true);
  assert.equal(f.document.activeElement, f.brand);
  f.toggle.visible = true;
  f.toggle.listeners.get('click')();
  f.drawer.listeners.get('click')({ target: { closest: () => f.firstLink } });
  assert.equal(f.drawer.inert, true);
  assert.equal(f.document.activeElement, null);
});

function htmlAttributes(html, name) {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'gi');
  return [...html.matchAll(pattern)].map(match => match[2]);
}

test('index.html local links, scripts, styles, and images point to existing exact-case files', () => {
  const references = [...htmlAttributes(indexHtml, 'href'), ...htmlAttributes(indexHtml, 'src')];
  const localFiles = new Set();
  for (const reference of references) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) continue;
    const pathname = reference.split(/[?#]/, 1)[0];
    if (!pathname) continue;
    const file = resolve(projectRoot, pathname.replace(/^\//, ''));
    assert.ok(!relative(projectRoot, file).startsWith('..'), `Reference escapes project: ${reference}`);
    assert.ok(existsSync(file), `Missing local homepage dependency: ${reference}`);
    assert.ok(statSync(file).isFile(), `Homepage dependency is not a file: ${reference}`);
    localFiles.add(pathname);
  }
  assert.ok(localFiles.has('portal-home.js'));
  assert.ok(localFiles.has('portal-home.css'));
  assert.ok(localFiles.has('videos.html'));
  assert.ok(localFiles.has('academy.html'));
  assert.ok(localFiles.has('my-learning.html'));
  assert.ok(localFiles.size >= 10, 'Scanner should inspect real homepage dependencies');
});

test('index.html has one H1, unique IDs, and valid same-page anchors', () => {
  assert.equal((indexHtml.match(/<h1(?:\s|>)/gi) || []).length, 1);
  const ids = htmlAttributes(indexHtml, 'id');
  assert.equal(new Set(ids).size, ids.length, 'Duplicate HTML IDs make anchors and labels ambiguous');
  for (const href of htmlAttributes(indexHtml, 'href').filter(value => value.startsWith('#') && value.length > 1)) {
    assert.ok(ids.includes(href.slice(1)), `Missing same-page anchor target: ${href}`);
  }
  assert.match(indexHtml, /<body\b[^>]*\bdata-portal-home\b/);
  assert.match(indexHtml, /<a\b[^>]*href="#main-content"/);
});

test('index.html essential learning, ecosystem, and legal routes remain available without JavaScript', () => {
  const hrefs = new Set(htmlAttributes(indexHtml, 'href'));
  for (const href of [
    'academy.html', 'videos.html', 'my-learning.html', 'about.html',
    'experts-cn.html', 'experts-intl.html', 'partners.html',
    'privacy.html', 'terms.html', 'disclaimer.html',
    'mailto:china@kidneysphere.com',
  ]) {
    assert.ok(hrefs.has(href), `Important static portal route missing: ${href}`);
  }
  assert.match(indexHtml, /<button\b[^>]*data-copy-contact[^>]*\bhidden\b[^>]*>/);
  assert.match(indexHtml, /data-contact-status[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(indexHtml, /src=["']trainingPrograms\.js/);
});

test('index.html removes article, moment, research marketing, and conference homepage modules', () => {
  assert.doesNotMatch(indexHtml, /data-home-(?:articles|moments)|id="home(?:LatestSection|Articles|Moments)"/);
  assert.doesNotMatch(indexHtml, /data-conference-status|id="research"|id="platforms"/);
  assert.doesNotMatch(indexHtml, /预约科研演示|30天免费试用|会议进行中/);
  assert.doesNotMatch(indexHtml, /<iframe\b|<video\b/i, 'Homepage should not initialize the player or preload video streams');
});

test('index.html keeps all four requested ecosystem categories and accessible initial state', () => {
  assert.match(indexHtml, /data-home-showcase(?:\s|>)/);
  const buttons = [...indexHtml.matchAll(/<button\b[^>]*data-home-showcase-tab="([^"]+)"[^>]*>[\s\S]*?<\/button>/g)];
  assert.deepEqual(buttons.map(match => match[1]), ['experts', 'flagship', 'co_building', 'partners']);
  assert.match(buttons[0][0], /aria-pressed="true"/);
  for (const button of buttons.slice(1)) assert.match(button[0], /aria-pressed="false"/);
  assert.match(indexHtml, /data-home-showcase-stats/);
  assert.match(indexHtml, /data-home-showcase-cards/);
  for (const label of ['证据与合作生态', '核心专家', '旗舰中心', '共建单位', '合作单位']) {
    assert.ok(indexHtml.includes(label), `Preserve requested ecosystem label: ${label}`);
  }
});

test('homepage styles protect touch input, safe areas, visible focus, and reduced motion', () => {
  assert.match(indexHtml, /name="viewport"[^>]*content="[^"]*width=device-width[^\"]*"/);
  assert.doesNotMatch(indexHtml, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:\D|$)/i);
  assert.match(portalCss, /env\(safe-area-inset-bottom(?:\s*,[^)]*)?\)/, 'Bottom shortcut bar respects the home indicator');
  assert.match(portalCss, /min-height:\s*(?:4[4-9]|[5-9]\d)px/, 'Touchable controls need at least 44 px height');
  assert.match(portalCss, /focus-visible/);
  assert.match(portalCss, /prefers-reduced-motion:\s*reduce/);
  const mobileBreakpoints = [...portalCss.matchAll(/@media\s*\([^)]*max-width:\s*(\d+)px/g)].map(match => Number(match[1]));
  assert.ok(mobileBreakpoints.some(width => width >= 768 && width <= 800), 'Tablet/mobile rules must cover the 768 px test viewport');
  assert.ok(mobileBreakpoints.some(width => width >= 430 && width <= 600), 'Single-column phone rules must cover the 430 px test viewport');
  assert.ok(mobileBreakpoints.some(width => width >= 320 && width < 360), 'Small-phone adjustments must cover 320 px');
  assert.doesNotMatch(portalCss, /\.portal-home[^{}]*\{[^}]*min-width:\s*(?:[4-9]\d{2}|\d{4,})px/);
});

test('homepage local CSS dependencies exist and contain no raw stream references', () => {
  for (const match of portalCss.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)) {
    const url = match[1];
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url)) continue;
    const file = resolve(projectRoot, url.split(/[?#]/, 1)[0].replace(/^\//, ''));
    assert.ok(!relative(projectRoot, file).startsWith('..'), `Stylesheet reference escapes project: ${url}`);
    assert.ok(existsSync(file) && statSync(file).isFile(), `Missing stylesheet asset: ${url}`);
  }
  assert.doesNotMatch(indexHtml + portalCss, /(?:source_url|aliyun_vid)\s*[=:]|https?:[^\s"']+\.(?:m3u8|mp4)(?:[?"'\s]|$)/i);
});

test('video catalogue normalization discards disabled, deleted, and invalid rows', () => {
  for (const row of [
    null, false, 'not a record', {}, { id: 'v1' }, { title: '课程' },
    { id: ' ', title: '课程' }, { id: 'v1', title: ' ' },
    { id: 'v1', title: '课程', enabled: false },
    { id: 'v1', title: '课程', deleted_at: '2026-09-13' },
  ]) assert.equal(normalizePortalVideo(row), null, `Unexpected visible row: ${JSON.stringify(row)}`);
  const normalized = normalizePortalVideo({
    id: 42, title: '  课程名称  ', speaker: '  教师  ', category: 'glomcon',
    is_paid: 'false', membership_accessible: 0,
  });
  assert.equal(normalized.id, '42');
  assert.equal(normalized.title, '课程名称');
  assert.equal(normalized.speaker, '教师');
  assert.equal(normalized.category, 'glom');
  assert.equal(normalized.source, 'glomcon');
  assert.equal(normalized.is_paid, null, 'Never coerce the string false to a permission label');
  assert.equal(normalized.membership_accessible, null);
});

test('video catalogue retains only whitelisted public metadata, never playback credentials', () => {
  const normalized = normalizePortalVideo({
    id: 'v1', title: '课程', category: 'icu', enabled: true,
    source_url: 'https://private.invalid/secret.m3u8', mp4_url: 'private.mp4',
    aliyun_vid: 'private-video-id', play_auth: 'private-play-token',
    bvid: 'BV1abc123456', product_id: 'private-product-id', token: 'private-token',
  });
  assert.deepEqual(Object.keys(normalized).sort(), [
    'id', 'title', 'speaker', 'category', 'source', 'is_paid',
    'membership_accessible', 'created_at', 'origin',
  ].sort());
  assert.doesNotMatch(JSON.stringify(normalized), /private/);
});

test('watch links keep the original playback gate and encode hostile IDs instead of passing sources', () => {
  const source = { id: 'course&source_url=secret#x"<>', origin: 'database', bvid: 'BV1abc123456', aliyun_vid: 'secret' };
  const url = new URL(portalWatchUrl(source), 'https://example.invalid/');
  assert.equal(url.pathname, '/watch.html');
  assert.equal(url.searchParams.get('id'), source.id);
  assert.deepEqual([...url.searchParams.keys()], ['id']);
  assert.equal(url.hash, '');
  const staticVideo = { id: 'free-1', origin: 'static', bvid: 'BV1abc123456' };
  assert.equal(portalWatchUrl(staticVideo), 'watch.html?id=free-1&bvid=BV1abc123456');
  for (const bvid of ['javascript:alert(1)', 'BV1x&source=secret', 'BV1x" onclick="alert(1)']) {
    assert.equal(portalWatchUrl({ ...staticVideo, bvid }), 'watch.html?id=free-1');
  }
});

test('video access badges describe catalogue categories without claiming a visitor is unlocked', () => {
  assert.deepEqual(portalVideoAccess({ is_paid: false }), { kind: 'free', label: '免费课程' });
  assert.deepEqual(portalVideoAccess({ source: 'glomcon', is_paid: false }), { kind: 'member', label: '会员课程' });
  assert.deepEqual(portalVideoAccess({ category: 'glomcon' }), { kind: 'member', label: '会员课程' });
  assert.deepEqual(portalVideoAccess({ is_paid: true, membership_accessible: true }), { kind: 'member', label: '会员课程' });
  assert.deepEqual(portalVideoAccess({ is_paid: true, membership_accessible: false }), { kind: 'paid', label: '付费课程' });
  assert.deepEqual(portalVideoAccess({}), { kind: 'unknown', label: '以课程页为准' });
  for (const video of [{}, { is_paid: true }, { source: 'glomcon' }, { is_paid: false }]) {
    assert.doesNotMatch(portalVideoAccess(video).label, /已解锁|已购买|继续观看|无需登录/);
  }
});

const sampleCatalogue = () => mergePortalVideos([
  { id: 'static-1', title: 'IgA 进展', speaker: '教师甲', category: 'glomcon', bvid: 'BV1abc123456', created_at: '2026-01-01' },
  { id: 'shared', title: '旧课程名称', category: 'glom', created_at: '2026-01-02' },
], [
  { id: 'paid-icu', title: 'CRRT 抗凝', speaker: '刘松', category: 'icu', source: 'kidneysphere', is_paid: true, membership_accessible: false, created_at: '2026-09-13' },
  { id: 'paid-tx', title: '移植住院管理', speaker: 'Teacher Smith', category: 'tx', source: 'kidneysphere', is_paid: true, membership_accessible: false, created_at: '2026-09-12' },
  { id: 'shared', title: '数据库课程名称', category: 'glom', created_at: '2026-09-11' },
  { id: 'free-path', title: '光镜基础', speaker: '教师乙', category: 'path', is_paid: false, created_at: '2026-09-10' },
]);

test('merged catalogue prioritizes newer database rows and includes non-GlomCon paid videos', () => {
  const videos = sampleCatalogue();
  assert.equal(videos.length, 5);
  assert.equal(videos[0].id, 'paid-icu');
  assert.equal(videos.find(video => video.id === 'shared').title, '数据库课程名称');
  assert.equal(videos.find(video => video.id === 'shared').origin, 'database');
  assert.equal(videos.find(video => video.id === 'static-1').bvid, 'BV1abc123456');
  assert.ok(videos.some(video => video.id === 'paid-tx'));
  assert.equal(new Set(videos.map(video => video.id)).size, videos.length);
});

test('video search matches Chinese titles, teachers, specialties, sources, and normalized English', () => {
  const videos = sampleCatalogue();
  assert.deepEqual(filterPortalVideos(videos, { query: 'ＣＲＲＴ 刘松' }).map(video => video.id), ['paid-icu']);
  assert.deepEqual(filterPortalVideos(videos, { query: 'teacher SMITH', category: 'tx' }).map(video => video.id), ['paid-tx']);
  assert.deepEqual(filterPortalVideos(videos, { query: '肾域原创' }).map(video => video.id), ['paid-icu', 'paid-tx']);
  assert.deepEqual(filterPortalVideos(videos, { query: 'GlomCon 中国' }).map(video => video.id), ['static-1']);
  assert.deepEqual(filterPortalVideos(videos, { query: '抗凝', category: 'tx' }), []);
  assert.deepEqual(filterPortalVideos(videos, { query: '<img onerror=alert(1)>' }), []);
});

test('homepage selection is compact by default and preserves the complete source list for filtering', () => {
  const videos = sampleCatalogue();
  const before = JSON.stringify(videos);
  const selected = selectPortalVideos(videos);
  assert.equal(selected.length, 3);
  assert.equal(new Set(selected.map(video => video.category)).size, 3);
  assert.equal(selectPortalVideos(videos, { limit: 99 }).length, 3);
  assert.equal(selectPortalVideos(videos, { limit: 0 }).length, 0);
  assert.equal(selectPortalVideos(videos, { limit: -1 }).length, 0);
  assert.deepEqual(selectPortalVideos(videos, { category: 'path' }).map(video => video.id), ['free-path']);
  assert.deepEqual(selectPortalVideos(videos, { query: '肾域原创' }).map(video => video.id), ['paid-icu', 'paid-tx']);
  assert.equal(JSON.stringify(videos), before, 'Filtering and selection must not mutate the catalogue');
});

function metadataProvider(result = { data: [], error: null }) {
  const calls = [];
  const query = {};
  for (const method of ['select', 'eq', 'is', 'order', 'limit', 'abortSignal']) {
    query[method] = (...args) => { calls.push([method, ...args]); return query; };
  }
  query.then = (onResult, onError) => Promise.resolve(result).then(onResult, onError);
  const provider = {
    isConfigured: () => true,
    ensureSupabase: async () => {},
    supabase: { from(table) { calls.push(['from', table]); return query; } },
  };
  return { calls, query, provider };
}

test('metadata loader only reads enabled public catalogue fields and never calls auth or entitlement APIs', async () => {
  const f = metadataProvider({ data: [
    { id: 'valid', title: '课程', enabled: true, deleted_at: null },
    { id: 'disabled', title: '隐藏课程', enabled: false },
    { id: 'deleted', title: '删除课程', enabled: true, deleted_at: '2026-09-01' },
  ], error: null });
  const result = await loadPortalVideoMetadata({ loadClient: async () => f.provider });
  assert.deepEqual(result.videos.map(video => video.id), ['valid']);
  assert.equal(result.capped, false);
  assert.deepEqual(f.calls[0], ['from', 'learning_videos']);
  const fields = f.calls.find(call => call[0] === 'select')[1].split(',').sort();
  assert.deepEqual(fields, [
    'id', 'title', 'speaker', 'category', 'source', 'is_paid',
    'membership_accessible', 'created_at', 'enabled', 'deleted_at',
  ].sort());
  assert.ok(f.calls.some(call => call[0] === 'eq' && call[1] === 'enabled' && call[2] === true));
  assert.ok(f.calls.some(call => call[0] === 'is' && call[1] === 'deleted_at' && call[2] === null));
  assert.ok(f.calls.some(call => call[0] === 'limit' && call[1] === 200));
  assert.doesNotMatch(fields.join(','), /source_url|mp4_url|aliyun_vid|play_auth|token|\*/);
});

test('metadata loader marks capped results and reports network/configuration errors', async () => {
  const f = metadataProvider({ data: Array.from({ length: 200 }, (_, i) => ({ id: String(i), title: '课程', enabled: true })), error: null });
  assert.equal((await loadPortalVideoMetadata({ loadClient: async () => f.provider })).capped, true);
  const errors = [
    { isConfigured: () => false },
    { isConfigured: () => true, ensureSupabase: async () => {}, supabase: null },
    metadataProvider({ data: null, error: null }).provider,
    metadataProvider({ data: [], error: new Error('Network unavailable') }).provider,
  ];
  for (const provider of errors) await assert.rejects(() => loadPortalVideoMetadata({ loadClient: async () => provider }));
});

test('metadata loader times out rather than leaving mobile users waiting indefinitely', async () => {
  const f = metadataProvider();
  f.query.then = () => new Promise(() => {});
  await assert.rejects(
    () => loadPortalVideoMetadata({ loadClient: async () => f.provider, timeoutMs: 5 }),
    /timed out/,
  );
  const signal = f.calls.find(call => call[0] === 'abortSignal')?.[1];
  if (signal) assert.equal(signal.aborted, true);
});

test('video cards escape user-provided text through DOM APIs rather than HTML interpolation', () => {
  const source = utilitySource.slice(utilitySource.indexOf('function makeVideoCard('), utilitySource.indexOf('export async function initPortalVideos('));
  assert.ok(source.length > 0, 'Card renderer must exist');
  assert.match(source, /title\.textContent\s*=\s*video\.title/);
  assert.match(source, /speaker\.textContent\s*=/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(utilitySource, /supabase\.auth|\.rpc\(|\.from\(['"](?:orders|entitlements|profiles)['"]\)/);
});

function homeContext({ selectors = {}, tabs = [], provider = {} } = {}) {
  const context = {
    URL,
    document: {
      baseURI: 'https://kidneysphere.com/',
      querySelector: selector => selectors[selector] || null,
      querySelectorAll: () => tabs,
    },
    window: {
      requestAnimationFrame: callback => callback(),
      addEventListener() {},
      getComputedStyle: () => ({ columnGap: '12px' }),
      matchMedia: () => ({ matches: false }),
    },
    supabase: null,
    ensureSupabase: async () => {},
    isConfigured: () => false,
    ...provider,
  };
  const source = homeSource.replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];\s*/, '')
    .replace(/\nloadHomeShowcase\(\);\s*$/, '\n');
  vm.runInNewContext(source, context);
  return context;
}

test('ecosystem cards use compact native disclosures with matching aria-controls and hidden descriptions', () => {
  const context = homeContext();
  const html = context.renderShowcaseCard({
    title: '王医生｜示例大学', category: 'experts_cn', description: '完整简介\n第二段',
    image_url: 'https://example.invalid/expert.png',
  }, 'experts', 3);
  assert.match(html, /<article\b[^>]*class="home-showcase-card"/);
  assert.match(html, /<button\b[^>]*type="button"[^>]*data-showcase-toggle[^>]*aria-expanded="false"/);
  const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
  assert.equal(controls, 'home-showcase-experts-3-description');
  assert.ok(html.includes(`id="${controls}" hidden>`));
  assert.match(html, /<div class="institution">示例大学<\/div>/);
  assert.match(html, /完整简介<br\/>第二段/);
  assert.match(html, /width="80" height="80"/);
  assert.match(html, /loading="lazy"/);
  assert.doesNotMatch(html, /<a\b[^>]*>[\s\S]*<button[\s\S]*<\/a>/, 'Do not nest a disclosure button in a link');
});

test('ecosystem card rendering escapes all text and rejects script/data URLs', () => {
  const context = homeContext();
  const html = context.renderShowcaseCard({
    title: '<img src=x onerror=alert(1)>｜Fake "University"',
    description: '<script>alert(1)</script>', category: 'experts_intl',
    link: 'javascript:alert(1)', image_url: 'data:image/svg+xml,<svg onload=alert(1)>',
  }, 'experts', 1);
  assert.match(html, /href="experts-intl\.html"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|<img|href="javascript:|src="data:/);
  assert.match(html, /Fake &quot;University&quot;/);
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'vbscript:msgbox(1)']) {
    assert.equal(context.safeShowcaseUrl(url, 'about.html'), 'about.html');
  }
  assert.equal(context.safeShowcaseUrl('experts-cn.html', ''), 'experts-cn.html');
  const external = context.renderShowcaseCard({ title: '机构', link: 'https://example.invalid/info' }, 'partners', 0);
  assert.match(external, /target="_blank" rel="noopener noreferrer"/);
});

test('ecosystem render keeps stable domestic/international ordering and avoids invented institutions', () => {
  const context = homeContext();
  const cn = [{ title: 'CN1' }, { title: 'CN2' }];
  const intl = [{ title: 'INTL1' }];
  assert.equal(JSON.stringify(context.buildExpertList(cn, intl)), JSON.stringify([cn[0], intl[0], cn[1]]));
  const html = context.renderShowcaseCard({ title: 'Dr. Example', description: 'A supplied biography.' }, 'experts', 0);
  assert.doesNotMatch(html, /class="institution"/);
  const co = context.renderShowcaseCard({ title: '示例医院肾脏内科', description: 'Unused prose' }, 'co_building', 0);
  assert.match(co, />示例医院肾内科<\/a>/);
  assert.doesNotMatch(co, /class="desc"|data-showcase-toggle/);
});

function showcaseFixture(provider) {
  const makeElement = () => ({
    attributes: {}, dataset: {}, listeners: new Map(), hidden: false,
    textContent: '', innerHTML: '', scrollWidth: 1000, clientWidth: 400, scrollLeft: 0,
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    classList: { toggle() {} },
    querySelector: () => null,
    scrollTo(options) { this.scrollLeft = options.left; },
  });
  const cards = makeElement();
  const stats = makeElement();
  const actions = makeElement();
  const status = makeElement();
  const prev = makeElement();
  const next = makeElement();
  const tabs = ['experts', 'flagship', 'co_building', 'partners'].map(kind => {
    const tab = makeElement(); tab.attributes['data-home-showcase-tab'] = kind; return tab;
  });
  const selectors = {
    '[data-home-showcase]': makeElement(),
    '[data-home-showcase-cards]': cards,
    '[data-home-showcase-stats]': stats,
    '[data-home-showcase-actions]': actions,
    '[data-home-showcase-status]': status,
    '[data-home-showcase-prev]': prev,
    '[data-home-showcase-next]': next,
  };
  return { context: homeContext({ selectors, tabs, provider }), cards, stats, actions, status, tabs, prev, next };
}

test('ecosystem disclosure really hides/unhides the biography without changing scroll or other cards', () => {
  const f = showcaseFixture();
  const description = { hidden: true };
  const attributes = { 'aria-expanded': 'false' };
  const classes = new Set();
  const card = {
    dataset: { kind: 'experts' },
    querySelector: selector => selector === '.desc' ? description : { textContent: '王医生' },
    classList: { toggle(name, active) { active ? classes.add(name) : classes.delete(name); } },
  };
  const button = {
    textContent: '展开简介',
    closest: () => card,
    getAttribute: name => attributes[name],
    setAttribute: (name, value) => { attributes[name] = value; },
  };
  f.cards.contains = element => element === button;
  f.cards.scrollLeft = 200;
  f.context.bindShowcaseExpand();
  const click = f.cards.listeners.get('click');
  click({ target: { closest: () => button } });
  assert.equal(description.hidden, false);
  assert.equal(attributes['aria-expanded'], 'true');
  assert.equal(attributes['aria-label'], '收起王医生的简介');
  assert.equal(button.textContent, '收起简介');
  assert.equal(classes.has('expanded'), true);
  assert.equal(f.cards.scrollLeft, 200);
  click({ target: { closest: () => button } });
  assert.equal(description.hidden, true);
  assert.equal(attributes['aria-expanded'], 'false');
  assert.equal(button.textContent, '展开简介');
  assert.equal(f.cards.scrollLeft, 200);
});

test('empty or failed ecosystem tabs stay usable and reset their own horizontal scroll', () => {
  const f = showcaseFixture();
  f.cards.scrollLeft = 500;
  f.context.renderShowcaseState('partners', { rows: [], error: true });
  assert.match(f.status.textContent, /合作单位暂时未能加载/);
  assert.equal(f.status.hidden, false);
  assert.equal(f.cards.scrollLeft, 0);
  assert.equal(f.cards.attributes['aria-busy'], 'false');
  assert.ok(f.actions.innerHTML.includes('partners.html'));
  assert.equal(f.tabs[3].attributes['aria-pressed'], 'true');
  assert.equal(f.tabs.every(tab => tab.disabled === false), true);
  f.context.renderShowcaseState('flagship', { rows: [] });
  assert.match(f.status.textContent, /旗舰中心暂无展示内容/);
  assert.ok(f.actions.innerHTML.includes('flagship.html'));
});

test('ecosystem module makes no requests when its DOM is absent and does not restore legacy feeds or touch interception', async () => {
  let calls = 0;
  const context = homeContext({ provider: {
    isConfigured: () => true,
    ensureSupabase: async () => { calls += 1; },
    supabase: { from() { calls += 1; throw new Error('No request expected'); } },
  } });
  await context.loadHomeShowcase();
  assert.equal(calls, 0);
  assert.doesNotMatch(homeSource, /\.from\(['"](?:articles|moments|profiles)['"]\)/);
  assert.doesNotMatch(homeSource, /setInterval\(|addEventListener\(['"]touchmove/);
});

test('ecosystem partial failures preserve other categories and do not fabricate complete expert totals', async () => {
  const requested = [];
  const provider = {
    isConfigured: () => true,
    ensureSupabase: async () => {},
    supabase: { from(table) {
      assert.equal(table, 'about_showcase');
      let category;
      const query = {
        select: () => query,
        eq(name, value) { assert.equal(name, 'category'); category = value; requested.push(value); return query; },
        order: () => query,
        then(onResult, onError) {
          return Promise.resolve(category === 'experts_intl'
            ? { data: null, error: new Error('Catalogue temporarily unavailable') }
            : { data: [{ id: category, title: `Existing ${category}`, category }], error: null }
          ).then(onResult, onError);
        },
      };
      return query;
    } },
  };
  const f = showcaseFixture(provider);
  await f.context.loadHomeShowcase();
  assert.deepEqual(requested.sort(), ['flagship', 'co_building', 'partners', 'experts_cn', 'experts_intl'].sort());
  assert.match(f.stats.innerHTML, /核心专家 —/);
  assert.match(f.stats.innerHTML, /旗舰中心 1/);
  assert.match(f.stats.innerHTML, /共建单位 1/);
  assert.match(f.stats.innerHTML, /合作单位 1/);
  assert.match(f.status.textContent, /部分专家资料暂时未能加载/);
  assert.match(f.cards.innerHTML, /Existing experts_cn/);
  f.tabs[1].listeners.get('click')();
  assert.match(f.cards.innerHTML, /Existing flagship/);
  assert.equal(f.status.hidden, true);
});

test('homepage module imports resolve to existing files with exact case', () => {
  for (const [name, source] of [['portal-home.js', utilitySource], ['home.js', homeSource], ['app.js', appSource]]) {
    const imports = [...source.matchAll(/(?:from\s*|import\(\s*)['"](\.[^'"]+)['"]/g)].map(match => match[1]);
    for (const reference of imports) {
      const path = reference.split(/[?#]/, 1)[0];
      const file = resolve(projectRoot, dirname(name), path);
      assert.ok(existsSync(file) && statSync(file).isFile(), `Missing ${name} module import: ${reference}`);
    }
  }
});

test('mobile bottom navigation exposes exactly video, training, and My Learning without authentication hiding', () => {
  const bar = indexHtml.match(/<nav\b[^>]*class="portal-mobile-bar"[^>]*>[\s\S]*?<\/nav>/)?.[0];
  assert.ok(bar, 'A semantic bottom navigation must be present');
  assert.match(bar, /aria-label="手机学习快捷入口"/);
  assert.deepEqual(htmlAttributes(bar, 'href'), ['videos.html', 'academy.html', 'my-learning.html']);
  for (const label of ['视频课程', '培训报名', '我的学习']) assert.ok(bar.includes(`>${label}<`));
  assert.doesNotMatch(bar, /data-nav-auth-only|\shidden(?:\s|=|>)|data-logout/);
  assert.equal((bar.match(/<svg\b/g) || []).length, 3);
  assert.equal((bar.match(/<svg\b[^>]*aria-hidden="true"/g) || []).length, 3);
  assert.match(portalCss, /\.portal-mobile-bar\s*\{[^}]*position:\s*fixed;[^}]*bottom:\s*0;/);
  assert.match(portalCss, /\.portal-mobile-bar\s+a\s*\{[^}]*min-height:\s*(?:4[4-9]|[5-9]\d)px/);
  assert.match(portalCss, /\.footer\[data-custom-footer\]\s*\{[^}]*padding-bottom:\s*calc\([^;]*env\(safe-area-inset-bottom\)/);
  assert.match(portalCss, /\.portal-home\.menu-open\s+\.portal-mobile-bar\s*\{\s*display:\s*none/);
});

test('homepage cross-page anchors and static search action point to real destinations', () => {
  const references = [...htmlAttributes(indexHtml, 'href'), ...htmlAttributes(indexHtml, 'action')];
  let crossPageAnchors = 0;
  for (const reference of references) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference) || !reference.includes('#')) continue;
    const [route, rawAnchor] = reference.split('#');
    if (!rawAnchor) continue;
    const pathname = route.split('?')[0];
    const target = pathname ? readProjectFile(pathname.replace(/^\//, '')) : indexHtml;
    const anchor = decodeURIComponent(rawAnchor);
    const ids = htmlAttributes(target, 'id');
    const names = htmlAttributes(target, 'name');
    assert.ok(ids.includes(anchor) || names.includes(anchor), `Missing destination anchor: ${reference}`);
    if (pathname) crossPageAnchors += 1;
  }
  assert.ok(crossPageAnchors >= 2, 'Check both training-projects and pricing anchors');
  assert.match(indexHtml, /<form\b[^>]*data-portal-search[^>]*action="#videos"/);
  assert.match(indexHtml, /<input\b[^>]*id="portal-search-input"[^>]*name="q"[^>]*type="search"/);
  assert.match(portalCss, /\.portal-search input\s*\{[^}]*font-size:\s*16px/, 'A 16 px search field avoids unwanted iPhone input zoom');
});

test('compact secondary resource disclosure uses matching styled class and touch-sized summary', () => {
  assert.match(indexHtml, /<details\b[^>]*class="portal-other-links"/);
  assert.match(portalCss, /\.portal-home\s+\.portal-other-links\s+summary\s*\{[^}]*min-height:\s*(?:4[4-9]|[5-9]\d)px/);
  assert.doesNotMatch(portalCss, /\.portal-footer-other-links(?:\s|\[|\{)/, 'Avoid a stale class that leaves the real disclosure unstyled');
});

test('hidden expert descriptions and reset controls stay genuinely hidden despite component display rules', () => {
  assert.match(portalCss, /\.portal-home\s+\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;?\s*\}/);
  assert.match(indexHtml, /<button\b[^>]*data-portal-video-reset[^>]*\bhidden\b/);
  assert.match(homeSource, /description\.hidden\s*=\s*!expanded/);
});

function cssRuleFor(selector) {
  const source = portalCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1].split(',').some(value => value.trim() === selector));
  assert.ok(rules.length, `Missing scoped homepage rule: ${selector}`);
  return rules.map(match => match[2]).join(';');
}

function cssHex(rule, property) {
  const pattern = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*(#[0-9a-f]{3,6})(?:\\s|;|$)`, 'gi');
  const matches = [...rule.matchAll(pattern)];
  assert.ok(matches.length, `Expected an explicit ${property} color in: ${rule}`);
  return matches[matches.length - 1][1];
}

function contrastRatio(foreground, background) {
  const luminance = color => {
    const hex = color.length === 4 ? [...color.slice(1)].map(value => value + value).join('') : color.slice(1);
    const values = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('light-theme account menu keeps logout legible over an explicitly overridden footer background', () => {
  const background = cssHex(cssRuleFor('.portal-home .user-dropdown .ud-footer'), 'background');
  const foreground = cssHex(cssRuleFor('.portal-home .user-dropdown .ud-danger'), 'color');
  assert.ok(contrastRatio(foreground, background) >= 4.5, 'Logout text must remain readable after converting the menu to a light theme');
  const summary = cssRuleFor('.portal-home .user-dropdown summary');
  assert.match(summary, /min-height:\s*(?:4[4-9]|[5-9]\d)px/);
});

test('light-theme membership links override old inline pale colors without changing link destinations', () => {
  for (const selector of [
    '.portal-home .user-dropdown a[href^="checkout.html?product=MEMBERSHIP-"]',
    '.portal-home .user-dropdown a[href="videos.html?source=glomcon"]',
  ]) {
    const rule = cssRuleFor(selector);
    assert.match(rule, /color:\s*#[0-9a-f]+\s*!important/i, 'A normal rule cannot override the legacy inline color');
    assert.ok(contrastRatio(cssHex(rule, 'color'), '#ffffff') >= 4.5, `Insufficient membership link contrast: ${selector}`);
  }
});

test('scoped member badge state colors override later shared style injection on light backgrounds', () => {
  for (const state of ['cta', 'expiring']) {
    const rule = cssRuleFor(`.portal-home .nav-member-badge[data-state="${state}"]`);
    assert.ok(contrastRatio(cssHex(rule, 'color'), '#eef5ff') >= 4.5, `Insufficient member badge state contrast: ${state}`);
  }
});

test('compact homepage search keeps its submit action free of the shared voice overlay', () => {
  const loader = appSource.slice(appSource.indexOf('(function loadVoiceModule(){'));
  assert.match(loader, /hasAttribute\('data-portal-home'\)\) return;[\s\S]*shared\/ks-voice\.js/);
  assert.match(indexHtml, /<button type="submit" aria-label="搜索视频">搜索<\/button>/);
});
