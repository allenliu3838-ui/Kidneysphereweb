import {
  supabase,
  ensureSupabase,
  isConfigured,
} from './supabaseClient.js?v=20260401_fix';

// Only the existing showcase module is loaded. Removed article/moment modules
// make no background requests; course discovery has its own reader.
const showcaseSection = document.querySelector('[data-home-showcase]');
const showcaseStatsEl = document.querySelector('[data-home-showcase-stats]');
const showcaseCardsEl = document.querySelector('[data-home-showcase-cards]');
const showcaseActionsEl = document.querySelector('[data-home-showcase-actions]');
const showcaseStatusEl = document.querySelector('[data-home-showcase-status]');
const showcaseTabs = Array.from(document.querySelectorAll('[data-home-showcase-tab]'));
const showcasePrevBtn = document.querySelector('[data-home-showcase-prev]');
const showcaseNextBtn = document.querySelector('[data-home-showcase-next]');
const showcasePlaybackEl = document.querySelector('[data-home-showcase-playback]');
const showcaseAutoplayBtn = document.querySelector('[data-home-showcase-autoplay]');
let showcaseRotation = null;
let showcaseActiveKind = 'experts';

const showcaseLabels = {
  experts: '核心专家',
  flagship: '旗舰中心',
  co_building: '共建单位',
  partners: '合作单位',
};

function esc(str){
  return String(str ?? '').replace(/[&<>"']/g, s => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[s]));
}

function ensureCoBuildingNeiKeTitle(raw){
  const title = String(raw || '').trim();
  if(!title) return '';
  return title.replace(/\s*(肾脏内科|肾病科|肾内科|肾内|肾病)\s*$/,'').trim() + '肾内科';
}

function safeShowcaseUrl(raw, fallback = ''){
  const value = String(raw || '').trim();
  if(!value) return fallback;
  try{
    const url = new URL(value, document.baseURI);
    return ['https:', 'http:'].includes(url.protocol) ? value : fallback;
  }catch(_e){
    return fallback;
  }
}

function shortDesc(desc, max = 180){
  const value = String(desc || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function buildExpertList(cn = [], intl = []){
  // Keep both directories represented; rotate the starting point only once
  // when the page loads, never reorder cards while someone is reading.
  const out = [];
  for(let i = 0; i < Math.max(cn.length, intl.length); i++){
    if(cn[i]) out.push(cn[i]);
    if(intl[i]) out.push(intl[i]);
  }
  return out;
}

function chooseExpertStart(rows, storage, random = Math.random){
  if(rows.length < 2) return rows.slice();
  const key = 'ks-home-expert-start-v1';
  let start = Math.floor(random() * rows.length) % rows.length;
  try{
    const saved = storage?.getItem(key);
    if(saved !== null && saved !== undefined && /^\d+$/.test(saved)){
      start = (Number(saved) + 1) % rows.length;
    }
    storage?.setItem(key, String(start));
  }catch(_e){ /* Private browsing still gets a varied starting expert. */ }
  return rows.slice(start).concat(rows.slice(0, start));
}

function expertStartForVisit(rows){
  let storage;
  try{ storage = window.localStorage; }catch(_e){ /* Storage is optional. */ }
  return chooseExpertStart(rows, storage);
}

function renderShowcaseCard(item, kind, index = 0){
  const rawTitle = kind === 'co_building'
    ? ensureCoBuildingNeiKeTitle(item?.title)
    : String(item?.title || '').trim();
  // Split only an explicit "name | institution" title; do not invent
  // affiliations or infer credentials from biographies.
  const parts = kind === 'experts' ? rawTitle.match(/^(.+?)\s*[|｜]\s*(.+)$/s) : null;
  const title = parts ? parts[1].trim() : rawTitle;
  const institution = parts ? parts[2].trim() : '';
  const rawDesc = String(item?.description || '').trim();
  const imageUrl = safeShowcaseUrl(item?.image_url);
  const international = String(item?.category || '').toLowerCase() === 'experts_intl';
  const fallbackHref = kind === 'experts'
    ? (international ? 'experts-intl.html' : 'experts-cn.html')
    : kind === 'flagship' ? 'flagship.html' : 'partners.html';
  const href = safeShowcaseUrl(item?.link, fallbackHref);
  const externalLink = href !== fallbackHref && new URL(href, document.baseURI).origin !== new URL(document.baseURI).origin;
  const region = kind === 'experts' ? (international ? '国际' : '国内')
    : kind === 'co_building' ? '共建' : kind === 'partners' ? '合作' : '旗舰';
  const cardId = `home-showcase-${kind}-${index}`;
  const descriptionId = `${cardId}-description`;
  const thumb = imageUrl
    ? `<img class="thumb" src="${esc(imageUrl)}" alt="" loading="lazy" decoding="async" width="80" height="80" />`
    : `<div class="thumb showcase-placeholder" aria-hidden="true">${kind === 'experts' ? '专家' : '机构'}</div>`;
  const isExpert = kind === 'experts';
  const hasDescription = !!rawDesc && kind !== 'co_building';

  return `
    <article class="home-showcase-card" data-kind="${esc(kind)}" aria-labelledby="${cardId}-title">
      ${thumb}
      <div class="main">
        <div class="title" id="${cardId}-title"><a class="showcase-title-link" href="${esc(href)}"${externalLink ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(title || showcaseLabels[kind])}</a></div>
        ${institution ? `<div class="institution">${esc(institution)}</div>` : ''}
        <div class="meta">
          <span class="pill">${region}</span>
          ${isExpert && hasDescription ? `<button class="more" type="button" data-showcase-toggle aria-expanded="false" aria-controls="${descriptionId}" aria-label="展开${esc(title)}的简介">展开简介</button>` : ''}
        </div>
        ${hasDescription ? `<div class="desc" id="${descriptionId}"${isExpert ? ' hidden' : ''}>${esc(isExpert ? rawDesc : shortDesc(rawDesc)).replace(/\n/g, '<br/>')}</div>` : ''}
      </div>
    </article>
  `;
}

function setTabActive(kind){
  showcaseTabs.forEach(btn => {
    const active = btn.getAttribute('data-home-showcase-tab') === kind;
    btn.classList.toggle('active', active);
    btn.removeAttribute('aria-selected');
    btn.setAttribute('aria-pressed', String(active));
    btn.disabled = false;
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
  }else if(kind === 'flagship'){
    showcaseActionsEl.innerHTML = `
      <a class="btn primary" href="flagship.html">查看全部旗舰中心</a>
      <a class="btn" href="about.html">了解更多</a>
    `;
  }else{
    showcaseActionsEl.innerHTML = `
      <a class="btn primary" href="partners.html">查看全部共建/合作单位</a>
      <a class="btn" href="about.html">了解更多</a>
    `;
  }
}

function updateShowcaseNav(){
  if(!showcaseCardsEl) return;
  const max = Math.max(0, showcaseCardsEl.scrollWidth - showcaseCardsEl.clientWidth);
  if(showcasePrevBtn) showcasePrevBtn.disabled = showcaseCardsEl.scrollLeft <= 2;
  if(showcaseNextBtn) showcaseNextBtn.disabled = max <= 2 || showcaseCardsEl.scrollLeft >= max - 2;
}

function showcaseScrollStep(){
  const first = showcaseCardsEl?.querySelector('.home-showcase-card');
  if(!first) return 0;
  return first.getBoundingClientRect().width +
    (parseFloat(window.getComputedStyle(showcaseCardsEl).columnGap) || 0);
}

function syncShowcaseRotation(){
  showcaseRotation?.sync();
}

function initShowcaseRotation(){
  if(showcaseRotation || !showcaseSection || !showcaseCardsEl || !showcaseAutoplayBtn) return;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let paused = motion.matches;
  let hovered = false;
  let visible = false;
  let timer = null;

  const hasExperts = () => showcaseActiveKind === 'experts' &&
    showcaseCardsEl.querySelectorAll('.home-showcase-card').length > 1;
  const reading = () => !!showcaseCardsEl.querySelector('[data-showcase-toggle][aria-expanded="true"]');
  const canAdvance = () => hasExperts() && !paused && !hovered && visible &&
    !document.hidden && !reading() &&
    showcaseCardsEl.scrollWidth > showcaseCardsEl.clientWidth + 2;

  function sync(){
    if(timer !== null){ window.clearTimeout(timer); timer = null; }
    const available = hasExperts();
    if(showcasePlaybackEl) showcasePlaybackEl.hidden = !available;
    showcaseAutoplayBtn.disabled = reading();
    showcaseAutoplayBtn.textContent = paused ? '开始轮播' : '暂停轮播';
    showcaseAutoplayBtn.setAttribute('aria-label', paused ? '开始专家轮播' : '暂停专家轮播');
    showcaseCardsEl.setAttribute('aria-live', canAdvance() ? 'off' : 'polite');
    if(!canAdvance()) return;
    timer = window.setTimeout(() => {
      timer = null;
      if(!canAdvance()) return sync();
      const max = showcaseCardsEl.scrollWidth - showcaseCardsEl.clientWidth;
      const left = showcaseCardsEl.scrollLeft >= max - 2 ? 0 :
        Math.min(max, showcaseCardsEl.scrollLeft + showcaseScrollStep());
      showcaseCardsEl.scrollTo({ left, behavior: motion.matches ? 'auto' : 'smooth' });
      sync();
    }, 6000);
  }

  function pause(){ paused = true; sync(); }
  showcaseRotation = { sync, pause };
  showcaseAutoplayBtn.addEventListener('click', () => { paused = !paused; sync(); });
  showcaseSection.addEventListener('pointerenter', event => {
    if(event.pointerType === 'mouse'){ hovered = true; sync(); }
  });
  showcaseSection.addEventListener('pointerleave', event => {
    if(event.pointerType === 'mouse'){ hovered = false; sync(); }
  });
  showcaseCardsEl.addEventListener('focusin', pause);
  showcaseCardsEl.addEventListener('pointerdown', pause, { passive: true });
  showcasePrevBtn?.addEventListener('focusin', pause);
  showcaseNextBtn?.addEventListener('focusin', pause);
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('pagehide', () => {
    visible = false;
    sync();
  });
  window.addEventListener('pageshow', checkVisibility);
  motion.addEventListener?.('change', () => { if(motion.matches) paused = true; sync(); });

  function checkVisibility(){
    const rect = showcaseSection.getBoundingClientRect();
    visible = rect.bottom > 0 && rect.top < window.innerHeight;
    sync();
  }
  if(typeof IntersectionObserver !== 'undefined'){
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      sync();
    }, { threshold: 0 });
    observer.observe(showcaseSection);
  }else{
    window.addEventListener('scroll', checkVisibility, { passive: true });
    window.addEventListener('resize', checkVisibility, { passive: true });
  }
  checkVisibility();
}

function bindCarouselNav(){
  if(!showcaseCardsEl || showcaseCardsEl.dataset.navBound === '1') return;
  showcaseCardsEl.dataset.navBound = '1';
  function scrollByStep(direction){
    showcaseRotation?.pause();
    const step = showcaseScrollStep();
    if(!step) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    showcaseCardsEl.scrollBy({ left: direction * step, behavior: reducedMotion ? 'auto' : 'smooth' });
  }
  showcasePrevBtn?.addEventListener('click', () => scrollByStep(-1));
  showcaseNextBtn?.addEventListener('click', () => scrollByStep(1));
  showcaseCardsEl.addEventListener('scroll', updateShowcaseNav, { passive: true });
  if(typeof ResizeObserver !== 'undefined'){
    const observer = new ResizeObserver(() => { updateShowcaseNav(); syncShowcaseRotation(); });
    observer.observe(showcaseCardsEl);
  }else{
    window.addEventListener('resize', () => { updateShowcaseNav(); syncShowcaseRotation(); }, { passive: true });
  }
  // Native scrolling handles touch. Pointer contact pauses automatic advance;
  // no gesture emulation or touchmove cancellation interferes with the page.
}

function bindShowcaseExpand(){
  if(!showcaseCardsEl || showcaseCardsEl.dataset.expandBound === '1') return;
  showcaseCardsEl.dataset.expandBound = '1';
  showcaseCardsEl.addEventListener('click', event => {
    const button = event.target?.closest?.('[data-showcase-toggle]');
    if(!button || !showcaseCardsEl.contains(button)) return;
    const card = button.closest('.home-showcase-card');
    const description = card?.querySelector('.desc');
    if(!card || !description || card.dataset.kind !== 'experts') return;
    const expanded = button.getAttribute('aria-expanded') !== 'true';
    card.classList.toggle('expanded', expanded);
    description.hidden = !expanded;
    button.setAttribute('aria-expanded', String(expanded));
    button.textContent = expanded ? '收起简介' : '展开简介';
    const title = card.querySelector('.title')?.textContent || '专家';
    button.setAttribute('aria-label', `${expanded ? '收起' : '展开'}${title}的简介`);
    if(expanded) showcaseRotation?.pause();
    else syncShowcaseRotation();
    // Keep focus on the native button. Do not collapse another card, scroll
    // the document, or reset horizontal position while the user is reading.
  });
}

function renderShowcaseState(kind, state){
  const { rows = [], error = false, partial = false } = state || {};
  showcaseActiveKind = kind;
  setTabActive(kind);
  updateShowcaseActions(kind);
  const label = showcaseLabels[kind] || '展示目录';
  const message = error
    ? `${label}暂时未能加载，请使用下方目录入口查看。`
    : partial
      ? '部分专家资料暂时未能加载，下方仅展示已读取的资料；完整名单请查看国内／国际专家目录。'
      : rows.length === 0 ? `${label}暂无展示内容，可通过下方入口了解更多。` : '';
  if(showcaseStatusEl){
    showcaseStatusEl.textContent = message;
    showcaseStatusEl.hidden = !message;
  }
  showcaseCardsEl.innerHTML = rows.length
    ? rows.map((item, index) => renderShowcaseCard(item, kind, index)).join('')
    : showcaseStatusEl ? '' : `<p class="muted small" role="status">${esc(message)}</p>`;
  if(partial && !showcaseStatusEl){
    showcaseCardsEl.insertAdjacentHTML('afterbegin', `<p class="muted small" role="status">${esc(message)}</p>`);
  }
  // Reset every tab, including empty and failed categories.
  showcaseCardsEl.scrollTo({ left: 0, behavior: 'instant' });
  showcaseCardsEl.setAttribute('aria-busy', 'false');
  window.requestAnimationFrame(() => { updateShowcaseNav(); syncShowcaseRotation(); });
}

function connectShowcaseTabs(byTab){
  showcaseTabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.getAttribute('data-home-showcase-tab');
      if(Object.prototype.hasOwnProperty.call(byTab, kind)) renderShowcaseState(kind, byTab[kind]);
    });
  });
  bindCarouselNav();
  bindShowcaseExpand();
  initShowcaseRotation();
  renderShowcaseState('experts', byTab.experts);
}

function showShowcaseUnavailable(){
  if(showcaseStatsEl) showcaseStatsEl.textContent = '';
  connectShowcaseTabs(Object.fromEntries(Object.keys(showcaseLabels).map(kind => [kind, { error: true }])));
}

async function readShowcaseCategory(category){
  try{
    const result = await supabase.from('about_showcase')
      .select('id, category, title, description, image_url, link, sort, created_at')
      .eq('category', category)
      .order('sort', { ascending: true })
      .order('created_at', { ascending: false });
    if(result.error) return { rows: [], error: true };
    return { rows: Array.isArray(result.data) ? result.data : [], error: false };
  }catch(_e){
    return { rows: [], error: true };
  }
}

async function loadHomeShowcase(){
  if(!showcaseSection || !showcaseCardsEl) return;
  showcaseCardsEl.setAttribute('aria-busy', 'true');
  if(isConfigured() && !supabase){
    try{ await ensureSupabase(); }catch(_e){ /* Keep the module's directory links. */ }
  }
  if(!isConfigured() || !supabase){
    showShowcaseUnavailable();
    return;
  }

  // Independent failures keep other directories usable. Counts are derived
  // only from successfully read records, never hard-coded marketing totals.
  const [flagship, coBuilding, partners, cn, intl] = await Promise.all([
    'flagship', 'co_building', 'partners', 'experts_cn', 'experts_intl',
  ].map(readShowcaseCategory));
  const experts = {
    rows: expertStartForVisit(buildExpertList(cn.rows, intl.rows)),
    error: cn.error && intl.error,
    partial: cn.error !== intl.error,
  };
  const byTab = { experts, flagship, co_building: coBuilding, partners };
  if(showcaseStatsEl){
    showcaseStatsEl.innerHTML = Object.entries(byTab).map(([kind, state]) => {
      const unknown = state.error || state.partial;
      return `<span class="chip"${unknown ? ' title="目录未完整加载，暂不显示总数"' : ''}>${showcaseLabels[kind]} ${unknown ? '—' : state.rows.length}</span>`;
    }).join('');
  }
  connectShowcaseTabs(byTab);
}

loadHomeShowcase();
