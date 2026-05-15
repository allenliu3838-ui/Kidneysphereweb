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

async function loadAtlasHome(){
  revealAdminEntryIfAdmin();
  let payload = null;
  try {
    const r = await fetch('/api/atlas/home');
    if(r.ok) payload = await r.json();
  } catch {}
  const categories = payload?.categories || [];
  const topics = payload?.featuredTopics || [];
  const series = payload?.latestSeries || [];

  document.getElementById('atlasCategoryList').innerHTML = categories.map(c=>card(c.name,c.description,`atlas-category.html?slug=${encodeURIComponent(c.slug)}`)).join('') || '<div class="note">图谱分类正在建设中</div>';
  document.getElementById('atlasFeaturedList').innerHTML = topics.map(t=>card(t.name,t.summary,`atlas-topic.html?slug=${encodeURIComponent(t.slug)}`)).join('') || '<div class="note">热门专题正在建设中</div>';
  document.getElementById('atlasLatestList').innerHTML = series.map(s=>card(`${s.title}${s.visibility==='pro'?' · Pro':''}`,s.summary,`atlas-series.html?slug=${encodeURIComponent(s.slug)}`)).join('') || '<div class="note">暂无更新</div>';
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
  const { data: t } = await supabase.from('atlas_topics').select('*').eq('slug',slug).maybeSingle();
  if(!t) return;
  document.getElementById('atlasTopicTitle').textContent = t.name;
  document.getElementById('atlasTopicSummary').textContent = t.summary || '';
  const { data: s } = await supabase.from('atlas_series').select('title,slug,summary,visibility,status').eq('topic_id',t.id).eq('status','published').neq('visibility','hidden').order('sort_order');
  document.getElementById('atlasTopicSeries').innerHTML = (s||[]).map(x=>card(`${x.title}${x.visibility==='pro'?' · Pro':''}`,x.summary,`atlas-series.html?slug=${encodeURIComponent(x.slug)}`)).join('') || '<div class="note">该专题正在建设中，可先查看其他图谱。</div>';
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
      <p>${esc(canHD?(a.caption||''):'该图谱为 Pro 内容，解锁 Atlas Pro 查看完整高清图谱。')}</p>
      ${!canHD?'<a class="btn danger" href="membership.html">解锁 Atlas Pro</a>':''}
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
