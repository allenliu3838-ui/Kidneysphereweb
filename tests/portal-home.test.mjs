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

// The repository is a static site, not a type:module Node package. A data URL
// tests the actual module exports without changing package metadata or running
// browser initialization (Node has no document).
const { conferenceState, updateConferenceStatuses, initContactCopy } = await import(
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

test('app.js portal navigation provides the requested primary routes in order', () => {
  const { html, menu, hrefs } = renderNavigation(true);
  assert.deepEqual(hrefs, [
    'index.html', 'learning.html', 'community.html', 'research-pilot.html',
    'events.html', 'about.html', 'my-learning.html',
  ]);
  for (const label of ['首页', '学术学习', '病例社区', '科研合作', '会议活动', '关于肾域']) {
    assert.ok(menu.includes(`>${label}<`), `Missing portal navigation label: ${label}`);
  }
  const dropdown = html.match(/<div class="nav-dropdown-menu">[\s\S]*?<\/div>/)?.[0];
  assert.ok(dropdown);
  for (const href of ['nephro-pro.html', 'moments.html']) {
    assert.ok(dropdown.includes(`href="${href}"`), `Missing secondary route: ${href}`);
  }
  assert.match(menu, /<a\b[^>]*data-nav-auth-only[^>]*\bhidden\b[^>]*>/);
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
  assert.ok(localFiles.has('research-pilot.html'));
  assert.ok(localFiles.size >= 15, 'Scanner should inspect real homepage dependencies');
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

test('index.html important portal routes remain available without JavaScript', () => {
  const hrefs = new Set(htmlAttributes(indexHtml, 'href'));
  for (const href of [
    'academy.html', 'learning.html', 'videos.html', 'nephro-pro.html',
    'community.html', 'events.html', 'about.html', 'research-pilot.html',
    'research-pilot.html#contact', 'privacy.html', 'terms.html', 'disclaimer.html',
    'https://kidneysphereregistry.cn/', 'https://kidneyspheredoctorapp.cn/',
    'https://kidneyspherefollowup.cn/', 'https://kidneysphereremote.cn/',
    'mailto:china@kidneysphere.com',
  ]) {
    assert.ok(hrefs.has(href), `Important static portal route missing: ${href}`);
  }
  assert.match(indexHtml, /<button\b[^>]*data-copy-contact[^>]*\bhidden\b[^>]*>/);
  assert.match(indexHtml, /data-contact-status[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotMatch(indexHtml, /src=["']trainingPrograms\.js/);
});
