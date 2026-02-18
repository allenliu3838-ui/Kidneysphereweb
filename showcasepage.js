import { getSupabase, isConfigured, toast } from './supabaseClient.js?v=20260128_030';

const singleListEl = document.getElementById('showcaseList');
const singleEmptyEl = document.getElementById('showcaseEmpty');
const titleEl = document.getElementById('showcaseTitle');

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[c]));
}

function ensureCoBuildingNeiKeTitle(raw){
  let t = String(raw || '').trim();
  if(!t) return '';
  t = t.replace(/\s*(肾脏内科|肾病科|肾内科|肾内|肾病)\s*$/,'').trim();
  if(/肾内科\s*$/.test(t)) return t;
  return t + '肾内科';
}



function iconFor(category){
  const c = String(category || '').toLowerCase();
  if(c === 'experts' || c === 'experts_cn' || c === 'experts_intl') return '👤';
  if(c === 'flagship') return '🏥';
  if(c === 'partners' || c === 'co_building') return '🤝';
  return '📌';
}

function renderItem(it, category){
  const title = esc(category === 'co_building' ? ensureCoBuildingNeiKeTitle(it?.title) : it?.title);
  const desc = esc(it?.description);

  const img = it?.image_url
    ? `<img class="showcase-avatar" src="${esc(it.image_url)}" alt="" />`
    : `<div class="showcase-avatar" style="display:grid;place-items:center;background:rgba(255,255,255,.05)">${iconFor(category)}</div>`;

  const link = it?.link
    ? `<a class="btn tiny" href="${esc(it.link)}" target="_blank" rel="noopener">链接</a>`
    : '';

  return `
    <div class="showcase-item">
      ${img}
      <div class="showcase-main">
        <div class="row" style="gap:12px;align-items:center;flex-wrap:wrap">
          <div style="font-weight:800">${title}</div>
          <span class="spacer"></span>
          ${link}
        </div>
        ${(category !== 'co_building' && desc) ? `<div class="muted" style="margin-top:6px;white-space:pre-wrap;line-height:1.6">${desc}</div>` : ''}
      </div>
    </div>
  `;
}

async function loadCategory(supabase, category, listEl, emptyEl){
  const cat = String(category || '').toLowerCase();
  if(!listEl) return;

  const { data, error } = await supabase
    .from('about_showcase')
    .select('id, title, description, image_url, link, sort, created_at')
    .eq('category', cat)
    .order('sort', { ascending: true })
    .order('created_at', { ascending: false });

  if(error){
    listEl.innerHTML = `<div class="muted">加载失败：${esc(error.message || error)}</div>`;
    return;
  }

  const rows = data || [];
  if(!rows.length){
    emptyEl && (emptyEl.style.display = 'block');
    listEl.innerHTML = '';
    return;
  }

  emptyEl && (emptyEl.style.display = 'none');
  listEl.innerHTML = rows.map(r => renderItem(r, cat)).join('');
}

async function load(){
  const multi = Array.from(document.querySelectorAll('[data-showcase-page]'));

  // Multi-section mode (e.g., partners.html shows co_building + partners)
  if(multi.length){
    if(!isConfigured()){
      multi.forEach(el=>{
        el.innerHTML = `<div class="muted">未配置 Supabase。请先在 assets/config.js 填入 SUPABASE_URL 与 SUPABASE_ANON_KEY。</div>`;
      });
      return;
    }
    const supabase = await getSupabase();
    if(!supabase){
      multi.forEach(el=>{
        el.innerHTML = `<div class="muted">Supabase 初始化失败。</div>`;
      });
      return;
    }

    for(const el of multi){
      const cat = String(el.getAttribute('data-category') || '').trim();
      const emptyEl = document.querySelector(`[data-showcase-empty="${CSS.escape(cat)}"]`);
      await loadCategory(supabase, cat, el, emptyEl);
    }
    return;
  }

  // Single-list mode (backwards compatible)
  if(!singleListEl) return;
  const category = String(singleListEl.getAttribute('data-category') || 'experts').toLowerCase();
  const pageTitle = String(singleListEl.getAttribute('data-title') || '').trim();
  if(titleEl && pageTitle) titleEl.textContent = pageTitle;

  if(!isConfigured()){
    singleListEl.innerHTML = `<div class="muted">未配置 Supabase。请先在 assets/config.js 填入 SUPABASE_URL 与 SUPABASE_ANON_KEY。</div>`;
    return;
  }
  const supabase = await getSupabase();
  if(!supabase){
    singleListEl.innerHTML = `<div class="muted">Supabase 初始化失败。</div>`;
    return;
  }
  await loadCategory(supabase, category, singleListEl, singleEmptyEl);
}

load().catch(err => {
  console.error(err);
  try{ toast('加载失败', err?.message || String(err), 'err'); }catch(_e){}
});
