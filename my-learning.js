/**
 * my-learning.js — 我的学习页面逻辑
 * Tabs: 我的权益 / 我的订单 / 已报名项目
 */
import {
  supabase, ensureSupabase, isConfigured,
  getCurrentUser, toast,
} from './supabaseClient.js?v=20260323_001';

/* ── helpers ── */
function esc(s) {
  return String(s ?? '').replace(/[&<>'"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

function daysLeft(endAt) {
  if (!endAt) return null;
  const diff = Math.ceil((new Date(endAt) - Date.now()) / 86400000);
  return diff;
}

/* ── tab switching ── */
function initTabs() {
  const tabBar = document.getElementById('mlTabs');
  if (!tabBar) return;
  tabBar.addEventListener('click', e => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    const tab = btn.dataset.tab;
    tabBar.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.ml-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`ml-panel-${tab}`)?.classList.add('active');
  });
}

/* ── 权益类型标签 ── */
const ENT_TYPE_LABEL = {
  membership:      '会员',
  specialty_bundle:'专科整套课',
  single_video:    '单视频',
  project_access:  '项目权限',
  cohort_access:   '班期权限',
};

function entBadge(ent) {
  const days = daysLeft(ent.end_at);
  if (!ent.end_at) return `<span class="ent-badge active">长期有效</span>`;
  if (days === null || days < 0) return `<span class="ent-badge expired">已过期</span>`;
  if (days <= 30) return `<span class="ent-badge expiring">剩余 ${days} 天</span>`;
  return `<span class="ent-badge active">有效至 ${fmtDate(ent.end_at)}</span>`;
}

function renderEntitlements(list) {
  const wrap = document.getElementById('entList');
  document.getElementById('entLoading').hidden = true;

  if (!list || list.length === 0) {
    document.getElementById('entEmpty').hidden = false;
    return;
  }

  // Deduplicate: for specialty_bundle, keep only the one with latest end_at per specialty_id
  const seen = new Map();
  const deduped = [];
  for (const e of list) {
    if (e.entitlement_type === 'specialty_bundle' && e.specialty_id) {
      const key = `sp_${e.specialty_id}`;
      const prev = seen.get(key);
      if (prev) {
        // keep the one with later end_at
        if ((e.end_at || '') > (prev.end_at || '')) {
          deduped[deduped.indexOf(prev)] = e;
          seen.set(key, e);
        }
        continue;
      }
      seen.set(key, e);
    }
    deduped.push(e);
  }

  // Group by type
  const groups = {};
  deduped.forEach(e => {
    const t = e.entitlement_type;
    if (!groups[t]) groups[t] = [];
    groups[t].push(e);
  });

  const ORDER = ['membership','specialty_bundle','project_access','cohort_access','single_video'];
  let html = '';

  for (const type of ORDER) {
    if (!groups[type]) continue;
    html += `<h4 style="margin:16px 0 8px;opacity:.8">${esc(ENT_TYPE_LABEL[type] || type)}</h4>`;
    for (const e of groups[type]) {
      const title = e.product_title || e.specialty_name || e.project_title || ENT_TYPE_LABEL[type] || '权益';
      const sub = [
        e.specialty_name && type !== 'membership' ? `专科：${esc(e.specialty_name)}` : null,
        e.project_title ? `项目：${esc(e.project_title)}` : null,
        e.start_at ? `开始：${fmtDate(e.start_at)}` : null,
      ].filter(Boolean).join('　');

      // CTA button
      let cta = '';
      if (type === 'specialty_bundle' && e.specialty_id) {
        cta = `<a class="btn tiny" href="videos.html?specialty=${encodeURIComponent(e.specialty_id)}">进入视频库</a>`;
      } else if (type === 'project_access' && e.project_id) {
        cta = `<a class="btn tiny" href="my-learning.html">查看项目</a>`;
      } else if (type === 'single_video' && e.video_id) {
        cta = `<a class="btn tiny" href="watch.html?id=${encodeURIComponent(e.video_id)}">立即观看</a>`;
      } else if (type === 'membership') {
        cta = `<a class="btn tiny" href="learning.html">进入学习中心</a>`;
      }

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
    const hasMembership = groups['membership'] && groups['membership'].length > 0;
    if(hasMembership){
      const m = groups['membership'][0];
      const expiry = m.end_at ? new Date(m.end_at).toLocaleDateString('zh-CN', {year:'numeric',month:'long',day:'numeric'}) : '永久';
      memberCard.style.background = 'rgba(168,85,247,.08)';
      memberCard.style.border = '1px solid rgba(168,85,247,.25)';
      memberCard.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
          <div>
            <span style="font-size:14px;font-weight:600;color:#c084fc">✓ GlomCon 教育会员</span>
            <span class="small muted" style="margin-left:8px">有效期至 ${esc(expiry)}</span>
          </div>
          <a class="btn tiny" href="videos.html?cat=glomcon">进入 GlomCon 视频库</a>
        </div>`;
      memberCard.hidden = false;
    }else{
      memberCard.style.background = 'rgba(168,85,247,.05)';
      memberCard.style.border = '1px solid rgba(168,85,247,.2)';
      memberCard.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
          <div>
            <div style="font-weight:600;font-size:14px">👑 升级为 GlomCon 教育会员</div>
            <div class="small muted" style="margin-top:3px">¥199/年 · 解锁全部 GlomCon 中国教育系列视频</div>
          </div>
          <a class="btn primary" href="academy.html#membership">开通会员</a>
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
      `<span class="small">${esc(i.product_title)} ×${i.quantity} ¥${i.amount_cny}</span>`
    ).join('　');

    // Action based on status
    let action = '';
    if (o.status === 'pending_payment') {
      action = `<a class="btn tiny primary" href="checkout.html?order_id=${o.id}">去付款</a>`;
    } else if (o.status === 'pending_review') {
      action = `<span class="small muted">等待管理员审核（通常1工作日内）</span>`;
    } else if (o.status === 'rejected') {
      action = `<span class="small" style="color:#f87171">请联系客服或重新购买</span>`;
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
    const groupQr = e.group_qr_url
      ? `<div class="qr-wrap">
           <p class="small" style="margin:0 0 8px">扫码加入学习群</p>
           <img src="${esc(e.group_qr_url)}" alt="学习群二维码" />
           <p class="small muted" style="margin:6px 0 0">二维码有效期有限，请尽快扫码</p>
         </div>`
      : (e.enrollment_status === 'confirmed' && e.approval_status === 'approved'
          ? `<p class="small muted" style="margin-top:8px">学习群二维码由管理员配置后显示</p>`
          : '');

    return `
      <div class="enroll-card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div>
            <div style="font-weight:600;font-size:15px">${esc(e.project_title || '培训项目')}</div>
            ${e.cohort_title ? `<div class="small muted" style="margin-top:4px">班期：${esc(e.cohort_title)}</div>` : ''}
            ${e.cohort_start_date ? `<div class="small muted">开始：${esc(String(e.cohort_start_date))}</div>` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            <span class="ent-badge ${e.enrollment_status === 'confirmed' ? 'active' : 'expired'}">
              ${esc(ENROLL_STATUS[e.enrollment_status] || e.enrollment_status)}
            </span>
            <span class="ent-badge ${e.approval_status === 'approved' ? 'active' : (e.approval_status === 'rejected' ? 'expired' : 'expiring')}">
              ${esc(APPROVAL_STATUS[e.approval_status] || e.approval_status)}
            </span>
          </div>
        </div>
        ${groupQr}
      </div>`;
  }).join('');
}

/* ── main init ── */
async function init() {
  const gate = document.getElementById('mlGate');
  const main = document.getElementById('mlMain');

  if (!isConfigured()) {
    gate.innerHTML = '<b>提示：</b>服务暂不可用，请联系管理员。';
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
    supabase.rpc('get_my_enrollments'),
  ]);

  if (entRes.status === 'fulfilled' && !entRes.value.error) {
    renderEntitlements(entRes.value.data || []);
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
