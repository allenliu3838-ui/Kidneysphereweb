/**
 * admin-commerce.js — 主入口
 * Tab 切换 + Dashboard 统计 + 权限检查
 * Content is injected dynamically after auth verification.
 */
import {
  supabase, ensureSupabase, isConfigured,
  getCurrentUser, getUserProfile, isAdminRole, toast,
} from './supabaseClient.js?v=20260401_fix';

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

/* ── inject admin content ── */
function injectCommerceContent() {
  const root = document.getElementById('commerceRoot');
  if (!root) return;

  root.innerHTML = `
    <section class="section">
      <div class="container">
        <div class="card" style="margin-bottom:18px">
          <div class="section-title">
            <div><h2>商品与订单管理</h2><p>统一管理商品、定价、订单、权益、项目报名、学习群。</p></div>
            <span class="badge">Commerce Admin</span>
          </div>
        </div>

        <div class="grid cols-4" id="dashboardStats" style="margin-bottom:18px">
          <div class="card soft stat-card"><div class="num" id="statOrders">-</div><div class="label">待审核订单</div></div>
          <div class="card soft stat-card"><div class="num" id="statProducts">-</div><div class="label">在售商品</div></div>
          <div class="card soft stat-card"><div class="num" id="statEntitlements">-</div><div class="label">活跃权益</div></div>
          <div class="card soft stat-card"><div class="num" id="statEnrollments">-</div><div class="label">项目报名</div></div>
        </div>

        <div class="card">
          <div class="commerce-tabs" id="commerceTabs">
            <button class="btn active" data-tab="orders">订单审核</button>
            <button class="btn" data-tab="products">商品中心</button>
            <button class="btn" data-tab="config">系统配置</button>
            <button class="btn" data-tab="entitlements">权益管理</button>
            <button class="btn" data-tab="projects">项目中心</button>
            <button class="btn" data-tab="cohorts">班期管理</button>
            <button class="btn" data-tab="groups">学习群</button>
            <button class="btn" data-tab="templates">通知模板</button>
            <button class="btn" data-tab="audit">审计日志</button>
          </div>
        </div>

        <div class="tab-panel active" id="panel-orders"><div class="card soft"><div class="section-title"><h3>订单核销中心</h3><div style="display:flex;gap:8px"><select class="input" id="orderFilterStatus" style="width:auto"><option value="pending_all">待处理</option><option value="pending_review">待审核</option><option value="pending_payment">待付款</option><option value="all">全部</option><option value="approved">已通过</option><option value="approved_no_proof">⚠ 已通过无凭证</option><option value="rejected">已驳回</option><option value="cancelled">已取消</option></select><button class="btn" id="refreshOrders" type="button">刷新</button></div></div><div id="ordersTableWrap" style="overflow-x:auto;margin-top:12px"><div class="muted">加载中…</div></div></div></div>

        <div class="tab-panel" id="panel-products"><div class="card soft"><div class="section-title"><h3>商品中心</h3><button class="btn primary" id="btnAddProduct" type="button">新建商品</button></div><div id="productsTableWrap" style="overflow-x:auto;margin-top:12px"><div class="muted">加载中…</div></div></div></div>

        <div class="tab-panel" id="panel-config"><div class="card soft"><div class="section-title"><h3>系统配置</h3><button class="btn" id="refreshConfig" type="button">刷新</button></div><div id="configForm" style="margin-top:12px"><div class="muted">加载中…</div></div></div></div>

        <div class="tab-panel" id="panel-entitlements"><div class="card soft"><div class="section-title"><h3>权益管理</h3><button class="btn" id="refreshEntitlements" type="button">刷新</button></div><div class="inline-form" style="margin:12px 0"><input class="input" id="entSearchInput" placeholder="搜索用户ID或邮箱…" /><button class="btn" id="entSearchBtn" type="button">搜索</button></div><div id="entitlementsTableWrap" style="overflow-x:auto"><div class="muted">加载中…</div></div></div><div class="card soft" style="margin-top:16px"><div class="section-title"><h3>批量邮箱查询</h3><button class="btn primary" id="bulkEmailCheckBtn" type="button">查询</button></div><div style="margin:12px 0"><textarea class="input" id="bulkEmailInput" rows="6" placeholder="每行一个邮箱，例如：&#10;1. abc@qq.com&#10;2. xyz@163.com" style="width:100%;font-family:monospace;font-size:13px"></textarea></div><div style="margin:8px 0;display:flex;gap:8px;align-items:center"><label class="small" style="white-space:nowrap">开通项目:</label><select class="input" id="bulkGrantProject" style="width:auto"><option value="">加载中…</option></select><button class="btn primary" id="bulkGrantBtn" type="button" disabled>批量开通未激活用户</button></div><div id="bulkEmailResultWrap" style="overflow-x:auto"></div></div></div>

        <div class="tab-panel" id="panel-projects"><div class="card soft"><div class="section-title"><h3>项目中心</h3><button class="btn primary" id="btnAddProject" type="button">新建项目</button></div><div id="projectsTableWrap" style="overflow-x:auto;margin-top:12px"><div class="muted">加载中…</div></div></div></div>

        <div class="tab-panel" id="panel-cohorts"><div class="card soft"><div class="section-title"><h3>班期管理</h3><button class="btn primary" id="btnAddCohort" type="button">新建班期</button></div><div id="cohortsTableWrap" style="overflow-x:auto;margin-top:12px"><div class="muted">加载中…</div></div></div></div>

        <div class="tab-panel" id="panel-groups"><div class="card soft"><div class="section-title"><h3>学习群中心</h3><button class="btn primary" id="btnAddGroup" type="button">新建学习群</button></div><div id="groupsTableWrap" style="overflow-x:auto;margin-top:12px"><div class="muted">加载中…</div></div><div class="hr"></div><h4>入群邀请管理</h4><div id="groupInvitesWrap" style="overflow-x:auto;margin-top:12px"><div class="muted">加载中…</div></div></div></div>

        <div class="tab-panel" id="panel-templates"><div class="card soft"><div class="section-title"><h3>通知模板</h3><button class="btn primary" id="btnAddTemplate" type="button">新建模板</button></div><div id="templatesTableWrap" style="overflow-x:auto;margin-top:12px"><div class="muted">加载中…</div></div></div></div>

        <div class="tab-panel" id="panel-audit"><div class="card soft"><div class="section-title"><h3>审计日志</h3><button class="btn" id="refreshAudit" type="button">刷新</button></div><div id="auditTableWrap" style="overflow-x:auto;margin-top:12px"><div class="muted">加载中…</div></div></div></div>

      </div>
    </section>`;
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

  if (isConfigured() && !supabase) await ensureSupabase();
  if (!isConfigured() || !supabase) {
    location.replace('index.html');
    return;
  }

  _user = await getCurrentUser();
  if (!_user) {
    location.replace('login.html?next=admin-commerce.html');
    return;
  }

  _profile = await getUserProfile(_user);
  _isAdmin = isAdminRole(_profile?.role);
  if (!_isAdmin) {
    location.replace('index.html');
    return;
  }

  // Auth passed — inject content
  gate.hidden = true;
  injectCommerceContent();
  initTabs();
  loadStats();

  // Lazy-load sub-modules
  const mods = await Promise.allSettled([
    import('./admin-commerce-orders.js?v=20260325_001'),
    import('./admin-commerce-products.js?v=20260325_001'),
    import('./admin-commerce-config.js?v=20260325_001'),
    import('./admin-commerce-entitlements.js?v=20260416_manage'),
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

  document.getElementById('panel-orders')?.dispatchEvent(new CustomEvent('panel:show'));
}

init();
