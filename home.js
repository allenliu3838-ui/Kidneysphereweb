import {
  supabase,
  ensureSupabase,
  isConfigured,
  getUserProfile,
  getCurrentUser,
  isAdminRole,
  normalizeRole,
  levelLabelFromPoints,
  formatBeijingDateTime,
  formatBeijingDate,
} from './supabaseClient.js?v=20260309_001';

// DOM references — latest content section
const momentsRoot = document.querySelector('[data-home-moments]');
const momentsCard = document.getElementById('homeMoments');
const articlesRoot = document.querySelector('[data-home-articles]');
const articlesCard = document.getElementById('homeArticles');
const latestSection = document.getElementById('homeLatestSection');

// Home showcase board
const showcaseSection = document.querySelector('[data-home-showcase]');
const showcaseStatsEl = document.querySelector('[data-home-showcase-stats]');
const showcaseCardsEl = document.querySelector('[data-home-showcase-cards]');
const showcaseActionsEl = document.querySelector('[data-home-showcase-actions]');
const showcaseTabs = Array.from(document.querySelectorAll('[data-home-showcase-tab]'));
const showcasePrevBtn = document.querySelector('[data-home-showcase-prev]');
const showcaseNextBtn = document.querySelector('[data-home-showcase-next]');

let showcaseActiveKind = 'experts';

function esc(str){
  return String(str ?? '').replace(/[&<>"']/g, s => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[s]));
}

function ensureCoBuildingNeiKeTitle(raw){
  let t = String(raw || '').trim();
  if(!t) return '';
  t = t.replace(/\s*(肾脏内科|肾病科|肾内科|肾内|肾病)\s*$/,'').trim();
  if(/肾内科\s*$/.test(t)) return t;
  return t + '肾内科';
}

function iconForShowcase(kind){
  const k = String(kind || '').toLowerCase();
  if(k === 'experts') return '👤';
  if(k === 'flagship') return '🏥';
  if(k === 'co_building') return '🤝';
  if(k === 'partners') return '🤝';
  return '📌';
}

function shortDesc(desc, max = 120){
  const t = String(desc || '').replace(/\s+/g, ' ').trim();
  if(!t) return '';
  if(t.length <= max) return t;
  return t.slice(0, max) + '…';
}

function buildExpertList(cn = [], intl = [], limit){
  const out = [];
  const a = [...cn];
  const b = [...intl];
  const max = Number.isFinite(limit) ? Math.max(0, limit) : (a.length + b.length);
  while(out.length < max && (a.length || b.length)){
    if(a.length) out.push(a.shift());
    if(out.length >= max) break;
    if(b.length) out.push(b.shift());
  }
  return out;
}

function hash32(str){
  let h = 2166136261;
  const s = String(str || '');
  for(let i=0;i<s.length;i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a += 0x6D2B79F5;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(list, seed){
  const arr = Array.isArray(list) ? list.slice() : [];
  if(arr.length <= 1) return arr;
  const rand = mulberry32((seed >>> 0) || 1);
  for(let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function shuffleBySortBuckets(list, seed){
  const rows = Array.isArray(list) ? list : [];
  if(rows.length <= 1) return rows.slice();
  const buckets = new Map();
  for(const it of rows){
    const k = Number.isFinite(Number(it?.sort)) ? Number(it.sort) : 9999;
    if(!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(it);
  }
  const keys = Array.from(buckets.keys()).sort((a,b)=>a-b);
  const out = [];
  for(let i=0;i<keys.length;i++){
    const k = keys[i];
    const bucket = buckets.get(k) || [];
    const bucketSeed = (seed ^ hash32(String(k)) ^ (i * 2654435761)) >>> 0;
    out.push(...seededShuffle(bucket, bucketSeed));
  }
  return out;
}

function renderShowcaseCard(item, kind){
  const title = esc(kind === 'co_building' ? ensureCoBuildingNeiKeTitle(item?.title || '') : (item?.title || ''));
  const rawDesc = String(item?.description || '').trim();
  const imgUrl = String(item?.image_url || '').trim();

  let metaLine = '';
  let bodyDesc = rawDesc;
  let descHtml = '';
  if(kind === 'co_building'){
    descHtml = '';
  }else if(kind === 'experts'){
    const safeBody = bodyDesc.length > 8000 ? (bodyDesc.slice(0, 8000) + '…') : bodyDesc;
    descHtml = esc(safeBody).replace(/\n/g, '<br/>');
  }else{
    const safe = shortDesc(rawDesc, 180);
    descHtml = esc(safe).replace(/\n/g, '<br/>');
  }

  let href = '';
  if(item?.link){
    href = String(item.link);
  }else{
    if(kind === 'flagship') href = 'flagship.html';
    else if(kind === 'co_building' || kind === 'partners') href = 'partners.html';
    else if(kind === 'experts'){
      const c = String(item?.category || '').toLowerCase();
      href = (c === 'experts_intl') ? 'experts-intl.html' : 'experts-cn.html';
    }else href = 'about.html';
  }

  const regionPill = (kind === 'experts')
    ? `<span class="pill">${String(item?.category||'').toLowerCase() === 'experts_intl' ? '国际' : '国内'}</span>`
    : (kind === 'co_building')
      ? `<span class="pill">共建</span>`
      : (kind === 'partners')
        ? `<span class="pill">合作</span>`
        : `<span class="pill">旗舰</span>`;

  const thumb = imgUrl
    ? `<img class="thumb" src="${esc(imgUrl)}" alt="" loading="lazy" />`
    : `<div class="thumb" style="display:grid;place-items:center">${iconForShowcase(kind)}</div>`;

  const showToggle = (kind === 'experts') && !!bodyDesc && String(bodyDesc).trim().length > 0;
  const toggle = showToggle
    ? `<span class="more" role="button" tabindex="0" data-showcase-toggle aria-expanded="false">展开</span>`
    : '';

  return `
    <a class="home-showcase-card" data-kind="${esc(kind)}" href="${esc(href)}" ${item?.link ? 'target="_blank" rel="noopener"' : ''}>
      ${thumb}
      <div class="main">
        <div class="title">${title}</div>
        <div class="meta">
          ${regionPill}
          ${metaLine ? `<span class="muted" style="font-size:12px">${esc(metaLine)}</span>` : ''}
          ${toggle}
        </div>
        ${descHtml ? `<div class="desc">${descHtml}</div>` : ''}
      </div>
    </a>
  `;
}

function setTabActive(kind){
  showcaseTabs.forEach(btn => {
    const k = btn.getAttribute('data-home-showcase-tab');
    const active = k === kind;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function updateShowcaseActions(kind){
  if(!showcaseActionsEl) return;
  if(kind === 'experts'){
    showcaseActionsEl.innerHTML = `
      <a class="btn" href="experts-cn.html">国内专家</a>
      <a class="btn" href="experts-intl.html">国际专家</a>
      <a class="btn primary" href="about.html">了解更多</a>
    `;
    return;
  }
  if(kind === 'flagship'){
    showcaseActionsEl.innerHTML = `
      <a class="btn primary" href="flagship.html">查看全部旗舰中心</a>
      <a class="btn" href="about.html">了解更多</a>
    `;
    return;
  }
  showcaseActionsEl.innerHTML = `
    <a class="btn primary" href="partners.html">查看全部共建/合作单位</a>
    <a class="btn" href="about.html">了解更多</a>
  `;
}

function bindCarouselNav(){
  if(!showcaseCardsEl) return;
  const step = () => {
    const first = showcaseCardsEl.querySelector('.home-showcase-card');
    if(!first) return 320;
    const rect = first.getBoundingClientRect();
    return Math.max(260, Math.min(420, rect.width + 12));
  };

  function scrollByStep(dir){
    const s = step();
    showcaseCardsEl.scrollBy({ left: dir * s, behavior: 'smooth' });
  }

  showcasePrevBtn && showcasePrevBtn.addEventListener('click', (e)=>{
    e.preventDefault();
    scrollByStep(-1);
  });
  showcaseNextBtn && showcaseNextBtn.addEventListener('click', (e)=>{
    e.preventDefault();
    scrollByStep(1);
  });
}

function bindShowcaseExpand(){
  if(!showcaseCardsEl) return;
  if(showcaseCardsEl.dataset.expandBound === '1') return;
  showcaseCardsEl.dataset.expandBound = '1';

  function collapseOthers(keep){
    const expanded = showcaseCardsEl.querySelectorAll('.home-showcase-card.expanded');
    expanded.forEach(card => {
      if(keep && card === keep) return;
      card.classList.remove('expanded');
      const t = card.querySelector('[data-showcase-toggle]');
      if(t){
        t.textContent = '展开';
        t.setAttribute('aria-expanded','false');
      }
    });
  }

  function toggleCard(toggleEl){
    const card = toggleEl.closest('.home-showcase-card');
    if(!card) return;
    const kind = String(card.getAttribute('data-kind') || '').toLowerCase();
    if(kind !== 'experts') return;
    const isExpanded = card.classList.contains('expanded');
    if(isExpanded){
      card.classList.remove('expanded');
      toggleEl.textContent = '展开';
      toggleEl.setAttribute('aria-expanded','false');
    }else{
      collapseOthers(card);
      card.classList.add('expanded');
      toggleEl.textContent = '收起';
      toggleEl.setAttribute('aria-expanded','true');
    }
  }

  showcaseCardsEl.addEventListener('click', (e)=>{
    const t = e.target && e.target.closest && e.target.closest('[data-showcase-toggle]');
    if(!t) return;
    e.preventDefault();
    e.stopPropagation();
    toggleCard(t);
  });

  showcaseCardsEl.addEventListener('keydown', (e)=>{
    const t = e.target && e.target.closest && e.target.closest('[data-showcase-toggle]');
    if(!t) return;
    if(e.key === 'Enter' || e.key === ' '){
      e.preventDefault();
      e.stopPropagation();
      toggleCard(t);
    }
  });
}


function startAutoCarousel(){
  if(!showcaseCardsEl) return;
  let last = Date.now();
  function touch(){ last = Date.now(); }
  showcaseCardsEl.addEventListener('pointerdown', touch, { passive: true });
  showcaseCardsEl.addEventListener('wheel', touch, { passive: true });
  showcaseCardsEl.addEventListener('scroll', ()=>{
    last = Date.now();
  }, { passive: true });

  let stopped = false;
  function tick(){
    if(stopped || !document.body.contains(showcaseCardsEl)) return;
    const kind = showcaseActiveKind || 'experts';
    const interval = (kind === 'experts') ? 2800 : 6500;
    const pauseAfterInteractionMs = (kind === 'experts') ? 3500 : 6000;

    if(showcaseCardsEl.querySelector('.home-showcase-card.expanded')){
      setTimeout(tick, interval);
      return;
    }

    if(Date.now() - last >= pauseAfterInteractionMs){
      const max = showcaseCardsEl.scrollWidth - showcaseCardsEl.clientWidth;
      if(max > 0){
        const atEnd = showcaseCardsEl.scrollLeft >= max - 10;
        if(atEnd){
          showcaseCardsEl.scrollTo({ left: 0, behavior: 'auto' });
        }else{
          const first = showcaseCardsEl.querySelector('.home-showcase-card');
          const rect = first ? first.getBoundingClientRect() : null;
          const s = rect ? (rect.width + 12) : 320;
          showcaseCardsEl.scrollBy({ left: s, behavior: 'smooth' });
        }
      }
    }

    setTimeout(tick, interval);
  }
  setTimeout(tick, 3200);
  window.addEventListener('beforeunload', ()=>{ stopped = true; }, { once: true });
}

async function loadHomeShowcase(){
  if(!showcaseSection || !showcaseCardsEl) return;

  if(!isConfigured() || !supabase){
    if(showcaseStatsEl){
      showcaseStatsEl.innerHTML = `
        <span class="chip">核心专家 0</span>
        <span class="chip">旗舰中心 0</span>
        <span class="chip">共建单位 0</span>
        <span class="chip">合作单位 0</span>
      `;
    }
    showcaseCardsEl.innerHTML = `
      <div class="muted small">配置数据源后将自动展示核心专家、旗舰中心与合作单位。</div>
    `;
    updateShowcaseActions('experts');
    bindCarouselNav();
    return;
  }

  try{
    const [flagship, co, partners, cn, intl] = await Promise.all([
      supabase.from('about_showcase').select('id, category, title, description, image_url, link, sort, created_at').eq('category','flagship').order('sort',{ascending:true}).order('created_at',{ascending:false}),
      supabase.from('about_showcase').select('id, category, title, description, image_url, link, sort, created_at').eq('category','co_building').order('sort',{ascending:true}).order('created_at',{ascending:false}),
      supabase.from('about_showcase').select('id, category, title, description, image_url, link, sort, created_at').eq('category','partners').order('sort',{ascending:true}).order('created_at',{ascending:false}),
      supabase.from('about_showcase').select('id, category, title, description, image_url, link, sort, created_at').eq('category','experts_cn').order('sort',{ascending:true}).order('created_at',{ascending:false}),
      supabase.from('about_showcase').select('id, category, title, description, image_url, link, sort, created_at').eq('category','experts_intl').order('sort',{ascending:true}).order('created_at',{ascending:false}),
    ]);

    const err = flagship.error || co.error || partners.error || cn.error || intl.error;
    if(err) throw err;

    const data = {
      flagship: flagship.data || [],
      co_building: co.data || [],
      partners: partners.data || [],
      experts_cn: cn.data || [],
      experts_intl: intl.data || [],
    };

    const baseSeed = (() => {
      try{
        const a = new Uint32Array(1);
        crypto.getRandomValues(a);
        return a[0] >>> 0;
      }catch(_e){
        return (Math.floor(Math.random() * 4294967296) >>> 0);
      }
    })();
    const cnShuffled = seededShuffle(data.experts_cn, (baseSeed ^ 0xC0FFEE) >>> 0);
    const intlShuffled = seededShuffle(data.experts_intl, (baseSeed ^ 0xBADC0DE) >>> 0);

    const experts = buildExpertList(
      cnShuffled,
      intlShuffled,
      (data.experts_cn.length + data.experts_intl.length)
    );

    if(showcaseStatsEl){
      showcaseStatsEl.innerHTML = `
        <span class="chip">核心专家 ${data.experts_cn.length + data.experts_intl.length}</span>
        <span class="chip">旗舰中心 ${data.flagship.length}</span>
        <span class="chip">共建单位 ${data.co_building.length}</span>
        <span class="chip">合作单位 ${data.partners.length}</span>
      `;
    }

    const byTab = {
      experts,
      flagship: (data.flagship || []).slice(0, 12),
      co_building: (data.co_building || []).slice(0, 12),
      partners: (data.partners || []).slice(0, 12),
    };

    function render(kind){
      const list = byTab[kind] || [];
      showcaseActiveKind = kind || 'experts';
      setTabActive(kind);
      updateShowcaseActions(kind);
      if(list.length === 0){
        showcaseCardsEl.innerHTML = `<div class="muted small">暂无内容。</div>`;
        return;
      }
      showcaseCardsEl.innerHTML = list.map(it => renderShowcaseCard(it, kind)).join('');
      showcaseCardsEl.scrollTo({ left: 0, behavior: 'auto' });
    }

    if(showcaseTabs.length){
      showcaseTabs.forEach(btn=>{
        btn.addEventListener('click', (e)=>{
          e.preventDefault();
          const kind = btn.getAttribute('data-home-showcase-tab');
          if(!kind) return;
          render(kind);
        });
      });
    }

    bindCarouselNav();
    bindShowcaseExpand();
    render('experts');
    startAutoCarousel();
  }catch(e){
    console.error('Home showcase load failed', e);
    showcaseCardsEl.innerHTML = `<div class="muted small">读取展示内容失败。</div>`;
  }
}

function relTime(ts){
  try{
    const t = new Date(ts).getTime();
    const now = Date.now();
    if(Number.isNaN(t)) return '';
    const diff = Math.floor((now - t) / 1000);
    if(diff < 20) return '刚刚';
    if(diff < 60) return `${diff}秒前`;
    const m = Math.floor(diff / 60);
    if(m < 60) return `${m}分钟前`;
    const h = Math.floor(m / 60);
    if(h < 24) return `${h}小时前`;
    const d = Math.floor(h / 24);
    if(d < 7) return `${d}天前`;
    return formatBeijingDate(ts);
  }catch(_e){
    return '';
  }
}

// Show the "latest content" wrapper section if at least one sub-module has content
function showLatestSectionIfNeeded(){
  if(!latestSection) return;
  const hasArticles = articlesCard && !articlesCard.hidden;
  const hasMoments = momentsCard && !momentsCard.hidden;
  latestSection.hidden = !(hasArticles || hasMoments);
}

async function loadHome(){
  if(!momentsRoot && !articlesRoot && !showcaseSection) return;

  if(isConfigured() && !supabase){
    try{ await ensureSupabase(); }catch(_e){ /* ignore */ }
  }

  // Demo mode — hide dynamic content sections
  if(!isConfigured() || !supabase){
    if(showcaseSection){
      await loadHomeShowcase();
    }
    showLatestSectionIfNeeded();
    return;
  }

  // Showcase board
  if(showcaseSection){
    await loadHomeShowcase();
  }

  // Articles
  if(articlesRoot){
    articlesRoot.innerHTML = `<div class="muted small">加载中…</div>`;
    try{
      let data = null;
      let error = null;

      const r1 = await supabase
        .from('articles')
        .select('id, title, summary, cover_url, published_at, created_at, author_name, pinned, status, deleted_at, view_count, download_count')
        .eq('status', 'published')
        .is('deleted_at', null)
        .order('pinned', { ascending: false })
        .order('published_at', { ascending: false })
        .limit(6);

      data = r1.data;
      error = r1.error;

      if(error){
        const msg = String(error.message || error);
        if(msg.includes('download_count')){
          const r1c = await supabase
            .from('articles')
            .select('id, title, summary, cover_url, published_at, created_at, author_name, pinned, status, deleted_at, view_count')
            .eq('status', 'published')
            .is('deleted_at', null)
            .order('pinned', { ascending: false })
            .order('published_at', { ascending: false })
            .limit(6);
          data = r1c.data;
          error = r1c.error;
        }
        if(error){
          const msgV = String(error.message || error);
          if(msgV.includes('view_count')){
            const r1b = await supabase
              .from('articles')
              .select('id, title, summary, cover_url, published_at, created_at, author_name, pinned, status, deleted_at')
              .eq('status', 'published')
              .is('deleted_at', null)
              .order('pinned', { ascending: false })
              .order('published_at', { ascending: false })
              .limit(6);
            data = r1b.data;
            error = r1b.error;
          }
        }
        if(error){
          const msg2 = String(error.message || error);
          if(msg2.includes('pinned')){
            const r2 = await supabase
              .from('articles')
              .select('id, title, summary, cover_url, published_at, created_at, author_name, status, deleted_at')
              .eq('status', 'published')
              .is('deleted_at', null)
              .order('published_at', { ascending: false })
              .limit(6);
            data = r2.data;
            error = r2.error;
          }
        }
      }

      if(error) throw error;

      const items = (data || []).slice(0, 4);

      if(items.length === 0){
        // No articles — hide the entire card
        if(articlesCard) articlesCard.hidden = true;
      }else{
        if(articlesCard) articlesCard.hidden = false;
        articlesRoot.innerHTML = `
          <div class="stack">
            ${items.map(a=>{
              const title = a.title || '未命名';
              const summary = String(a.summary || '').trim();
              const cover = String(a.cover_url || '').trim();
              const when = a.published_at || a.created_at;
              const views = (typeof a.view_count === 'number' && Number.isFinite(a.view_count)) ? a.view_count : null;
              const meta = `${relTime(when)}${a.author_name ? ' · ' + esc(a.author_name) : ''}${views!==null ? ' · 阅读 ' + esc(String(views)) : ''}`;

              return `
                <a class="list-item" href="article.html?id=${encodeURIComponent(a.id)}">
                  <div style="display:flex;gap:10px;align-items:flex-start">
                    ${cover ? `<img class="thumb" alt="cover" src="${esc(cover)}" />` : ''}
                    <div style="min-width:0">
                      <b style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</b>
                      ${summary ? `<div class="small muted" style="margin-top:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(summary)}</div>` : ''}
                      <div class="small muted" style="margin-top:6px">${esc(meta)}</div>
                    </div>
                  </div>
                </a>
              `;
            }).join('')}
          </div>
        `;
      }
    }catch(e){
      // On error, hide the articles card (don't show error to public visitors)
      if(articlesCard) articlesCard.hidden = true;
    }
  }

  // Moments
  if(momentsRoot){
    momentsRoot.innerHTML = `<div class="muted small">加载中…</div>`;
    try{
      const { data, error } = await supabase
        .from('moments')
        .select('id, created_at, author_id, author_name, content, images, like_count')
        .order('created_at', { ascending: false })
        .limit(5);
      if(error) throw error;

      const items = (data || []).slice(0, 4);
      if(items.length === 0){
        if(momentsCard) momentsCard.hidden = true;
      }else{
        if(momentsCard) momentsCard.hidden = false;
        const authorIds = Array.from(new Set(items.map(x=>x.author_id).filter(Boolean)));
        const profileMap = new Map();
        if(authorIds.length){
          try{
            const { data: ps } = await supabase
              .from('profiles')
              .select('id, full_name, avatar_url, points')
              .in('id', authorIds);
            (ps || []).forEach(p=> profileMap.set(p.id, p));
          }catch(_e){ /* ignore */ }
        }

        momentsRoot.innerHTML = `
          <div class="home-list">
            ${items.map(m=>{
              const p = profileMap.get(m.author_id) || null;
              const name = p?.full_name || m.author_name || 'Member';
              const lv = levelLabelFromPoints(Number(p?.points || 0));

              const text = String(m.content || '').trim();
              const preview = text.length > 120 ? (text.slice(0,120) + '…') : text;
              const img = Array.isArray(m.images) && m.images.length ? String(m.images[0]) : '';

              const avatar = p?.avatar_url
                ? `<img class="home-thumb" alt="avatar" src="${esc(p.avatar_url)}" style="width:34px;height:34px;border-radius:999px" />`
                : `<div class="avatar" style="width:34px;height:34px;border-radius:999px">${esc(String(name).trim().slice(0,1).toUpperCase())}</div>`;

              const thumb = img ? `<img class="home-thumb" alt="img" src="${esc(img)}" />` : '';

              return `
                <a class="home-item" href="moments.html" title="打开动态">
                  <div class="meta">
                    <div class="who">
                      ${avatar}
                      <div style="min-width:0">
                        <b>${esc(name)}</b>
                        <div class="sub">${lv ? esc(lv) + ' · ' : ''}${esc(relTime(m.created_at))}</div>
                      </div>
                    </div>
                    <div class="sub">❤️ ${Number(m.like_count||0)}</div>
                  </div>
                  ${preview ? `<div class="preview">${esc(preview)}</div>` : ''}
                  ${thumb ? `<div style="margin-top:10px">${thumb}</div>` : ''}
                </a>
              `;
            }).join('')}
          </div>
        `;
      }
    }catch(e){
      if(momentsCard) momentsCard.hidden = true;
    }
  }

  showLatestSectionIfNeeded();
}

// Mobile sticky CTA: hide when scrolled to footer
function initStickyCtaVisibility(){
  const bar = document.getElementById('mobileStickyCtaBar');
  const footer = document.querySelector('footer.footer');
  if(!bar || !footer) return;

  function check(){
    const footerRect = footer.getBoundingClientRect();
    const hide = footerRect.top < window.innerHeight;
    bar.style.transform = hide ? 'translateY(100%)' : 'translateY(0)';
  }

  bar.style.transition = 'transform .25s ease';
  window.addEventListener('scroll', check, { passive: true });
  check();
}

loadHome();
initStickyCtaVisibility();
