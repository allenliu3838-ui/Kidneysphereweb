/**
 * my-learning.js — 我的学习页面逻辑
 * Tabs: 我的权益 / 我的订单 / 已报名项目
 */
import {
  supabase, ensureSupabase, isConfigured,
  getCurrentUser, canAccessNephroPro,
} from './supabaseClient.js?v=20260401_fix';
import {
  formatLearningDate as fmtDate, entitlementDisplayState, currentLearningMembership,
  learningPeriod, learningCourseLink, safeLearningImageUrl, enrollmentDisplayState,
} from './my-learning-display.js?v=20260914_payment1';

/* ── helpers ── */
function esc(s) {
  return String(s ?? '').replace(/[&<>'"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

/* ── tab switching ── */
function initTabs() {
  const tabBar = document.getElementById('mlTabs');
  if (!tabBar) return;
  const selectTab = tab => {
    const btn = tabBar.querySelector(`button[data-tab="${tab}"]`);
    if (!btn) return;
    tabBar.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.ml-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`ml-panel-${tab}`)?.classList.add('active');
  };
  tabBar.addEventListener('click', e => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    const tab = btn.dataset.tab;
    selectTab(tab);
    history.replaceState(null, '', `#${tab}`);
  });
  const selectHash = () => {
    const tab = location.hash.slice(1);
    if (['entitlements', 'orders', 'enrollments'].includes(tab)) selectTab(tab);
  };
  window.addEventListener('hashchange', selectHash);
  selectHash();
}

/* ── 权益类型标签 ── */
const ENT_TYPE_LABEL = {
  membership:      'GlomCon 中国教育会员',
  specialty_bundle:'专科整套课',
  single_video:    '单视频',
  project_access:  '项目课程权益',
  cohort_access:   '班期课程权益',
  atlas_pro:       '肾域 Pro',
};

function entBadge(ent) {
  const state = entitlementDisplayState(ent);
  return `<span class="ent-badge ${state.tone}">${esc(state.label)}</span>`;
}

async function renderNephroProCard(entitlements){
  const card = document.getElementById('nephroProCard');
  if(!card) return;
  const hasAccess = await canAccessNephroPro((entitlements || []).filter(ent => entitlementDisplayState(ent).active));
  if(hasAccess){
    card.innerHTML = `
      <div style="padding:14px 16px;border:1px solid rgba(34,197,94,.4);background:rgba(34,197,94,.08);border-radius:14px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <div>
          <div style="font-weight:600;">🗺️ 肾域 Pro <span class="badge" style="margin-left:6px;color:#4ade80;border-color:rgba(34,197,94,.4);background:rgba(34,197,94,.1);">已解锁</span></div>
          <div class="small muted" style="margin-top:3px;">肾内科证据图谱与文献更新工具</div>
        </div>
        <a class="btn primary tiny" href="nephro-pro.html">进入学习</a>
      </div>`;
  } else {
    card.innerHTML = `
      <div style="padding:14px 16px;border:1px solid rgba(168,85,247,.25);background:rgba(168,85,247,.05);border-radius:14px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <div>
          <div style="font-weight:600;">🗺️ 肾域 Pro</div>
          <div class="small muted" style="margin-top:3px;">肾内科证据图谱与文献更新工具</div>
        </div>
        <a class="btn primary tiny" href="checkout.html?product=MEMBERSHIP-YEARLY">开通教育会员解锁</a>
      </div>`;
  }
  card.hidden = false;
}

async function renderEntitlements(list) {
  const wrap = document.getElementById('entList');
  document.getElementById('entLoading').hidden = true;
  await renderNephroProCard(list || []);
  document.getElementById('entEmpty').hidden = !!list?.length;

  // Keep each server record: different orders and lifetime grants have distinct terms.
  const groups = Object.create(null);
  (list || []).forEach(e => {
    const t = e.entitlement_type;
    if (!groups[t]) groups[t] = [];
    groups[t].push(e);
  });

  const knownTypes = ['membership','specialty_bundle','project_access','cohort_access','single_video','atlas_pro'];
  const ORDER = [...knownTypes, ...Object.keys(groups).filter(type => !knownTypes.includes(type))];
  let html = '';

  for (const type of ORDER) {
    if (!groups[type]) continue;
    html += `<h4 style="margin:16px 0 8px;opacity:.8">${esc(ENT_TYPE_LABEL[type] || type)}</h4>`;
    for (const e of groups[type]) {
      const title = e.product_title || e.specialty_name || e.project_title || ENT_TYPE_LABEL[type] || '权益';
      const sub = [
        e.specialty_name && type !== 'membership' ? `专科：${esc(e.specialty_name)}` : null,
        e.project_title ? `项目：${esc(e.project_title)}` : null,
        e.cohort_id ? '班期：请在已报名项目查看对应班期' : (['project_access','cohort_access'].includes(type) ? '班期：未指定' : null),
        `权益期限：${esc(learningPeriod(e))}`,
      ].filter(Boolean).join('　');

      // CTA button
      const course = learningCourseLink(e);
      const cta = course ? `<a class="btn tiny" href="${esc(course.href)}">${esc(course.label)}</a>` : '';

      html += `
        <div class="ent-card">
          <div class="ent-head">
            <div>
              <div class="ent-title">${esc(title)}</div>
              ${sub ? `<div class="ent-meta">${sub}</div>` : ''}
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              ${entBadge(e)}
              ${cta}
            </div>
          </div>
          <div class="ent-meta" style="margin-top:6px">
            来源：${esc(e.grant_reason === 'order_approved' ? '订单购买' : e.grant_reason === 'auto_upgrade_from_singles' ? '单视频累计升级' : (e.grant_reason || '管理员授权'))}
          </div>
        </div>`;
    }
  }

  wrap.innerHTML = html;

  // Render membership upgrade/status card
  const memberCard = document.getElementById('membershipCard');
  if(memberCard){
    const m = currentLearningMembership(list);
    if(m){
      const expiry = m.end_at == null ? '长期有效' : `有效期至 ${fmtDate(m.end_at)}`;
      memberCard.style.background = 'rgba(168,85,247,.08)';
      memberCard.style.border = '1px solid rgba(168,85,247,.25)';
      memberCard.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
          <div>
            <span style="font-size:14px;font-weight:600;color:#c084fc">✓ GlomCon 教育会员</span>
            <span class="small muted" style="margin-left:8px">${esc(expiry)}</span>
          </div>
          <a class="btn tiny" href="videos.html?source=glomcon">进入 GlomCon 视频库</a>
        </div>`;
      memberCard.hidden = false;
    }else{
      memberCard.style.background = 'rgba(168,85,247,.05)';
      memberCard.style.border = '1px solid rgba(168,85,247,.2)';
      memberCard.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
          <div>
            <div style="font-weight:600;font-size:14px">👑 升级为 GlomCon 教育会员</div>
            <div class="small muted" style="margin-top:3px">¥299/年 · 视频学习、病例讨论、肾域 Pro 一站解锁</div>
          </div>
          <a class="btn primary" href="checkout.html?product=MEMBERSHIP-YEARLY">开通会员</a>
        </div>`;
      memberCard.hidden = false;
    }
  }
}

/* ── 订单状态标签 ── */
const ORDER_STATUS = {
  pending_payment: '待付款',
  pending_review:  '待审核',
  approved:        '已通过',
  rejected:        '已驳回',
  cancelled:       '已取消',
  refunded:        '已退款',
};

const CHANNEL_LABEL = {
  wechat: '微信支付', alipay: '支付宝',
  bank_transfer: '银行转账', online_wechat: '微信', online_alipay: '支付宝',
};

function renderOrders(list) {
  const wrap = document.getElementById('ordList');
  document.getElementById('ordLoading').hidden = true;

  if (!list || list.length === 0) {
    document.getElementById('ordEmpty').hidden = false;
    return;
  }

  wrap.innerHTML = list.map(o => {
    const items = (o.items || []).map(i =>
      `<span class="small">${esc(i.product_title)} ×${esc(i.quantity)} ¥${esc(i.amount_cny)}</span>`
    ).join('　');

    // Action based on status
    let action = '';
    if (o.status === 'pending_payment') {
      action = `<a class="btn tiny primary" href="checkout.html?order_id=${encodeURIComponent(o.id)}">去付款</a>`;
    } else if (o.status === 'pending_review') {
      action = `<span class="small muted">等待管理员审核（通常1工作日内）</span>`;
    } else if (o.status === 'rejected') {
      const reason = o.remark ? `<span class="small" style="color:#f87171">驳回原因：${esc(o.remark)}</span><br/>` : '';
      action = `${reason}<a class="btn tiny primary" href="checkout.html?order_id=${encodeURIComponent(o.id)}">重新提交凭证</a>`;
    } else if (o.status === 'approved') {
      action = `<a class="btn tiny primary" href="#entitlements">查看已购权益</a> <a class="btn tiny" href="#enrollments">查看项目与班期</a>`;
    }

    return `
      <div class="order-row">
        <div class="order-head">
          <div>
            <span class="order-no">${esc(o.order_no)}</span>
            <span class="order-status ${esc(o.status)}" style="margin-left:8px">${esc(ORDER_STATUS[o.status] || o.status)}</span>
          </div>
          <b>¥${esc(String(o.total_amount_cny))}</b>
        </div>
        <div class="small muted" style="margin-top:6px">${items || '—'}</div>
        <div class="small muted" style="margin-top:4px">
          下单：${fmtDate(o.created_at)}
          ${o.channel ? `　渠道：${esc(CHANNEL_LABEL[o.channel] || o.channel)}` : ''}
          ${o.approved_at ? `　通过：${fmtDate(o.approved_at)}` : ''}
          ${o.remark ? `　备注：${esc(o.remark)}` : ''}
        </div>
        ${action ? `<div style="margin-top:8px">${action}</div>` : ''}
      </div>`;
  }).join('');
}

/* ── 报名状态 ── */
const ENROLL_STATUS = {
  pending: '待确认', confirmed: '已确认', cancelled: '已取消', expired: '已过期',
};
const APPROVAL_STATUS = {
  pending: '待审批', approved: '已批准', rejected: '已驳回',
};

function renderEnrollments(list) {
  const wrap = document.getElementById('enrList');
  document.getElementById('enrLoading').hidden = true;

  if (!list || list.length === 0) {
    document.getElementById('enrEmpty').hidden = false;
    return;
  }

  wrap.innerHTML = list.map(e => {
    const state = enrollmentDisplayState(e);
    const qrUrl = state.active && e.cohort_id ? safeLearningImageUrl(e.group_qr_url) : null;
    const groupQr = qrUrl
      ? `<div class="qr-wrap">
           <p class="small" style="margin:0 0 8px">扫码加入学习群</p>
           <a href="${esc(qrUrl)}" target="_blank" rel="noopener noreferrer"><img src="${esc(qrUrl)}" alt="${esc(e.project_title || '项目')}学习群二维码" loading="lazy" /></a>
           <p class="small" style="margin:6px 0 0"><a href="${esc(qrUrl)}" target="_blank" rel="noopener noreferrer">打开学习群二维码</a></p>
           <p class="small muted" style="margin:6px 0 0">二维码有效期有限，请尽快扫码</p>
         </div>`
      : (state.active
          ? `<p class="small muted" style="margin-top:8px">${e.cohort_id ? '学习群入口待配置，请联系项目管理员。' : '班期未指定，分班后显示对应学习群入口。'}</p>`
          : '');
    const course = state.active ? learningCourseLink({
      entitlement_type: 'project_access', status: 'active', specialty_id: e.specialty_id,
      start_at: e.access_start_at, end_at: e.access_end_at,
    }) : null;
    const hasPeriod = e.access_status !== 'ambiguous' && (e.is_access_active === true || e.access_start_at != null || e.access_end_at != null);
    const period = hasPeriod
      ? learningPeriod({ start_at: e.access_start_at, end_at: e.access_end_at })
      : '暂无可核实的对应权益期限';

    return `
      <div class="enroll-card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div>
            <div style="font-weight:600;font-size:15px">${esc(e.project_title || '培训项目')}</div>
            ${e.product_title ? `<div class="small muted" style="margin-top:4px">所购项目：${esc(e.product_title)}</div>` : ''}
            <div class="small muted" style="margin-top:4px">班期：${esc(e.cohort_title || (e.cohort_id ? '名称待核实' : '未指定'))}</div>
            ${e.cohort_start_date || e.cohort_end_date ? `<div class="small muted">班期日期：${esc(fmtDate(e.cohort_start_date))} 至 ${esc(fmtDate(e.cohort_end_date))}</div>` : ''}
            <div class="small muted" style="margin-top:4px">权益期限：${esc(period)}</div>
            <div class="small muted" style="margin-top:4px">报名记录：${esc(ENROLL_STATUS[e.enrollment_status] || e.enrollment_status || '待核实')} · ${esc(APPROVAL_STATUS[e.approval_status] || e.approval_status || '待核实')}</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            <span class="ent-badge ${state.tone}">${esc(state.label)}</span>
            ${course ? `<a class="btn primary tiny" href="${esc(course.href)}">进入项目课程</a>` : ''}
          </div>
        </div>
        ${groupQr}
      </div>`;
  }).join('');
}

/* ── dashboard summary: membership card + recent notifications ── */
async function renderDashboardSummary(user, entitlements) {
  const wrap = document.getElementById('mlDashSummary');
  if (!wrap) return;

  // 1. Membership card (top-left)
  const memberEl = document.getElementById('dashMembership');
  if (memberEl) {
    try {
      if (!Array.isArray(entitlements)) throw new Error('Entitlements unavailable');
      const ent = currentLearningMembership(entitlements);
      if (ent) {
        const { days } = entitlementDisplayState(ent);
        const expiry = ent.end_at == null ? '长期有效' : `有效期至 ${fmtDate(ent.end_at)}`;
        const expiringSoon = days != null && days <= 30;
        memberEl.innerHTML = `
          <h4>👑 会员状态</h4>
          <div style="font-size:15px;font-weight:600;color:#c084fc">✓ GlomCon 教育会员</div>
          <div class="small muted" style="margin-top:4px">
            ${days != null ? `剩余 <b>${days}</b> 天 · ` : ''}${esc(expiry)}
          </div>
          ${expiringSoon ? `<a class="btn tiny" href="checkout.html?product=MEMBERSHIP-YEARLY" style="margin-top:8px">续费会员</a>` : ''}
        `;
      } else {
        memberEl.innerHTML = `
          <h4>👑 会员状态</h4>
          <div style="font-size:15px;font-weight:600">当前无有效会员权益</div>
          <div class="small muted" style="margin-top:4px">¥299/年 · 视频学习、病例讨论、肾域 Pro 一站解锁</div>
          <a class="btn primary tiny" href="checkout.html?product=MEMBERSHIP-YEARLY" style="margin-top:10px">立即开通</a>
        `;
      }
    } catch (_e) {
      memberEl.innerHTML = `<h4>👑 会员状态</h4><div class="small muted">加载失败</div>`;
    }
  }

  // 2. Recent notifications (top-middle) — pull last 3 site notifications
  const notifList = document.getElementById('dashNotifList');
  if (notifList) {
    try {
      const { data: jobs } = await supabase
        .from('notification_jobs')
        .select('id, related_order_id, payload_json, created_at, template:template_id ( code, title )')
        .eq('user_id', user.id)
        .eq('channel', 'site')
        .order('created_at', { ascending: false })
        .limit(3);
      if (!jobs || jobs.length === 0) {
        notifList.innerHTML = `<div class="muted small">暂无新通知。</div>`;
      } else {
        notifList.innerHTML = jobs.map(j => {
          const code = j.template?.code || '';
          const title = j.template?.title || '通知';
          const payload = j.payload_json || {};
          const orderNo = payload.order_no || '';
          const reason = payload.reason || '';
          const ts = fmtDate(j.created_at);
          const cls = code === 'order_approved' ? 'approved' : (code === 'order_rejected' ? 'rejected' : '');
          const sub = orderNo ? `订单 ${esc(orderNo)}${reason ? ' · ' + esc(reason) : ''}` : '';
          return `
            <div class="ml-dash-notif ${cls}">
              <div class="notif-title">${esc(title)}</div>
              ${sub ? `<div class="small">${sub}</div>` : ''}
              <div class="notif-meta">${esc(ts)}</div>
            </div>`;
        }).join('');
      }
      // Mark notifications as seen since user is viewing them
      try { localStorage.setItem('ks_seen_order_notif_at', new Date().toISOString()); } catch (_e) {}
      // Hide the bell badge if currently showing
      const bellBadge = document.querySelector('[data-nav-bell-badge]');
      if (bellBadge) bellBadge.hidden = true;
    } catch (_e) {
      notifList.innerHTML = `<div class="muted small">通知系统暂不可用。</div>`;
    }
  }

  wrap.hidden = false;
}

/* ── main init ── */
async function init() {
  const gate = document.getElementById('mlGate');
  const main = document.getElementById('mlMain');

  if (!isConfigured()) {
    gate.innerHTML = '<b>提示：</b>服务暂时不可用，请稍后刷新重试。';
    return;
  }

  await ensureSupabase();
  if (!supabase) {
    gate.innerHTML = '<b>提示：</b>服务初始化失败，请刷新重试。';
    return;
  }

  const user = await getCurrentUser();
  if (!user) {
    gate.innerHTML = `请先 <a href="login.html?next=my-learning.html">登录</a> 后查看学习记录。`;
    return;
  }

  gate.hidden = true;
  main.hidden = false;
  initTabs();

  // Load all three data sources in parallel
  const [entRes, ordRes, enrRes] = await Promise.allSettled([
    supabase.rpc('get_my_entitlements'),
    supabase.rpc('get_my_orders'),
    supabase.rpc('get_my_learning_enrollments'),
  ]);

  const entitlements = entRes.status === 'fulfilled' && !entRes.value.error ? (entRes.value.data || []) : null;
  renderDashboardSummary(user, entitlements);
  if (entRes.status === 'fulfilled' && !entRes.value.error) {
    await renderEntitlements(entitlements);
  } else {
    document.getElementById('entLoading').textContent = '加载权益失败，请刷新重试。';
    console.warn('entitlements error:', entRes.reason || entRes.value?.error);
  }

  if (ordRes.status === 'fulfilled' && !ordRes.value.error) {
    renderOrders(ordRes.value.data || []);
  } else {
    document.getElementById('ordLoading').textContent = '加载订单失败，请刷新重试。';
    console.warn('orders error:', ordRes.reason || ordRes.value?.error);
  }

  if (enrRes.status === 'fulfilled' && !enrRes.value.error) {
    renderEnrollments(enrRes.value.data || []);
  } else {
    document.getElementById('enrLoading').textContent = '加载报名记录失败，请刷新重试。';
    console.warn('enrollments error:', enrRes.reason || enrRes.value?.error);
  }
}

init();
