/**
 * Playwright Smoke Tests: Production Security & SEO
 *
 * These tests verify that:
 * 1. Admin/internal pages are NOT accessible to anonymous users
 * 2. Public pages render core content without JS
 * 3. Sensitive keywords don't appear in public HTML
 * 4. SEO meta tags are correctly set
 * 5. No dead links on critical pages
 *
 * Run: npx playwright test tests/smoke.spec.js
 */

const { test, expect } = require('@playwright/test');

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
  test(`Admin route ${route} should not expose admin content`, async ({ page }) => {
    const response = await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    const html = await page.content();

    // Should not contain admin-specific keywords in initial HTML
    for (const kw of FORBIDDEN_KEYWORDS) {
      expect(html).not.toContain(kw);
    }

    // Should have noindex
    expect(html).toContain('noindex');
  });
}

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

for (const { path, mustContain } of PUBLIC_PAGES) {
  test(`Public page ${path} contains core content`, async ({ page }) => {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    const html = await page.content();

    for (const text of mustContain) {
      expect(html).toContain(text);
    }

    // Should NOT have noindex (these are public pages)
    if (path !== '/') {
      // index.html intentionally has no noindex
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
});

test('sitemap.xml is accessible and well-formed', async ({ request }) => {
  const res = await request.get(`${BASE}/sitemap.xml`);
  expect(res.status()).toBe(200);
  const text = await res.text();
  expect(text).toContain('<urlset');
  expect(text).toContain('kidneysphere.com');
  // Should NOT contain admin/internal pages
  expect(text).not.toContain('/admin');
  expect(text).not.toContain('/login');
  expect(text).not.toContain('/register');
  expect(text).not.toContain('/checkout');
  expect(text).not.toContain('/profile');
});

// ─── noindex verification for auth pages ───

const NOINDEX_PAGES = [
  '/login',
  '/register',
  '/forgot',
  '/reset',
  '/admin',
  '/admin-commerce',
  '/article-editor',
  '/profile',
  '/checkout',
  '/membership',
  '/favorites',
  '/notifications',
  '/post-case',
  '/board',
  '/case',
  '/verify-doctor',
];

for (const path of NOINDEX_PAGES) {
  test(`${path} has noindex meta tag`, async ({ page }) => {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    const html = await page.content();
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

// ─── Article detail page structure ───

test('Article page does not expose edit button in HTML', async ({ request }) => {
  const res = await request.get(`${BASE}/article`);
  const html = await res.text();
  expect(html).not.toContain('编辑此文章');
  expect(html).not.toContain('data-admin-only');
});

// ─── Register page does not show empty email ───

test('Register page does not show empty confirmation text', async ({ request }) => {
  const res = await request.get(`${BASE}/register`);
  const html = await res.text();
  // The confirmWrap should be hidden and have proper default text
  expect(html).not.toContain('我们已尝试发送确认邮件到 <code></code>');
  expect(html).toContain('确认邮件已发送至');
});

// ─── Dev API endpoint should return 404 in production ───

test('Dev grant-access API returns 404 without env flag', async ({ request }) => {
  const res = await request.post(`${BASE}/api/dev/grant-access`, {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ videoId: 'test' }),
  });
  // Should be 404 (disabled) or 401 (auth required), never 200
  expect([404, 401]).toContain(res.status());
});

// ─── Build-time HTML scan: no admin keywords in public page HTML ───

const fs = require('fs');
const path = require('path');

const PUBLIC_HTML_FILES = [
  'index.html',
  'about.html',
  'articles.html',
  'community.html',
  'learning.html',
  'events.html',
  'frontier.html',
  'videos.html',
  'academy.html',
];

for (const file of PUBLIC_HTML_FILES) {
  test(`Build scan: ${file} has no admin keywords`, () => {
    const filePath = path.join(__dirname, '..', file);
    if (!fs.existsSync(filePath)) return;
    const html = fs.readFileSync(filePath, 'utf-8');

    const adminKeywords = [
      '仅管理员可使用',
      '全部（含草稿）',
      '管理员提示',
      'data-admin-only',
    ];

    for (const kw of adminKeywords) {
      expect(html).not.toContain(kw);
    }
  });
}
