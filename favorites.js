import { supabase, ensureSupabase, isConfigured, ensureAuthed, toast, getCurrentUser, formatBeijingDate } from './supabaseClient.js?v=20260128_030';

const momentsRoot = document.getElementById('favMoments');
const articlesRoot = document.getElementById('favArticles');
const casesRoot = document.getElementById('favCases');

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function relTime(ts){
  try{
    const t = (typeof ts === 'number') ? ts : Date.parse(ts);
    if(!Number.isFinite(t)) return '';
    const diff = Date.now() - t;
    const sec = Math.floor(diff/1000);
    if(sec < 60) return '刚刚';
    const min = Math.floor(sec/60);
    if(min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min/60);
    if(hr < 24) return `${hr} 小时前`;
    const day = Math.floor(hr/24);
    if(day < 7) return `${day} 天前`;
    return formatBeijingDate(t);
  }catch{ return ''; }
}

function snippet(text, n=120){
  const s = String(text || '').trim();
  if(s.length <= n) return s;
  return s.slice(0, n) + '…';
}

function renderEmpty(kind){
  const name = kind === 'moments' ? '社区动态'
    : kind === 'cases' ? '病例讨论'
    : '文章';
  return `<div class="muted small">暂无收藏。你可以在 ${name} 中点击 ⭐ 进行收藏。</div>`;
}

function renderErr(title, msg){
  return `<div class="note"><b>${esc(title)}</b><div class="small" style="margin-top:6px">${esc(msg)}</div></div>`;
}

function isMissingTableError(e, table){
  const m = String(e?.message || e || '').toLowerCase();
  return m.includes(table.toLowerCase()) && (
    m.includes('does not exist') ||
    m.includes('relation') ||
    m.includes('not find') ||
    m.includes('schema cache')
  );
}

async function loadMomentFavorites(user){
  if(!momentsRoot) return;

  momentsRoot.innerHTML = `<div class="muted small">加载中…</div>`;

  // 1) read favorites rows
  let favRows = [];
  try{
    const r = await supabase
      .from('moment_favorites')
      .select('moment_id, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if(r.error) throw r.error;
    favRows = r.data || [];
  }catch(e){
    if(isMissingTableError(e,'moment_favorites')){
      momentsRoot.innerHTML = renderErr('收藏功能未初始化', '请在 Supabase SQL Editor 运行 MIGRATION_20260110_FAVORITES.sql，然后 Settings → API 点击 “Reload schema”。');
      return;
    }
    momentsRoot.innerHTML = renderErr('加载失败', e?.message || String(e));
    return;
  }

  if(!favRows.length){
    momentsRoot.innerHTML = renderEmpty('moments');
    return;
  }

  const ids = favRows.map(r => r.moment_id).filter(Boolean);
  const favMetaById = new Map(favRows.map(r => [String(r.moment_id), r]));

  // 2) fetch moments (compat: video_url/deleted_at may be missing)
  let moments = [];
  try{
    const candidates = [
      { fields: 'id, created_at, author_name, content, images, video_url, deleted_at', filterDeleted: true },
      { fields: 'id, created_at, author_name, content, images, deleted_at', filterDeleted: true },
      { fields: 'id, created_at, author_name, content, images, video_url', filterDeleted: false },
      { fields: 'id, created_at, author_name, content, images', filterDeleted: false },
    ];

    let res = null;
    for(const c of candidates){
      let q = supabase.from('moments').select(c.fields).in('id', ids);
      if(c.filterDeleted) q = q.is('deleted_at', null);
      res = await q;
      if(!res?.error) break;
      const msg = String(res.error.message || res.error).toLowerCase();
      if(!(msg.includes('column') && (msg.includes('video_url') || msg.includes('deleted_at')))) break;
    }
    const { data, error } = res || {};
    if(error) throw error;
    moments = data || [];
  }catch(e){
    momentsRoot.innerHTML = renderErr('加载动态失败', e?.message || String(e));
    return;
  }

  // 3) order by favorite created_at desc
  const ordered = moments
    .map(m => ({ m, f: favMetaById.get(String(m.id)) }))
    .sort((a,b) => Date.parse(b.f?.created_at || 0) - Date.parse(a.f?.created_at || 0));

  momentsRoot.innerHTML = ordered.map(({m,f})=>{
    const firstImg = Array.isArray(m.images) && m.images.length ? String(m.images[0] || '') : '';
    const author = m.author_name || '匿名';
    const when = relTime(f?.created_at || m.created_at);
    const text = snippet(m.content, 140);

    return `
      <div class="card soft" style="padding:14px" data-moment-row="${esc(m.id)}">
        <div style="display:flex;gap:10px;align-items:flex-start">
          ${firstImg ? `<img class="thumb" alt="" src="${esc(firstImg)}" />` : ''}
          <div style="min-width:0;flex:1">
            <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">
              <b style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(author)}</b>
              <span class="small muted">· ${esc(when)}</span>
              <span class="spacer"></span>
              <button class="btn tiny danger" type="button" data-unfav-moment="${esc(m.id)}">取消收藏</button>
            </div>
            ${text ? `<div class="small" style="margin-top:8px;line-height:1.6">${esc(text)}</div>` : ''}
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
              <a class="btn tiny" href="moments.html?id=${encodeURIComponent(m.id)}">查看</a>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function loadArticleFavorites(user){
  if(!articlesRoot) return;

  articlesRoot.innerHTML = `<div class="muted small">加载中…</div>`;

  // 1) read favorites rows
  let favRows = [];
  try{
    const r = await supabase
      .from('article_favorites')
      .select('article_id, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if(r.error) throw r.error;
    favRows = r.data || [];
  }catch(e){
    if(isMissingTableError(e,'article_favorites')){
      articlesRoot.innerHTML = renderErr('文章收藏未初始化', '请在 Supabase SQL Editor 运行 MIGRATION_20260114_ARTICLE_FAVORITES.sql，然后 Settings → API 点击 “Reload schema”。');
      return;
    }
    articlesRoot.innerHTML = renderErr('加载失败', e?.message || String(e));
    return;
  }

  if(!favRows.length){
    articlesRoot.innerHTML = renderEmpty('articles');
    return;
  }

  const ids = favRows.map(r => r.article_id).filter(Boolean);
  const favMetaById = new Map(favRows.map(r => [String(r.article_id), r]));

  // 2) fetch articles (RLS will filter out unpublished for normal users)
  let articles = [];
  try{
    const candidates = [
      { fields: 'id, title, summary, cover_url, author_name, status, pinned, created_at, published_at, deleted_at, view_count, download_count' },
      { fields: 'id, title, summary, cover_url, author_name, status, pinned, created_at, published_at, deleted_at, view_count' },
      { fields: 'id, title, summary, cover_url, author_name, status, pinned, created_at, published_at, deleted_at' },
    ];

    let res = null;
    for(const c of candidates){
      res = await supabase
        .from('articles')
        .select(c.fields)
        .in('id', ids)
        .is('deleted_at', null);
      if(!res?.error) break;
      const msg = String(res.error.message || res.error).toLowerCase();
      // Retry without missing counter columns on older schemas.
      if(!(msg.includes('column') && (msg.includes('view_count') || msg.includes('download_count')))) break;
    }

    const { data, error } = res || {};
    if(error) throw error;
    articles = data || [];
  }catch(e){
    articlesRoot.innerHTML = renderErr('加载文章失败', e?.message || String(e));
    return;
  }

  if(!articles.length){
    articlesRoot.innerHTML = `<div class="muted small">你收藏的文章可能已下线/转为草稿（或你无权限查看）。</div>`;
    return;
  }

  // 3) order by favorite created_at desc
  const ordered = articles
    .map(a => ({ a, f: favMetaById.get(String(a.id)) }))
    .sort((x,y) => Date.parse(y.f?.created_at || 0) - Date.parse(x.f?.created_at || 0));

  articlesRoot.innerHTML = ordered.map(({a,f})=>{
    const title = a.title || '未命名文章';
    const sum = snippet(a.summary, 140);
    const when = relTime(f?.created_at || a.published_at || a.created_at);
    const author = a.author_name || '匿名';

    const views = (typeof a.view_count === 'number' && Number.isFinite(a.view_count)) ? a.view_count : null;
    const dls = (typeof a.download_count === 'number' && Number.isFinite(a.download_count)) ? a.download_count : null;
    const stats = `${views !== null ? ` · 阅读 ${views}` : ''}${dls !== null ? ` · 下载 ${dls}` : ''}`;

    return `
      <div class="card soft" style="padding:14px" data-article-row="${esc(a.id)}">
        <div style="display:flex;gap:10px;align-items:flex-start">
          ${a.cover_url ? `<img class="thumb" alt="" src="${esc(a.cover_url)}" />` : ''}
          <div style="min-width:0;flex:1">
            <div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">
              <b style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</b>
              <span class="small muted">· ${esc(author)} · ${esc(when)}${esc(stats)}</span>
              <span class="spacer"></span>
              <button class="btn tiny danger" type="button" data-unfav-article="${esc(a.id)}">取消收藏</button>
            </div>
            ${sum ? `<div class="small muted" style="margin-top:8px;line-height:1.6">${esc(sum)}</div>` : ''}
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
              <a class="btn tiny" href="article.html?id=${encodeURIComponent(a.id)}">查看</a>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function loadCaseFavorites(user){
  if(!casesRoot) return;

  casesRoot.innerHTML = `<div class="muted small">加载中…</div>`;

  let favRows = [];
  try{
    const r = await supabase
      .from('case_favorites')
      .select('case_id, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if(r.error) throw r.error;
    favRows = r.data || [];
  }catch(e){
    if(isMissingTableError(e,'case_favorites')){
      casesRoot.innerHTML = renderErr('收藏功能未初始化', '请在 Supabase SQL Editor 运行 MIGRATION_20260110_FAVORITES.sql，然后 Settings → API 点击 “Reload schema”。');
      return;
    }
    casesRoot.innerHTML = renderErr('加载失败', e?.message || String(e));
    return;
  }

  if(!favRows.length){
    casesRoot.innerHTML = renderEmpty('cases');
    return;
  }

  const ids = favRows.map(r => r.case_id).filter(Boolean);
  const favMetaById = new Map(favRows.map(r => [String(r.case_id), r]));

  let cases = [];
  try{
    const { data, error } = await supabase
      .from('cases')
      .select('id, title, summary, board, created_at, author_name, like_count')
      .in('id', ids);
    if(error) throw error;
    cases = data || [];
  }catch(e){
    casesRoot.innerHTML = renderErr('加载病例失败', e?.message || String(e));
    return;
  }

  const ordered = cases
    .map(c => ({ c, f: favMetaById.get(String(c.id)) }))
    .sort((a,b) => Date.parse(b.f?.created_at || 0) - Date.parse(a.f?.created_at || 0));

  casesRoot.innerHTML = ordered.map(({c,f})=>{
    const title = c.title || '未命名病例';
    const sum = snippet(c.summary, 140);
    const when = relTime(f?.created_at || c.created_at);
    const author = c.author_name || '匿名';
    const likes = (typeof c.like_count === 'number' && Number.isFinite(c.like_count)) ? c.like_count : 0;

    return `
      <div class="card soft" style="padding:14px" data-case-row="${esc(c.id)}">
        <div class="row" style="gap:10px;align-items:flex-start;flex-wrap:wrap">
          <div style="min-width:0;flex:1">
            <b style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</b>
            ${sum ? `<div class="small" style="margin-top:8px;line-height:1.6">${esc(sum)}</div>` : ''}
            <div class="small muted" style="margin-top:8px">${esc(author)} · ${esc(when)} · 👍 ${esc(String(likes))}</div>
          </div>
          <button class="btn tiny danger" type="button" data-unfav-case="${esc(c.id)}">取消收藏</button>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
          <a class="btn tiny" href="case.html?id=${encodeURIComponent(c.id)}">进入病例</a>
        </div>
      </div>
    `;
  }).join('');
}

function bindUnfavHandlers(user){
  momentsRoot?.addEventListener('click', async (e)=>{
    const btn = e.target?.closest?.('[data-unfav-moment]');
    if(!btn) return;
    const id = btn.getAttribute('data-unfav-moment');
    if(!id) return;
    btn.disabled = true;
    try{
      const { error } = await supabase
        .from('moment_favorites')
        .delete()
        .eq('moment_id', Number(id))
        .eq('user_id', user.id);
      if(error) throw error;
      btn.closest('[data-moment-row]')?.remove();
      toast('已取消收藏', '', 'ok');
    }catch(err){
      btn.disabled = false;
      toast('取消失败', err?.message || String(err), 'err');
    }
  });

  articlesRoot?.addEventListener('click', async (e)=>{
    const btn = e.target?.closest?.('[data-unfav-article]');
    if(!btn) return;
    const id = btn.getAttribute('data-unfav-article');
    if(!id) return;
    btn.disabled = true;
    try{
      const { error } = await supabase
        .from('article_favorites')
        .delete()
        .eq('article_id', id)
        .eq('user_id', user.id);
      if(error) throw error;
      btn.closest('[data-article-row]')?.remove();
      toast('已取消收藏', '', 'ok');
    }catch(err){
      btn.disabled = false;
      toast('取消失败', err?.message || String(err), 'err');
    }
  });

  casesRoot?.addEventListener('click', async (e)=>{
    const btn = e.target?.closest?.('[data-unfav-case]');
    if(!btn) return;
    const id = btn.getAttribute('data-unfav-case');
    if(!id) return;
    btn.disabled = true;
    try{
      const { error } = await supabase
        .from('case_favorites')
        .delete()
        .eq('case_id', Number(id))
        .eq('user_id', user.id);
      if(error) throw error;
      btn.closest('[data-case-row]')?.remove();
      toast('已取消收藏', '', 'ok');
    }catch(err){
      btn.disabled = false;
      toast('取消失败', err?.message || String(err), 'err');
    }
  });
}

async function main(){
  // Page might be partially embedded; handle gracefully.
  if(!momentsRoot && !casesRoot && !articlesRoot) return;

  if(!isConfigured()){
    if(momentsRoot) momentsRoot.innerHTML = `<div class="note"><b>演示模式：</b>请在 assets/config.js 配置 Supabase 后启用收藏功能。</div>`;
    if(articlesRoot) articlesRoot.innerHTML = '';
    if(casesRoot) casesRoot.innerHTML = '';
    return;
  }

  await ensureSupabase();

  const ok = await ensureAuthed('login.html');
  if(!ok) return;

  const user = await getCurrentUser();
  if(!user){
    toast('需要登录', '请先登录。', 'err');
    return;
  }

  bindUnfavHandlers(user);

  // Load in parallel (but keep independent error handling inside each loader)
  await Promise.all([
    loadMomentFavorites(user),
    loadArticleFavorites(user),
    loadCaseFavorites(user),
  ]);
}

main().catch(err => {
  console.error(err);
  try{ toast('加载失败', err?.message || String(err), 'err'); }catch(_e){}
});
