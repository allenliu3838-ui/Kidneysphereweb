// share.js
// Unified sharing helpers for KidneySphere.
// Works on static hosting (Netlify) and dynamic client-rendered pages.

function toAbsUrl(url){
  const raw = String(url || '').trim();
  if(!raw) return '';
  try{
    return new URL(raw, location.origin).href;
  }catch(_e){
    return raw;
  }
}

function ensureMeta(attr, key, content){
  const val = String(content ?? '').trim();
  if(!val) return null;

  const selector = (attr === 'property')
    ? `meta[property="${key}"]`
    : `meta[name="${key}"]`;

  let el = document.head.querySelector(selector);
  if(!el){
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', val);
  return el;
}

function ensureLinkRel(rel, href){
  const r = String(rel || '').trim();
  const h = String(href || '').trim();
  if(!r || !h) return null;
  let el = document.head.querySelector(`link[rel="${r}"]`);
  if(!el){
    el = document.createElement('link');
    el.rel = r;
    document.head.appendChild(el);
  }
  el.href = h;
  return el;
}

export function isWeChat(){
  try{
    return /MicroMessenger/i.test(navigator.userAgent || '');
  }catch(_e){
    return false;
  }
}

export function buildStableUrl(){
  try{
    const u = new URL(location.href);
    // v is used only for cache busting; keep share URLs clean.
    u.searchParams.delete('v');
    // Avoid sharing in-page anchors by default.
    u.hash = '';
    return u.href;
  }catch(_e){
    return location.href;
  }
}

export function applyShareMeta({
  title,
  description,
  image,
  url,
  type = 'website',
  siteName = '肾域AI · KidneySphereAI',
} = {}){
  const t = String(title || '').trim() || document.title || 'KidneySphere';
  const d = String(description || '').trim() || '';
  const shareUrl = String(url || '').trim() || buildStableUrl();

  // WeChat / OG prefer absolute image URLs.
  const img = toAbsUrl(image || 'assets/logo.png') || toAbsUrl('assets/logo.png');

  // Title
  try{ document.title = t; }catch(_e){}

  // Basic meta
  ensureMeta('name', 'description', d);

  // Open Graph
  ensureMeta('property', 'og:title', t);
  ensureMeta('property', 'og:description', d);
  ensureMeta('property', 'og:image', img);
  ensureMeta('property', 'og:url', shareUrl);
  ensureMeta('property', 'og:type', type);
  ensureMeta('property', 'og:site_name', siteName);

  // Twitter (not required, but helps other platforms)
  ensureMeta('name', 'twitter:card', 'summary_large_image');
  ensureMeta('name', 'twitter:title', t);
  ensureMeta('name', 'twitter:description', d);
  ensureMeta('name', 'twitter:image', img);

  // Canonical
  ensureLinkRel('canonical', shareUrl);

  // WeChat in-app share
  setupWeChatShare({ title: t, desc: d, image: img, url: shareUrl });

  return { title: t, description: d, image: img, url: shareUrl };
}

export function setupWeChatShare({ title, desc, image, url } = {}){
  const t = String(title || '').trim();
  const d = String(desc || '').trim();
  const link = String(url || '').trim();
  const imgUrl = toAbsUrl(image || 'assets/logo.png');

  if(!t || !link) return;

  const onReady = ()=>{
    const bridge = window.WeixinJSBridge;
    if(!bridge) return;

    // Some newer WeChat clients support these two update methods.
    // They may silently fail on older clients, so we wrap in try/catch.
    try{
      bridge.invoke('updateAppMessageShareData', { title: t, desc: d, link, imgUrl }, ()=>{});
      bridge.invoke('updateTimelineShareData', { title: t, link, imgUrl }, ()=>{});
    }catch(_e){}

    // Classic hooks
    try{
      bridge.on('menu:share:appmessage', ()=>{
        try{
          bridge.invoke('sendAppMessage', {
            title: t,
            desc: d,
            link,
            img_url: imgUrl,
            img_width: '120',
            img_height: '120'
          }, ()=>{});
        }catch(_e){}
      });
    }catch(_e){}

    try{
      bridge.on('menu:share:timeline', ()=>{
        try{
          bridge.invoke('shareTimeline', {
            title: t,
            desc: d,
            link,
            img_url: imgUrl,
            img_width: '120',
            img_height: '120'
          }, ()=>{});
        }catch(_e){}
      });
    }catch(_e){}
  };

  if(window.WeixinJSBridge){
    onReady();
  }else{
    document.addEventListener('WeixinJSBridgeReady', onReady, false);
  }
}

export async function copyToClipboard(text){
  const t = String(text ?? '');
  if(!t) return false;

  // Modern API
  try{
    if(navigator.clipboard && typeof navigator.clipboard.writeText === 'function'){
      await navigator.clipboard.writeText(t);
      return true;
    }
  }catch(_e){}

  // Fallback
  try{
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  }catch(_e){
    return false;
  }
}
