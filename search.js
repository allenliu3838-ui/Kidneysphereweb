import { ensureSupabase, getSession, isConfigured, toast, formatBeijingDateTime } from './supabaseClient.js?v=20260211_001';

const els = {
  q: document.getElementById('siteSearchInput'),
  btn: document.getElementById('siteSearchBtn'),
  clear: document.getElementById('siteSearchClear'),
  filters: document.getElementById('siteSearchFilters'),
  count: document.getElementById('siteSearchCount'),
  hint: document.getElementById('siteSearchHint'),
  list: document.getElementById('siteSearchResults'),
  empty: document.getElementById('siteSearchEmpty'),
  more: document.getElementById('siteSearchMore'),
  top: document.getElementById('siteSearchTop'),
};

const PAGE_SIZE = 20;

const TYPE_LABEL = {
  article: '文章',
  case: '病例讨论',
  moment: '社区动态',
  event: '会议活动',
  research: '临床研究',
  person: '专家/伙伴',
};

const TYPE_HELP = {
  article: '已发布文章',
  case: '需要登录',
  moment: '公开动态',
  event: '公开活动',
  research: '公开项目',
  person: '关于页内容',
};

const ALL_TYPES = Object.keys(TYPE_LABEL);

let state = {
  q: '',
  types: new Set(ALL_TYPES),
  offset: 0,
  loading: false,
  hasMore: false,
  lastRows: [],
};

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, (ch)=>({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}

function escapeRegExp(str){
  return String(str ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitTerms(q){
  const s = String(q ?? '').trim();
  if(!s) return [];
  return s.split(/\s+/g).map(x=>x.trim()).filter(Boolean).slice(0, 6);
}

function highlight(text, q){
  const raw = String(text ?? '').trim();
  if(!raw) return '';
  const terms = splitTerms(q);
  if(!terms.length) return esc(raw);

  let out = esc(raw);
  // Highlight longest terms first to avoid nested highlights.
  const sorted = terms.slice().sort((a,b)=>b.length-a.length);
  for(const t of sorted){
    if(!t) continue;
    const re = new RegExp(escapeRegExp(esc(t)), 'gi');
    out = out.replace(re, (m)=>`<mark>${m}</mark>`);
  }
  return out;
}

function typeChip(type){
  const label = TYPE_LABEL[type] || type;
  const help = TYPE_HELP[type] || '';
  return `<span class="chip" title="${esc(help)}">${esc(label)}</span>`;
}

function fmtTime(ts){
  const s = formatBeijingDateTime(ts);
  return s ? s : '';
}

function readUrlQ(){
  try{
    const u = new URL(location.href);
    return String(u.searchParams.get('q') || '').trim();
  }catch{ return ''; }
}

function setUrlQ(q){
  try{
    const u = new URL(location.href);
    const v = String(q || '').trim();
    if(v) u.searchParams.set('q', v);
    else u.searchParams.delete('q');
    history.replaceState({}, '', u.toString());
  }catch(_e){}
}

function updateHint(){
  const q = String(state.q || '').trim();
  if(!q){
    els.hint.textContent = '输入关键词开始搜索。';
    return;
  }
  const chosen = Array.from(state.types);
  const label = (chosen.length === ALL_TYPES.length)
    ? '全部内容'
    : chosen.map(t=>TYPE_LABEL[t] || t).join(' / ');
  els.hint.textContent = `范围：${label}`;
}

function renderFilters(){
  if(!els.filters) return;
  const frag = document.createDocumentFragment();

  function mkBtn(type){
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pill-btn';
    btn.textContent = TYPE_LABEL[type] || type;
    btn.title = TYPE_HELP[type] || '';
    btn.dataset.type = type;
    if(state.types.has(type)) btn.classList.add('active');
    btn.addEventListener('click', ()=>{
      // Toggle
      if(state.types.has(type)) state.types.delete(type);
      else state.types.add(type);
      // Never allow empty set (fallback to all)
      if(state.types.size === 0){
        ALL_TYPES.forEach(t=>state.types.add(t));
      }
      renderFilters();
      updateHint();
      runSearch(true);
    });
    return btn;
  }

  // "全部"
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'pill-btn';
  allBtn.textContent = '全部';
  const allActive = state.types.size === ALL_TYPES.length;
  if(allActive) allBtn.classList.add('active');
  allBtn.addEventListener('click', ()=>{
    ALL_TYPES.forEach(t=>state.types.add(t));
    renderFilters();
    updateHint();
    runSearch(true);
  });
  frag.appendChild(allBtn);

  ALL_TYPES.forEach(t=> frag.appendChild(mkBtn(t)));
  els.filters.innerHTML = '';
  els.filters.appendChild(frag);
}

function renderRows(rows, { append=false } = {}){
  const arr = Array.isArray(rows) ? rows : [];
  els.empty.hidden = arr.length > 0 || append;
  if(!append) els.list.innerHTML = '';

  const html = arr.map(r=>{
    const type = String(r?.type || '').trim();
    const title = String(r?.title || '').trim() || '(无标题)';
    const snippet = String(r?.snippet || '').trim();
    const url = String(r?.url || '').trim() || '#';
    const created = fmtTime(r?.created_at);
    const extra = r?.extra || {};
    const tags = Array.isArray(extra?.tags) ? extra.tags : [];
    const board = String(extra?.board || '').trim();

    const metaBits = [];
    if(created) metaBits.push(created);
    if(board) metaBits.push(board);
    if(tags.length) metaBits.push(tags.slice(0,3).join(' · '));

    return `
      <li>
        <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px">
          <div style="min-width:0">
            <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap">
              ${typeChip(type)}
              <a href="${esc(url)}" style="font-weight:800; font-size:15px; color: rgba(233,241,255,.96); text-decoration:none">
                ${esc(title)}
              </a>
            </div>
            ${snippet ? `<div class="small" style="margin-top:8px; line-height:1.55">${highlight(snippet, state.q)}</div>` : ''}
            ${metaBits.length ? `<div class="small muted" style="margin-top:8px">${esc(metaBits.join(' · '))}</div>` : ''}
          </div>
          <div style="flex:0 0 auto">
            <a class="btn" href="${esc(url)}">打开</a>
          </div>
        </div>
      </li>
    `;
  }).join('');

  if(append) els.list.insertAdjacentHTML('beforeend', html);
  else els.list.innerHTML = html;
}

function setCount(n, { loading=false } = {}){
  const num = Number(n || 0);
  els.count.textContent = loading ? ' · 搜索中…' : (Number.isFinite(num) ? ` · ${num} 条` : '');
}

let _debounceTimer = null;
function debounce(fn, ms=260){
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(fn, ms);
}

async function runSearch(reset=false){
  const q = String(els.q?.value || '').trim();
  state.q = q;
  setUrlQ(q);
  updateHint();

  if(!q){
    state.offset = 0;
    state.hasMore = false;
    state.lastRows = [];
    renderRows([], { append:false });
    setCount(0);
    els.more.hidden = true;
    els.top.hidden = true;
    els.empty.hidden = false;
    return;
  }

  if(!isConfigured()){
    toast('Supabase 未配置', '请先在 assets/config.js 填入 SUPABASE_URL / SUPABASE_ANON_KEY。', 'err');
    return;
  }

  if(state.loading) return;
  state.loading = true;
  setCount(state.lastRows.length || 0, { loading:true });

  try{
    const client = await ensureSupabase();
    if(!client) throw new Error('Supabase 初始化失败');

    if(reset){
      state.offset = 0;
      state.lastRows = [];
    }

    // If all selected, pass null so backend doesn't do any filtering.
    const selected = Array.from(state.types);
    const typesArg = (selected.length === ALL_TYPES.length) ? null : selected;

    const { data, error } = await client.rpc('search_site', {
      q,
      limit_count: PAGE_SIZE,
      offset_count: state.offset,
      types: typesArg,
    });

    if(error){
      const msg = String(error?.message || error);
      // Common deployment issue: RPC not found (migration not executed or schema cache not refreshed)
      if(/function\s+public\.search_site\b/i.test(msg) || /search_site/i.test(msg) || /could not find/i.test(msg)){
        toast('搜索功能未初始化', '请在 Supabase 运行 MIGRATION_20260211_SITE_SEARCH.sql，并在 Settings → API 点击 Reload schema。', 'err');
      }else{
        toast('搜索失败', msg, 'err');
      }
      return;
    }

    const rows = Array.isArray(data) ? data : [];
    const append = !reset && state.offset > 0;
    renderRows(rows, { append });

    if(reset) state.lastRows = rows.slice();
    else state.lastRows = state.lastRows.concat(rows);

    state.hasMore = rows.length >= PAGE_SIZE;
    state.offset = state.lastRows.length;
    els.more.hidden = !state.hasMore;
    els.top.hidden = state.lastRows.length < 10;

    setCount(state.lastRows.length || 0);
    if(reset && state.lastRows.length === 0) els.empty.hidden = false;

    // If user is not logged in, remind about cases search.
    try{
      const session = await getSession();
      if(!session && (typesArg == null || (Array.isArray(typesArg) && typesArg.includes('case')))){
        // Only show if query likely about cases or default search.
        els.hint.textContent = '提示：病例讨论搜索需要登录（未登录时不会返回病例结果）。';
      }
    }catch(_e){ /* ignore */ }
  }finally{
    state.loading = false;
  }
}

function bind(){
  renderFilters();
  updateHint();

  // Init from URL
  const initQ = readUrlQ();
  if(initQ){
    els.q.value = initQ;
    state.q = initQ;
    runSearch(true);
  }else{
    els.empty.hidden = false;
  }

  els.btn?.addEventListener('click', ()=> runSearch(true));
  els.clear?.addEventListener('click', ()=>{
    els.q.value = '';
    state.q = '';
    setUrlQ('');
    runSearch(true);
    els.q.focus();
  });
  els.more?.addEventListener('click', ()=> runSearch(false));
  els.top?.addEventListener('click', ()=> window.scrollTo({ top: 0, behavior: 'smooth' }));

  els.q?.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){
      e.preventDefault();
      runSearch(true);
    }
  });
  els.q?.addEventListener('input', ()=>{
    debounce(()=> runSearch(true), 260);
  });

  // Global shortcut: focus search input
  document.addEventListener('keydown', (e)=>{
    if(e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey){
      const t = e.target;
      const tag = (t?.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable;
      if(!typing){
        e.preventDefault();
        els.q?.focus?.();
      }
    }
  });
}

bind();
