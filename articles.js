import {
  supabase,
  ensureSupabase,
  isConfigured,
  ensureAuthed,
  toast,
  getCurrentUser,
  getUserProfile,
  isAdminRole,
} from './supabaseClient.js?v=20260128_030';

const listEl = document.getElementById('articlesList');
const countEl = document.getElementById('articlesCount');
const searchEl = document.getElementById('articlesSearch');
const refreshBtn = document.getElementById('articlesRefresh');
const scopeEl = document.getElementById('articlesScope');
const tagInfoEl = document.getElementById('articlesTagInfo'); // optional


let currentUserId = null;
let canFavorite = true; // may become false if table is missing
let favedSet = new Set();

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function fmtBeijing(ts){
  try{
    const d = new Date(ts);
    const opts = { timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' };
    const parts = new Intl.DateTimeFormat('zh-CN', opts).formatToParts(d);
    const m = Object.fromEntries(parts.map(p=>[p.type,p.value]));
    return `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}`;
  }catch(_e){
    return String(ts || '');
  }
}

function relTime(ts){
  if(!ts) return '';
  const t = new Date(ts).getTime();
  if(!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const min = Math.floor(diff/60000);
  if(min < 1) return '刚刚';
  if(min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min/60);
  if(hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr/24);
  if(day < 14) return `${day} 天前`;
  return fmtBeijing(ts);
}

function getFilterTag(){
  // Filter articles by a single tag.
  // Priority: URL ?tag=xxx, then <body data-articles-tag="xxx">.
  try{
    const u = new URL(location.href);
    const q = String(u.searchParams.get('tag') || '').trim();
    if(q) return q;
  }catch(_e){}
  try{
    const d = String(document.body?.dataset?.articlesTag || '').trim();
    if(d) return d;
  }catch(_e){}
  return '';
}

function isMissingTableError(e, table){
  const m = String(e?.message || e || '').toLowerCase();
  return m.includes(table.toLowerCase()) && (
    m.includes('does not exist') ||
    m.includes('relation') ||
    m.includes('schema cache') ||
    m.includes('not find')
  );
}

function favLabel(isFaved){
  return isFaved ? '⭐ 已收藏' : '⭐ 收藏';
}

function renderItem(a, opts){
  const { isAdmin, canFavorite, faved } = opts || {};
  const id = a.id;
  const title = a.title || '未命名';
  const summary = String(a.summary || '').trim();
  const cover = String(a.cover_url || '').trim();
  const status = String(a.status || 'draft');
  const when = a.published_at || a.created_at;
  const views = (typeof a.view_count === 'number' && isFinite(a.view_count)) ? a.view_count : null;
  const dls = (typeof a.download_count === 'number' && isFinite(a.download_count)) ? a.download_count : null;
  const likes = (typeof a.like_count === 'number' && isFinite(a.like_count)) ? a.like_count : null;
  const metaLeft = `${relTime(when)}${a.author_name ? ' · ' + a.author_name : ''}${views !== null ? ' · 阅读 ' + views : ''}${dls !== null ? ' · 下载 ' + dls : ''}${likes !== null ? ' · 点赞 ' + likes : ''}`;
  const metaRight = status !== 'published' ? ` · ${status === 'draft' ? '草稿' : status}` : '';

  const favBtn = canFavorite ? `
    <button
      class="btn tiny ${faved ? 'primary' : ''}"
      type="button"
      data-afav="${esc(id)}"
      data-afaved="${faved ? '1' : '0'}"
      title="${faved ? '取消收藏' : '收藏'}"
    >${favLabel(faved)}</button>
  ` : '';

  const adminBtn = isAdmin ? `
    <a class="btn tiny" href="article-editor.html?id=${encodeURIComponent(id)}">编辑</a>
  ` : '';

  return `
    <div class="article-row card soft" style="padding:14px">
      <div style="display:flex;gap:14px;align-items:flex-start;justify-content:space-between">
        <a class="article-link" href="article.html?id=${encodeURIComponent(id)}" style="min-width:0;flex:1">
          <div style="display:flex;gap:12px;align-items:flex-start">
            ${cover ? `<img class="thumb" src="${esc(cover)}" alt="cover"/>` : ''}
            <div style="min-width:0">
              <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
                <b style="display:block;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</b>
                ${a.pinned ? `<span class="chip soon">置顶</span>` : ''}
                ${status !== 'published' ? `<span class="chip todo">${esc(status === 'draft' ? '草稿' : status)}</span>` : ''}
              </div>
              ${summary ? `<div class="small muted" style="margin-top:8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(summary)}</div>` : ''}
              <div class="small muted" style="margin-top:8px">${esc(metaLeft)}${esc(metaRight)}</div>
            </div>
          </div>
        </a>

        ${(favBtn || adminBtn) ? `
          <div style="flex:0 0 auto;display:flex;flex-direction:column;gap:8px;align-items:flex-end">
            ${favBtn}
            ${adminBtn}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

async function loadFavoritesForArticles(userId, articleIds){
  favedSet = new Set();
  if(!userId || !canFavorite || !articleIds?.length) return;

  try{
    const { data, error } = await supabase
      .from('article_favorites')
      .select('article_id')
      .eq('user_id', userId)
      .in('article_id', articleIds);
    if(error) throw error;
    (data || []).forEach(r => { if(r?.article_id) favedSet.add(String(r.article_id)); });
  }catch(e){
    if(isMissingTableError(e, 'article_favorites')){
      canFavorite = false;
      // Only toast once per page load
      toast('收藏暂不可用', '文章收藏功能暂未启用或正在维护中，请稍后再试。', 'err');
      return;
    }
    // Don't block list; just disable favorite for now.
    canFavorite = false;
    console.warn('loadFavoritesForArticles failed:', e);
  }
}

async function toggleFavorite(btn){
  const articleId = String(btn.getAttribute('data-afav') || '').trim();
  if(!articleId) return;

  if(!isConfigured()){
    toast('服务暂不可用', '系统尚未完成初始化或正在维护中，请稍后重试。', 'err');
    return;
  }

  await ensureSupabase();
  if(!supabase){
    toast('服务不可用', 'Supabase SDK 初始化失败，请刷新后重试。', 'err');
    return;
  }

  let user = await getCurrentUser();
  if(!user){
    const ok = await ensureAuthed('login.html');
    if(!ok) return;
    user = await getCurrentUser();
  }
  if(!user){
    toast('需要登录', '请先登录后再收藏。', 'err');
    return;
  }

  const isFaved = btn.getAttribute('data-afaved') === '1';
  btn.disabled = true;

  try{
    if(isFaved){
      const { error } = await supabase
        .from('article_favorites')
        .delete()
        .eq('article_id', articleId)
        .eq('user_id', user.id);
      if(error) throw error;
      btn.setAttribute('data-afaved', '0');
      btn.textContent = favLabel(false);
      btn.classList.remove('primary');
      favedSet.delete(articleId);
      toast('已取消收藏', '', 'ok');
    }else{
      const { error } = await supabase
        .from('article_favorites')
        .upsert({ article_id: articleId, user_id: user.id }, { onConflict: 'article_id,user_id' });
      if(error) throw error;
      btn.setAttribute('data-afaved', '1');
      btn.textContent = favLabel(true);
      btn.classList.add('primary');
      favedSet.add(articleId);
      toast('已收藏', '可在「我的收藏」中查看。', 'ok');
    }
  }catch(e){
    if(isMissingTableError(e, 'article_favorites')){
      canFavorite = false;
      toast('收藏暂不可用', '文章收藏功能暂未启用或正在维护中，请稍后再试。', 'err');
      // Disable all favorite buttons on page
      document.querySelectorAll('[data-afav]').forEach(b=>{ b.disabled = true; b.title = '文章收藏未初始化'; });
      return;
    }
    toast('操作失败', e?.message || String(e), 'err');
  }finally{
    btn.disabled = false;
  }
}

async function loadArticles(){
  if(!listEl) return;
  listEl.innerHTML = `<div class="muted small">加载中…</div>`;

  const q = String(searchEl?.value || '').trim();
  const scope = String(scopeEl?.value || 'published');
  const filterTag = getFilterTag();

  if(!isConfigured()){
    listEl.innerHTML = `<div class="note"><b>提示：</b>当前服务未就绪或正在维护中，文章列表暂不可用。</div>`;
    return;
  }

  await ensureSupabase();
  if(!supabase){
    listEl.innerHTML = `<div class="muted small">Supabase 未初始化，请刷新或切换网络后重试。</div>`;
    return;
  }

  const user = await getCurrentUser();
  currentUserId = user?.id || null;
  const profile = user ? await getUserProfile(user.id) : null;
  const role = String(profile?.role || '');
  const isAdmin = Boolean(user && isAdminRole(role));

  // if user isn't admin, force scope to published
  const effectiveScope = isAdmin ? scope : 'published';

  try{
    const buildQuery = (mode)=>{
      // mode: 'both' | 'view' | 'like' | 'none'
      const fields = mode === 'both'
        ? 'id, title, summary, cover_url, tags, status, pinned, author_name, created_at, published_at, deleted_at, view_count, download_count, like_count'
        : mode === 'view'
          ? 'id, title, summary, cover_url, tags, status, pinned, author_name, created_at, published_at, deleted_at, view_count, like_count'
          : mode === 'like'
            ? 'id, title, summary, cover_url, tags, status, pinned, author_name, created_at, published_at, deleted_at, like_count'
            : 'id, title, summary, cover_url, tags, status, pinned, author_name, created_at, published_at, deleted_at';

      let query = supabase
        .from('articles')
        .select(fields)
        .is('deleted_at', null);

      if(effectiveScope === 'published'){
        query = query.eq('status', 'published');
      }

      if(q){
        const qq = q.replace(/%/g, '\\%');
        query = query.or(`title.ilike.%${qq}%,summary.ilike.%${qq}%`);
      }

      if(filterTag){
        // tags is a text[] column; contains([tag]) means the article has this tag.
        query = query.contains('tags', [filterTag]);
      }

      return query;
    };

    const runWithOrder = async (query)=>{
      // Order: pinned first (if exists), then published_at/created_at
      let r = await query.order('pinned', { ascending: false }).order('published_at', { ascending: false }).order('created_at', { ascending: false }).limit(50);
      // Backward compatibility (if pinned doesn't exist yet)
      if(r.error && String(r.error.message||'').includes('pinned')){
        r = await query.order('published_at', { ascending: false }).order('created_at', { ascending: false }).limit(50);
      }
      return r;
    };

    let r = await runWithOrder(buildQuery('both'));
    // Backward compatibility: download_count may not exist yet.
    if(r.error && /download_count/i.test(String(r.error.message||''))){
      r = await runWithOrder(buildQuery('view'));
    }
    // Backward compatibility: view_count may not exist yet.
    if(r.error && /view_count/i.test(String(r.error.message||''))){
      r = await runWithOrder(buildQuery('like'));
    }
    // Backward compatibility: like_count may not exist yet.
    if(r.error && /like_count/i.test(String(r.error.message||''))){
      r = await runWithOrder(buildQuery('none'));
    }

    if(r.error) throw r.error;

    const items = r.data || [];
    if(countEl){
      const tagInfo = filterTag ? ` · 标签：${filterTag}` : '';
      countEl.textContent = items.length ? `共 ${items.length} 篇${tagInfo}` : (filterTag ? `标签：${filterTag}` : '');
    }
    if(tagInfoEl){
      tagInfoEl.textContent = filterTag ? `当前标签：${filterTag}` : '';
      tagInfoEl.hidden = !filterTag;
    }

    if(items.length === 0){
      listEl.innerHTML = `<div class="muted small">暂无匹配内容${filterTag ? `（标签：${esc(filterTag)}）` : ''}。</div>`;
      return;
    }

    // Favorites
    canFavorite = true;
    await loadFavoritesForArticles(currentUserId, items.map(a => String(a.id)));

    listEl.innerHTML = items.map(a => renderItem(a, {
      isAdmin,
      canFavorite,
      faved: canFavorite ? favedSet.has(String(a.id)) : false,
    })).join('');

  }catch(e){
    const showDev = Boolean(typeof window !== 'undefined' && window.__SHOW_DEV_HINTS__);
    const msg = esc(e?.message || String(e));
    const detail = showDev ? `<div class="small muted" style="margin-top:8px">错误详情：${msg}</div>` : '';
    listEl.innerHTML = `
      <div class="muted small">读取文章失败，请刷新后重试。</div>
      <div class="small muted" style="margin-top:8px">如仍无法加载，请稍后再试或联系管理员。</div>
      ${detail}
    `;
  }
}

refreshBtn?.addEventListener('click', loadArticles);
searchEl?.addEventListener('keydown', (e)=>{ if(e.key==='Enter') loadArticles(); });
scopeEl?.addEventListener('change', loadArticles);

listEl?.addEventListener('click', async (e)=>{
  const btn = e.target?.closest?.('[data-afav]');
  if(!btn) return;
  e.preventDefault();
  e.stopPropagation();
  if(!canFavorite){
    toast('收藏不可用', '文章收藏功能尚未初始化（或已被禁用）。', 'err');
    return;
  }
  await toggleFavorite(btn);
});

// Auto-load
loadArticles();
