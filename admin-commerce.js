/**
 * admin-commerce.js — 主入口
 * Tab 切换 + Dashboard 统计 + 权限检查
 */
import {
  supabase, ensureSupabase, isConfigured,
  getCurrentUser, getUserProfile, isAdminRole, toast,
} from './supabaseClient.js?v=20260325_001';

/* ── helpers ── */
export function esc(s) {
  return String(s ?? '').replace(/[&<>'"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

export function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function statusDot(color) {
  return `<span class="status-dot ${color}"></span>`;
}

export function badge(text, style) {
  return `<span class="badge" ${style ? `style="${style}"` : ''}>${esc(text)}</span>`;
}

/* ── state ── */
let _user = null;
let _profile = null;
let _isAdmin = false;

export function getAdminUser() { return _user; }
export function getAdminProfile() { return _profile; }

/* ── modal ── */
export function showModal(title, bodyHtml, footerHtml) {
  const c = document.getElementById('modalContainer');
  c.innerHTML = `
    <div class="modal-overlay" id="modalOverlay">
      <div class="modal-box">
        <div class="section-title" style="margin-bottom:12px">
          <h3>${title}</h3>
          <button class="btn tiny" id="modalClose" type="button">✕</button>
        </div>
        <div id="modalBody">${bodyHtml}</div>
        ${footerHtml ? `<div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">${footerHtml}</div>` : ''}
      </div>
    </div>`;
  document.getElementById('modalClose').onclick = closeModal;
  document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target.id === 'modalOverlay') closeModal();
  });
}

export function closeModal() {
  document.getElementById('modalContainer').innerHTML = '';
}

/* ── tabs ── */
function initTabs() {
  const tabs = document.getElementById('commerceTabs');
  if (!tabs) return;
  tabs.addEventListener('click', e => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    const tab = btn.dataset.tab;
    tabs.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(`panel-${tab}`);
    if (panel) {
      panel.classList.add('active');
      // dispatch custom event so sub-modules can lazy-load
      panel.dispatchEvent(new CustomEvent('panel:show', { detail: { tab } }));
    }
  });
}

/* ── dashboard stats ── */
async function loadStats() {
  try {
    const [orders, products, ents, enrolls] = await Promise.all([
      supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'pending_review'),
      supabase.from('products').select('id', { count: 'exact', head: true }).eq('is_active', true),
      supabase.from('user_entitlements').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      supabase.from('project_enrollments').select('id', { count: 'exact', head: true }),
    ]);
    document.getElementById('statOrders').textContent = orders.count ?? '—';
    document.getElementById('statProducts').textContent = products.count ?? '—';
    document.getElementById('statEntitlements').textContent = ents.count ?? '—';
    document.getElementById('statEnrollments').textContent = enrolls.count ?? '—';
  } catch (err) {
    console.warn('loadStats error:', err);
  }
}

/* ── init ── */
async function init() {
  const gate = document.getElementById('commerceGate');
  const main = document.getElementById('commerceMain');

  if (isConfigured() && !supabase) await ensureSupabase();
  if (!isConfigured() || !supabase) {
    gate.innerHTML = '<b>演示模式：</b>未配置 Supabase。';
    return;
  }

  _user = await getCurrentUser();
  if (!_user) {
    gate.innerHTML = '请先 <a href="login.html?next=admin-commerce.html">登录</a>。';
    return;
  }

  _profile = await getUserProfile(_user);
  _isAdmin = isAdminRole(_profile?.role);
  if (!_isAdmin) {
    gate.innerHTML = '<b>无权限：</b>仅管理员可访问此页面。';
    return;
  }

  gate.hidden = true;
  main.hidden = false;
  initTabs();
  loadStats();

  // Lazy-load sub-modules
  const mods = await Promise.allSettled([
    import('./admin-commerce-orders.js?v=20260325_001'),
    import('./admin-commerce-products.js?v=20260325_001'),
    import('./admin-commerce-config.js?v=20260325_001'),
    import('./admin-commerce-entitlements.js?v=20260325_001'),
    import('./admin-commerce-projects.js?v=20260325_001'),
    import('./admin-commerce-cohorts.js?v=20260325_001'),
    import('./admin-commerce-groups.js?v=20260325_001'),
    import('./admin-commerce-templates.js?v=20260325_001'),
    import('./admin-commerce-audit.js?v=20260325_001'),
  ]);
  mods.forEach((m, i) => {
    if (m.status === 'fulfilled' && m.value?.init) m.value.init();
    else if (m.status === 'rejected') console.warn(`Module ${i} failed:`, m.reason);
  });

  // Show first panel
  document.getElementById('panel-orders')?.dispatchEvent(new CustomEvent('panel:show'));
}

init();
