import { ensureSupabase, supabase, getCurrentUser, getUserProfile, isAdminRole, normalizeRole } from './supabaseClient.js?v=20260401_fix';

function qp(k){ return new URLSearchParams(location.search).get(k) || ''; }
function esc(s){ return String(s||'').replace(/[&<>\"]/g, m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[m])); }

function publicUrl(bucket, path){
  if(!path) return '';
  try {
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data?.publicUrl || '';
  } catch {
    return '';
  }
}


async function hasAtlasPro(userId){
  if(!userId || !supabase) return false;
  const now = new Date().toISOString();
  const { data } = await supabase.from('user_entitlements')
    .select('id,entitlement_type,status,end_at')
    .eq('user_id', userId)
    .in('entitlement_type', ['atlas_pro','membership'])
    .eq('status', 'active')
    .or(`end_at.is.null,end_at.gt.${now}`)
    .limit(1);
  return !!(data && data.length);
}

function card(title, body, href){ return `<a class="card" style="display:block;padding:12px;text-decoration:none;color:inherit" href="${href}"><h4>${esc(title)}</h4><p>${esc(body||'')}</p></a>`; }

function topicCard(t){
  return `<a class="card" style="display:block;padding:14px;text-decoration:none;color:inherit;" href="atlas-topic.html?slug=${encodeURIComponent(t.slug)}">
    <h4 style="margin:0 0 4px 0;">${esc(t.name)}</h4>
    <p style="margin:0;font-size:13px;opacity:.8;">${esc(t.summary || '')}</p>
  </a>`;
}

async function loadAtlasHome(){
  revealAdminEntryIfAdmin();
  const container = document.getElementById('atlasCategoryGroups');
  if(!container) return;
  container.innerHTML = '<div class="note">加载中…</div>';

  // 一次性查所有 published 分类（按 sort_order）+ 所有 published 专题
  const [catRes, topicRes] = await Promise.all([
    supabase.from('atlas_categories')
      .select('id,name,slug,icon,description,sort_order')
      .eq('status','published')
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
    supabase.from('atlas_topics')
      .select('id,name,slug,summary,category_id,sort_order')
      .eq('status','published')
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
  ]);

  const cats = catRes.data || [];
  const allTopics = topicRes.data || [];

  if(!cats.length){
    container.innerHTML = '<div class="note">图谱目录正在建设中</div>';
    return;
  }

  // 按 category_id 分组专题
  const topicsByCatId = {};
  allTopics.forEach(t=>{
    (topicsByCatId[t.category_id] ||= []).push(t);
  });

  container.innerHTML = cats.map(c=>{
    const topics = topicsByCatId[c.id] || [];
    const icon = c.icon || '📚';
    const countLabel = topics.length ? `${topics.length} 个专题` : '敬请期待';
    const body = topics.length
      ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;">
          ${topics.map(topicCard).join('')}
        </div>`
      : `<div class="note" style="opacity:.7;">敬请期待，相关图谱正在建设中。</div>`;
    return `
      <section class="stack" style="margin-top:24px;" id="cat-${esc(c.slug)}">
        <h2 style="display:flex;align-items:baseline;gap:10px;margin-bottom:6px;">
          <span style="font-size:24px;line-height:1;">${esc(icon)}</span>
          <span>${esc(c.name)}</span>
          <span class="small muted" style="font-weight:normal;font-size:13px;">${esc(countLabel)}</span>
        </h2>
        ${c.description ? `<p class="small muted" style="margin:0 0 10px 0;">${esc(c.description)}</p>` : ''}
        ${body}
      </section>
    `;
  }).join('');
}

async function revealAdminEntryIfAdmin(){
  const btn = document.getElementById('atlasAdminEntry');
  if(!btn) return;
  try {
    const user = await getCurrentUser();
    if(!user) return;
    const profile = await getUserProfile(user);
    if(isAdminRole(normalizeRole(profile?.role))) btn.hidden = false;
  } catch {}
}


async function loadCategory(){
  const slug = qp('slug');
  const { data: c } = await supabase.from('atlas_categories').select('*').eq('slug',slug).maybeSingle();
  if(!c) return;
  document.getElementById('atlasCategoryTitle').textContent = c.name;
  document.getElementById('atlasCategoryDesc').textContent = c.description || '';
  const { data: t } = await supabase.from('atlas_topics').select('name,slug,summary').eq('category_id',c.id).eq('status','published').order('sort_order');
  document.getElementById('atlasCategoryTopics').innerHTML = (t||[]).map(x=>card(x.name,x.summary,`atlas-topic.html?slug=${encodeURIComponent(x.slug)}`)).join('') || '<div class="note">该专题正在建设中</div>';
}

async function loadTopic(){
  const slug = qp('slug');
  const tabsEl = document.getElementById('atlasTopicSeriesTabs');
  const gridEl = document.getElementById('atlasTopicAssetGrid');
  if(!tabsEl || !gridEl) return;
  gridEl.innerHTML = '<div class="note">加载中…</div>';

  const [{ data: t }, userObj] = await Promise.all([
    supabase.from('atlas_topics').select('*').eq('slug',slug).maybeSingle(),
    getCurrentUser(),
  ]);
  if(!t){ gridEl.innerHTML = '<div class="note">专题不存在</div>'; return; }

  document.getElementById('atlasTopicTitle').textContent = t.name;
  document.getElementById('atlasTopicSummary').textContent = t.summary || '';

  const profile = userObj ? await getUserProfile(userObj) : null;
  const isAdmin = isAdminRole(normalizeRole(profile?.role));
  const pro = userObj ? await hasAtlasPro(userObj.id) : false;

  // 查该专题下所有公开系列
  const seriesQuery = supabase.from('atlas_series')
    .select('id,title,slug,visibility,status,sort_order')
    .eq('topic_id', t.id)
    .neq('visibility', 'hidden')
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if(!isAdmin) seriesQuery.eq('status', 'published');  // admin 也看 draft 方便预览
  const { data: seriesList } = await seriesQuery;

  if(!seriesList || !seriesList.length){
    tabsEl.innerHTML = '';
    gridEl.innerHTML = '<div class="note">该专题正在建设中，可先查看其他图谱。</div>';
    return;
  }

  // 拉所有 series 下的 assets (非回收站)
  const seriesIds = seriesList.map(s=>s.id);
  const { data: allAssets } = await supabase.from('atlas_assets')
    .select('id,title,series_id,sequence_no,thumbnail_path,preview_image_path,visibility,is_preview')
    .in('series_id', seriesIds)
    .is('deleted_at', null)
    .order('series_id', { ascending: true })
    .order('sequence_no', { ascending: true });

  const assetsBySeries = {};
  (allAssets || []).forEach(a=>{
    (assetsBySeries[a.series_id] ||= []).push(a);
  });

  const totalCount = (allAssets || []).length;
  let activeId = 'all';   // 'all' 或某个 series.id

  function renderTabs(){
    const onlyOneSeries = seriesList.length === 1;
    if(onlyOneSeries){ tabsEl.innerHTML = ''; return; }  // 只有 1 个系列就不显示 tab
    const allBtn = `<button class="btn ${activeId==='all'?'primary':''}" data-tab="all" style="font-size:13px;">全部 · ${totalCount}</button>`;
    const seriesBtns = seriesList.map(s=>{
      const n = (assetsBySeries[s.id] || []).length;
      const draftTag = s.status === 'draft' ? ' · 草稿' : '';
      return `<button class="btn ${activeId===s.id?'primary':''}" data-tab="${s.id}" style="font-size:13px;">${esc(s.title)} · ${n}${draftTag}</button>`;
    }).join('');
    tabsEl.innerHTML = allBtn + seriesBtns;
    tabsEl.querySelectorAll('[data-tab]').forEach(btn=>{
      btn.onclick = ()=>{
        const v = btn.getAttribute('data-tab');
        activeId = (v === 'all') ? 'all' : Number(v);
        renderTabs();
        renderGrid();
      };
    });
  }

  function renderGrid(){
    let items = [];
    if(activeId === 'all'){
      seriesList.forEach(s=>{
        (assetsBySeries[s.id] || []).forEach(a => items.push({ ...a, _seriesTitle: s.title, _seriesSlug: s.slug }));
      });
    } else {
      const s = seriesList.find(x=>x.id === activeId);
      items = (assetsBySeries[activeId] || []).map(a => ({ ...a, _seriesTitle: s?.title, _seriesSlug: s?.slug }));
    }

    if(!items.length){
      gridEl.innerHTML = '<div class="note">该分组暂无图谱</div>';
      return;
    }

    gridEl.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;">
      ${items.map(a => assetCard(a)).join('')}
    </div>`;

    gridEl.querySelectorAll('[data-series-slug]').forEach(el=>{
      el.onclick = (e)=>{
        e.preventDefault();
        const sslug = el.getAttribute('data-series-slug');
        if(sslug) location.href = `atlas-series.html?slug=${encodeURIComponent(sslug)}`;
      };
    });
  }

  function assetCard(a){
    const thumb = publicUrl('atlas_previews', a.thumbnail_path || a.preview_image_path);
    const canHD = isAdmin || a.visibility === 'free' || a.is_preview || pro;
    const lockBadge = !canHD
      ? '<span class="badge" style="position:absolute;top:8px;right:8px;background:rgba(168,85,247,.85);color:#fff;border:none;font-size:11px;padding:3px 7px;">🔒 Pro</span>'
      : '';
    const imgStyle = `width:100%;aspect-ratio:1.4;object-fit:cover;background:rgba(255,255,255,.04);display:block;${canHD ? '' : 'filter:blur(10px);'}`;
    const imgHtml = thumb
      ? `<img src="${esc(thumb)}" alt="${esc(a.title||'')}" loading="lazy" style="${imgStyle}" />`
      : `<div style="aspect-ratio:1.4;background:rgba(255,255,255,.04);display:flex;align-items:center;justify-content:center;color:#888;font-size:13px;">无缩略图</div>`;
    return `<div class="card" data-series-slug="${esc(a._seriesSlug || '')}" style="padding:0;cursor:pointer;overflow:hidden;position:relative;">
      ${imgHtml}
      ${lockBadge}
      <div style="padding:10px 12px;">
        <div style="font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(a.title || '未命名')}</div>
        ${a._seriesTitle && activeId === 'all' ? `<div class="small muted" style="margin-top:2px;font-size:12px;">${esc(a._seriesTitle)}</div>` : ''}
      </div>
    </div>`;
  }

  renderTabs();
  renderGrid();
}

async function loadSeries(){
  const slug = qp('slug');
  const user = await getCurrentUser();
  const profile = user ? await getUserProfile(user) : null;
  const isAdmin = isAdminRole(normalizeRole(profile?.role));
  const pro = user ? await hasAtlasPro(user.id) : false;
  const { data: s } = await supabase.from('atlas_series').select('*').eq('slug',slug).maybeSingle();
  if(!s) return;
  document.getElementById('atlasSeriesTitle').textContent = s.title;
  document.getElementById('atlasSeriesSummary').textContent = s.summary || '';
  const { data: assets } = await supabase.from('atlas_assets').select('*').eq('series_id',s.id).is('deleted_at', null).order('sequence_no');
  let idx=0;
  const viewer = document.getElementById('atlasAssetViewer');
  async function resolveAssetUrl(a, canHD){
    const previewFallback = publicUrl('atlas_previews', a.preview_image_path) || publicUrl('atlas_previews', a.thumbnail_path);
    if(!canHD) return previewFallback;
    if(a.visibility==='free' || a.is_preview || s.visibility==='free') return previewFallback;
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const r = await fetch(`/api/atlas/assets/${encodeURIComponent(a.id)}/url`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const j = await r.json();
      return j.signedURL || j.url || previewFallback;
    } catch {
      return previewFallback;
    }
  }

  async function render(){
    if(!assets?.length){ viewer.innerHTML = '<div class="note">该系列正在建设中</div>'; return; }
    const a = assets[idx];
    const canHD = isAdmin || a.visibility==='free' || s.visibility==='free' || pro;
    const img = await resolveAssetUrl(a, canHD);
    viewer.innerHTML = `<div style="opacity:${canHD?1:0.55}">
      <div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
        <span>${String(idx+1).padStart(2,'0')}/${String(assets.length).padStart(2,'0')}</span>
        ${canHD && img ? '<span class="small muted">点击图片查看大图（← → 键翻页 · Esc 关闭）</span>' : ''}
      </div>
      <img id="atlasAssetImg" src="${esc(img||'')}" alt="${esc(a.alt_text||a.title||'atlas')}" style="width:100%;max-height:85vh;object-fit:contain;border-radius:10px;background:rgba(255,255,255,0.04);${canHD && img ? 'cursor:zoom-in;' : ''}" />
      <h3>${esc(a.title||'')}</h3>
      <p>${esc(canHD?(a.caption||''):'该图谱为肾域 Pro 内容，开通 GlomCon 教育会员查看完整高清图谱。')}</p>
      ${!canHD?'<a class="btn danger" href="membership.html">解锁肾域 Pro</a>':''}
    </div>`;
    if(canHD && img){
      const el = document.getElementById('atlasAssetImg');
      if(el) el.onclick = openLightbox;
    }
  }

  let lightboxOverlay = null;
  function openLightbox(){
    if(lightboxOverlay || !assets?.length) return;
    lightboxOverlay = document.createElement('div');
    lightboxOverlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.94);display:flex;align-items:center;justify-content:center;padding:20px;';
    const multi = assets.length > 1;
    lightboxOverlay.innerHTML = `
      ${multi ? '<button type="button" data-lb-prev style="position:absolute;left:16px;top:50%;transform:translateY(-50%);background:rgba(255,255,255,0.1);border:none;color:#fff;font-size:32px;width:48px;height:48px;border-radius:50%;cursor:pointer;line-height:1;">‹</button>' : ''}
      <img data-lb-img alt="" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;cursor:default;" />
      ${multi ? '<button type="button" data-lb-next style="position:absolute;right:16px;top:50%;transform:translateY(-50%);background:rgba(255,255,255,0.1);border:none;color:#fff;font-size:32px;width:48px;height:48px;border-radius:50%;cursor:pointer;line-height:1;">›</button>' : ''}
      <div data-lb-counter style="position:absolute;bottom:24px;left:50%;transform:translateX(-50%);color:#fff;background:rgba(0,0,0,0.5);padding:4px 12px;border-radius:4px;font-size:14px;"></div>
      <button type="button" data-lb-close style="position:absolute;top:16px;right:16px;background:rgba(255,255,255,0.1);border:none;color:#fff;font-size:20px;width:40px;height:40px;border-radius:50%;cursor:pointer;line-height:1;">✕</button>
    `;
    document.body.appendChild(lightboxOverlay);

    const lbImg = lightboxOverlay.querySelector('[data-lb-img]');
    const lbCounter = lightboxOverlay.querySelector('[data-lb-counter]');

    async function syncLightbox(){
      const a = assets[idx];
      const canHD = isAdmin || a.visibility==='free' || s.visibility==='free' || pro;
      lbImg.src = await resolveAssetUrl(a, canHD) || '';
      lbImg.alt = a.alt_text || a.title || '';
      lbCounter.textContent = `${idx+1} / ${assets.length}`;
    }

    const navigate = async (delta)=>{
      if(assets.length < 2) return;
      idx = (idx + delta + assets.length) % assets.length;
      await syncLightbox();
      render();
    };

    lbImg.onclick = (e)=>e.stopPropagation();
    lightboxOverlay.querySelector('[data-lb-prev]')?.addEventListener('click', (e)=>{ e.stopPropagation(); navigate(-1); });
    lightboxOverlay.querySelector('[data-lb-next]')?.addEventListener('click', (e)=>{ e.stopPropagation(); navigate(+1); });
    lightboxOverlay.querySelector('[data-lb-close]')?.addEventListener('click', (e)=>{ e.stopPropagation(); closeLightbox(); });
    lightboxOverlay.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', onLightboxKey);

    syncLightbox();
  }

  function closeLightbox(){
    if(!lightboxOverlay) return;
    document.removeEventListener('keydown', onLightboxKey);
    lightboxOverlay.remove();
    lightboxOverlay = null;
  }

  function onLightboxKey(e){
    if(!lightboxOverlay) return;
    if(e.key === 'Escape'){ closeLightbox(); return; }
    if(e.key === 'ArrowLeft'){ lightboxOverlay.querySelector('[data-lb-prev]')?.click(); return; }
    if(e.key === 'ArrowRight'){ lightboxOverlay.querySelector('[data-lb-next]')?.click(); return; }
  }

  document.getElementById('atlasPrev').onclick = ()=>{ if(!assets?.length) return; idx=(idx-1+assets.length)%assets.length; render(); };
  document.getElementById('atlasNext').onclick = ()=>{ if(!assets?.length) return; idx=(idx+1)%assets.length; render(); };
  render();
}

(async function init(){
  await ensureSupabase();
  if(!supabase) return;
  const p = location.pathname;
  if(p.endsWith('/atlas.html')||p==='/atlas') return loadAtlasHome();
  if(p.includes('atlas-category')) return loadCategory();
  if(p.includes('atlas-topic')) return loadTopic();
  if(p.includes('atlas-series')) return loadSeries();
})();
