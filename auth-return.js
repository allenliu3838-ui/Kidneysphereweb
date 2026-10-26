// Authentication links carry only a same-origin destination. Keep it in the URL
// so confirmation/recovery emails work when opened in another browser or device.
export const AUTH_RETURN_VERSION = '20260915_mobile1';
export const DEFAULT_AUTH_RETURN = '/my-learning.html';

const AUTH_PAGES = new Set(['login.html', 'register.html', 'auth-callback.html', 'forgot.html', 'reset.html']);
const currentHref = () => globalThis.location?.href || 'https://kidneysphere.com/';

export function safeAuthReturn(candidate, baseHref = currentHref()) {
  if (typeof candidate !== 'string' || !candidate.trim()) return DEFAULT_AUTH_RETURN;
  // Browsers normalize backslashes and control characters when parsing URLs.
  // Reject them before parsing, including encoded path variants.
  if (/[\u0000-\u001f\u007f\\]/.test(candidate)) return DEFAULT_AUTH_RETURN;
  const raw = candidate.trim();
  if (raw.startsWith('//')) return DEFAULT_AUTH_RETURN;
  try {
    const base = new URL(baseHref);
    const url = new URL(raw, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== base.origin || url.username || url.password) {
      return DEFAULT_AUTH_RETURN;
    }
    let path = url.pathname;
    for (let i = 0; i < 3; i += 1) {
      if (path.startsWith('//') || /[\u0000-\u001f\u007f\\]/.test(path)) return DEFAULT_AUTH_RETURN;
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    }
    if (path.startsWith('//') || /[\u0000-\u001f\u007f\\]/.test(path)) return DEFAULT_AUTH_RETURN;
    // An auth page is never the final destination; it would send users back
    // through authentication after they have just finished it.
    if (AUTH_PAGES.has(path.split('/').pop().toLowerCase())) return DEFAULT_AUTH_RETURN;
    return url.pathname + url.search + url.hash;
  } catch (_error) {
    return DEFAULT_AUTH_RETURN;
  }
}

export function getAuthReturnTarget(search = globalThis.location?.search || '', baseHref = currentHref()) {
  return safeAuthReturn(new URLSearchParams(search).get('next'), baseHref);
}

export function authFlowUrl(page, next, params = {}, baseHref = currentHref()) {
  const base = new URL(baseHref);
  const url = new URL(page, base);
  if (url.origin !== base.origin || !AUTH_PAGES.has(url.pathname.split('/').pop())) {
    throw new Error('Unsupported authentication page');
  }
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  url.searchParams.set('v', AUTH_RETURN_VERSION);
  url.searchParams.set('next', safeAuthReturn(next, baseHref));
  return url.pathname + url.search;
}

export function preserveAuthReturnLinks(next, root = document, baseHref = currentHref()) {
  for (const link of root.querySelectorAll('a[data-auth-return]')) {
    const url = new URL(link.getAttribute('href'), baseHref);
    link.setAttribute('href', authFlowUrl(url.pathname, next, Object.fromEntries(url.searchParams), baseHref));
  }
}
