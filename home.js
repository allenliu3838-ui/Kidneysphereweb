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
} from './supabaseClient.js?v=20260128_030';

const nextRoot = document.querySelector('[data-home-next-meeting]');
const momentsRoot = document.querySelector('[data-home-moments]');
const sponsorsRoot = document.querySelector('[data-home-sponsors]');
const sponsorsCard = document.getElementById('homeSponsors');
const articlesRoot = document.querySelector('[data-home-articles]');
const postMomentBtn = document.querySelector('[data-home-post-moment]');

// Home showcase board
const showcaseSection = document.querySelector('[data-home-showcase]');
const showcaseStatsEl = document.querySelector('[data-home-showcase-stats]');
const showcaseCardsEl = document.querySelector('[data-home-showcase-cards]');
const showcaseActionsEl = document.querySelector('[data-home-showcase-actions]');
const showcaseTabs = Array.from(document.querySelectorAll('[data-home-showcase-tab]'));
const showcasePrevBtn = document.querySelector('[data-home-showcase-prev]');
const showcaseNextBtn = document.querySelector('[data-home-showcase-next]');

// Track current tab so the auto-play can adapt (experts rotates faster to ensure everyone gets exposure).
let showcaseActiveKind = 'experts';

function esc(str){
  return String(str ?? '').replace(/[&<>"']/g, s => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[s]));
}

function ensureCoBuildingNeiKeTitle(raw){
  let t = String(raw || '').trim();
  if(!t) return '';
  // unify variants at end then ensure suffix
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

function pickFirstLine(desc){
  const t = String(desc || '').trim();
  if(!t) return '';
  const i = t.indexOf('\n');
  return (i >= 0 ? t.slice(0, i) : t).trim();
}

function shortDesc(desc, max = 120){
  const t = String(desc || '').replace(/\s+/g, ' ').trim();
  if(!t) return '';
  if(t.length <= max) return t;
  return t.slice(0, max) + '…';
}

function buildExpertList(cn = [], intl = [], limit){
  // Home showcase should be fair: include *all* experts in the rotation pool.
  // We still interleave CN/INTL for a balanced feel.
  const out = [];
  const a = [...cn];
  const b = [...intl];
  const max = Number.isFinite(limit) ? Math.max(0, limit) : (a.length + b.length);

  // Interleave for a balanced “国内/国际” feel
  while(out.length < max && (a.length || b.length)){
    if(a.length) out.push(a.shift());
    if(out.length >= max) break;
    if(b.length) out.push(b.shift());
  }
  return out;
}

// ------------------------------
// Daily deterministic shuffle (Beijing time)
// - Everyone sees the same order on the same Beijing date
// - Next Beijing day: different order
// - Still respects `sort` priority: shuffle within each sort bucket
// ------------------------------
function hash32(str){
  // FNV-1a 32bit (fast, stable)
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
    // Mix base seed with bucket key to produce distinct bucket shuffles.
    const bucketSeed = (seed ^ hash32(String(k)) ^ (i * 2654435761)) >>> 0;
    out.push(...seededShuffle(bucket, bucketSeed));
  }
  return out;
}

function renderShowcaseCard(item, kind){
  const title = esc(kind === 'co_building' ? ensureCoBuildingNeiKeTitle(item?.title || '') : (item?.title || ''));
  const rawDesc = String(item?.description || '').trim();
  const imgUrl = String(item?.image_url || '').trim();

  // Experts: keep the full bio text together (no splitting), so we never “lose” content.
  // (Earlier versions split the first line into meta; users反馈“简介不全/不一致”.)
  let metaLine = '';
  let bodyDesc = rawDesc;

  // Keep (almost) full text in DOM; CSS controls preview via line-clamp.
  // This fixes “简介引用不全” caused by JS-level truncation.
  let descHtml = '';
  if(kind === 'co_building'){
    // 共建单位：按需求仅展示医院/机构名称（不展示联系人/备注）。
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

  // Experts: always offer “展开/收起”，避免因为字符数/换行结构导致正文被 clamp 截断但按钮不出现。
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
  if(kind === 'co_building'){
    showcaseActionsEl.innerHTML = `
      <a class="btn primary" href="partners.html">查看全部共建/合作单位</a>
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
  // Bind once
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
    // Only experts cards have expand toggles
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
    // Prevent the parent <a> navigation
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
  // simple auto-scroll; pauses on interaction
  let last = Date.now();
  function touch(){ last = Date.now(); }
  showcaseCardsEl.addEventListener('pointerdown', touch, { passive: true });
  showcaseCardsEl.addEventListener('wheel', touch, { passive: true });
  showcaseCardsEl.addEventListener('scroll', ()=>{
    // user scroll updates too frequently; keep lightweight
    last = Date.now();
  }, { passive: true });

  // Use a self-scheduling loop so we can vary pacing by tab.
  let stopped = false;
  function tick(){
    if(stopped || !document.body.contains(showcaseCardsEl)) return;

    const kind = showcaseActiveKind || 'experts';
    // Experts rotate faster so everyone can appear on the homepage in a reasonable time.
    const interval = (kind === 'experts') ? 2800 : 6500;
    const pauseAfterInteractionMs = (kind === 'experts') ? 3500 : 6000;

    // If a card is expanded, pause auto-play so the user can read the full bio.
    if(showcaseCardsEl.querySelector('.home-showcase-card.expanded')){
      setTimeout(tick, interval);
      return;
    }

    // If user interacted recently, don't auto-move.
    if(Date.now() - last >= pauseAfterInteractionMs){
      const max = showcaseCardsEl.scrollWidth - showcaseCardsEl.clientWidth;
      if(max > 0){
        const atEnd = showcaseCardsEl.scrollLeft >= max - 10;
        if(atEnd){
          // Jump back without a long animated rewind.
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

  // Safety in case SPA-like navigation replaces the DOM.
  window.addEventListener('beforeunload', ()=>{ stopped = true; }, { once: true });
}

async function loadHomeShowcase(){
  if(!showcaseSection || !showcaseCardsEl) return;

  // demo mode
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
      <div class="muted small">（演示模式）配置 Supabase 后将自动展示核心专家/旗舰中心/共建与合作单位。</div>
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

    // Include ALL experts in the rotation pool so everyone appears on the homepage.
    // Per-visit shuffle: every page load gets a fresh randomized order (fair exposure).
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

    // Stats
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
        showcaseCardsEl.innerHTML = `<div class="muted small">暂无内容。你可以在「关于」页维护该模块。</div>`;
        return;
      }
      showcaseCardsEl.innerHTML = list.map(it => renderShowcaseCard(it, kind)).join('');
      showcaseCardsEl.scrollTo({ left: 0, behavior: 'auto' });
    }

    // Tabs
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
    showcaseCardsEl.innerHTML = `<div class="muted small">读取展示内容失败：${esc(e?.message || String(e))}</div>`;
  }
}

function fmtBeijing(ts){
  // Unified formatting: always show Beijing time (Asia/Shanghai)
  return formatBeijingDateTime(ts, { suffix: '（北京时间）' });
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

function roleLabelZh(role){
  const r = normalizeRole(role);
  if(!r) return 'Member';
  if(r === 'doctor' || r === 'doctor_verified') return '医生';
  if(r === 'doctor_pending') return '医生（待认证）';
  if(r === 'industry') return '企业/赞助';
  if(r === 'official') return '官方';
  if(r === 'admin') return '管理员';
  if(r === 'moderator') return '版主';
  if(r === 'super_admin' || r === 'owner') return '超级管理员';
  if(r === 'member' || r === 'user') return 'Member';
  return role;
}

function isOnlinePlatform(platform){
  const p = String(platform || '').toLowerCase();
  if(!p) return true; // default to online if not specified
  return (
    p.includes('zoom') ||
    p.includes('腾讯') ||
    p.includes('tencent') ||
    p.includes('线上') ||
    p.includes('online') ||
    p.includes('webinar')
  );
}


async function fetchUpcomingEvents(nowIso){
  // v7: include speaker info on home card (may require MIGRATION_20260107_NEXT.sql)
  const baseFields = 'id, title_zh, platform, status, next_time, rule_zh, updated_at, speaker_name, speaker_title, speaker_bio, speaker_avatar_url';
  const fallbackFields = 'id, title_zh, platform, status, next_time, rule_zh, updated_at, speaker_name, speaker_title, speaker_bio';

  try{
    const { data, error } = await supabase
      .from('event_series')
      .select(baseFields)
      .not('next_time', 'is', null)
      .gte('next_time', nowIso)
      .order('next_time', { ascending: true })
      .limit(20);
    if(error) throw error;
    return data || [];
  }catch(e){
    const msg = String(e?.message || e || '');
    // If schema hasn't been migrated (speaker_avatar_url missing), fallback gracefully
    if(msg.includes('speaker_avatar_url')){
      const { data, error } = await supabase
        .from('event_series')
        .select(fallbackFields)
        .not('next_time', 'is', null)
        .gte('next_time', nowIso)
        .order('next_time', { ascending: true })
        .limit(20);
      if(error) throw error;
      return data || [];
    }
    throw e;
  }
}

async function fetchRecentEventsFallback(){
  const baseFields = 'id, title_zh, platform, status, next_time, rule_zh, updated_at, speaker_name, speaker_title, speaker_bio, speaker_avatar_url';
  const fallbackFields = 'id, title_zh, platform, status, next_time, rule_zh, updated_at, speaker_name, speaker_title, speaker_bio';
  try{
    const { data, error } = await supabase
      .from('event_series')
      .select(baseFields)
      .order('updated_at', { ascending: false })
      .limit(20);
    if(error) throw error;
    return data || [];
  }catch(e){
    const msg = String(e?.message || e || '');
    if(msg.includes('speaker_avatar_url')){
      const { data, error } = await supabase
        .from('event_series')
        .select(fallbackFields)
        .order('updated_at', { ascending: false })
        .limit(20);
      if(error) throw error;
      return data || [];
    }
    throw e;
  }
}

async function loadHome(){
  if(!nextRoot && !momentsRoot && !sponsorsRoot && !articlesRoot && !showcaseSection) return;

  // Ensure client first (this script can run before app.js finishes initializing)
  if(isConfigured() && !supabase){
    try{ await ensureSupabase(); }catch(_e){ /* ignore */ }
  }

  // Demo mode
  if(!isConfigured() || !supabase){
    if(nextRoot){
      nextRoot.innerHTML = `
        <div class="muted small">（演示模式）配置 Supabase 后将自动展示下一场线上会议时间。</div>
        <div class="small" style="margin-top:8px">示例：周日 10:00（北京时间） · Zoom</div>
      `;
    }
    if(momentsRoot){
      momentsRoot.innerHTML = `
        <div class="muted small">（演示模式）配置 Supabase 后将展示最新 Moments 预览。</div>
      `;
    }
    if(sponsorsRoot){
      sponsorsRoot.innerHTML = `
        <div class="muted small">（演示模式）配置 Supabase 后将展示赞助商 Logo 墙。</div>
      `;
    }
    if(articlesRoot){
      articlesRoot.innerHTML = `
        <div class="muted small">（演示模式）配置 Supabase 后将展示最新文章。</div>
      `;
    }

    // Home showcase demo
    if(showcaseSection){
      await loadHomeShowcase();
    }
    return;
  }

  // Session (for join link visibility / “发布动态”按钮文案)
  let user = null;
  let isAdmin = false;
  try{
    user = await getCurrentUser();
  }catch(_e){
    user = null;
  }

  // Admin hinting (best-effort): used to decide whether to keep empty blocks visible.
  if(user){
    try{
      const me = await getUserProfile(user.id);
      isAdmin = isAdminRole(me?.role);
    }catch(_e){
      isAdmin = false;
    }
  }

  if(postMomentBtn && !user){
    postMomentBtn.textContent = '登录后发布';
    postMomentBtn.classList.remove('primary');
    postMomentBtn.classList.add('btn');
    postMomentBtn.href = 'login.html?next=' + encodeURIComponent('moments.html#composer');
  }

  // Showcase board (experts / flagship / partners)
  if(showcaseSection){
    await loadHomeShowcase();
  }

  // 1) Next online meeting
  if(nextRoot){
    nextRoot.innerHTML = `<div class="muted small">加载中…</div>`;
    try{
      const nowIso = new Date().toISOString();

      const data = await fetchUpcomingEvents(nowIso);

      const upcoming = (data || [])
        .filter(ev => String(ev.status || '').toLowerCase() !== 'canceled')
        .filter(ev => isOnlinePlatform(ev.platform))
        .sort((a,b)=> new Date(a.next_time).getTime() - new Date(b.next_time).getTime());

      let ev = upcoming[0] || null;

      // Fallback: if no next_time set yet, show the first non-canceled online series rule
      if(!ev){
        const all = await fetchRecentEventsFallback();
        ev = (all || [])
          .filter(x => String(x.status || '').toLowerCase() !== 'canceled')
          .filter(x => isOnlinePlatform(x.platform))
          .find(x => x.rule_zh || x.title_zh) || null;
      }

      if(!ev){
        nextRoot.innerHTML = `<div class="muted small">暂无即将举行的线上会议，敬请关注。</div>`;
      }else{
        const status = String(ev.status||'').toLowerCase();
        const statusBadge = status === 'confirmed'
          ? '<span class="chip soon">已确认</span>'
          : status === 'rescheduled'
          ? '<span class="chip todo">已改期</span>'
          : status === 'planning'
          ? '<span class="chip todo">筹备中</span>'
          : '<span class="chip todo">待确认</span>';

        const timeLine = ev.next_time
          ? `<div class="small" style="margin-top:8px">时间：<b>${esc(fmtBeijing(ev.next_time))}</b></div>`
          : (ev.rule_zh ? `<div class="small" style="margin-top:8px">常规：<b>${esc(ev.rule_zh)}</b></div>` : '');

        const spName = String(ev.speaker_name || '').trim();
        const spTitle = String(ev.speaker_title || '').trim();
        const spBio = String(ev.speaker_bio || '').trim();
        const spAvatar = String(ev.speaker_avatar_url || '').trim();

        const speakerLine = [spName ? `<b>${esc(spName)}</b>` : '', spTitle ? `<span class="muted">${esc(spTitle)}</span>` : '']
          .filter(Boolean)
          .join(' · ');

        const speakerHtml = (spName || spTitle || spBio || spAvatar)
          ? `
            <div class="speaker-block" style="margin-top:10px">
              ${spAvatar ? `<img class="speaker-avatar" src="${esc(spAvatar)}" alt="讲者头像" />` : ''}
              <div class="speaker-text">
                <div class="small"><span class="muted">讲者：</span>${speakerLine || '<span class="muted">（待更新）</span>'}</div>
                ${spBio ? `<div class="small muted" style="margin-top:6px">${esc(spBio).replace(/\n/g,'<br/>')}</div>` : ''}
              </div>
            </div>
          `
          : '';

        // Optional join link for authed users when confirmed
        let joinHtml = '';
        if(user && status === 'confirmed'){
          try{
            const { data: linkRow } = await supabase
              .from('event_links')
              .select('join_url, passcode')
              .eq('event_id', ev.id)
              .maybeSingle();
            if(linkRow?.join_url){
              joinHtml = `
                <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;align-items:center">
                  <a class="btn primary" target="_blank" rel="noopener" href="${esc(linkRow.join_url)}">进入会议</a>
                  ${linkRow.passcode ? `<span class="small muted">口令：${esc(linkRow.passcode)}</span>` : ''}
                </div>
              `;
            }
          }catch(_e){ /* ignore */ }
        }

        // Show next few events as "最近安排"
        const more = upcoming.slice(1, 4);
        const moreHtml = more.length
          ? `
            <div class="hr" style="margin:12px 0"></div>
            <div class="small muted" style="margin-bottom:8px">最近安排（自动读取）</div>
            <div class="stack">
              ${more.map(x=>{
                const t = x.next_time ? fmtBeijing(x.next_time) : (x.rule_zh || '');
                return `<a class="list-item" href="events.html">
                  <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
                    <div style="min-width:0"><b style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.title_zh || '线上会议')}</b>
                      <div class="small muted" style="margin-top:4px">${esc(x.platform || '线上')} · ${esc(t)}</div>
                    </div>
                    <span class="chip">${esc(String(x.status||'').toLowerCase()==='confirmed'?'已确认':'待更新')}</span>
                  </div>
                </a>`;
              }).join('')}
            </div>
          `
          : '';

        nextRoot.innerHTML = `
          <div class="home-item">
            <div class="meta">
              <div class="who" style="min-width:0">
                <b style="display:block;min-width:0">${esc(ev.title_zh || '线上会议')}</b>
                <span class="sub">${esc(ev.platform || '线上')} · ${statusBadge}</span>
              </div>
            </div>
            ${timeLine}
            ${ev.rule_zh && ev.next_time ? `<div class="small muted" style="margin-top:6px">常规：${esc(ev.rule_zh)}</div>` : ''}
            ${speakerHtml}
            ${joinHtml}
            ${moreHtml}
          </div>
          <div class="small muted" style="margin-top:10px" data-superadmin-only hidden>提示：管理员可在 Events 更新 next_time / 改期 / 取消，并维护讲者信息与照片。</div>
        `;
      }
    }catch(e){
      nextRoot.innerHTML = `<div class="muted small">读取会议失败：${esc(e.message || String(e))}</div>`;
    }
  }

// 2) Latest Moments preview
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
        momentsRoot.innerHTML = `<div class="muted small">暂无动态。你可以成为第一个发布的人。</div>`;
      }else{
        // Fetch author profiles in one batch (best-effort)
        const authorIds = Array.from(new Set(items.map(x=>x.author_id).filter(Boolean)));
        const profileMap = new Map();
        if(authorIds.length){
          try{
            const { data: ps } = await supabase
              .from('profiles')
              .select('id, full_name, role, avatar_url, points, membership_status')
              .in('id', authorIds);
            (ps || []).forEach(p=> profileMap.set(p.id, p));
          }catch(_e){ /* ignore */ }
        }

        momentsRoot.innerHTML = `
          <div class="home-list">
            ${items.map(m=>{
              const p = profileMap.get(m.author_id) || null;
              const name = p?.full_name || m.author_name || 'Member';
              const role = roleLabelZh(p?.role || 'member');
              const lv = levelLabelFromPoints(Number(p?.points || 0));
              const membership = String(p?.membership_status || '').trim().toLowerCase();
              const memberBadge = (membership && membership !== 'none') ? '会员' : '';
              const badgeLine = [role, lv, memberBadge].filter(Boolean).join(' · ');

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
                        <div class="sub">${esc(badgeLine)} · ${esc(relTime(m.created_at))}</div>
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
      const msg = (e && (e.message || e.error_description)) ? String(e.message || e.error_description) : String(e);
      if(/could not find the table/i.test(msg) && msg.includes('moments')){
        momentsRoot.innerHTML = `
          <div class="note"><b>Moments 未初始化：</b>未找到 <code>public.moments</code> 表。<br/>
          请在 Supabase → SQL Editor 运行最新版 <code>SUPABASE_SETUP.sql</code>（或 <code>MIGRATION_ONLY_MOMENTS.sql</code>），
          然后在 Supabase → Settings → API 点击 “Reload schema”。</div>
        `;
      }else{
        momentsRoot.innerHTML = `<div class="muted small">读取动态失败：${esc(msg)}</div>`;
      }
    }
  }


  // 3) Latest Articles preview
  if(articlesRoot){
    articlesRoot.innerHTML = `<div class="muted small">加载中…</div>`;
    try{
      // Prefer pinned + published_at order (requires MIGRATION_20260107_NEXT.sql)
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

      // Backward compatibility: older schema may not have view_count / pinned
      if(error){
        const msg = String(error.message || error);
        // Retry w/o download_count
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

        // Retry w/o view_count
        if(error){
          const msgV = String(error.message || error);
          if(msgV.includes('view_count')){
          const r1b = await supabase
            .from('articles')
              .select('id, title, summary, cover_url, published_at, created_at, author_name, pinned, status, deleted_at, download_count')
            .eq('status', 'published')
            .is('deleted_at', null)
            .order('pinned', { ascending: false })
            .order('published_at', { ascending: false })
            .limit(6);
          data = r1b.data;
          error = r1b.error;
          }
        }

        // Retry w/o pinned
        if(error){
          const msg2 = String(error.message || error);
          if(msg2.includes('pinned')){
            const r2 = await supabase
              .from('articles')
              .select('id, title, summary, cover_url, published_at, created_at, author_name, status, deleted_at, view_count, download_count')
              .eq('status', 'published')
              .is('deleted_at', null)
              .order('published_at', { ascending: false })
              .limit(6);
            data = r2.data;
            error = r2.error;

            // Retry w/o counter columns on older schema
            if(error){
              const msg3 = String(error.message || error);
              if(msg3.includes('download_count')){
                const r2c = await supabase
                  .from('articles')
                  .select('id, title, summary, cover_url, published_at, created_at, author_name, status, deleted_at, view_count')
                  .eq('status', 'published')
                  .is('deleted_at', null)
                  .order('published_at', { ascending: false })
                  .limit(6);
                data = r2c.data;
                error = r2c.error;
              }
            }
            if(error){
              const msg4 = String(error.message || error);
              if(msg4.includes('view_count')){
                const r2b = await supabase
                  .from('articles')
                  .select('id, title, summary, cover_url, published_at, created_at, author_name, status, deleted_at')
                  .eq('status', 'published')
                  .is('deleted_at', null)
                  .order('published_at', { ascending: false })
                  .limit(6);
                data = r2b.data;
                error = r2b.error;
              }
            }
          }
        }
      }

      if(error) throw error;

      const items = (data || []).slice(0, 4);

      if(items.length === 0){
        articlesRoot.innerHTML = `<div class="muted small">暂无文章，敬请关注。</div>`;
      }else{
        articlesRoot.innerHTML = `
          <div class="stack">
            ${items.map(a=>{
              const title = a.title || '未命名';
              const summary = String(a.summary || '').trim();
              const cover = String(a.cover_url || '').trim();
              const when = a.published_at || a.created_at;
              const views = (typeof a.view_count === 'number' && Number.isFinite(a.view_count)) ? a.view_count : null;
              const dls = (typeof a.download_count === 'number' && Number.isFinite(a.download_count)) ? a.download_count : null;
              const likes = (typeof a.like_count === 'number' && Number.isFinite(a.like_count)) ? a.like_count : null;
              const meta = `${relTime(when)}${a.author_name ? ' · ' + esc(a.author_name) : ''}${views!==null ? ' · 阅读 ' + esc(String(views)) : ''}${dls!==null ? ' · 下载 ' + esc(String(dls)) : ''}${likes!==null ? ' · 点赞 ' + esc(String(likes)) : ''}`;

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
      const msg = esc(e?.message || String(e));
      articlesRoot.innerHTML = `
        <div class="muted small">读取文章失败：${msg}</div>
        <div class="small muted" style="margin-top:8px">提示：请在 Supabase 运行 <b>MIGRATION_20260107_NEXT.sql</b> 创建 articles 表并刷新 schema。</div>
      `;
    }
  }

  // 4) Sponsors wall
  if(sponsorsRoot){
    sponsorsRoot.innerHTML = `<div class="muted small">加载中…</div>`;
    try{
      // Prefer v4.1 column show_on_home when available
      let res = await supabase
        .from('sponsors')
        .select('id, name, logo_url, website, enabled, sort, created_at, show_on_home')
        .order('sort', { ascending: true })
        .order('created_at', { ascending: false });

      // Backward compatibility: column may not exist yet
      if(res?.error && String(res.error.message||'').toLowerCase().includes('column')){
        res = await supabase
          .from('sponsors')
          .select('id, name, logo_url, website, enabled, sort, created_at')
          .order('sort', { ascending: true })
          .order('created_at', { ascending: false });
      }

      if(res?.error) throw res.error;

      const rows = (res.data || []).filter(s => Boolean(s.enabled));
      const filtered = rows.filter(s => (
        (typeof s.show_on_home === 'undefined') ? true : Boolean(s.show_on_home)
      ));
      const list = filtered.slice(0, 12);

      if(list.length === 0){
        // UX: hide the entire block for normal visitors; keep a small hint for admins.
        if(sponsorsCard) sponsorsCard.hidden = !isAdmin;
        if(isAdmin){
          sponsorsRoot.innerHTML = `<div class="muted small">暂无赞助商信息。</div>`;
        }
      }else{
        if(sponsorsCard) sponsorsCard.hidden = false;
        sponsorsRoot.innerHTML = `
          <div class="sponsor-wall">
            ${list.map(s=>{
              const img = s.logo_url
                ? `<img alt="${esc(s.name)}" src="${esc(s.logo_url)}" />`
                : ``;
              const name = `<div class="sponsor-name">${esc(s.name || 'Sponsor')}</div>`;
              const inner = `<div class="sponsor-card">${img}${name}</div>`;
              const href = `sponsor.html?id=${encodeURIComponent(s.id)}`;
              return `<a href="${esc(href)}" title="${esc(s.name)}">${inner}</a>`;
            }).join('')}
          </div>
          <div class="small muted" style="margin-top:10px">感谢合作伙伴的支持（展示内容可由管理员随时更新）。</div>
        `;
      }
    }catch(e){
      // Hide sponsor block entirely on error for non-admin users
      if(sponsorsCard) sponsorsCard.hidden = !isAdmin;
      if(isAdmin) sponsorsRoot.innerHTML = `<div class="muted small">读取赞助商失败：${esc(e.message || String(e))}</div>`;
    }
  }
}

loadHome();
