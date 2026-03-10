import { supabase, ensureSupabase, isConfigured, toast } from './supabaseClient.js?v=20260128_030';

const bodyEl = document.getElementById('sponsorBody');
const titleEl = document.getElementById('sponsorTitle');

function esc(s){
  return String(s ?? '').replace(/[&<>'"]/g, c => ({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[c]));
}

function nl2br(s){
  return esc(s).replace(/\n/g,'<br/>');
}

async function load(){
  if(!bodyEl) return;

  const params = new URLSearchParams(location.search);
  const idRaw = params.get('id');
  const id = Number(idRaw);
  if(!id){
    bodyEl.innerHTML = `<div class="note"><b>缺少参数</b><div class="small" style="margin-top:6px">请使用 sponsor.html?id=... 访问。</div></div>`;
    return;
  }

  if(!isConfigured()){
    bodyEl.innerHTML = `<div class="note"><b>演示模式：</b>请在 assets/config.js 配置 Supabase 后启用赞助商详情页。</div>`;
    return;
  }

  await ensureSupabase();

  bodyEl.innerHTML = `<div class="muted small">加载中…</div>`;

  try{
    // Backward compatible selects
    const candidates = [
      'id, name, tier, description, logo_url, website, enabled',
      'id, name, description, logo_url, website, enabled',
      'id, name, logo_url, website, enabled'
    ];

    let res = null;
    for(const fields of candidates){
      res = await supabase
        .from('sponsors')
        .select(fields)
        .eq('id', id)
        .maybeSingle();
      if(!res?.error) break;
      const msg = String(res.error.message || '').toLowerCase();
      if(!msg.includes('column')) break;
    }

    const { data, error } = res || {};
    if(error) throw error;

    if(!data || data.enabled === false){
      bodyEl.innerHTML = `<div class="muted">未找到该赞助商（或已隐藏）。</div>`;
      return;
    }

    const s = data;
    const name = s.name || 'Sponsor';
    if(titleEl) titleEl.textContent = name;
    document.title = `${name} · 赞助商 · KidneySphere`;

    const logo = s.logo_url
      ? `<img alt="${esc(name)}" src="${esc(s.logo_url)}" style="width:76px;height:76px;object-fit:contain;border-radius:18px;background:rgba(255,255,255,.04);padding:10px" />`
      : `<div style="width:76px;height:76px;border-radius:18px;background:rgba(255,255,255,.05);display:grid;place-items:center;font-size:26px">🏷️</div>`;

    const tier = s.tier ? `<span class="badge">${esc(String(s.tier))}</span>` : '';

    const website = s.website
      ? `<a class="btn" href="${esc(String(s.website))}" target="_blank" rel="noopener">访问官网</a>`
      : '';

    const desc = String(s.description || '').trim();

    bodyEl.innerHTML = `
      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
        ${logo}
        <div style="min-width:0">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <h3 style="margin:0">${esc(name)}</h3>
            ${tier}
          </div>
          <div class="small muted" style="margin-top:6px">赞助商/合作伙伴展示页面</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
            ${website}
          </div>
        </div>
      </div>

      <div class="hr" style="margin:16px 0"></div>

      ${desc ? `<div style="line-height:1.8;white-space:pre-wrap">${nl2br(desc)}</div>` : `<div class="muted">（暂无简介）</div>`}

      <div class="hr" style="margin:16px 0"></div>
      <div class="note"><b>声明：</b>本页内容由合作单位提供或由编辑团队整理，仅作信息展示。</div>
    `;
  }catch(e){
    bodyEl.innerHTML = `<div class="note"><b>加载失败</b><div class="small" style="margin-top:6px">${esc(e?.message || String(e))}</div></div>`;
    try{ toast('加载失败', e?.message || String(e), 'err'); }catch(_e){}
  }
}

load();
