import { getSupabase, isConfigured, toast } from './supabaseClient.js?v=20260128_030';

const listEl = document.getElementById('expertsList');
const emptyEl = document.getElementById('expertsEmpty');

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
}

function renderItem(it){
  const title = esc(it.title);
  const desc = esc(it.description);
  const img = it.image_url
    ? `<img class="expert-avatar" src="${esc(it.image_url)}" alt="" />`
    : `<div class="expert-avatar" style="display:grid;place-items:center;">👤</div>`;

  const link = it.link
    ? `<a class="btn tiny" href="${esc(it.link)}" target="_blank" rel="noopener">链接</a>`
    : '';

  return `
    <div class="expert-item">
      ${img}
      <div class="expert-main">
        <div class="row" style="gap:12px;align-items:center;flex-wrap:wrap">
          <div class="expert-name">${title}</div>
          <span class="spacer"></span>
          ${link}
        </div>
        ${desc ? `<div class="expert-desc">${desc}</div>` : ''}
      </div>
    </div>
  `;
}

async function loadExperts(){
  if(!listEl) return;

  if(!isConfigured()){
    listEl.innerHTML = `<div class="muted">未配置 Supabase。请先在 assets/config.js 填入 SUPABASE_URL 与 SUPABASE_ANON_KEY。</div>`;
    return;
  }

  const supabase = await getSupabase();
  if(!supabase){
    listEl.innerHTML = `<div class="muted">Supabase 初始化失败。</div>`;
    return;
  }

  const category = String(listEl.getAttribute('data-category') || 'experts_cn').trim().toLowerCase();
  // Backward compatibility: old data used category = 'experts'. Treat it as domestic.
  const cats = category === 'experts_cn' ? ['experts_cn', 'experts'] : [category];

  const { data, error } = await supabase
    .from('about_showcase')
    .select('id, title, description, image_url, link, sort, created_at')
    .in('category', cats)
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
  listEl.innerHTML = rows.map(renderItem).join('');
}

loadExperts().catch(err => {
  console.error(err);
  try{ toast('加载失败', err?.message || String(err), 'err'); }catch(_e){}
});
