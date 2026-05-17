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

// 教科书章节式专题页:
//   顶部粘性目录 (chips, 点击平滑滚动到对应章节)
//   主体按系列分块 (每个系列 = 一个章节, 头部 title + count + 可选 summary)
//   图卡智能去前缀 (避免 "狼疮性肾炎 · 治疗新变革 03" 在治疗新变革章节下冗余)
//   点图打开内嵌 lightbox, 全专题图片可左右翻 (跨章节)
//   admin 看到 draft 系列, 标 "草稿" 灰色
function shortAssetTitle(assetTitle, topicName, seriesTitle){
  const t = String(assetTitle || '').trim();
  if(!t) return '';
  const longPrefix = `${topicName} · ${seriesTitle}`;
  if(t.startsWith(longPrefix)){
    const tail = t.slice(longPrefix.length).trim();
    return tail || t;
  }
  if(seriesTitle && t.startsWith(seriesTitle)){
    const tail = t.slice(seriesTitle.length).trim();
    return tail || t;
  }
  return t;
}

async function loadTopic(){
  const slug = qp('slug');
  const tocEl = document.getElementById('atlasTopicToc');
  const sectionsEl = document.getElementById('atlasTopicSections');
  if(!tocEl || !sectionsEl) return;
  sectionsEl.innerHTML = '<div class="note">加载中…</div>';

  const [{ data: t }, userObj] = await Promise.all([
    supabase.from('atlas_topics').select('*').eq('slug',slug).maybeSingle(),
    getCurrentUser(),
  ]);
  if(!t){ sectionsEl.innerHTML = '<div class="note">专题不存在</div>'; return; }

  document.getElementById('atlasTopicTitle').textContent = t.name;
  document.getElementById('atlasTopicSummary').textContent = t.summary || '';

  const profile = userObj ? await getUserProfile(userObj) : null;
  const isAdmin = isAdminRole(normalizeRole(profile?.role));
  const pro = userObj ? await hasAtlasPro(userObj.id) : false;

  // 该专题下所有公开系列 (admin 看 draft 方便预览)
  const seriesQuery = supabase.from('atlas_series')
    .select('id,title,slug,summary,subtitle,visibility,status,sort_order')
    .eq('topic_id', t.id)
    .neq('visibility', 'hidden')
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if(!isAdmin) seriesQuery.eq('status', 'published');
  const { data: seriesList } = await seriesQuery;

  if(!seriesList || !seriesList.length){
    tocEl.innerHTML = '';
    sectionsEl.innerHTML = '<div class="note">该专题正在建设中，可先查看其他图谱。</div>';
    return;
  }

  // 所有 series 下的 assets (非回收站)
  const seriesIds = seriesList.map(s=>s.id);
  const { data: allAssets } = await supabase.from('atlas_assets')
    .select('id,title,series_id,sequence_no,thumbnail_path,preview_image_path,image_path,alt_text,caption,visibility,is_preview')
    .in('series_id', seriesIds)
    .is('deleted_at', null)
    .order('series_id', { ascending: true })
    .order('sequence_no', { ascending: true });

  const assetsBySeries = {};
  (allAssets || []).forEach(a=>{
    (assetsBySeries[a.series_id] ||= []).push(a);
  });

  // 构造扁平 asset 列表 (供 lightbox 跨章节翻页用)
  const flatAssets = [];
  seriesList.forEach(s=>{
    (assetsBySeries[s.id] || []).forEach(a=>{
      flatAssets.push({ ...a, _series: s });
    });
  });

  // 顶部统计
  document.getElementById('atlasTopicStats').textContent =
    `${seriesList.length} 章 · ${flatAssets.length} 张图谱`;

  // 渲染粘性目录条
  tocEl.innerHTML = `<div style="display:flex;gap:6px;overflow-x:auto;padding:0 2px;-webkit-overflow-scrolling:touch;">
    ${seriesList.map(s=>{
      const n = (assetsBySeries[s.id] || []).length;
      const draftTag = s.status === 'draft' ? ' · 草稿' : '';
      return `<a class="btn tiny" data-toc="${esc(s.slug)}" href="#series-${esc(s.slug)}" style="flex-shrink:0;font-size:13px;white-space:nowrap;">${esc(s.title)} · ${n}${draftTag}</a>`;
    }).join('')}
  </div>`;
  tocEl.querySelectorAll('[data-toc]').forEach(chip=>{
    chip.onclick = (e)=>{
      e.preventDefault();
      const sl = chip.getAttribute('data-toc');
      const target = document.getElementById(`series-${sl}`);
      if(target){
        const tocH = tocEl.getBoundingClientRect().height || 0;
        const y = target.getBoundingClientRect().top + window.scrollY - tocH - 8;
        window.scrollTo({ top: y, behavior: 'smooth' });
      }
    };
  });

  // 渲染章节
  let flatIdxCounter = 0;
  sectionsEl.innerHTML = seriesList.map(s=>{
    const assets = assetsBySeries[s.id] || [];
    const draftBadge = s.status === 'draft'
      ? ' <span class="badge" style="background:rgba(251,191,36,.18);border:1px solid rgba(251,191,36,.4);color:#fbbf24;font-size:12px;padding:2px 7px;">草稿</span>'
      : '';
    const summaryHtml = s.summary
      ? `<p style="margin:0 0 12px 0;opacity:.85;line-height:1.7;">${esc(s.summary)}</p>`
      : '';
    const subtitleHtml = s.subtitle
      ? `<div class="small muted" style="margin:-4px 0 8px 0;">${esc(s.subtitle)}</div>`
      : '';

    let assetsHtml;
    if(!assets.length){
      assetsHtml = '<div class="note" style="opacity:.7;">本章节暂无图谱</div>';
    } else {
      assetsHtml = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;">${
        assets.map(a=>{
          const idx = flatIdxCounter; flatIdxCounter += 1;
          return assetCard(a, s, idx);
        }).join('')
      }</div>`;
    }

    return `<section style="margin-top:28px;scroll-margin-top:70px;" id="series-${esc(s.slug)}">
      <h2 style="margin:0 0 4px 0;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;">
        <span style="font-size:18px;">📖</span>
        <span>${esc(s.title)}</span>
        <span class="small muted" style="font-weight:normal;font-size:13px;">${assets.length} 张</span>
        ${draftBadge}
      </h2>
      ${subtitleHtml}
      ${summaryHtml}
      ${assetsHtml}
    </section>`;
  }).join('');

  function assetCard(a, s, flatIdx){
    const thumb = publicUrl('atlas_previews', a.thumbnail_path || a.preview_image_path);
    const canHD = isAdmin || a.visibility === 'free' || a.is_preview || s.visibility === 'free' || pro;
    const shortLabel = shortAssetTitle(a.title || '', t.name, s.title);
    const lockBadge = !canHD
      ? '<span class="badge" style="position:absolute;top:8px;right:8px;background:rgba(168,85,247,.85);color:#fff;border:none;font-size:11px;padding:3px 7px;">🔒 Pro</span>'
      : '';
    const imgStyle = `width:100%;aspect-ratio:1.4;object-fit:cover;background:rgba(255,255,255,.04);display:block;${canHD ? '' : 'filter:blur(10px);'}`;
    const imgHtml = thumb
      ? `<img src="${esc(thumb)}" alt="${esc(a.title||'')}" loading="lazy" style="${imgStyle}" />`
      : `<div style="aspect-ratio:1.4;background:rgba(255,255,255,.04);display:flex;align-items:center;justify-content:center;color:#888;font-size:13px;">无缩略图</div>`;
    return `<div class="card" data-asset-idx="${flatIdx}" style="padding:0;cursor:pointer;overflow:hidden;position:relative;">
      ${imgHtml}
      ${lockBadge}
      <div style="padding:10px 12px;">
        <div style="font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(shortLabel || '未命名')}</div>
      </div>
    </div>`;
  }

  sectionsEl.querySelectorAll('[data-asset-idx]').forEach(el=>{
    el.onclick = ()=> openTopicLightbox(Number(el.getAttribute('data-asset-idx')));
  });

  // 滚动定位 active TOC chip (IntersectionObserver)
  setupTocSpy();

  function setupTocSpy(){
    if(!('IntersectionObserver' in window)) return;
    const sectionEls = sectionsEl.querySelectorAll('section[id^="series-"]');
    const chipBySlug = {};
    tocEl.querySelectorAll('[data-toc]').forEach(c=>{ chipBySlug[c.getAttribute('data-toc')] = c; });
    const setActive = (slug)=>{
      Object.values(chipBySlug).forEach(c=>{
        c.style.background = '';
        c.style.borderColor = '';
        c.style.color = '';
      });
      const a = chipBySlug[slug];
      if(a){
        a.style.background = 'rgba(74,144,226,.18)';
        a.style.borderColor = 'rgba(74,144,226,.5)';
        a.style.color = '#4a90e2';
      }
    };
    const io = new IntersectionObserver((entries)=>{
      const inView = entries.filter(e=>e.isIntersecting).sort((a,b)=>a.boundingClientRect.top - b.boundingClientRect.top);
      if(inView.length){
        const id = inView[0].target.id;
        const slug = id.replace(/^series-/,'');
        setActive(slug);
      }
    }, { rootMargin: '-80px 0px -60% 0px', threshold: 0 });
    sectionEls.forEach(el=>io.observe(el));
  }

  // ── 内嵌 lightbox: 全专题图跨章节左右翻 ──
  let lbIdx = 0;
  let overlay = null;
  let cachedUrls = {};   // assetId -> resolved URL

  async function resolveUrl(a){
    const previewFallback = publicUrl('atlas_previews', a.preview_image_path) || publicUrl('atlas_previews', a.thumbnail_path);
    const canHD = isAdmin || a.visibility === 'free' || a.is_preview || a._series.visibility === 'free' || pro;
    if(!canHD) return { url: previewFallback, canHD: false };
    if(a.visibility === 'free' || a.is_preview || a._series.visibility === 'free'){
      return { url: previewFallback, canHD: true };
    }
    if(cachedUrls[a.id]) return { url: cachedUrls[a.id], canHD: true };
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const r = await fetch(`/api/atlas/assets/${encodeURIComponent(a.id)}/url`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const j = await r.json();
      const url = j.signedURL || j.url || previewFallback;
      cachedUrls[a.id] = url;
      return { url, canHD: true };
    } catch {
      return { url: previewFallback, canHD: true };
    }
  }

  async function openTopicLightbox(startIdx){
    if(overlay || !flatAssets.length) return;
    lbIdx = Math.max(0, Math.min(startIdx, flatAssets.length - 1));
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.94);display:flex;align-items:center;justify-content:center;padding:20px;';
    const multi = flatAssets.length > 1;
    overlay.innerHTML = `
      ${multi ? '<button type="button" data-lb-prev style="position:absolute;left:16px;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.1);border:none;color:#fff;font-size:32px;width:48px;height:48px;border-radius:50%;cursor:pointer;line-height:1;">‹</button>' : ''}
      <div style="max-width:100%;max-height:100%;display:flex;flex-direction:column;align-items:center;gap:10px;">
        <img data-lb-img alt="" style="max-width:100%;max-height:78vh;object-fit:contain;border-radius:6px;" />
        <div data-lb-caption style="color:#ddd;text-align:center;max-width:760px;font-size:14px;line-height:1.5;"></div>
      </div>
      ${multi ? '<button type="button" data-lb-next style="position:absolute;right:16px;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.1);border:none;color:#fff;font-size:32px;width:48px;height:48px;border-radius:50%;cursor:pointer;line-height:1;">›</button>' : ''}
      <div data-lb-counter style="position:absolute;bottom:24px;left:50%;transform:translateX(-50%);color:#fff;background:rgba(0,0,0,.55);padding:5px 14px;border-radius:6px;font-size:13px;"></div>
      <button type="button" data-lb-close style="position:absolute;top:16px;right:16px;background:rgba(255,255,255,.1);border:none;color:#fff;font-size:20px;width:40px;height:40px;border-radius:50%;cursor:pointer;line-height:1;">✕</button>
    `;
    document.body.appendChild(overlay);

    const lbImg = overlay.querySelector('[data-lb-img]');
    const lbCounter = overlay.querySelector('[data-lb-counter]');
    const lbCaption = overlay.querySelector('[data-lb-caption]');

    async function sync(){
      const a = flatAssets[lbIdx];
      const { url, canHD } = await resolveUrl(a);
      lbImg.src = url || '';
      lbImg.alt = a.alt_text || a.title || '';
      lbImg.style.filter = canHD ? '' : 'blur(14px)';
      const seriesName = a._series?.title || '';
      const shortLbl = shortAssetTitle(a.title || '', t.name, seriesName);
      lbCounter.textContent = `${lbIdx + 1} / ${flatAssets.length}  ·  ${seriesName}`;
      lbCaption.innerHTML = canHD
        ? `<div style="font-weight:600;margin-bottom:4px;">${esc(shortLbl || a.title || '')}</div>${a.caption ? `<div style="opacity:.8;">${esc(a.caption)}</div>` : ''}`
        : `<div>该图谱为肾域 Pro 内容，<a href="checkout.html?product=MEMBERSHIP-YEARLY" style="color:#4a90e2;">开通 GlomCon 教育会员</a> 查看完整高清图谱。</div>`;
    }

    function navigate(delta){
      if(flatAssets.length < 2) return;
      lbIdx = (lbIdx + delta + flatAssets.length) % flatAssets.length;
      sync();
    }

    lbImg.onclick = (e)=>e.stopPropagation();
    overlay.querySelector('[data-lb-prev]')?.addEventListener('click', (e)=>{ e.stopPropagation(); navigate(-1); });
    overlay.querySelector('[data-lb-next]')?.addEventListener('click', (e)=>{ e.stopPropagation(); navigate(+1); });
    overlay.querySelector('[data-lb-close]')?.addEventListener('click', (e)=>{ e.stopPropagation(); closeLb(); });
    overlay.addEventListener('click', closeLb);
    document.addEventListener('keydown', onKey);
    sync();
  }

  function closeLb(){
    if(!overlay) return;
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    overlay = null;
  }

  function onKey(e){
    if(!overlay) return;
    if(e.key === 'Escape'){ closeLb(); return; }
    if(e.key === 'ArrowLeft'){ overlay.querySelector('[data-lb-prev]')?.click(); return; }
    if(e.key === 'ArrowRight'){ overlay.querySelector('[data-lb-next]')?.click(); return; }
  }
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
