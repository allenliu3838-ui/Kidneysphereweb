/**
 * Netlify Function: /s/:id  -> render a WeChat-friendly share page with OG meta tags.
 *
 * Required env vars (Netlify site settings):
 *   - SUPABASE_URL
 *   - SUPABASE_ANON_KEY
 *
 * This function reads the "frontier_posts" table via Supabase REST.
 * By default, only posts with is_public_share = true are readable anonymously
 * (see RLS policy: frontier_posts_select_shareable_anon).
 */

const htmlEscape = (s) => String(s ?? '')
  .replace(/&/g,'&amp;')
  .replace(/</g,'&lt;')
  .replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;')
  .replace(/'/g,'&#39;');

const strip = (s) => String(s ?? '').replace(/\s+/g,' ').trim();

const shortText = (s, n=90) => {
  const t = strip(s);
  return t.length > n ? t.slice(0,n) + '…' : t;
};

const typeLabel = (t) => {
  const k = String(t || '').toLowerCase();
  if(k === 'literature') return '文献分享';
  if(k === 'pathology') return '病理图片';
  return '学习总结';
};

exports.handler = async function handler(event) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  // Build origin for absolute URLs
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host = event.headers['host'];
  const origin = host ? `${proto}://${host}` : '';

  const id = (event.queryStringParameters && event.queryStringParameters.id) ? String(event.queryStringParameters.id) : '';
  const fallbackLogo = origin ? `${origin}/assets/logo.png` : 'assets/logo.png';

  if(!id || !SUPABASE_URL || !SUPABASE_ANON_KEY){
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>KidneySphere 社区动态</title>
<meta property="og:title" content="KidneySphere 社区动态"/>
<meta property="og:description" content="查看社区动态（文献/病理/学习总结）"/>
<meta property="og:image" content="${htmlEscape(fallbackLogo)}"/>
<meta name="description" content="KidneySphere 社区动态"/>
</head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; padding:16px">
  <h2>KidneySphere 社区动态</h2>
  <p>分享页暂不可用（缺少参数或环境变量）。</p>
  <p><a href="${htmlEscape(origin ? origin + '/moments.html' : 'moments.html')}">进入社区动态</a></p>
</body>
</html>`;
    return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html };
  }

  try{
    // Supabase REST: query one row
    const url = new URL(`${SUPABASE_URL.replace(/\/$/,'')}/rest/v1/frontier_posts`);
    url.searchParams.set('id', `eq.${id}`);
    url.searchParams.set('select', 'id,type,title,body,image_urls,author_name,created_at,is_public_share,deleted_at');

    const res = await fetch(url.toString(), {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Accept: 'application/json'
      }
    });

    if(!res.ok){
      const t = await res.text().catch(()=> '');
      throw new Error(`Supabase REST error: ${res.status} ${t}`);
    }

    const rows = await res.json();
    const post = Array.isArray(rows) ? rows[0] : null;

    if(!post || post.deleted_at){
      const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>动态不存在 · KidneySphere</title>
<meta property="og:title" content="动态不存在 · KidneySphere"/>
<meta property="og:description" content="该动态不存在或已删除"/>
<meta property="og:image" content="${htmlEscape(fallbackLogo)}"/>
</head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; padding:16px">
  <h2>动态不存在或已删除</h2>
  <p><a href="${htmlEscape(origin + '/moments.html')}">返回社区动态</a></p>
</body>
</html>`;
      return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html };
    }

    // Respect share flag (even though RLS should already enforce it)
    if(!post.is_public_share){
      const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>KidneySphere 社区动态</title>
<meta property="og:title" content="KidneySphere 社区动态"/>
<meta property="og:description" content="该动态未开启公开分享"/>
<meta property="og:image" content="${htmlEscape(fallbackLogo)}"/>
</head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; padding:16px">
  <h2>该动态未开启公开分享</h2>
  <p>如需分享，请在站内发布时勾选“允许生成可公开分享链接”。</p>
  <p><a href="${htmlEscape(origin + '/moments.html')}">进入社区动态</a></p>
</body>
</html>`;
      return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html };
    }

    const title = strip(post.title) || `KidneySphere 社区动态（${typeLabel(post.type)}）`;
    const desc = shortText(post.body, 100) || 'KidneySphere 社区动态';
    const image = Array.isArray(post.image_urls) && post.image_urls.length ? post.image_urls[0] : fallbackLogo;

    const openLink = `${origin}/moment.html?id=${encodeURIComponent(post.id)}`;

    const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${htmlEscape(title)}</title>

<meta name="description" content="${htmlEscape(desc)}"/>

<!-- Open Graph (WeChat usually reads these) -->
<meta property="og:title" content="${htmlEscape(title)}"/>
<meta property="og:description" content="${htmlEscape(desc)}"/>
<meta property="og:image" content="${htmlEscape(image)}"/>
<meta property="og:type" content="article"/>

<!-- Twitter card (harmless for WeChat, useful elsewhere) -->
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${htmlEscape(title)}"/>
<meta name="twitter:description" content="${htmlEscape(desc)}"/>
<meta name="twitter:image" content="${htmlEscape(image)}"/>

<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;margin:0;background:#0b1020;color:#eaf0ff}
  .wrap{max-width:720px;margin:0 auto;padding:18px}
  .card{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);border-radius:16px;padding:14px}
  .badge{display:inline-block;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);border-radius:999px;padding:6px 10px;font-size:12px}
  h1{font-size:20px;margin:10px 0 6px;line-height:1.35}
  p{margin:8px 0;line-height:1.55;opacity:.95}
  img{width:100%;height:auto;border-radius:14px;border:1px solid rgba(255,255,255,.10);margin-top:10px}
  a.btn{display:inline-block;margin-top:12px;padding:10px 12px;border-radius:12px;border:1px solid rgba(99,225,255,.35);background:rgba(99,225,255,.10);color:#eaf0ff;text-decoration:none;font-weight:700}
  .muted{opacity:.78;font-size:12px;margin-top:10px}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between}
</style>
</head>

<body>
  <div class="wrap">
    <div class="card">
      <div class="row">
        <span class="badge">${htmlEscape(typeLabel(post.type))}</span>
        <span class="muted">${htmlEscape(post.author_name || 'Member')}</span>
      </div>
      <h1>${htmlEscape(title)}</h1>
      <p>${htmlEscape(desc)}</p>
      ${image ? `<img alt="cover" src="${htmlEscape(image)}"/>` : ``}
      <a class="btn" href="${htmlEscape(openLink)}">打开 KidneySphere 查看完整内容</a>
      <div class="muted">提示：完整内容可能需要登录。分享病理/病例相关内容请确保已去标识化。</div>
    </div>
  </div>
</body>
</html>`;

    return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html };
  }catch(e){
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>KidneySphere 社区动态</title>
<meta property="og:title" content="KidneySphere 社区动态"/>
<meta property="og:description" content="分享页加载失败"/>
<meta property="og:image" content="${htmlEscape(fallbackLogo)}"/>
</head>
<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; padding:16px">
  <h2>分享页加载失败</h2>
  <p style="opacity:.7">${htmlEscape(e.message || String(e))}</p>
  <p><a href="${htmlEscape(origin + '/moments.html')}">进入社区动态</a></p>
</body>
</html>`;
    return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html };
  }
};