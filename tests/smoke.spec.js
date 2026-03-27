/**
 * Playwright Smoke Tests: Production Security & SEO
 *
 * Verifies:
 * 1. Admin/internal pages NOT accessible to anonymous users
 * 2. Posting forms NOT visible to anonymous users
 * 3. Public pages render core content
 * 4. Sensitive keywords don't appear in public HTML
 * 5. SEO meta tags correctly set
 * 6. Article detail page has SSR content (Edge Function)
 *
 * Run: npx playwright test tests/smoke.spec.js
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:8888';

// ─── Admin / Internal routes: anonymous must NOT see admin content ───

const ADMIN_ROUTES = [
  '/admin',
  '/admin.html',
  '/admin-commerce',
  '/admin-commerce.html',
  '/article-editor',
  '/article-editor.html',
];

const FORBIDDEN_KEYWORDS = [
  '新建项目',
  '平台管理后台',
  '医生认证审核',
  '订阅申请审核',
  '悬赏收款审核',
  '编辑此文章',
  '仅管理员可使用',
  '全部（含草稿）',
  '邀请码管理',
  '版主管理',
  '权限与管理员',
  '商品中心',
  '订单核销中心',
  '权益管理',
  '审计日志',
];

for (const route of ADMIN_ROUTES) {
  test(`Admin route ${route}: no admin content in HTML`, async ({ page }) => {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    const html = await page.content();
    for (const kw of FORBIDDEN_KEYWORDS) {
      expect(html).not.toContain(kw);
    }
    expect(html).toContain('noindex');
  });
}

// ─── Posting forms hidden from anonymous ───

test('post-case.html: form hidden from anonymous', async ({ request }) => {
  const res = await request.get(`${BASE}/post-case`);
  const html = await res.text();
  // Auth gate should be visible
  expect(html).toContain('postAuthGate');
  // Form should be hidden
  expect(html).toContain('id="postFormWrap" hidden');
  // Should NOT expose form fields directly
  expect(html).not.toMatch(/<form id="caseForm"[^>]*>(?!.*hidden)/);
});

test('moments.html: composer hidden from anonymous', async ({ request }) => {
  const res = await request.get(`${BASE}/moments`);
  const html = await res.text();
  // Auth gate should be visible
  expect(html).toContain('momentsAuthGate');
  // Composer should be hidden
  expect(html).toContain('id="composer" hidden');
});

// ─── Public pages: should render core content ───

const PUBLIC_PAGES = [
  { path: '/', mustContain: ['肾域', '临床研究'] },
  { path: '/about', mustContain: ['肾域'] },
  { path: '/articles', mustContain: ['文献库'] },
  { path: '/community', mustContain: ['社区讨论'] },
  { path: '/events', mustContain: ['会议'] },
  { path: '/privacy', mustContain: ['隐私'] },
  { path: '/terms', mustContain: ['用户协议'] },
];

for (const { path: p, mustContain } of PUBLIC_PAGES) {
  test(`Public page ${p} contains core content`, async ({ request }) => {
    const res = await request.get(`${BASE}${p}`);
    const html = await res.text();
    for (const text of mustContain) {
      expect(html).toContain(text);
    }
  });
}

// ─── SEO: sitemap and robots.txt ───

test('robots.txt is accessible and well-formed', async ({ request }) => {
  const res = await request.get(`${BASE}/robots.txt`);
  expect(res.status()).toBe(200);
  const text = await res.text();
  expect(text).toContain('Sitemap:');
  expect(text).toContain('Disallow: /admin');
  expect(text).toContain('Disallow: /article-editor');
  expect(text).toContain('Disallow: /login');
  expect(text).toContain('Disallow: /post-case');
  expect(text).toContain('Disallow: /board');
  expect(text).toContain('Disallow: /case');
});

test('sitemap.xml is accessible and well-formed', async ({ request }) => {
  const res = await request.get(`${BASE}/sitemap.xml`);
  expect(res.status()).toBe(200);
  const text = await res.text();
  expect(text).toContain('<urlset');
  expect(text).toContain('kidneysphere.com');
  expect(text).not.toContain('/admin');
  expect(text).not.toContain('/login');
  expect(text).not.toContain('/register');
  expect(text).not.toContain('/checkout');
  expect(text).not.toContain('/profile');
  expect(text).not.toContain('/membership');
});

// ─── noindex verification ───

const NOINDEX_PAGES = [
  '/login', '/register', '/forgot', '/reset',
  '/admin', '/admin-commerce', '/article-editor',
  '/profile', '/checkout', '/membership',
  '/favorites', '/notifications', '/post-case',
  '/board', '/case', '/verify-doctor',
  '/expert-ppt', '/notes', '/my-learning',
];

for (const p of NOINDEX_PAGES) {
  test(`${p} has noindex meta tag`, async ({ request }) => {
    const res = await request.get(`${BASE}${p}`);
    const html = await res.text();
    expect(html.toLowerCase()).toContain('noindex');
  });
}

// ─── Homepage noscript fallback ───

test('Homepage has noscript fallback content', async ({ request }) => {
  const res = await request.get(`${BASE}/`);
  const html = await res.text();
  expect(html).toContain('<noscript>');
  expect(html).toContain('肾域');
});

// ─── Article detail page ───

test('Article page: no edit button in HTML source', async ({ request }) => {
  const res = await request.get(`${BASE}/article`);
  const html = await res.text();
  expect(html).not.toContain('编辑此文章');
  expect(html).not.toContain('data-admin-only');
});

test('Article page: has noscript fallback', async ({ request }) => {
  const res = await request.get(`${BASE}/article`);
  const html = await res.text();
  expect(html).toContain('<noscript>');
});

// ─── Register page ───

test('Register page: no empty email placeholder', async ({ request }) => {
  const res = await request.get(`${BASE}/register`);
  const html = await res.text();
  expect(html).not.toContain('我们已尝试发送确认邮件到 <code></code>');
});

// ─── Beta product links should not go to broken sites ───

test('Homepage: beta product links go to申请内测, not broken sites', async ({ request }) => {
  const res = await request.get(`${BASE}/`);
  const html = await res.text();
  // Beta products should link to mailto, not external broken sites
  expect(html).not.toContain('href="https://kidneysphereremote.cn"');
  expect(html).not.toContain('href="https://kidneyspherefollowup.cn"');
  expect(html).not.toContain('href="https://kidneyspheredoctorapp.cn"');
});

// ─── Dev API endpoint ───

test('Dev grant-access API returns 404 without env flag', async ({ request }) => {
  const res = await request.post(`${BASE}/api/dev/grant-access`, {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ videoId: 'test' }),
  });
  expect([404, 401]).toContain(res.status());
});

// ─── Build-time HTML scan: no admin keywords in public pages ───

const PUBLIC_HTML_FILES = [
  'index.html', 'about.html', 'articles.html', 'community.html',
  'learning.html', 'events.html', 'frontier.html', 'videos.html',
  'academy.html', 'moments.html',
];

const BUILD_FORBIDDEN = [
  '仅管理员可使用',
  '全部（含草稿）',
  '管理员提示',
  'data-admin-only',
  '编辑此文章',
];

for (const file of PUBLIC_HTML_FILES) {
  test(`Build scan: ${file} has no admin keywords`, () => {
    const filePath = path.join(__dirname, '..', file);
    if (!fs.existsSync(filePath)) return;
    const html = fs.readFileSync(filePath, 'utf-8');
    for (const kw of BUILD_FORBIDDEN) {
      expect(html).not.toContain(kw);
    }
  });
}

// ─── Canonical tag check for public pages ───

const CANONICAL_PAGES = [
  { path: '/', expected: 'https://kidneysphere.com/' },
  { path: '/about', expected: 'https://kidneysphere.com/about' },
  { path: '/community', expected: 'https://kidneysphere.com/community' },
  { path: '/articles', expected: 'https://kidneysphere.com/articles' },
];

for (const { path: p, expected } of CANONICAL_PAGES) {
  test(`${p} has correct canonical tag`, async ({ request }) => {
    const res = await request.get(`${BASE}${p}`);
    const html = await res.text();
    expect(html).toContain(`href="${expected}"`);
  });
}
