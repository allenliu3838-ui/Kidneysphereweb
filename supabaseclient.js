/**
 * supabaseClient.js (ESM)
 *
 * Goals (Phase 1):
 * - Static-site friendly (no build step)
 * - Loads @supabase/supabase-js from CDN with multiple fallbacks
 * - Stable auth storage (localStorage/sessionStorage + cookie fallback)
 * - Exports a consistent API used across pages
 * - Improves login/logout reliability and debuggability
 */

import {
  SUPABASE_URL as CFG_SUPABASE_URL,
  SUPABASE_ANON_KEY as CFG_SUPABASE_ANON_KEY,
} from './assets/config.js';

// ----------------------------
// Runtime config
// ----------------------------

export const SUPABASE_URL = String(
  CFG_SUPABASE_URL || (typeof window !== 'undefined' ? window.SUPABASE_URL : '') || ''
).trim();

export const SUPABASE_ANON_KEY = String(
  CFG_SUPABASE_ANON_KEY ||
    (typeof window !== 'undefined' ? window.SUPABASE_ANON_KEY : '') ||
    ''
).trim();

const CONFIG_SOURCE = CFG_SUPABASE_URL ? 'module' : 'window';

// ----------------------------
// CDN fallback (ESM + UMD)
// ----------------------------

const SUPABASE_JS_VERSION = '2.89.0';

const SUPABASE_ESM_CANDIDATES = [
  `https://unpkg.com/@supabase/supabase-js@${SUPABASE_JS_VERSION}/dist/module/index.js`,
  `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${SUPABASE_JS_VERSION}/+esm`,
  `https://esm.sh/@supabase/supabase-js@${SUPABASE_JS_VERSION}`,
  `https://cdn.skypack.dev/@supabase/supabase-js@${SUPABASE_JS_VERSION}?min`,
];

const SUPABASE_UMD_CANDIDATES = [
  `https://unpkg.com/@supabase/supabase-js@${SUPABASE_JS_VERSION}/dist/umd/supabase.min.js`,
  `https://registry.npmmirror.com/@supabase/supabase-js/${SUPABASE_JS_VERSION}/files/dist/umd/supabase.min.js`,
  `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${SUPABASE_JS_VERSION}/dist/umd/supabase.min.js`,
];

let _createClient = null;
let _supabaseLibSource = null;
let _supabaseInitError = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    try {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.referrerPolicy = 'no-referrer';
      s.onload = () => resolve(true);
      s.onerror = () => reject(new Error('script_load_failed'));
      document.head.appendChild(s);
    } catch (e) {
      reject(e);
    }
  });
}

function pickGlobalCreateClient() {
  try {
    const g = typeof window !== 'undefined' ? window : null;
    const lib = (g && (g.supabase || g.Supabase || g.supabaseJs)) || null;
    if (lib && typeof lib.createClient === 'function') return lib.createClient;
  } catch (_e) {
    // ignore
  }
  return null;
}

async function loadCreateClient() {
  if (_createClient) return _createClient;

  // 0) If already loaded globally (because you injected a UMD build elsewhere)
  const already = pickGlobalCreateClient();
  if (already) {
    _createClient = already;
    _supabaseLibSource = 'global';
    return _createClient;
  }

  // 1) Try ESM candidates
  for (const url of SUPABASE_ESM_CANDIDATES) {
    try {
      const mod = await import(url);
      if (mod && typeof mod.createClient === 'function') {
        _createClient = mod.createClient;
        _supabaseLibSource = url;
        return _createClient;
      }
    } catch (_e) {
      // try next
    }
  }

  // 2) Fallback: inject UMD script
  for (const url of SUPABASE_UMD_CANDIDATES) {
    try {
      await loadScript(url);
      const cc = pickGlobalCreateClient();
      if (typeof cc === 'function') {
        _createClient = cc;
        _supabaseLibSource = url;
        return _createClient;
      }
    } catch (_e) {
      // try next
    }
  }

  throw new Error(
    '无法加载 @supabase/supabase-js（可能网络拦截/不稳定）。建议在 assets/vendor 放置本地 supabase-js.esm.js。'
  );
}

// ----------------------------
// Safe storage adapter
// ----------------------------

function canUseStorage(store) {
  try {
    const k = '__ks_test__' + String(Math.random()).slice(2);
    store.setItem(k, '1');
    store.removeItem(k);
    return true;
  } catch (_e) {
    return false;
  }
}

function getCookie(name) {
  try {
    const m = document.cookie.match(
      new RegExp(
        '(?:^|; )' +
          name.replace(/[.$?*|{}()\[\]\\\/\+^]/g, '\\$&') +
          '=([^;]*)'
      )
    );
    return m ? decodeURIComponent(m[1]) : null;
  } catch (_e) {
    return null;
  }
}

function setCookie(name, value) {
  try {
    const isHttps = location.protocol === 'https:';
    const maxAge = 60 * 60 * 24 * 30; // 30d
    document.cookie = `${name}=${encodeURIComponent(
      value
    )}; Path=/; Max-Age=${maxAge}; SameSite=Lax;${isHttps ? ' Secure;' : ''}`;
  } catch (_e) {
    // ignore
  }
}

function delCookie(name) {
  try {
    const isHttps = location.protocol === 'https:';
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax;${
      isHttps ? ' Secure;' : ''
    }`;
  } catch (_e) {
    // ignore
  }
}

function makeSafeStorage() {
  const hasLS = typeof localStorage !== 'undefined' && canUseStorage(localStorage);
  const hasSS = typeof sessionStorage !== 'undefined' && canUseStorage(sessionStorage);

  // Cookie fallback is ONLY for environments where Web Storage is unavailable
  // (e.g. certain private browsing / restrictive WebViews).
  // Older builds mirrored the auth session into cookies even when localStorage worked;
  // we avoid that to reduce exposure and request header bloat.
  const useCookie = !(hasLS || hasSS);

  return {
    getItem(key) {
      if (hasLS) {
        const v = localStorage.getItem(key);
        if (v != null) return v;
      }
      if (hasSS) {
        const v = sessionStorage.getItem(key);
        if (v != null) return v;
      }
      return useCookie ? getCookie(key) : null;
    },
    setItem(key, value) {
      let written = false;
      if (hasLS) {
        try {
          localStorage.setItem(key, value);
          written = true;
        } catch (_e) {
          // ignore
        }
      }
      if (!written && hasSS) {
        try {
          sessionStorage.setItem(key, value);
          written = true;
        } catch (_e) {
          // ignore
        }
      }

      if (useCookie) {
        // Fallback only
        setCookie(key, value);
      } else {
        // Cleanup legacy mirrored cookies (older builds always mirrored sessions).
        delCookie(key);
      }
    },
    removeItem(key) {
      if (hasLS) {
        try {
          localStorage.removeItem(key);
        } catch (_e) {
          // ignore
        }
      }
      if (hasSS) {
        try {
          sessionStorage.removeItem(key);
        } catch (_e) {
          // ignore
        }
      }
      delCookie(key);
    },
  };
}

const SAFE_STORAGE = makeSafeStorage();

export const AUTH_STORAGE_KEY = 'kidneysphere-auth-v1';

// ----------------------------
// Create supabase client
// ----------------------------

export let supabase = null;
let _initPromise = null;

async function initSupabase() {
  if (!(SUPABASE_URL && SUPABASE_ANON_KEY)) {
    supabase = null;
    try {
      if (typeof window !== 'undefined') window.sb = null;
    } catch (_e) {
      // ignore
    }
    return null;
  }

  // Avoid concurrent init
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const createClient = await loadCreateClient();

      supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          storage: SAFE_STORAGE,
          storageKey: AUTH_STORAGE_KEY,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false, // handled by auth-callback.html
        },
        global: {
          headers: {
            'x-kidneysphere-client': 'phase1-emailauth-v3',
            // Reduce stale reads on aggressive proxies / captive portals
            'cache-control': 'no-cache',
          },
        },
      });

      _supabaseInitError = null;
      try {
        if (typeof window !== 'undefined') window.sb = supabase;
      } catch (_e) {
        // ignore
      }

      return supabase;
    } catch (e) {
      _supabaseInitError = e;
      supabase = null;
      try {
        if (typeof window !== 'undefined') window.sb = null;
      } catch (_e) {
        // ignore
      }
      return null;
    } finally {
      // Allow retry later (e.g. if CDN was blocked temporarily)
      _initPromise = null;
    }
  })();

  return _initPromise;
}

export function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export async function ensureSupabase() {
  if (supabase) return supabase;
  return await initSupabase();
}

// Backward-compatible alias used by some page modules.
// Several pages import { getSupabase } from './supabaseClient.js?v=20260128_030'.
// Keep this wrapper to avoid breaking those imports.
export async function getSupabase() {
  return await ensureSupabase();
}

export function getSupabaseDebugInfo() {
  return {
    configured: isConfigured(),
    hasClient: Boolean(supabase),
    libSource: _supabaseLibSource,
    initError: _supabaseInitError
      ? String(_supabaseInitError.message || _supabaseInitError)
      : null,
    storageKey: AUTH_STORAGE_KEY,
    configSource: CONFIG_SOURCE,
  };
}

// ----------------------------
// Role + level system
// ----------------------------

export function normalizeRole(role) {
  return (role || '').toString().trim().toLowerCase();
}

export function isAdminRole(role) {
  const r = normalizeRole(role);
  return r === 'admin' || r === 'super_admin' || r === 'owner';
}

export const LEVEL_THRESHOLDS = [
  0, 10, 30, 60, 100, 160, 240, 340, 460, 600, 760, 940,
];

export function computeLevelFromPoints(points) {
  const p = Math.max(0, Number(points || 0));
  let lv = 1;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
    if (p >= LEVEL_THRESHOLDS[i]) lv = i + 1;
  }
  return Math.min(12, Math.max(1, lv));
}

export function levelName(level) {
  const lv = Math.min(12, Math.max(1, Number(level || 1)));
  const tiers = ['青铜', '白银', '黄金', '铂金'];
  const romans = ['I', 'II', 'III'];
  const t = Math.floor((lv - 1) / 3);
  const r = (lv - 1) % 3;
  // UI preference: no space between tier and roman (e.g. 青铜I)
  return `${tiers[t]}${romans[r]}`;
}

export function levelLabelFromPoints(points) {
  const lv = computeLevelFromPoints(points);
  return `Lv${lv} · ${levelName(lv)}`;
}

export function nextLevelProgress(points) {
  const p = Math.max(0, Number(points || 0));
  const lv = computeLevelFromPoints(p);
  const idx = lv - 1;
  const cur = LEVEL_THRESHOLDS[idx] ?? 0;
  const next = LEVEL_THRESHOLDS[idx + 1] ?? null;
  if (next == null) {
    return { level: lv, points: p, current: cur, next: null, remain: 0, pct: 100 };
  }
  const remain = Math.max(0, next - p);
  const pct = Math.min(100, Math.max(0, ((p - cur) / (next - cur)) * 100));
  return { level: lv, points: p, current: cur, next, remain, pct };
}

// ----------------------------
// UI helpers
// ----------------------------

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (s) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[s]));
}

export function toast(title, message = '', type = 'ok') {
  const el = document.querySelector('[data-toast]');
  const rawTitle = String(title ?? '');
  const rawMessage = String(message ?? '');

  // Go-live polish: avoid leaking internal deployment / migration / backend details to end users.
  // Super admins can still see the raw message by enabling admin UI mode.
  const showDev = Boolean(typeof window !== 'undefined' && window.__SHOW_DEV_HINTS__);
  const devKw = /(Supabase|MIGRATION_|Reload schema|schema cache|SQL Editor|Settings\s*→\s*API|assets\/config\.js|SUPABASE_URL|SUPABASE_ANON_KEY|service_role|bucket|Policies|RLS|PostgREST)/i;

  let t = rawTitle;
  let m = rawMessage;
  if (!showDev && devKw.test(`${rawTitle} ${rawMessage}`)) {
    // Keep the title if it is already user-friendly; otherwise use a generic one.
    const titleTooTech = /(未初始化|未配置|schema|迁移|migrat|supabase|sql)/i.test(rawTitle);
    if (devKw.test(rawTitle) || titleTooTech || !rawTitle.trim()) {
      t = type === 'err' ? '功能暂不可用' : '提示';
    }
    m = '系统正在维护或升级中，请稍后重试；如持续失败，请联系管理员。';
  }

  if (!el) {
    // eslint-disable-next-line no-alert
    alert(`${t}
${m}`);
    return;
  }
  el.className = `toast show ${type === 'err' ? 'err' : 'ok'}`;
  el.innerHTML = `<b>${escapeHtml(t)}</b><div class="small">${escapeHtml(m)}</div>`;
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}



// ----------------------------
// Time helpers (Beijing / Asia-Shanghai)
// ----------------------------

export const BEIJING_TIMEZONE = 'Asia/Shanghai';
export const BEIJING_LOCALE = 'zh-CN';

// YYYY-MM-DD in Beijing time (stable for daily rotations, schedules, etc.)
export function beijingDayKey(date = new Date()){
  try{
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: BEIJING_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }catch(_e){
    // Fallback: treat as UTC+8
    try{
      const d = (date instanceof Date) ? date : new Date(date);
      const t = d.getTime() + 8 * 60 * 60 * 1000;
      const u = new Date(t);
      const y = u.getUTCFullYear();
      const m = String(u.getUTCMonth()+1).padStart(2,'0');
      const dd = String(u.getUTCDate()).padStart(2,'0');
      return `${y}-${m}-${dd}`;
    }catch{ return ''; }
  }
}

// Format a timestamp in Beijing time.
// Default: YYYY-MM-DD HH:mm
export function formatBeijingDateTime(ts, options = {}){
  const { withSeconds = false, dateOnly = false, suffix = '' } = options || {};
  if(!ts) return '';
  try{
    const d = new Date(ts);
    if(Number.isNaN(d.getTime())) return '';
    const opts = {
      timeZone: BEIJING_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    };
    if(!dateOnly){
      opts.hour = '2-digit';
      opts.minute = '2-digit';
      opts.hour12 = false;
      if(withSeconds) opts.second = '2-digit';
    }
    const parts = new Intl.DateTimeFormat(BEIJING_LOCALE, opts).formatToParts(d);
    const m = Object.fromEntries(parts.map(p=>[p.type,p.value]));
    let s = `${m.year}-${m.month}-${m.day}`;
    if(!dateOnly){
      s += ` ${m.hour}:${m.minute}`;
      if(withSeconds) s += `:${m.second}`;
    }
    if(suffix) s += suffix;
    return s;
  }catch(_e){
    try{ return String(ts); }catch{ return ''; }
  }
}

export function formatBeijingDate(ts){
  return formatBeijingDateTime(ts, { dateOnly: true });
}

// ----------------------------
// Profile + auth helpers
// ----------------------------

export async function getUserProfile(userOrId) {
  if (!isConfigured()) return null;
  if (!supabase) await ensureSupabase();
  if (!supabase) return null;

  const uid = (typeof userOrId === "string") ? userOrId : userOrId?.id;
  if (!uid) return null;

  try {
    const colsV11 = "id, full_name, role, avatar_url, points, membership_status";
    const colsV10 = "id, full_name, role, avatar_url";

    let res = await supabase
      .from("profiles")
      .select(colsV11)
      .eq("id", uid)
      .maybeSingle();

    if (res?.error) {
      const msg = String(res.error.message || res.error);
      if (msg.toLowerCase().includes("column") || msg.toLowerCase().includes("does not exist")) {
        res = await supabase
          .from("profiles")
          .select(colsV10)
          .eq("id", uid)
          .maybeSingle();
      }
    }

    if (res?.error) return null;
    return res.data || null;
  } catch (_e) {
    return null;
  }
}

export async function getSession() {
  if (!isConfigured()) return null;
  if (!supabase) await ensureSupabase();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data?.session || null;
  } catch (_e) {
    return null;
  }
}

export async function getCurrentUser() {
  const session = await getSession();
  return session?.user || null;
}

export async function ensureAuthed(redirectTo = 'login.html') {
  // Demo mode
  if (!isConfigured()) return true;

  if (!supabase) await ensureSupabase();
  if (!supabase) return true;

  let session = await getSession();
  if (!session) {
    // Best-effort refresh
    try {
      const { data, error } = await supabase.auth.refreshSession();
      if (!error) session = data?.session || null;
    } catch (_e) {
      // ignore
    }
  }

  if (!session) {
    const next = encodeURIComponent(
      (location.pathname.split('/').pop() || 'index.html') + location.search
    );
    const join = String(redirectTo).includes('?') ? '&' : '?';
    location.href = `${redirectTo}${join}next=${next}`;
    return false;
  }
  return true;
}

export function clearLocalAuthCache() {
  try {
    SAFE_STORAGE.removeItem(AUTH_STORAGE_KEY);
  } catch (_e) {
    // ignore
  }

  // Also wipe older keys that might linger across iterations
  try {
    if (typeof localStorage !== 'undefined') {
      Object.keys(localStorage)
        .filter((k) => k.includes('auth-token') || k.includes('supabase') || k.includes('sb-'))
        .forEach((k) => {
          try {
            localStorage.removeItem(k);
          } catch (_e) {
            // ignore
          }
        });
    }
  } catch (_e) {
    // ignore
  }
}

export async function signOut() {
  try {
    if (!isConfigured()) {
      toast('已退出', '（演示模式）Supabase 未配置。', 'ok');
      location.href = 'index.html';
      return;
    }

    if (!supabase) await ensureSupabase();
    if (!supabase) {
      clearLocalAuthCache();
      toast('已退出', '认证服务不可用，已清理本地登录态。', 'ok');
      location.href = 'index.html';
      return;
    }

    const { data } = await supabase.auth.getSession();
    if (!data?.session) {
      clearLocalAuthCache();
      toast('已退出', '当前已是未登录状态。', 'ok');
      location.href = 'index.html';
      return;
    }

    // Sign out (local session). If you want to sign out ALL devices, use scope:'global'.
    const { error } = await supabase.auth.signOut();
    if (error) {
      // Session might already be invalid. Still clear local cache.
      console.warn('signOut warning:', error.message);
    }

    clearLocalAuthCache();
    toast('已退出', '期待你下次回来。', 'ok');
    setTimeout(() => (location.href = 'index.html'), 600);
  } catch (e) {
    console.warn('signOut fallback:', e);
    clearLocalAuthCache();
    toast('已退出', '已清理本地登录态并返回首页。', 'ok');
    location.href = 'index.html';
  }
}

// ----------------------------
// Expose helpers for quick debugging in console (non-breaking)
// ----------------------------

try {
  if (typeof window !== 'undefined') {
    window.KS = window.KS || {};
    Object.assign(window.KS, {
      supabase: () => supabase,
      ensureSupabase,
      isConfigured,
      getSupabaseDebugInfo,
      getSession,
      getCurrentUser,
      getUserProfile,
      ensureAuthed,
      signOut,
      clearLocalAuthCache,
      normalizeRole,
      isAdminRole,
      LEVEL_THRESHOLDS,
      computeLevelFromPoints,
      levelName,
      levelLabelFromPoints,
      nextLevelProgress,
      toast,
      // time helpers (Beijing)
      BEIJING_TIMEZONE,
      BEIJING_LOCALE,
      beijingDayKey,
      formatBeijingDateTime,
      formatBeijingDate,
    });
  }
} catch (_e) {
  // ignore
}

// Kick off init in the background (do not block page render)
if (isConfigured()) {
  // no await
  ensureSupabase();
}
