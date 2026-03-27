/**
 * Netlify Edge Function: Article SSR
 *
 * Intercepts requests to /article and /article.html, fetches the article
 * data from the Content API, and injects title, author, date, and preview
 * content into the HTML response. This ensures:
 * 1. First-screen content is visible without JS
 * 2. Search engines can index article content
 * 3. Social sharing (OG tags) has real article metadata
 */

const SUPABASE_URL = 'https://eaatpwakhcjxjonlyfii.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhYXRwd2FraGNqeGpvbmx5ZmlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5MDUzMzMsImV4cCI6MjA4MjQ4MTMzM30.OZ6mhKVsOKfJeI6opkk7GxRJuv0kY__k5N936h261PI';

function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  } catch { return ''; }
}

function stripHtmlTags(html) {
  return String(html || '').replace(/<[^>]*>/g, '').trim();
}

async function fetchArticle(id) {
  if (!id) return null;

  // Try content_items first (new content hub)
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    Accept: 'application/json',
  };

  // Try by UUID
  let url = `${SUPABASE_URL}/rest/v1/content_items?id=eq.${encodeURIComponent(id)}&status=eq.published&select=id,title_zh,title_en,summary_zh,author_name,published_at,last_published_version_id&limit=1`;
  let res = await fetch(url, { headers });
  let items = res.ok ? await res.json() : [];

  // Try by legacy_article_id
  if (!items?.length) {
    url = `${SUPABASE_URL}/rest/v1/content_items?legacy_article_id=eq.${encodeURIComponent(id)}&status=eq.published&select=id,title_zh,title_en,summary_zh,author_name,published_at,last_published_version_id&limit=1`;
    res = await fetch(url, { headers });
    items = res.ok ? await res.json() : [];
  }

  const item = items?.[0];
  if (!item?.last_published_version_id) {
    // Fallback to legacy articles table
    url = `${SUPABASE_URL}/rest/v1/articles?id=eq.${encodeURIComponent(id)}&status=eq.published&select=id,title,summary,author_name,published_at,content_md&limit=1`;
    res = await fetch(url, { headers });
    const legacy = res.ok ? await res.json() : [];
    const a = legacy?.[0];
    if (!a) return null;
    return {
      title: a.title || '',
      summary: a.summary || '',
      author: a.author_name || '',
      date: a.published_at || '',
      preview: (a.content_md || '').slice(0, 800),
    };
  }

  // Fetch the version preview body
  const vUrl = `${SUPABASE_URL}/rest/v1/content_versions?id=eq.${encodeURIComponent(item.last_published_version_id)}&select=preview_body&limit=1`;
  const vRes = await fetch(vUrl, { headers });
  const ver = vRes.ok ? (await vRes.json())?.[0] : null;

  return {
    title: item.title_zh || item.title_en || '',
    summary: item.summary_zh || '',
    author: item.author_name || '',
    date: item.published_at || '',
    preview: ver?.preview_body || item.summary_zh || '',
  };
}

export default async function handler(request, context) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';

  // Get the original response
  const response = await context.next();

  // Only process HTML responses
  const ct = response.headers.get('content-type') || '';
  if (!ct.includes('text/html')) return response;

  // If no article ID, return as-is
  if (!id) return response;

  let html = await response.text();

  try {
    const article = await fetchArticle(id);
    if (!article) return new Response(html, response);

    const safeTitle = escHtml(article.title);
    const safeAuthor = escHtml(article.author);
    const safeDate = fmtDate(article.date);
    const safeSummary = escHtml(article.summary || stripHtmlTags(article.preview).slice(0, 200));
    const previewText = stripHtmlTags(article.preview).slice(0, 600);

    // Inject real title
    html = html.replace(
      /<title>[^<]*<\/title>/,
      `<title>${safeTitle} · 肾域</title>`
    );

    // Inject real meta description
    html = html.replace(
      /<meta name="description" content="[^"]*"/,
      `<meta name="description" content="${safeSummary}"`
    );

    // Inject real OG tags
    html = html.replace(
      /<meta property="og:title" content="[^"]*"/,
      `<meta property="og:title" content="${safeTitle} · 肾域"`
    );
    html = html.replace(
      /<meta property="og:description" content="[^"]*"/,
      `<meta property="og:description" content="${safeSummary}"`
    );

    // Inject article content into the loading placeholder
    const articleHtml = `
      <article class="article-ssr-preview">
        <h1 style="margin-bottom:8px">${safeTitle}</h1>
        <div class="small muted" style="margin-bottom:16px">
          ${safeAuthor ? `<span>${safeAuthor}</span> · ` : ''}${safeDate ? `<span>${escHtml(safeDate)}</span>` : ''}
        </div>
        ${article.preview ? `<div class="prose">${article.preview}</div>` : `<p>${escHtml(previewText)}</p>`}
        <div class="muted small" style="margin-top:16px">正在加载完整内容…</div>
      </article>`;

    html = html.replace(
      '<div class="muted small">正在加载文章…</div>',
      articleHtml
    );

    // Update noscript to include article title
    html = html.replace(
      '<h1>文章详情 · 肾域</h1>',
      `<h1>${safeTitle}</h1>`
    );

    return new Response(html, {
      status: response.status,
      headers: response.headers,
    });
  } catch (e) {
    // On error, return original response
    return new Response(html, response);
  }
}

export const config = {
  path: ["/article", "/article.html"],
};
