import { supabase, ensureSupabase, isConfigured, toast } from './supabaseClient.js?v=20260401_fix';

const root = document.getElementById('sponsorsList');

function esc(s){
  return String(s ?? '').replace(/[&<>'"]/g, c => ({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[c]));
}

function snippet(s, n=160){
  const t = String(s || '').trim();
  if(t.length <= n) return t;
  return t.slice(0, n) + '…';
}

function renderCard(s){
  const name = s.name || 'Sponsor';
  const tier = s.tier ? `<span class="badge">${esc(String(s.tier))}</span>` : '';
  const desc = snippet(s.description || '', 170);

  const logo = s.logo_url
    ? `<img alt="${esc(name)}" src="${esc(s.logo_url)}" style="width:54px;height:54px;object-fit:contain;border-radius:14px;background:rgba(255,255,255,.04);padding:8px" />`
    : `<div style="width:54px;height:54px;border-radius:14px;background:rgba(255,255,255,.05);display:grid;place-items:center">🏷️</div>`;

  const btnDetail = `<a class="btn tiny" href="sponsor.html?id=${encodeURIComponent(s.id)}">查看介绍</a>`;
  const btnSite = s.website ? `<a class="btn tiny" href="${esc(String(s.website))}" target="_blank" rel="noopener">官网</a>` : '';

  return `
    <div class="card soft" style="padding:16px">
      <div style="display:flex;gap:12px;align-items:center">
        ${logo}
        <div style="min-width:0;flex:1">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <b style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</b>
            ${tier}
          </div>
          ${desc ? `<div class="small muted" style="margin-top:6px;line-height:1.6">${esc(desc)}</div>` : `<div class="small muted" style="margin-top:6px">（暂无简介）</div>`}
        </div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
        ${btnDetail}
        ${btnSite}
      </div>
    </div>
  `;
}

async function load(){
  if(!root) return;

  if(!isConfigured()){
    root.innerHTML = `<div class="note"><b>演示模式：</b>请在 assets/config.js 配置 Supabase 后启用赞助商展示页。</div>`;
    return;
  }

  await ensureSupabase();

  root.innerHTML = `<div class="muted small">加载中…</div>`;

  let res = null;
  try{
    res = await supabase
      .from('sponsors')
      .select('id, name, tier, description, logo_url, website, enabled, sort, created_at, show_on_home')
      .order('sort', { ascending: true })
      .order('created_at', { ascending: false });

    if(res?.error && String(res.error.message || '').toLowerCase().includes('column')){
      // Backward compatible
      res = await supabase
        .from('sponsors')
        .select('id, name, tier, description, logo_url, website, enabled, sort, created_at')
        .order('sort', { ascending: true })
        .order('created_at', { ascending: false });
    }

    if(res?.error) throw res.error;

    const list = (res.data || []).filter(s => Boolean(s.enabled));
    if(list.length === 0){
      root.innerHTML = `<div class="muted small">暂无赞助商信息。</div>`;
      return;
    }

    root.innerHTML = `<div class="grid cols-2">${list.map(renderCard).join('')}</div>`;

  }catch(e){
    root.innerHTML = `<div class="note"><b>加载失败</b><div class="small" style="margin-top:6px">${esc(e?.message || String(e))}</div></div>`;
    try{ toast('加载失败', e?.message || String(e), 'err'); }catch(_e){}
  }
}

load();
