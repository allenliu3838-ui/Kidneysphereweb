import { supabase, ensureSupabase, getSession, getUserProfile, ensureAuthed, signOut, toast, isConfigured, isAdminRole, normalizeRole, computeLevelFromPoints, levelName } from './supabaseClient.js?v=20260128_030';

// ------------------------------------------------------------
// Password recovery guard (Supabase)
// Why: If the Supabase recovery link accidentally lands on index/login/etc,
// the browser may keep an existing session (often the "main" account) and the
// user will feel that "reset opens the wrong account".
//
// We route all recovery links to reset.html so the token can be consumed and
// the correct recovery session can be established.
// ------------------------------------------------------------
(function redirectRecoveryToReset(){
  try{
    const path = (location.pathname.split('/').pop() || '').toLowerCase();
    if(path === 'reset.html') return;

    const u = new URL(location.href);
    const hash = (u.hash || '').startsWith('#') ? u.hash.slice(1) : (u.hash || '');
    const hp = new URLSearchParams(hash);
    const type = (u.searchParams.get('type') || hp.get('type') || '').toLowerCase();

    // Only redirect password recovery flows.
    // (Signup / magic link will carry a different type, e.g. "signup".)
    const isRecovery = type === 'recovery';
    if(!isRecovery) return;

    const target = new URL('reset.html', location.origin);
    target.search = u.search;
    target.hash = u.hash;
    location.replace(target.toString());
  }catch(_e){ /* ignore */ }
})();


// ------------------------------
// Build / cache-busting version
// Why: Chrome normal mode (and iOS Safari) may keep old CSS/JS for days if earlier
// deployments were served with long max-age. Incognito/Edge look fine because they
// don't reuse that cache.
//
// We solve it by:
// 1) stamping current URL with v via history.replaceState (no reload)
// 2) adding a stable ?v=BUILD_VERSION to internal .html links
// ------------------------------
// Build stamp used for cache-busting and consistent navigation.
// Bump this whenever you ship a new zip.
const BUILD_VERSION = "20260128_030";

// Admin UI view mode (frontend-only)
// Why: super/admin accounts often want to browse as a normal member.
// This only controls UI visibility; it does NOT change DB/RLS permissions.
const VIEW_MODE_KEY = 'ks_view_mode';

function readViewModePref(){
  try{
    const v = localStorage.getItem(VIEW_MODE_KEY);
    if(v === 'admin' || v === 'member') return v;
    return null;
  }catch{ return null; }
}

function writeViewModePref(v){
  try{
    if(v === 'admin' || v === 'member') localStorage.setItem(VIEW_MODE_KEY, v);
  }catch(_e){}
}

function clearViewModePref(){
  try{ localStorage.removeItem(VIEW_MODE_KEY); }catch{}
}

function applyVersionParamToUrl(){
  try{
    const u = new URL(location.href);
    if(u.searchParams.get('v') !== BUILD_VERSION){
      u.searchParams.set('v', BUILD_VERSION);
      history.replaceState({}, '', u.toString());
    }
  }catch(_e){}
}

function applyVersionParamToLinks(){
  try{
    const links = Array.from(document.querySelectorAll('a[href]'));
    for(const a of links){
      const href = a.getAttribute('href') || '';
      if(!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) continue;

      const parts = href.split('#');
      const base = parts[0];
      const hash = parts[1] ? ('#' + parts[1]) : '';
      if(!base.endsWith('.html')) continue;

      const u = new URL(base, location.origin);
      if(u.searchParams.get('v') !== BUILD_VERSION){
        u.searchParams.set('v', BUILD_VERSION);
      }
      a.setAttribute('href', u.pathname + u.search + hash);
    }
  }catch(_e){}
}


// ------------------------------
// Shared nav / footer / toast injection
// Single source of truth: HTML pages only need
//   <header class="nav"></header>
//   <footer class="footer" data-blurb="..."></footer>
// and app.js fills them in at runtime.
// ------------------------------

function injectNav(){
  const header = document.querySelector('header.nav');
  if(!header) return;
  header.innerHTML = `
    <div class="container nav-inner">
      <a class="brand" href="index.html" aria-label="KidneySphere Home">
        <img src="assets/logo.png" alt="KidneySphere AI Logo" />
        <div class="title">
          <b>肾域AI · KidneySphereAI</b>
          <span>GlomCon中国 × KidneySphere AI</span>
        </div>
      </a>
      <nav class="menu" aria-label="Primary">
        <a data-nav href="index.html"><span class="zh">首页</span><span class="en">Home</span></a>
        <a data-nav href="community.html"><span class="zh">社区讨论</span><span class="en">Community</span></a>
        <a data-nav href="learning.html"><span class="zh">学习中心</span><span class="en">Learning</span></a>
        <a data-nav href="frontier.html"><span class="zh">前沿进展</span><span class="en">Frontier</span></a>
        <a data-nav href="moments.html"><span class="zh">社区动态</span><span class="en">Moments</span></a>
        <a data-nav href="events.html"><span class="zh">会议与活动</span><span class="en">Events</span></a>
        <a data-nav href="research.html"><span class="zh">临床研究中心</span><span class="en">Research</span></a>
        <a data-nav href="about.html"><span class="zh">关于</span><span class="en">About</span></a>
      </nav>
      <div class="auth" data-auth>
        <a class="btn" href="login.html">登录</a>
        <a class="btn primary" href="register.html">注册</a>
      </div>
    </div>`;
}

function injectFooter(){
  const footer = document.querySelector('footer.footer');
  if(!footer) return;
  // Skip if the footer already has child elements (custom footer kept in HTML)
  if(footer.children.length > 0) return;
  const blurb = escapeHtml(footer.getAttribute('data-blurb') || '以病例讨论与学习体系为核心，逐步建设可沉淀、可检索的肾脏病知识社区。');
  footer.innerHTML = `
    <div class="container footer-grid">
      <div>
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px">
          <img src="assets/logo.png" alt="logo" style="width:26px;height:26px;border-radius:8px">
          <b>KidneySphere × KidneySphere AI</b>
        </div>
        <div class="small">${blurb}</div>
      </div>
      <div class="small">
        <div>© 2025–2026 KidneySphere</div>
        <div style="margin-top:8px">联系：<a href="mailto:china@glomcon.org">china@glomcon.org</a></div>
      </div>
    </div>`;
}

function ensureToast(){
  if(document.querySelector('[data-toast]')) return;
  const d = document.createElement('div');
  d.className = 'toast';
  d.setAttribute('data-toast', '');
  const footer = document.querySelector('footer.footer');
  if(footer) footer.parentNode.insertBefore(d, footer);
  else document.body.appendChild(d);
}

function ensureExtraNavLinks(){
  // Add global "Search" entry without manually editing every HTML header.
  // (All pages share app.js.)
  try{
    const menu = document.querySelector('.menu');
    if(!menu) return;
    const has = menu.querySelector('a[href^="search.html"], a[href^="/search"], a[href*="search.html"]');
    if(has) return;

    const a = document.createElement('a');
    a.setAttribute('data-nav','');
    a.setAttribute('href','search.html');
    a.innerHTML = '<span class="zh">搜索</span><span class="en">Search</span>';
    menu.appendChild(a);
  }catch(_e){ /* ignore */ }
}

document.addEventListener('DOMContentLoaded', ()=>{
  applyVersionParamToUrl();
  applyVersionParamToLinks();

  // 生产环境默认隐藏“开发/初始化提示”（仅超级管理员在“管理模式”下可见）
  markDevHintsAsSuperAdminOnly();
});

// 将包含开发/初始化关键词的提示块标记为 superadmin-only（默认隐藏）
function markDevHintsAsSuperAdminOnly(){
  try{
    const kw = /(Supabase|MIGRATION_|Reload schema|schema cache|Redirect URL|SQL Editor|Settings\s*→\s*API|Site URL|anon\s*key|service_role|bucket|Policies|RLS|初始化提示|开发者提示|管理员提示：培训项目|付费接口预留)/i;
    const candidates = document.querySelectorAll('.note, .small.muted, .muted.small');
    candidates.forEach(el => {
      // 允许个别提示块显式保留（用于患者隐私等必须对外展示的提醒）
      if(el.hasAttribute('data-keep-public-hint')) return;
      const txt = (el.textContent || '').trim();
      if(!txt) return;
      if(kw.test(txt)){
        el.setAttribute('data-superadmin-only', '');
        el.hidden = true;
      }
    });
  }catch(_e){}
}

// ------------------------------
// Mobile navigation (hamburger + drawer)
// ------------------------------
function initMobileDrawer(){
  const navInner = document.querySelector('.nav-inner');
  const brand = document.querySelector('.brand');
  const menu = document.querySelector('.menu');
  if(!navInner || !brand || !menu) return;

  // 1) Toggle button
  let toggle = navInner.querySelector('[data-menu-toggle]');
  if(!toggle){
    toggle = document.createElement('button');
    toggle.className = 'menu-toggle';
    toggle.type = 'button';
    toggle.setAttribute('data-menu-toggle', '');
    toggle.setAttribute('aria-label', '菜单');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '☰<span class="notify-dot" aria-hidden="true"></span>';
    navInner.appendChild(toggle);
  }else{
    // Ensure the unread dot exists (older cached HTML might miss it)
    if(!toggle.querySelector('.notify-dot')){
      toggle.insertAdjacentHTML('beforeend', '<span class="notify-dot" aria-hidden="true"></span>');
    }
  }

  // 2) Drawer container
  let drawer = document.querySelector('[data-mobile-drawer]');
  if(!drawer){
    drawer = document.createElement('div');
    drawer.className = 'mobile-drawer';
    drawer.setAttribute('data-mobile-drawer', '');

    const brandHtml = brand.outerHTML;

    drawer.innerHTML = `
      <div class="drawer-overlay" data-drawer-close></div>
      <div class="drawer-panel" role="dialog" aria-modal="true" aria-label="菜单">
        <div class="drawer-top">
          <div class="drawer-brand">${brandHtml}</div>
          <button class="icon-btn" type="button" data-drawer-close aria-label="关闭">✕</button>
        </div>

        <div class="auth" data-auth></div>

        <div class="drawer-links" data-drawer-links></div>
        <div class="small muted" style="margin-top:auto">© 2025 KidneySphere</div>
      </div>
    `;

    document.body.appendChild(drawer);

    // Fill links from desktop menu
    const linksRoot = drawer.querySelector('[data-drawer-links]');
    const links = Array.from(menu.querySelectorAll('a[data-nav]'))
      .map(a => ({ href: a.getAttribute('href'), html: a.innerHTML }));
    function badgeTypeForHref(href){
      const h = String(href || '').split('#')[0].split('?')[0];
      if(h.endsWith('community.html') || h.endsWith('board.html')) return 'cases';
      if(h.endsWith('moments.html')) return 'moments';
      if(h.endsWith('learning.html') || h.endsWith('articles.html') || h.endsWith('article.html')) return 'articles';
      return '';
    }
    linksRoot.innerHTML = links.map(l => {
      const href = l.href ? String(l.href) : '#';
      const bt = badgeTypeForHref(href);
      const badgeAttr = bt ? ` data-badge="${escapeAttr(bt)}"` : '';
      const dot = bt ? `<span class="badge-dot" aria-hidden="true"></span>` : '';
      return `<a data-nav${badgeAttr} href="${escapeAttr(href)}">${l.html}${dot}</a>`;
    }).join('');
  }

  const body = document.body;
  const closeBtns = Array.from(drawer.querySelectorAll('[data-drawer-close]'));

  function open(){
    body.classList.add('menu-open');
    toggle.setAttribute('aria-expanded','true');
    // focus close button for accessibility
    setTimeout(()=>{
      drawer.querySelector('[data-drawer-close]')?.focus?.();
    }, 0);
  }

  function close(){
    body.classList.remove('menu-open');
    toggle.setAttribute('aria-expanded','false');
    // return focus
    setTimeout(()=>{ toggle.focus?.(); }, 0);
  }

  toggle.addEventListener('click', ()=>{
    if(body.classList.contains('menu-open')) close();
    else open();
  });

  closeBtns.forEach(el=> el.addEventListener('click', close));
  // Close when selecting any link (auth menu links are injected later)
  drawer.addEventListener('click', (e)=>{
    const a = e.target?.closest?.('a');
    if(a) close();
    const logoutBtn = e.target?.closest?.('[data-logout]');
    if(logoutBtn) close();
  });
  document.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape' && body.classList.contains('menu-open')) close();
  });
}

function escapeAttr(str){
  return String(str).replace(/[&<>"]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s]));
}

function setActiveNav(){
  const path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('[data-nav]').forEach(a=>{
    const href = a.getAttribute('href');
    if(href === path){ a.classList.add('active'); }
  });
}

// ------------------------------
// Global shortcut: press "/" to jump to site search
// - If already on search.html, focus the input
// - If user selected some text, carry it as the initial query
// ------------------------------
function initSearchHotkey(){
  try{
    if(window.__ks_search_hotkey_bound) return;
    window.__ks_search_hotkey_bound = true;

    document.addEventListener('keydown', (e)=>{
      if(e.key !== '/') return;
      if(e.ctrlKey || e.metaKey || e.altKey) return;

      const t = e.target;
      const tag = (t?.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable;
      if(typing) return;

      e.preventDefault();

      const path = (location.pathname.split('/').pop() || '').toLowerCase();
      if(path === 'search.html'){
        document.getElementById('siteSearchInput')?.focus?.();
        return;
      }

      let seed = '';
      try{
        seed = String(window.getSelection?.()?.toString?.() || '').trim();
      }catch(_e){ seed = ''; }
      if(seed.length > 48) seed = seed.slice(0, 48);
      const u = new URL('search.html', location.origin);
      if(seed) u.searchParams.set('q', seed);
      location.href = u.pathname + u.search;
    }, { passive:false });
  }catch(_e){ /* ignore */ }
}

function roleLabelZh(role){
  const r = normalizeRole(role);
  if(!r) return 'Member';
  // Doctor roles
  // - doctor_verified: passed verification
  // - doctor_pending: applied but not verified (reserved)
  // - doctor: legacy alias (treat as verified)
  if(r === 'doctor_verified' || r === 'doctor') return '认证医生';
  if(r === 'doctor_pending') return '医生（待认证）';
  if(r === 'industry') return '企业/赞助';
  if(r === 'official') return '官方';
  if(r === 'admin') return '管理员';
  if(r === 'moderator') return '版主';
  if(r === 'super_admin' || r === 'owner') return '超级管理员';
  if(r === 'member' || r === 'user') return 'Member';
  return role;
}

// ------------------------------
// Admin UI mode (Super admin wants to browse as a normal member)
// - This ONLY affects frontend UI visibility.
// - Supabase RLS permissions are still enforced by the real role.
// ------------------------------
function uiRoleLabelZh(realRole, isAdminUser, isAdminUi){
  if(isAdminUser && !isAdminUi) return '普通会员';
  return roleLabelZh(realRole);
}

async function renderAuthArea(){
  const authEls = Array.from(document.querySelectorAll('[data-auth]'));
  if(authEls.length === 0) return;

  // If Supabase is not configured, show a warning badge + allow local demo.
  if(!isConfigured()){
    toggleAdminOnly(false);
	  toggleSuperAdminOnly(false);
	  try{ window.__IS_SUPER_ADMIN__ = false; window.__SHOW_DEV_HINTS__ = false; }catch(_e){}
    authEls.forEach(auth => {
      auth.innerHTML = `
        <span class="badge" title="请在 assets/config.js 填入 Supabase 配置后再上线真实注册登录">
          ⚠️ Supabase 未配置
        </span>
        <a class="btn" href="login.html">登录</a>
        <a class="btn primary" href="register.html">注册</a>
      `;
    });
    return;
  }

  const session = await getSession();
  if(!session){
    toggleAdminOnly(false);
	  toggleSuperAdminOnly(false);
	  try{ window.__IS_SUPER_ADMIN__ = false; window.__SHOW_DEV_HINTS__ = false; }catch(_e){}
    authEls.forEach(auth => {
      auth.innerHTML = `
        <a class="btn" href="login.html">登录</a>
        <a class="btn primary" href="register.html">注册</a>
      `;
    });
    return;
  }

  const user = session.user;
  const profile = await getUserProfile(user);

  const name = profile?.full_name || user.user_metadata?.full_name || user.phone || user.email || 'Member';
  const roleRaw = profile?.role || user.user_metadata?.role || 'member';
  const role = normalizeRole(roleRaw);
  const isAdmin = isAdminRole(role);
  const isSuper = String(role || '').toLowerCase() === 'super_admin';

  // Doctor verification
  // Source of truth should be profiles.role (doctor_verified), but some deployments may have
  // existing records in doctor_verifications while profiles.role wasn't updated (e.g. older SQL).
  // To avoid confusing UX ("已认证" but header stays Member), we add a safe fallback:
  // if there is an approved doctor_verifications record for this user, treat as verified in UI.
  let doctorVerifiedByRecord = false;
  if(!isAdmin && role !== 'doctor_verified' && role !== 'doctor' && role !== 'moderator'){
    try{
      await ensureSupabase();
      const { data: dv } = await supabase
        .from('doctor_verifications')
        .select('status')
        .eq('user_id', user.id)
        .maybeSingle();
      const st = String(dv?.status || '').toLowerCase();
      if(st === 'approved' || st === 'verified') doctorVerifiedByRecord = true
    }catch(_e){ /* ignore */ }
  }

  const isDoctorVerified = (role === 'doctor_verified' || role === 'doctor' || role === 'moderator' || isAdmin || doctorVerifiedByRecord);
  const doctorMenuLabel = isDoctorVerified
    ? '✅ 医生认证'
    : (role === 'doctor_pending' ? '🕒 医生认证（待审核）' : '医生认证');
  const nextParam = encodeURIComponent((location.pathname.split('/').pop() || 'index.html') + location.search);
  // UI view mode: allow admins to browse as normal members without seeing admin-only UI.
  // This does NOT change backend permissions (RLS).
  let viewMode = 'member';
  if(isAdmin){
    const pref = readViewModePref();
    viewMode = pref || 'member';
    if(!pref) writeViewModePref('member');
  }else{
    clearViewModePref();
  }
  const isAdminUi = Boolean(isAdmin && viewMode === 'admin');

  // Expose to other pages/scripts.
  try{
    window.__ks_view_mode = viewMode;
    window.__ks_is_admin_user = Boolean(isAdmin);
    window.__ks_is_admin_ui = Boolean(isAdminUi);
	  window.__IS_SUPER_ADMIN__ = (role === 'super_admin');
	  window.__SHOW_DEV_HINTS__ = Boolean((role === 'super_admin') && isAdminUi);
  }catch(_e){}

  toggleAdminOnly(isAdminUi);
	toggleSuperAdminOnly(Boolean((role === 'super_admin') && isAdminUi));
  const avatarUrl = profile?.avatar_url || user.user_metadata?.avatar_url || '';
  const initial = (name || 'M').trim().slice(0,1).toUpperCase();
  const points = Number(profile?.points || 0);
  const lv = computeLevelFromPoints(points);
  const tier = levelName(lv);
  const membership = String(profile?.membership_status || '').trim().toLowerCase();
  const memberBadge = (membership && membership !== 'none') ? '会员' : '';
  // UI preference (matches your screenshot): 角色 · Lv1 · 青铜I · 0分（· 会员）
  const effectiveRoleForUi = doctorVerifiedByRecord && !isAdmin ? 'doctor_verified' : role;
  const roleUi = uiRoleLabelZh(effectiveRoleForUi, isAdmin, isAdminUi);
  const statusLineShort = [roleUi, `Lv${lv}`, tier].filter(Boolean).join(' · ');
  const statusLine = [roleUi, `Lv${lv}`, tier, memberBadge].filter(Boolean).join(' · ');
  const statusLineWithPoints = [roleUi, `Lv${lv}`, tier, `${points}分`, memberBadge].filter(Boolean).join(' · ');

  authEls.forEach(auth => {
    auth.innerHTML = `
      <div class="user-menu">
        <button class="pill user-trigger" type="button" data-user-toggle aria-haspopup="menu" aria-expanded="false"
          title="${escapeHtml(name)} · ${escapeHtml(statusLineWithPoints)}">
          <div class="avatar">${avatarUrl ? `<img alt="avatar" src="${escapeAttr(avatarUrl)}" style="width:28px;height:28px;border-radius:999px;object-fit:cover">` : initial}</div>
          <div class="who">
            <b>${escapeHtml(name)}</b>
            <span class="status-line">${escapeHtml(statusLineShort)}</span>
          </div>
          <span class="chev" aria-hidden="true">▾</span>
          <span class="notify-dot" aria-hidden="true"></span>
        </button>

        <div class="user-dropdown" data-user-dropdown role="menu" aria-label="用户菜单">
          <div class="ud-scroll">
            <div class="ud-meta">
              <b>${escapeHtml(name)}</b>
              <div>${escapeHtml(statusLineWithPoints)}</div>
              ${isAdmin ? `<div class="small muted" style="margin-top:4px">（可切换：管理员 ↔ 普通会员）</div>` : ``}
            </div>

            ${isAdmin ? `
              <button type="button" class="ud-mode" data-toggle-mode role="menuitem" data-mode="${isAdminUi ? 'member' : 'admin'}">
                ${isAdminUi ? '👤 切换到普通会员模式' : '🔧 切换到管理员模式'}
              </button>
              <div class="ud-split"></div>
            ` : ``}

            <a role="menuitem" href="notifications.html" data-badge="notifications">通知中心 <span class="badge-dot" aria-hidden="true"></span></a>
            <a role="menuitem" href="favorites.html">我的收藏</a>
            <a role="menuitem" href="verify-doctor.html?next=${nextParam}">${doctorMenuLabel}</a>

            <a role="menuitem" href="moments.html" data-badge="moments">进入动态 <span class="badge-dot" aria-hidden="true"></span></a>
            <a role="menuitem" href="community.html" data-badge="cases">进入社区 <span class="badge-dot" aria-hidden="true"></span></a>
            <a role="menuitem" href="learning.html#hot-articles" data-badge="articles">文献库 <span class="badge-dot" aria-hidden="true"></span></a>
            <a role="menuitem" href="moments.html#composer">发布动态</a>

            ${isAdminUi ? `
              <div class="ud-split"></div>
              <details class="ud-group">
                <summary>管理功能</summary>
                <div class="ud-group-items">
                  <a role="menuitem" href="admin.html">管理后台</a>
                  <a role="menuitem" href="frontier.html">管理前沿</a>
                  <a role="menuitem" href="admin.html#events">管理会议</a>
                  <a role="menuitem" href="admin.html#research">管理研究</a>
                  <a role="menuitem" href="admin.html#articles">管理文章</a>
                  <a role="menuitem" href="article-editor.html">写文章</a>
                  ${isSuper ? `<a role="menuitem" href="admin.html#roles">权限管理</a>` : ``}
                  <a role="menuitem" href="about.html">管理关于</a>
                </div>
              </details>
            ` : ``}
          </div>

          <div class="ud-footer">
            <button type="button" class="ud-danger" data-logout role="menuitem">退出登录</button>
          </div>
        </div>
      </div>
    `;

    // Bind logout
    auth.querySelector('[data-logout]')?.addEventListener('click', async (e)=>{
      e.preventDefault();
      await signOut();
    });

    // Bind admin/member view mode toggle
    auth.querySelector('[data-toggle-mode]')?.addEventListener('click', (e)=>{
      e.preventDefault();
      const btn = e.currentTarget;
      const next = String(btn?.getAttribute('data-mode') || '').trim();
      if(next !== 'admin' && next !== 'member') return;
      writeViewModePref(next);
      // Reload to apply to the whole page (admin-only elements are toggled globally)
      location.reload();
    });

    // Bind dropdown toggle (per instance)
    const menu = auth.querySelector('.user-menu');
    const toggle = auth.querySelector('[data-user-toggle]');
    if(menu && toggle){
      toggle.addEventListener('click', (e)=>{
        e.stopPropagation();
        const open = menu.classList.toggle('open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        // Refresh unread badges when the menu is opened.
        // (Without this, the red dot may look "stuck" until a full page reload.)
        if(open){
          updateUnreadBadges().catch(()=>{});
        }
      });

      // Close the dropdown when a menu item is chosen (links/buttons),
      // but keep it open for non-navigational controls like <details>/<summary>.
      const dropdown = auth.querySelector('[data-user-dropdown]');
      dropdown?.addEventListener('click', (e)=>{
        const a = e?.target?.closest?.('a');
        const btn = e?.target?.closest?.('button');
        const shouldClose = Boolean(a) || (btn && (btn.hasAttribute('data-logout') || btn.hasAttribute('data-toggle-mode')));
        if(shouldClose){
          menu.classList.remove('open');
          toggle.setAttribute('aria-expanded','false');
        }
      });
    }

    // Update unread red dots after the dropdown has been rendered.
    // Safe to call multiple times; internal cache prevents chatty queries.
    if(session){
      updateUnreadBadges().catch(()=>{});
    }
  });

  // Global close handlers (only bind once)
  if(!window.__ks_user_menu_bound){
    window.__ks_user_menu_bound = true;
    // Close dropdown only when clicking OUTSIDE the menu.
    // Fix: clicking on <summary> (e.g. “管理功能”) inside the dropdown previously
    // bubbled to document and immediately closed the menu, so users needed a second
    // click to see the expanded items.
    document.addEventListener('click', (e)=>{
      const insideMenu = e?.target?.closest?.('.user-menu');
      if(insideMenu) return;
      document.querySelectorAll('.user-menu.open').forEach(m=>{
        m.classList.remove('open');
        m.querySelector('[data-user-toggle]')?.setAttribute('aria-expanded','false');
      });
    });
    document.addEventListener('keydown', (e)=>{
      if(e.key === 'Escape'){
        document.querySelectorAll('.user-menu.open').forEach(m=>{
          m.classList.remove('open');
          m.querySelector('[data-user-toggle]')?.setAttribute('aria-expanded','false');
        });
      }
    });
  }
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

function toggleAdminOnly(isAdmin){
  document.querySelectorAll('[data-admin-only]').forEach(el=>{
    el.hidden = !isAdmin;
  });
}

// “开发/初始化提示”：仅超级管理员在“管理模式”下可见
function toggleSuperAdminOnly(canSee){
  document.querySelectorAll('[data-superadmin-only]').forEach(el=>{
    el.hidden = !canSee;
  });
}

// ------------------------------
// Unread red-dot badges (member dropdown)
// - client-side (localStorage)
// - compares latest timestamps in Supabase tables
// ------------------------------
const UNREAD_CFG = {
  moments: {
    badgeSelector: '[data-badge="moments"]',
    seenKey: 'ks_seen_moments',
    table: 'moments',
    tsCols: ['created_at'],
    orderBy: 'created_at',
    filters: (q)=>q,
    pages: ['moments']
  },
  articles: {
    badgeSelector: '[data-badge="articles"]',
    seenKey: 'ks_seen_articles',
    table: 'articles',
    tsCols: ['published_at', 'created_at'],
    orderBy: 'published_at',
    filters: (q)=> q.eq('status','published').is('deleted_at', null),
    pages: ['learning','articles','article','article-editor']
  },
  cases: {
    badgeSelector: '[data-badge="cases"]',
    seenKey: 'ks_seen_cases',
    table: 'cases',
    tsCols: ['created_at'],
    orderBy: 'created_at',
    filters: (q)=>q,
    pages: ['community','board','case','post-case']
  }
};

function getSeenTs(seenKey){
  try{
    const v = localStorage.getItem(seenKey);
    if(!v) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }catch{ return null; }
}

function setSeenNow(seenKey){
  try{ localStorage.setItem(seenKey, new Date().toISOString()); }catch{}
}

function getPageSlug(){
  try{
    let path = (location.pathname || '').toLowerCase();
    // Strip trailing slashes
    path = path.replace(/\/+$/,'');
    let last = path.split('/').pop() || 'index';
    // Netlify pretty URLs may drop .html; normalize both forms
    if(last.endsWith('.html')) last = last.slice(0, -5);
    return last || 'index';
  }catch{
    return 'index';
  }
}

function markSeenForCurrentPage(){
  const page = getPageSlug();
  for(const key of Object.keys(UNREAD_CFG)){
    const cfg = UNREAD_CFG[key];
    // IMPORTANT:
    // Do NOT auto-mark "病例讨论 / 社区讨论" as seen just because the user is
    // browsing community pages.
    //
    // Otherwise:
    // 1) Red-dot badges won't react when a new thread is posted;
    // 2) 通知中心会一直显示 0（因为 seen 时间被不停刷新为“现在”）；
    // 3) 无法做到“精准定位到板块”。
    if(key === 'cases') continue;

    if(cfg.pages.includes(page)) setSeenNow(cfg.seenKey);
  }
}

async function fetchLatestTs(client, cfg){
  try{
    // fetch only the needed cols
    const cols = Array.from(new Set([cfg.orderBy, ...cfg.tsCols])).filter(Boolean).join(',');
    let q = client.from(cfg.table).select(cols);
    q = cfg.filters(q);
    q = q.order(cfg.orderBy, { ascending: false, nullsFirst: false }).limit(1);
    const { data, error } = await q;
    if(error) return null;
    const row = data?.[0];
    if(!row) return null;
    for(const col of cfg.tsCols){
      const v = row?.[col];
      if(v){
        const t = Date.parse(v);
        if(Number.isFinite(t)) return t;
      }
    }
    return null;
  }catch{ return null; }
}

// Latest activity for the "cases" module should include:
// - new cases (cases.created_at)
// - new replies (case_comments.created_at)
// This makes the red dot react to thread activity, not only new threads.
async function fetchLatestCaseActivityTs(client){
  const latestCase = await fetchLatestTs(client, UNREAD_CFG.cases);

  // Comments: be defensive about schema differences (some deployments may not have deleted_at)
  let latestComment = null;
  try{
    let q = client.from('case_comments').select('created_at').order('created_at', { ascending:false }).limit(1);
    try{ q = q.is('deleted_at', null); }catch(_e){}
    const { data, error } = await q;
    if(!error){
      const v = data?.[0]?.created_at;
      const t = v ? Date.parse(v) : NaN;
      if(Number.isFinite(t)) latestComment = t;
    }
  }catch(_e){
    latestComment = null;
  }

  const a = Number(latestCase || 0);
  const b = Number(latestComment || 0);
  const best = Math.max(a, b);
  return best > 0 ? best : null;
}

function applyUnreadUI(type, hasUnread){
  const cfg = UNREAD_CFG[type];
  if(!cfg) return;
  document.querySelectorAll(cfg.badgeSelector).forEach(a=>{
    a.classList.toggle('has-unread', Boolean(hasUnread));
  });
}

function applyAnyUnreadUI(anyUnread){
  // Desktop shows the unread dot on the avatar button;
  // Mobile hides the avatar in the header and uses a hamburger.
  document.querySelectorAll('.user-trigger, .menu-toggle').forEach(btn=>{
    btn.classList.toggle('has-unread', Boolean(anyUnread));
  });
}

function applyNotificationsUnreadUI(anyUnread){
  document.querySelectorAll('[data-badge="notifications"]').forEach(a=>{
    a.classList.toggle('has-unread', Boolean(anyUnread));
  });
}


// Targeting helpers: allow unread red-dot to deep-link into the exact community board
// (e.g. glom / tx) instead of only the community landing page.
const CASE_SECTION_KEYS = new Set(['glom','tx','icu','peds','rare','path']);
const BOARD_LABEL_ZH = {
  glom: '肾小球与间质性肾病',
  tx: '肾移植内科',
  icu: '重症肾内与透析',
  peds: '儿童肾脏病',
  rare: '罕见肾脏病',
  path: '肾脏病理',
  research: '科研讨论',
  literature: '文献学习',
  english: '国际讨论（英语）',
};

function buildBoardHref(boardKey, highlightId){
  const k = String(boardKey || '').trim().toLowerCase();
  const hid = highlightId ? String(highlightId) : '';
  if(!k) return 'community.html';
  const h = hid ? `&highlight=${encodeURIComponent(hid)}` : '';
  if(CASE_SECTION_KEYS.has(k)){
    return `board.html?c=case&s=${encodeURIComponent(k)}${h}`;
  }
  // research / literature etc.
  return `board.html?c=${encodeURIComponent(k)}${h}`;
}

async function fetchLatestUnreadCaseTarget(client, seenTs){
  try{
    const sinceIso = new Date(Number(seenTs || 0)).toISOString();

    // New thread
    const pCase = client
      .from('cases')
      .select('id, board, created_at')
      .gt('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(1);

    // New reply
    let pReply = client
      .from('case_comments')
      .select('id, case_id, created_at')
      .gt('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(1);
    // defensive: some schemas may not have deleted_at
    try{ pReply = pReply.is('deleted_at', null); }catch(_e){}

    const [{ data: casesData, error: casesErr }, { data: replyData, error: replyErr }] = await Promise.all([pCase, pReply]);
    const caseRow = casesErr ? null : (casesData?.[0] || null);
    const replyRow = replyErr ? null : (replyData?.[0] || null);

    if(!caseRow && !replyRow) return null;

    const caseT = caseRow?.created_at ? Date.parse(caseRow.created_at) : NaN;
    const replyT = replyRow?.created_at ? Date.parse(replyRow.created_at) : NaN;

    // Pick the latest activity
    const chooseReply = replyRow && (!caseRow || (Number.isFinite(replyT) && (!Number.isFinite(caseT) || replyT >= caseT)));

    if(chooseReply){
      const commentId = replyRow.id;
      const caseId = replyRow.case_id;

      // Fetch board for label
      let board = '';
      try{
        const { data: meta } = await client
          .from('cases')
          .select('board')
          .eq('id', caseId)
          .limit(1);
        board = String(meta?.[0]?.board || '').trim().toLowerCase();
      }catch(_e){}

      const label = board ? (BOARD_LABEL_ZH[board] || board) : '';
      const href = `case.html?id=${encodeURIComponent(String(caseId))}#comment-${encodeURIComponent(String(commentId))}`;
      return { kind: 'reply', board, id: caseId, commentId, label, href };
    }

    const board = String(caseRow.board || '').trim().toLowerCase();
    const id = caseRow.id;
    const label = BOARD_LABEL_ZH[board] || board;
    const href = buildBoardHref(board, id);
    return { kind: 'case', board, id, label, href };
  }catch(_e){
    return null;
  }
}

function applyCasesTargetHref(target){
  const links = document.querySelectorAll('[data-badge="cases"]');
  links.forEach(a=>{
    if(!a) return;
    if(!a.dataset.defaultHref){
      a.dataset.defaultHref = a.getAttribute('href') || 'community.html';
    }
    if(target && target.href){
      a.setAttribute('href', target.href);
      const isReply = target.kind === 'reply';
      const kind = isReply ? '回复' : '内容';
      const lab = target.label ? `（有新${kind}：${target.label}）` : `（有新${kind}）`;
      a.title = isReply ? `点击直达最新回复${lab}` : `点击直达社区板块${lab}`;
    }else{
      a.setAttribute('href', a.dataset.defaultHref);
      a.title = '';
    }
  });
}


async function updateUnreadBadges(){
  if(!isConfigured()) return;
  const client = await ensureSupabase();
  if(!client) return;

  const { data: { session } } = await client.auth.getSession();
  if(!session?.user) return;

  // For some modules (e.g. 动态/文章) we treat visiting the page as "seen".
  // For 病例讨论 we intentionally do NOT auto-mark as seen (see markSeenForCurrentPage).
  markSeenForCurrentPage();

  // simple in-memory cache to avoid repeated Supabase calls
  const now = Date.now();
  const cache = window.__ks_unread_cache;
  // Keep a small cache to avoid repeated Supabase calls when users
  // open/close the menu quickly, but don't make it so long that the
  // red dot feels "stuck" after new content is created.
  if(cache && (now - cache.t) < 10_000){
    const state = cache.state || {};
    const targets = cache.targets || {};
    for(const [k,v] of Object.entries(state)) applyUnreadUI(k, v);
    applyAnyUnreadUI(Object.values(state).some(Boolean));
    applyNotificationsUnreadUI(state.moments || state.cases || state.articles);
    applyCasesTargetHref(targets.cases || null);
    return;
  }

  if(window.__ks_unread_inflight){
    const res = await window.__ks_unread_inflight;
    const state = res?.state || res || {};
    const targets = res?.targets || {};
    for(const [k,v] of Object.entries(state)) applyUnreadUI(k, v);
    applyAnyUnreadUI(Object.values(state).some(Boolean));
    applyNotificationsUnreadUI(state.moments || state.cases || state.articles);
    applyCasesTargetHref(targets.cases || null);
    return;
  }

  window.__ks_unread_inflight = (async ()=>{
    const state = {};
    const seenByType = {};

    for(const type of Object.keys(UNREAD_CFG)){
      const cfg = UNREAD_CFG[type];

      // "cases" red dot should react to both new threads and new replies
      const latest = (type === 'cases')
        ? await fetchLatestCaseActivityTs(client)
        : await fetchLatestTs(client, cfg);

      // If user never recorded a "seen" time on this device (e.g., mobile / incognito),
      // don't auto-mark as seen. Otherwise the red dot will never show on a fresh device.
      // Use the user's account creation time as a safe baseline.
      let seenTs = getSeenTs(cfg.seenKey);
      if(!seenTs){
        const createdMs = Date.parse(session?.user?.created_at || '');
        seenTs = Number.isFinite(createdMs) ? createdMs : 0;
      }

      seenByType[type] = seenTs;
      state[type] = Boolean(latest && latest > seenTs);
    }

    const targets = { cases: null };
    if(state.cases){
      targets.cases = await fetchLatestUnreadCaseTarget(client, seenByType.cases);
    }

    window.__ks_unread_cache = { t: Date.now(), state, targets };
    window.__ks_unread_inflight = null;
    return { state, targets };
  })();

  const res = await window.__ks_unread_inflight;
  const state = res?.state || {};
  const targets = res?.targets || {};

  for(const [k,v] of Object.entries(state)) applyUnreadUI(k, v);
  applyAnyUnreadUI(Object.values(state).some(Boolean));
  applyNotificationsUnreadUI(state.moments || state.cases || state.articles);
  applyCasesTargetHref(targets.cases || null);
}


injectNav();
injectFooter();
ensureToast();
ensureExtraNavLinks();
initSearchHotkey();
initMobileDrawer();
setActiveNav();
renderAuthArea();

// keep auth UI updated
if(isConfigured()){
  (async ()=>{
    const client = await ensureSupabase();
    if(!client) return;
    client.auth.onAuthStateChange((event, session) => {
      // Keep a tiny local log for troubleshooting intermittent logouts.
      try{
        const key = 'ks_auth_events';
        const arr = JSON.parse(localStorage.getItem(key) || '[]');
        arr.unshift({
          t: Date.now(),
          event,
          hasSession: Boolean(session),
          userId: session?.user?.id || null,
        });
        localStorage.setItem(key, JSON.stringify(arr.slice(0, 30)));
      }catch(_e){
        // ignore
      }
      renderAuthArea();
    });
  })();
}

// expose helpers
window.KS = window.KS || {};
Object.assign(window.KS, { ensureAuthed, toast });

// ------------------------------
// About page: admin-editable showcase blocks
// ------------------------------
async function initAboutShowcase(){
  const root = document.querySelector('[data-about-showcase]');
  if(!root) return;

  // Preset: 84 co-building hospitals/units (paste-ready, one per line)
  // NOTE: This only inserts data when an admin explicitly clicks “批量导入”.
  const PRESET_CO_BUILDING_84 = `
1. 莫志宁 广药东莞清溪医院
2. 宋书贤-西安医学院第二附属医院
3. 贵州省罗甸县人民医院姜先洋
4. 白志勋 黔西南州人民医院
5. 王浩宇 广西人民医院
6. 刘子栋 山东省第二人民医院
7. 王稻 萍乡市人民医院
8. 李瑜琳 青海省人民医院
9. 丁嘉祥 北京大学国际医院
10. 甘肃白银市第一人民医院-王银鼎
11. 王佳丽 陆军特色医学中心
12. 陈光磊 联勤保障部队北戴河康复疗养中心
13. 颜晓勇 遵义医科大学附属医院
14. 张帅星 三门峡市中医院
15. 曾礼华 防城港市中医院
16. 杨帆 首都医科大学附属北京潞河医院
17. 喻邦能 遵义市播州区人民医院
18. 马东红 新乡医学院第一附属医
19. 黄瑶玲 广州市第十二人民医院
20. 范茂虓 苏州市吴中人民医院
21. 王雷 天津市东丽医院
22. 刘晓丽 河北工程大学附属医院
23. 王鑫 大连大学附属中山医院
24. 万秀贤 南通市海门区人民医院
25. 李雪霞 珠海市中西医结合医院肾病科
26. 李华兵 铁岭市中心医院
27. 黎蠡 甘肃平凉市第二人民医院
28. 梁谋—广州中医药大学顺德医院
29. 张冲-重庆大学附属涪陵医院
30. 黄丽丽 福建省第二人民医院
31. 张睿 珠海市人民医院
32. 王小兵 无锡市第五人民医院
33. 徐国俊-贵州省织金县人民医院
34. 刘立昌 广东省中医院珠海医院
35. 李树栋 河南省太康县人民医院
36. 孙广东 天津市人民医院
37. 梅煜明 迪安诊断技术集团股份有限公司
38. 蒲友敏 陆军第九五八医院
39. 揭阳市人民医院 田关源
40. 姜启 荆州市中医医院
41. 谢小街 鹰潭一八四医院
42. 林琼真 河北医科大学第一医院
43. 梁彩霞 贵州医科大学第二附属医院
44. 谢志芬 平江县第一人民医院
45. 芦园月 天津市第五中心医院
46. 张家隆 北大医疗海洋石油医院
47. 张彩虹 西宁市第一人民医院
48. 孟晓燕 柳州市工人医院
49. 迟雁青 河北医科大学第三医院
50. 陈天喜 永康市第一人民医院
51. 胡炀琳 武汉市第一医院
52. 梁静 四川省人民医院川东医院·达州市第一人民医院
53. 梁洁 暨南大学附属第五医院
54. 袁静 贵州省人民医院
55. 王选笠 盐津县人民医院
56. 于小勇 陕西省中医医院
57. 李婧 天水四零七医院
58. 陈超 河北中石油中心医院
59. 曹翠云 绍兴市中心医院
60. 刘金彦 肾内 济宁市第一人民医院
61. 王桃霞 河北工程大学附属医院肾内科
62. 赵文景 首都医科大学附属北京中医医院
63. 邓剑波 达州市中心医院
64. 固原市人民医院 杨晓丽
65. 邵磊 安徽省亳州市蒙城县第二人民医院
66. 赵相国 汶上县人民医院
67. 李汶汶 南京逸夫医院
68. 乔云静 乌鲁木齐市友谊医院
69. 刘晓刚 深圳市宝安区中心医院
70. 周丽娜 温州市人民医院
71. 陈志斌 乐清市人民医院
72. 苏国彬-广东省中医院
73. 陈卫红 安康市中医医院
74. 黄文 温州医科大学附属第二医院医院肾内科
75. 邵国建 温州市中心医院
76. 张小云-杭州市萧山第一人民医院
77. 裴小华 江苏省人民医院
78. 单薇 绍兴市中心医院医共体总院
79. 邵治国 荆州市中医医院
80. 史炯 南京鼓楼医院
81. 蔡琰 青岛市立医院东院区
82. 侯海晶 广东省中医院
83. 李清江 秭归县人民医院肾内科
84. 彭健韫 丽水市人民医院
`;

  const lists = {
    flagship: document.querySelector('[data-showcase-list="flagship"]'),
    // Partners
    co_building: document.querySelector('[data-showcase-list="co_building"]'),
    partners: document.querySelector('[data-showcase-list="partners"]'),
    // Experts split
    experts_cn: document.querySelector('[data-showcase-list="experts_cn"]'),
    experts_intl: document.querySelector('[data-showcase-list="experts_intl"]'),
    // Core team
    core_team: document.querySelector('[data-showcase-list="core_team"]'),
  };

  // Keep the About page readable: collapse long lists by default.
  const LIST_LIMIT = 3;
  const expandedState = Object.create(null);

  // Demo mode (no Supabase configured)
  if(!isConfigured()){
    Object.keys(lists).forEach(k=>{
      if(lists[k]){
        lists[k].innerHTML = `<div class="muted small">（演示模式）配置 Supabase 后可由管理员在此增删条目。</div>`;
      }
    });
    return;
  }

  // Try to (re)initialize auth client. If this fails on some mobile networks,
  // keep the page readable instead of throwing.
  await ensureSupabase();
  if(!supabase){
    Object.keys(lists).forEach(k=>{
      if(lists[k]){
        lists[k].innerHTML = `<div class="muted small">认证服务加载失败，请检查网络或稍后重试。</div>`;
      }
    });
    return;
  }

  const session = await getSession();
  const user = session?.user || null;
  const profile = user ? await getUserProfile(user) : null;
  // IMPORTANT: do NOT trust user_metadata for admin privileges.
  const role = normalizeRole(profile?.role);
  const isAdmin = isAdminRole(role);
  const isSuper = String(role || '').toLowerCase() === 'super_admin';
  const viewMode = isAdmin ? (readViewModePref() || 'member') : 'member';
  const isAdminUi = Boolean(isAdmin && viewMode === 'admin');
  toggleAdminOnly(isAdminUi);

  // --- Auto-seed (admin only):
  // 1) 共建单位：用户希望无需手动逐条输入，直接显示预置名单。
  // 2) 合作单位：把「华人肾移植内科学会」放到关于页。
  // 说明：只在数据库“确实为空/缺少条目”时写入，避免重复插入。
  if(isAdmin){
    try{
      await maybeAutoSeedCoBuilding();
      await maybeEnsurePartnerOrg('华人肾移植内科学会', '华人肾移植内科学会致力于搭建面向全球华语肾移植内科领域专业人士的学术交流与协作平台，汇聚移植内科、免疫、病理、药学及护理等多学科力量，推动循证医学与规范化长期随访管理在临床实践中的落地。学会关注移植受者全程管理与并发症防治，倡导高质量病例讨论与经验共享，促进科研合作、继续教育与青年人才培养，并重视患者隐私保护与医学伦理合规，共同提升肾移植诊疗质量与患者长期获益。');
    }catch(_e){
      // Seeding is best-effort. Do not block About rendering.
    }
  }

  // Toggle admin panels
  document.querySelectorAll('[data-admin-panel]').forEach(el=>{
    el.hidden = !isAdminUi;
  });

  // Load + render
  await loadAndRender();

  // Bind forms (admin only)
  if(isAdminUi){
    document.querySelectorAll('[data-showcase-form]').forEach(form=>{
      const category = form.getAttribute('data-showcase-form');
      bindShowcaseImageQuickUpload(form, category);
      form.addEventListener('submit', async (e)=>{
        e.preventDefault();
        const fd = new FormData(form);
        let title = (fd.get('title') || '').toString().trim();
        if(category === 'co_building') title = ensureCoBuildingNeiKe(title);
        const description = (fd.get('description') || '').toString().trim();
        const link = (fd.get('link') || '').toString().trim();
        if(!title){ toast('请输入名称/标题','', 'err'); return; }

        // Optional: upload image file (if provided) to Storage, then write its public URL.
        // Users can also paste/drag images into the URL field, which will auto-upload and fill image_url.
        let imageUrl = (fd.get('image_url')||'').toString().trim() || null;
        const file = fd.get('image_file');
        if(file && file instanceof File && file.size > 0){
          try{
            toast('上传中…', '正在上传图片/Logo…', 'ok');
            const uploaded = await uploadShowcaseImage(file, category);
            imageUrl = uploaded || imageUrl;
          }catch(err){
            toast('上传失败', err?.message || String(err), 'err');
            return;
          }
        }

        const { error } = await supabase
          .from('about_showcase')
          .insert({ category, title, description: description || null, link: link || null, image_url: imageUrl, sort: 0 });
        if(error){ toast('添加失败', error.message, 'err'); return; }
        form.reset();
        toast('已添加', '条目已写入。', 'ok');
        await loadAndRender();
      });
    });

    // Co-building: batch import (paste list / one-click preset)
    bindCoBuildingBatchImport();
  }

  function normalizeKey(s){
    return String(s ?? '')
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[·•，,。；;:：（）()【】\[\]<>“”"'‘’—–\-]/g, '');
  }

  function stripIndexPrefix(line){
    return String(line ?? '')
      .replace(/^\s*\d+\s*[\.|、|\)|）|-]\s*/, '')
      .trim();
  }

  function cleanOrgTitle(title){
    // 仅保留机构/医院名称（不保留联系人/科室等个人信息）。
    let t = String(title || '').trim();
    if(!t) return '';

    // 常见重复
    t = t.replace(/医院医院/g, '医院');

    // 去掉常见科室/院区/总院后缀（仅在结尾匹配，避免误删中间内容）
    t = t.replace(/(医院)(?:\s*(?:肾内科|肾脏内科|肾病科|肾内|肾病|血液净化中心|医共体总院|医共体|总院|东院区|西院区|院区))$/,'$1');
    t = t.replace(/(中心)(?:\s*(?:肾内科|肾脏内科|肾病科|血液净化中心))$/,'$1');

    // 处理“附属第二医院医院”之类的重复
    t = t.replace(/(附属[一二三四五六七八九十\d]+医院)医院$/,'$1');
    t = t.replace(/(附属医院)医院$/,'$1');

    // 兜底再清理一次重复
    t = t.replace(/医院医院/g, '医院');
    return t.trim();
  }

  function ensureCoBuildingNeiKe(title){
    // 共建单位统一展示为“机构/医院名称 + 肾内科”
    // 兼容历史数据里可能出现的“肾脏内科/肾病科/肾内”等写法，统一规范为“肾内科”。
    const base = cleanOrgTitle(title);
    if(!base) return '';
    const b = String(base).trim().replace(/\s+$/,'');
    // 避免重复：若 b 本身已以“肾内科”结尾（极少见），不重复追加
    if(/肾内科\s*$/.test(b)) return b;
    return b + '肾内科';
  }


  function parseCoBuildingLine(line){
    const raw0 = stripIndexPrefix(line);
    if(!raw0) return null;

    // Normalize separators so that “姓名-医院 / 医院-姓名 / 医院 姓名” can all be parsed.
    const raw = raw0
      .replace(/[，,]/g, ' ')
      .replace(/[—–-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const tokens = raw.split(' ').map(t=>t.trim()).filter(Boolean);
    const orgHint = /(医院|中心|大学|医学院|集团|公司|研究院|研究所|诊断)/;

    // Pick the most “org-like” token.
    let bestIdx = -1;
    let bestScore = -1;
    for(let i=0;i<tokens.length;i++){
      const t = tokens[i];
      if(!orgHint.test(t)) continue;
      let score = t.length;
      if(/医院/.test(t)) score += 120;
      if(/人民医院|附属医院|中医医院|中心医院/.test(t)) score += 18;
      if(/中心/.test(t)) score += 60;
      if(/集团|公司/.test(t)) score += 50;
      if(/大学|医学院/.test(t)) score += 40;
      if(score > bestScore){ bestScore = score; bestIdx = i; }
    }

    let title = '';
    let note = '';

    if(bestIdx >= 0){
      title = tokens[bestIdx];
      note = tokens.filter((_,idx)=> idx !== bestIdx).join(' ').trim();
    }else{
      // Fallback: no spaces or no obvious token. Try to cut at common suffixes.
      const m = raw0.match(/(.+?(?:医院|中心|集团股份有限公司|有限公司|诊断技术集团股份有限公司))/);
      if(m && m[1]){
        title = m[1].trim();
        note = raw0.slice(title.length).trim();
      }else{
        title = raw0.trim();
        note = '';
      }
    }

    // Handle cases like “某某人民医院张三” (no separator between org and person).
    // If we detect trailing 2–4 Chinese chars after the last “医院”, treat them as a contact.
    const lastHos = title.lastIndexOf('医院');
    if(lastHos >= 0 && lastHos + 2 < title.length){
      const tail = title.slice(lastHos + 2).trim();
      const head = title.slice(0, lastHos + 2).trim();
      if(/^[\u4e00-\u9fa5]{2,4}$/.test(tail) && head.length >= 4){
        title = head;
        note = note ? `${tail} ${note}`.trim() : tail;
      }
    }

    title = ensureCoBuildingNeiKe(title);
    // note 里可能是联系人/科室等信息：按需求不展示、也不写入数据库。
    // 这里保留解析逻辑仅用于更好地提取机构名称。
    // （避免未来误把联系人拼进 title）
    note = String(note || '').replace(/^[:：\-—·•\s]+/, '').trim();

    if(!title) return null;
    return { title, description: null };
  }

  function buildPresetCoBuildingRows(){
    const lines = PRESET_CO_BUILDING_84
      .split(/\r?\n/)
      .map(stripIndexPrefix)
      .map(s=>s.trim())
      .filter(Boolean);
    const parsed = lines.map(parseCoBuildingLine).filter(Boolean);
    const out = [];
    const seen = new Set();
    for(const it of parsed){
      const key = normalizeKey(it?.title);
      if(!key) continue;
      if(seen.has(key)) continue;
      seen.add(key);
      out.push({
        category: 'co_building',
        title: String(it.title).trim(),
        description: null,
        sort: 0,
      });
    }
    return out;
  }

  async function maybeAutoSeedCoBuilding(){
    // If co_building already has any rows, do nothing.
    const { count, error } = await supabase
      .from('about_showcase')
      .select('id', { count: 'exact', head: true })
      .eq('category', 'co_building');
    if(error) return;
    if(Number(count || 0) > 0) return;

    const rows = buildPresetCoBuildingRows();
    if(!rows.length) return;

    // Insert in chunks (84 rows)
    const CHUNK = 50;
    for(let i=0;i<rows.length;i+=CHUNK){
      const chunk = rows.slice(i, i+CHUNK);
      const { error: insErr } = await supabase.from('about_showcase').insert(chunk);
      if(insErr) throw insErr;
    }

    toast('已初始化共建单位', `已自动写入 ${rows.length} 家共建单位（仅保存机构名称）。`, 'ok');
  }

  
  async function maybeEnsurePartnerOrg(title, description=null, link=null, imageUrl=null){
    const name = String(title || '').trim();
    if(!name) return;

    const { data, error } = await supabase
      .from('about_showcase')
      .select('id, title, description, link, image_url')
      .eq('category', 'partners')
      .limit(500);
    if(error) return;

    const row = (data || []).find(r => normalizeKey(r?.title) === normalizeKey(name));

    // If exists, only fill missing fields (do not overwrite admin-edited content).
    if(row && row.id){
      const patch = {};
      const desc = String(description || '').trim();
      if(desc && !String(row.description || '').trim()) patch.description = desc;
      const lk = String(link || '').trim();
      if(lk && !String(row.link || '').trim()) patch.link = lk;
      const iu = String(imageUrl || '').trim();
      if(iu && !String(row.image_url || '').trim()) patch.image_url = iu;

      if(Object.keys(patch).length){
        try{
          await supabase.from('about_showcase').update(patch).eq('id', row.id);
        }catch(_e){
          // best effort
        }
      }
      return;
    }

    const { error: insErr } = await supabase
      .from('about_showcase')
      .insert({
        category: 'partners',
        title: name,
        description: String(description || '').trim() || null,
        link: String(link || '').trim() || null,
        image_url: String(imageUrl || '').trim() || null,
        sort: 0
      });
    if(insErr) throw insErr;
  }

  function bindCoBuildingBatchImport(){
    const panel = document.querySelector('[data-admin-panel="co_building"]');
    if(!panel) return;
    const textarea = panel.querySelector('[data-cobuild-batch]');
    const fillBtn = panel.querySelector('[data-cobuild-fill]');
    const clearBtn = panel.querySelector('[data-cobuild-clear]');
    const importBtn = panel.querySelector('[data-cobuild-import]');
    const statusEl = panel.querySelector('[data-cobuild-status]');
    if(!textarea || !importBtn) return;

    const setStatus = (msg)=>{ if(statusEl) statusEl.textContent = msg || ''; };
    const countLines = (txt)=> (String(txt||'').split(/\r?\n/).map(s=>stripIndexPrefix(s)).filter(s=>s && s.trim()).length);

    fillBtn?.addEventListener('click', ()=>{
      textarea.value = PRESET_CO_BUILDING_84.trim();
      setStatus(`已填入预置名单：${countLines(textarea.value)} 行。系统会自动提取并仅保存“单位/医院名称”（不保存联系人）。`);
      textarea.focus();
    });

    clearBtn?.addEventListener('click', ()=>{
      textarea.value = '';
      setStatus('');
      textarea.focus();
    });

    importBtn.addEventListener('click', async ()=>{
      const text = String(textarea.value || '').trim();
      if(!text){
        toast('请先粘贴名单', '可以点击“填入本次 84 家名单”。', 'err');
        return;
      }

      const lines = text
        .split(/\r?\n/)
        .map(stripIndexPrefix)
        .map(s=>s.trim())
        .filter(Boolean);

      if(!lines.length){
        toast('名单为空', '请确认每行都有内容。', 'err');
        return;
      }

      const parsed = lines.map(parseCoBuildingLine).filter(Boolean);
      if(!parsed.length){
        toast('解析失败', '未能从名单中解析出单位名称。', 'err');
        return;
      }

      setStatus('正在读取现有共建单位...');
      const { data: existing, error: exErr } = await supabase
        .from('about_showcase')
        .select('id, title')
        .eq('category', 'co_building');
      if(exErr){
        toast('读取失败', exErr.message, 'err');
        setStatus('读取现有数据失败。');
        return;
      }

      const existingSet = new Set((existing || []).map(r=> normalizeKey(r?.title)));
      const seen = new Set();
      const rows = [];
      let skippedExisting = 0;
      let skippedDup = 0;

      for(const it of parsed){
        const key = normalizeKey(it?.title);
        if(!key) continue;
        if(existingSet.has(key)){ skippedExisting++; continue; }
        if(seen.has(key)){ skippedDup++; continue; }
        seen.add(key);
        rows.push({
          category: 'co_building',
          title: String(it.title).trim(),
          // 按需求：共建单位仅展示医院/机构名称，不写入联系人信息。
          description: null,
          sort: 0,
        });
      }

      if(!rows.length){
        toast('无需导入', '这些单位已存在（或名单重复）。', 'ok');
        setStatus(`无新增：已存在 ${skippedExisting}，重复 ${skippedDup}。`);
        return;
      }

      const CHUNK = 50;
      let inserted = 0;
      try{
        for(let i=0;i<rows.length;i+=CHUNK){
          const chunk = rows.slice(i, i+CHUNK);
          setStatus(`正在导入...（${Math.min(i+chunk.length, rows.length)}/${rows.length}）`);
          const { error } = await supabase.from('about_showcase').insert(chunk);
          if(error) throw error;
          inserted += chunk.length;
        }
      }catch(err){
        toast('导入失败', err?.message || String(err), 'err');
        setStatus('导入中断：请检查数据库权限/RLS 或网络后重试。');
        return;
      }

      toast('导入完成', `已导入 ${inserted} 条（已存在 ${skippedExisting}，重复 ${skippedDup}）。`, 'ok');
      setStatus(`导入完成：新增 ${inserted}。已存在 ${skippedExisting}，重复 ${skippedDup}。`);
      await loadAndRender();
    });
  }

  // --- About page: quick upload helpers (drag/drop/paste/file) ---
  function isImageFile(file){
    const t = (file?.type || '').toLowerCase();
    if(t.startsWith('image/')) return true;
    // Some browsers may provide empty MIME; fall back to extension.
    const name = (file?.name || '').toLowerCase();
    return /\.(png|jpe?g|webp|gif)$/.test(name);
  }

  async function uploadShowcaseImage(file, category){
    if(!file || !(file instanceof File) || file.size <= 0) return null;
    if(!isImageFile(file)) throw new Error('仅支持图片文件（png/jpg/webp/gif）。');
    const maxBytes = 8 * 1024 * 1024; // generous; UI建议≤2MB
    if(file.size > maxBytes) throw new Error('图片文件过大（建议≤2MB）。');

    const extRaw = (file.name || '').split('.').pop() || 'png';
    const ext = extRaw.toLowerCase().replace(/[^a-z0-9]/g,'');
    const safeExt = ['png','jpg','jpeg','webp','gif'].includes(ext) ? ext : 'png';
    const rid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const path = `about/${category}/${rid}.${safeExt}`;
    const bucket = 'sponsor_logos'; // reuse existing public bucket for small logos/images

    const { error } = await supabase.storage
      .from(bucket)
      .upload(path, file, { upsert: false, cacheControl: '3600', contentType: file.type || undefined });
    if(error) throw error;

    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data?.publicUrl || null;
  }

  function bindShowcaseImageQuickUpload(form, category){
    const urlInput = form.querySelector('input[name="image_url"]');
    const fileInput = form.querySelector('input[name="image_file"]');
    const dropZone = form.querySelector('[data-image-dropzone]');
    if(!urlInput && !fileInput) return;

    const setHover = (on)=>{
      if(urlInput) urlInput.classList.toggle('drop-hover', !!on);
      if(dropZone) dropZone.classList.toggle('drop-hover', !!on);
    };

    const handleFile = async (file)=>{
      if(!file || !(file instanceof File) || file.size <= 0) return;
      if(!isImageFile(file)){
        toast('仅支持图片', '请上传 png/jpg/webp/gif 图片。', 'err');
        return;
      }
      try{
        toast('上传中…', '正在上传图片/Logo…', 'ok');
        const url = await uploadShowcaseImage(file, category);
        if(url && urlInput){
          urlInput.value = url;
          toast('已上传', '已自动填入图片 URL。', 'ok');
        }
      }catch(err){
        toast('上传失败', err?.message || String(err), 'err');
      }finally{
        if(fileInput) fileInput.value = '';
        setHover(false);
      }
    };

    // Choose file -> auto upload and fill URL.
    fileInput?.addEventListener('change', ()=>{
      const f = fileInput.files?.[0];
      if(f) handleFile(f);
    });

    const handlePaste = (e)=>{
      const cd = e.clipboardData;
      if(!cd) return;

      // IMPORTANT: Do NOT hijack normal text pasting.
      // Some apps put both "text" and an "image representation" into the clipboard.
      // On the About page admin forms, users paste a lot of text into title/description.
      // If we always prefer the image item, it feels like "paste goes into the photo URL".
      const plainText = (typeof cd.getData === 'function') ? (cd.getData('text/plain') || '') : '';
      const htmlText = (typeof cd.getData === 'function' && cd.types && Array.from(cd.types).includes('text/html'))
        ? (cd.getData('text/html') || '')
        : '';
      const hasText = !!(
        (plainText && plainText.trim().length > 0) ||
        (htmlText && htmlText.trim().length > 0)
      );

      const items = cd.items;
      if(!items || !items.length) return;
      const item = Array.from(items).find(it=> it.kind === 'file');
      if(!item) return;
      const f = item.getAsFile();
      if(!f) return;
      if(!isImageFile(f)) return;

      // If the clipboard also contains real text, assume the user is pasting text.
      // Only handle image-paste automatically when there's no text payload.
      if(hasText) return;

      // Only prevent default when we actually handle an image file.
      e.preventDefault();
      handleFile(f);
    };

    // Paste screenshot into the URL input / drop zone / anywhere inside this form.
    urlInput?.addEventListener('paste', handlePaste);
    dropZone?.addEventListener('paste', handlePaste);
    // Users often paste while focused on other fields (e.g. description). Support that too.
    form.addEventListener('paste', (e)=>{
      // Avoid double handling (if the paste originated from urlInput/dropZone)
      if(e.target === urlInput || e.target === dropZone) return;
      handlePaste(e);
    });

    const bindDropTarget = (el)=>{
      if(!el) return;
      el.addEventListener('dragover', (e)=>{ e.preventDefault(); setHover(true); });
      el.addEventListener('dragleave', ()=> setHover(false));
      el.addEventListener('drop', (e)=>{
        e.preventDefault();
        const f = e.dataTransfer?.files?.[0];
        if(f) handleFile(f);
        else setHover(false);
      });
    };

    // Drag & drop into the URL input / drop zone / form.
    bindDropTarget(urlInput);
    bindDropTarget(dropZone);
    bindDropTarget(form);

    // Click drop zone -> open file picker
    dropZone?.addEventListener('click', ()=> fileInput?.click());
    dropZone?.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter' || e.key === ' ') fileInput?.click();
    });
  }

  async function loadAndRender(){
    const { data, error } = await supabase
      .from('about_showcase')
      .select('id, category, title, description, link, image_url, sort, created_at')
      .order('sort', { ascending: true })
      .order('created_at', { ascending: false });
    if(error){
      Object.keys(lists).forEach(k=>{ if(lists[k]) lists[k].innerHTML = `<div class="muted small">读取失败：${escapeHtml(error.message)}</div>`; });
      return;
    }
    const byCat = {
      flagship: [],
      co_building: [],
      partners: [],
      experts_cn: [],
      experts_intl: [],
      core_team: [],
    };
    (data || []).forEach(row=>{
      const raw = String(row.category || '').toLowerCase();
      const mapped = raw === 'experts' ? 'experts_cn' : raw; // legacy category support
      if(byCat[mapped]) byCat[mapped].push(row);
    });
    // If the co_building list is still empty (e.g., page opened before admin seeding),
    // show a read-only preset list so users immediately see the hospitals.
    // Admin can still use the batch import / add/delete to persist changes.
    if((byCat.co_building || []).length === 0){
      byCat.co_building = buildPresetCoBuildingRows().map((r, idx)=>({
        id: null,
        category: 'co_building',
        title: r.title,
        description: null,
        link: null,
        image_url: null,
        sort: 0,
        created_at: null,
        _preset: true,
      }));
    }
    Object.keys(byCat).forEach(cat=> renderList(cat, byCat[cat]));
  }

  function renderList(category, items){
    const el = lists[category];
    if(!el) return;

    const total = Array.isArray(items) ? items.length : 0;
    if(total === 0){
      el.innerHTML = `<div class="muted small">暂无条目。管理员可在下方添加。</div>`;
      return;
    }

    // Collapse long lists by default, to keep the About page tidy.
    const expanded = Boolean(expandedState[category]);
    const viewItems = (!expanded && total > LIST_LIMIT) ? items.slice(0, LIST_LIMIT) : items;

    const html = viewItems.map(it=>{
      const link = it.link ? `<a class="small" href="${escapeHtml(it.link)}" target="_blank" rel="noopener">链接</a>` : '';
      const edit = (isAdminUi && it.id) ? `<button class="btn tiny" data-edit="${it.id}" data-cat="${category}">编辑</button>` : '';
      const del = (isAdminUi && it.id) ? `<button class="btn tiny danger" data-del="${it.id}" data-cat="${category}">删除</button>` : '';
      const actions = (edit || del) ? `<div style="display:flex;flex-direction:column;gap:8px">${edit}${del}</div>` : '';
      return `
        <div class="showcase-item">
          ${it.image_url ? `<img class="showcase-avatar" alt="img" src="${escapeHtml(it.image_url)}">` : ``}
          <div class="showcase-main">
            <b>${escapeHtml(category === 'co_building' ? ensureCoBuildingNeiKe(it.title) : it.title)}</b>
            ${(category !== 'co_building' && it.description) ? `<div class="small muted" style="margin-top:4px">${escapeHtml(it.description)}</div>` : ''}
            ${link ? `<div style="margin-top:6px">${link}</div>` : ''}
          </div>
          ${actions}
        </div>
      `;
    }).join('');

    const toggle = (total > LIST_LIMIT)
      ? `<div class="about-more"><button class="btn tiny" data-toggle-more="${category}">${expanded ? '收起' : `查看更多（${total}）`}</button></div>`
      : '';

    el.innerHTML = html + toggle;

    // Bind expand/collapse
    const tbtn = el.querySelector(`[data-toggle-more="${category}"]`);
    if(tbtn){
      tbtn.addEventListener('click', (e)=>{
        e.preventDefault();
        expandedState[category] = !expanded;
        renderList(category, items);
      });
    }

    if(isAdminUi){
      el.querySelectorAll('[data-del]').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          const id = btn.getAttribute('data-del');
          const { error } = await supabase.from('about_showcase').delete().eq('id', id);
          if(error){ toast('删除失败', error.message, 'err'); return; }
          toast('已删除', '条目已移除。', 'ok');
          await loadAndRender();
        });
      });

      el.querySelectorAll('[data-edit]').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          const id = btn.getAttribute('data-edit');
          const cat = btn.getAttribute('data-cat') || category;
          const row = items.find(x => String(x.id) === String(id));
          if(!row){ toast('无法编辑', '未找到该条目。', 'err'); return; }

          let title = prompt('编辑标题', row.title || '');
          if(title === null) return;
          title = title.trim();
          if(!title){ toast('标题不能为空', '请填写标题。', 'err'); return; }
          if(cat === 'co_building') title = ensureCoBuildingNeiKe(title);

          let description = row.description || '';
          if(cat !== 'co_building'){
            const d = prompt('编辑简介（可留空）', row.description || '');
            if(d === null) return;
            description = d.trim();
          }

          const l = prompt('编辑链接（可留空）', row.link || '');
          if(l === null) return;
          const link = l.trim();

          const img = prompt('编辑图片URL（可留空）', row.image_url || '');
          if(img === null) return;
          const image_url = img.trim();

          const patch = {
            title,
            description: (cat !== 'co_building') ? (description || null) : null,
            link: link || null,
            image_url: image_url || null,
          };

          const { error } = await supabase.from('about_showcase').update(patch).eq('id', id);
          if(error){ toast('更新失败', error.message, 'err'); return; }
          toast('已更新', '条目已保存。', 'ok');
          await loadAndRender();
        });
      });

    }
  }
}

initAboutShowcase();