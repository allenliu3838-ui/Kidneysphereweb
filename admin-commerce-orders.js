/**
 * admin-commerce-orders.js — 订单审核模块
 */
import {
  supabase, toast, formatBeijingDateTime,
} from './supabaseClient.js?v=20260401_fix';
import { esc, statusDot, showModal, closeModal } from './admin-commerce.js?v=20260914_payment1';
import { reviewApprovalState, canRepairEnrollment } from './admin-commerce-review.js?v=20260914_payment1';

const STATUS_MAP = {
  pending_payment: { label: '待付款', dot: 'yellow' },
  pending_review:  { label: '待审核', dot: 'yellow' },
  approved:        { label: '已通过', dot: 'green' },
  rejected:        { label: '已驳回', dot: 'red' },
  cancelled:       { label: '已取消', dot: 'gray' },
  refunded:        { label: '已退款', dot: 'gray' },
};

const REVIEW_MESSAGES = {
  MISSING_FULL_ENROLLMENT: '项目报名缺失或项目权益尚未绑定',
  AMBIGUOUS_MAPPING: '商品与项目归属无法确定',
  MISSING_OR_AMBIGUOUS_ENTITLEMENT: '项目权益缺失或存在重复记录',
  ENTITLEMENT_MAPPING_CONFLICT: '既有权益与订单项目或班期冲突',
  ENTITLEMENT_NOT_ACTIVE: '项目权益未生效、已过期或已撤销',
  ENROLLMENT_HISTORY_CONFLICT: '历史报名状态或归属存在冲突',
  ORDER_NOT_APPROVED: '订单尚未审核通过',
  COMPLETE: '项目报名完整',
  NO_VALID_PAYMENT_PROOF: '没有金额一致且归属有效的付款凭证',
  ORDER_AMOUNT_MISMATCH_OR_NO_ITEMS: '订单明细为空或与订单总金额不一致',
  EXISTING_ENTITLEMENT_HISTORY_REQUIRES_MANUAL_REVIEW: '订单已有权益发放历史，需另行核实，不能重复发放',
  ORDER_STATUS_NOT_APPROVABLE: '当前订单状态不能通过审核',
  PROOF_OWNER_MISMATCH: '付款凭证不属于此订单或此用户',
  PROOF_AMOUNT_MISMATCH: '凭证金额与订单金额不一致',
  PROOF_PATH_INVALID: '付款凭证文件位置无效',
  PROOF_OBJECT_MISSING_OR_NOT_OWNED: '凭证文件不存在或上传者与订单用户不符',
  PROOF_REJECTED: '该付款凭证已被驳回',
};

function reviewMessage(code) { return REVIEW_MESSAGES[code] || code; }

function statusLabel(s) {
  const m = STATUS_MAP[s] || { label: s, dot: 'gray' };
  return `${statusDot(m.dot)}${esc(m.label)}`;
}

async function loadOrders() {
  const wrap = document.getElementById('ordersTableWrap');
  if (!wrap) return;

  const filter = document.getElementById('orderFilterStatus')?.value || 'pending_all';

  if (filter === 'enrollment_issues') {
    await loadEnrollmentIssues(wrap);
    return;
  }

  let q = supabase
    .from('orders')
    .select(`
      id, order_no, user_id, total_amount_cny, status, channel,
      contact_wechat, contact_phone, contact_email,
      remark, created_at, paid_at, approved_at,
      order_items ( id, product_title, quantity, unit_price_cny, amount_cny ),
      payment_proofs ( id, channel, amount_cny, proof_bucket, proof_path, submitted_at, payer_name, transfer_ref_last4 )
    `)
    .order('created_at', { ascending: false })
    .limit(100);

  if (filter === 'approved_no_proof') {
    q = q.in('status', ['approved', 'rejected']);
  } else if (filter === 'pending_all') {
    q = q.eq('status', 'pending_review');
  } else if (filter !== 'all') {
    q = q.eq('status', filter);
  }

  let { data, error } = await q;
  // Backward compat: retry without contact columns if they don't exist yet
  if (error && /contact_wechat|contact_phone|contact_email/i.test(String(error.message || ''))) {
    let q2 = supabase
      .from('orders')
      .select(`
        id, order_no, user_id, total_amount_cny, status, channel,
        remark, created_at, paid_at, approved_at,
        order_items ( id, product_title, quantity, unit_price_cny, amount_cny ),
        payment_proofs ( id, channel, amount_cny, proof_bucket, proof_path, submitted_at, payer_name, transfer_ref_last4 )
      `)
      .order('created_at', { ascending: false })
      .limit(100);
    if (filter === 'approved_no_proof') {
      q2 = q2.in('status', ['approved', 'rejected']);
    } else if (filter === 'pending_all') {
      q2 = q2.eq('status', 'pending_review');
    } else if (filter !== 'all') {
      q2 = q2.eq('status', filter);
    }
    const r2 = await q2;
    data = r2.data;
    error = r2.error;
  }
  if (error) {
    wrap.innerHTML = `<div class="note">${esc(error.message)}</div>`;
    return;
  }

  let rows = data || [];

  // Client-side filter: approved orders with zero payment proofs
  if (filter === 'approved_no_proof') {
    rows = rows.filter(r => !r.payment_proofs || r.payment_proofs.length === 0);
  }

  if (!rows.length) {
    wrap.innerHTML = '<div class="muted">没有符合条件的订单。(筛选: ' + esc(filter) + ')</div>';
    return;
  }

  // For approved_no_proof filter, fetch user profiles and entitlement status
  let profileMap = {};
  let orderEntStatusMap = {};  // orderId -> { total, active, revoked }
  if (filter === 'approved_no_proof' && rows.length) {
    const userIds = [...new Set(rows.map(r => r.user_id))];
    const orderIds = rows.map(r => r.id);
    const [profileRes, entRes] = await Promise.all([
      supabase.from('profiles').select('id, full_name, role').in('id', userIds),
      supabase.from('user_entitlements').select('id, source_order_id, status').in('source_order_id', orderIds),
    ]);
    if (profileRes.data) {
      profileRes.data.forEach(p => { profileMap[p.id] = p; });
    }
    if (entRes.data) {
      entRes.data.forEach(e => {
        if (!orderEntStatusMap[e.source_order_id]) {
          orderEntStatusMap[e.source_order_id] = { total: 0, active: 0, revoked: 0 };
        }
        orderEntStatusMap[e.source_order_id].total++;
        if (e.status === 'active') orderEntStatusMap[e.source_order_id].active++;
        if (e.status === 'revoked') orderEntStatusMap[e.source_order_id].revoked++;
      });
    }
  }

  // Count by status
  const pendingReviewCount = rows.filter(r => r.status === 'pending_review').length;
  const countSummary = (filter === 'pending_all') ? `
    <div class="small muted" style="margin-bottom:8px">
      共 ${pendingReviewCount} 个待审核订单
    </div>` : '';

  const isNoProof = filter === 'approved_no_proof';
  const warningBanner = isNoProof ? `
    <div style="padding:12px 16px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:8px;margin-bottom:12px;color:#ef4444;font-weight:600">
      ⚠ 以下 ${rows.length} 个订单已通过审核但未上传任何支付凭证！
      <button class="btn tiny danger" id="batchRejectBtn" type="button" style="margin-left:12px;vertical-align:middle">
        批量驳回订单
      </button>
    </div>` : '';

  // Store rows for batch revoke
  if (isNoProof) {
    window._noProofOrders = rows;
  }

  wrap.innerHTML = `
    ${countSummary}
    ${warningBanner}
    <table class="data-table">
      <thead><tr>
        <th>订单号</th><th>培训项目</th>${isNoProof ? '<th>用户</th>' : ''}<th>金额</th><th>渠道</th><th>联系方式</th><th>状态</th><th>创建时间</th><th>操作</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => {
          const prof = profileMap[r.user_id];
          const userName = prof ? esc(prof.full_name || '未设置姓名') : '';
          const entStatus = orderEntStatusMap[r.id];
          const allRevoked = entStatus && entStatus.active === 0 && entStatus.revoked > 0;
          const isRejected = r.status === 'rejected';
          const isDone = isRejected || allRevoked;
          let entLabel = '';
          if (isNoProof) {
            if (isRejected) entLabel = `<span style="color:#ef4444;font-weight:600">✕ 已驳回</span>`;
            else if (allRevoked) entLabel = `<span style="color:#ef4444;font-weight:600">✕ 权益已撤销</span>`;
            else entLabel = statusLabel(r.status);
          }
          const productNames = (r.order_items || []).map(i => i.product_title).filter(Boolean).join('、') || '—';
          return `
          <tr${isDone ? ' style="opacity:0.5"' : ''}>
            <td><code>${esc(r.order_no)}</code></td>
            <td class="small">${esc(productNames)}</td>
            ${isNoProof ? `<td class="small">${userName}<br/><code class="small">${esc(r.user_id)}</code></td>` : ''}
            <td><b>¥${esc(String(r.total_amount_cny ?? 0))}</b></td>
            <td>${esc(r.channel || '—')}</td>
            <td class="small">${esc(r.contact_wechat || r.contact_phone || r.contact_email || '—')}</td>
            <td>${isNoProof ? entLabel : statusLabel(r.status)}</td>
            <td class="small">${esc(formatBeijingDateTime(r.created_at))}</td>
            <td>
              <button class="btn tiny" data-detail="${r.id}" type="button">详情</button>
              ${isNoProof && r.status === 'approved' ? `<button class="btn tiny danger" data-reject-noproof="${r.id}" data-order-no="${esc(r.order_no)}" type="button">驳回订单</button>` : ''}
              ${r.status === 'pending_review' ? `
                <button class="btn tiny danger" data-reject="${r.id}" type="button">驳回</button>
              ` : ''}
              ${r.status === 'pending_payment' ? `
                <button class="btn tiny danger" data-reject="${r.id}" type="button">驳回</button>
              ` : ''}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

let issueOffset = 0;
const ISSUE_PAGE_SIZE = 100;
const enrollmentIssues = new Map();
const reviewRequests = new Set();
let detailRequest = 0;

function fulfillmentItemsHtml(items) {
  const labels = { full: '项目报名', bundle: '专科整套课', video: '原回放商品', membership: '会员', single_video: '单视频' };
  const grants = { project_access: '项目学习权限', specialty_bundle: '专科整套课', membership: '会员权限', single_video: '单视频' };
  return (items || []).map(item => `<div class="card soft" style="padding:12px;margin:8px 0">
    <div><b>${esc(item.product_code || item.product_id || '未识别商品')}</b> · ${esc(labels[item.variant] || item.product_type || '—')}</div>
    <div class="small">归属项目：<b>${esc(item.project_title || (item.project_id ? '项目名称暂不可用' : '不关联项目'))}</b>${item.project_id ? ` <code>${esc(item.project_id)}</code>` : ''}</div>
    <div class="small">归属班期：<b>${esc(item.cohort_title || (item.cohort_id ? '班期名称暂不可用' : '未指定班期'))}</b>${item.cohort_id ? ` <code>${esc(item.cohort_id)}</code>` : ''}</div>
    <div class="small">权限范围：${esc(grants[item.grant_type] || labels[item.variant] || '待核实')} · ${esc(item.specialty_name || item.specialty_id || item.project_title || '—')} · ${item.enrollment_required ? '自动建立项目报名' : '发放对应学习权益'}${item.gift_membership ? '；含同期赠送会员' : ''}</div>
    <div class="small">权限期限：${item.duration_days == null ? '以服务端规则为准' : `${esc(item.duration_days)} 天`}${item.access_start_at || item.expected_start_at ? ` · ${esc(formatBeijingDateTime(item.access_start_at || item.expected_start_at))} 至 ${esc(formatBeijingDateTime(item.access_end_at || item.expected_end_at))}` : '（以审核通过时间起算）'}</div>
    <div class="small muted">订单商品金额：¥${esc(item.amount_cny ?? '—')} · ${item.mapping_source === 'purchase_snapshot' ? '购买时归属记录' : '旧订单已登记的商品归属'}</div>
  </div>`).join('');
}

async function loadEnrollmentIssues(wrap) {
  wrap.innerHTML = '<div class="muted">正在检查已通过订单的报名归属…</div>';
  enrollmentIssues.clear();
  try {
    const { data, error } = await supabase.rpc('admin_list_payment_enrollment_issues', {
      p_limit: ISSUE_PAGE_SIZE, p_offset: issueOffset,
    });
    if (error) throw error;
    const rows = data || [];
    rows.forEach(row => enrollmentIssues.set(row.order_id, row));
    wrap.innerHTML = `<p class="small muted">以下为服务端检测到的已通过订单报名异常。修复仅补齐可核实的缺失报名，不延长既有权限；归属不明的订单需先核实。</p>
      ${rows.length ? `<table class="data-table"><thead><tr><th>订单</th><th>用户</th><th>通过时间</th><th>异常</th><th>操作</th></tr></thead><tbody>${rows.map(row => `<tr>
        <td><code>${esc(row.order_no)}</code></td><td><code>${esc(row.user_id)}</code></td><td>${esc(formatBeijingDateTime(row.approved_at))}</td>
        <td>${esc(reviewMessage(row.issue_code))}<div class="small">${row.can_repair ? '可核实后补齐报名' : '需核实归属，暂不可自动修复'}</div></td>
        <td><button class="btn tiny" type="button" data-detail="${esc(row.order_id)}">查看归属${row.can_repair ? '并修复' : ''}</button></td>
      </tr>`).join('')}</tbody></table>` : '<div class="muted">当前页没有报名异常。</div>'}
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn tiny" type="button" id="issuesPrev" ${issueOffset === 0 ? 'disabled' : ''}>上一页</button><span class="small">第 ${Math.floor(issueOffset / ISSUE_PAGE_SIZE) + 1} 页</span><button class="btn tiny" type="button" id="issuesNext" ${rows.length < ISSUE_PAGE_SIZE ? 'disabled' : ''}>下一页</button></div>`;
    document.getElementById('issuesPrev')?.addEventListener('click', () => { issueOffset = Math.max(0, issueOffset - ISSUE_PAGE_SIZE); loadOrders(); });
    document.getElementById('issuesNext')?.addEventListener('click', () => { issueOffset += ISSUE_PAGE_SIZE; loadOrders(); });
  } catch (error) {
    wrap.innerHTML = `<div class="note">报名异常检查失败：${esc(error.message)}。请刷新重试。</div>`;
  }
}

async function showOrderDetail(orderId) {
  const request = ++detailRequest;
  let order, fulfillment;
  try {
    const [orderResult, fulfillmentResult] = await Promise.all([supabase
    .from('orders')
    .select(`
      *, order_items(*), payment_proofs(*)
    `)
    .eq('id', orderId)
    .single(), supabase.rpc('admin_get_order_fulfillment', { p_order_id: orderId })]);
    if (request !== detailRequest) return;
    if (orderResult.error) throw orderResult.error;
    if (fulfillmentResult.error) throw fulfillmentResult.error;
    order = orderResult.data;
    fulfillment = fulfillmentResult.data;
    if (!order || !fulfillment?.ok || fulfillment.order_id !== orderId) throw new Error('未能取得订单的完整审核信息');
  } catch (error) {
    toast('加载失败', error.message, 'err');
    return;
  }

  const items = order.order_items || [];
  const proofs = order.payment_proofs || [];

  // ★ Amount mismatch detection
  const orderAmount = Number(order.total_amount_cny) || 0;

  let proofHtml = '<div class="muted" style="color:#ef4444;font-weight:600">⚠ 无凭证 — 该订单尚未上传任何支付凭证！</div>';
  if (proofs.length) {
    proofHtml = proofs.map(p => {
      const proofAmount = Number(p.amount_cny) || 0;
      const mismatch = proofAmount !== orderAmount;
      const mismatchStyle = mismatch ? 'color:#ef4444;font-weight:600' : 'color:#22c55e';
      const mismatchIcon = mismatch ? '⚠' : '✓';
      const proofCheck = fulfillment.proof_checks?.find(check => check.id === p.id);
      return `
      <div class="card soft" style="padding:12px;margin-bottom:8px${mismatch ? ';border:2px solid #ef4444' : ''}">
        <div>渠道: ${esc(p.channel || '—')} | 付款人: ${esc(p.payer_name || '—')}</div>
        <div style="${mismatchStyle};margin:4px 0">
          ${mismatchIcon} 凭证金额: ¥${esc(String(p.amount_cny ?? '—'))} vs 订单金额: ¥${esc(String(orderAmount))}
          ${mismatch ? ' — 金额不一致！请仔细核对' : ' — 金额一致'}
        </div>
        <div class="small muted">流水后4位: ${esc(p.transfer_ref_last4 || '—')} | 提交: ${esc(formatBeijingDateTime(p.submitted_at))}</div>
        <div class="small">服务端凭证校验：${proofCheck?.valid === true ? '通过' : esc(reviewMessage(proofCheck?.reason || '未通过'))}</div>
        ${p.proof_bucket && p.proof_path ? `<button class="btn tiny" data-view-proof="${p.id}" data-bucket="${esc(p.proof_bucket)}" data-path="${esc(p.proof_path)}" type="button" style="margin-top:6px">查看凭证图</button>` : ''}
      </div>`;
    }).join('');
  }

  const body = `
    <div class="grid cols-2" style="gap:8px;margin-bottom:12px">
      <div><span class="small muted">订单号</span><br/><code>${esc(order.order_no)}</code></div>
      <div><span class="small muted">状态</span><br/>${statusLabel(order.status)}</div>
      <div><span class="small muted">金额</span><br/><b>¥${esc(String(order.total_amount_cny))}</b></div>
      <div><span class="small muted">渠道</span><br/>${esc(order.channel || '—')}</div>
      <div><span class="small muted">用户ID</span><br/><code class="small">${esc(order.user_id)}</code></div>
      <div><span class="small muted">创建时间</span><br/>${esc(formatBeijingDateTime(order.created_at))}</div>
    </div>
    ${(order.contact_wechat || order.contact_phone || order.contact_email) ? `
    <div style="padding:10px 12px;background:rgba(59,130,246,.08);border-radius:8px;margin-bottom:12px">
      <span class="small" style="font-weight:600">📱 联系方式</span>
      <div class="small" style="margin-top:4px">
        ${order.contact_wechat ? `微信: <b>${esc(order.contact_wechat)}</b>` : ''}
        ${order.contact_phone ? `${order.contact_wechat ? ' | ' : ''}手机: <b>${esc(order.contact_phone)}</b>` : ''}
        ${order.contact_email ? `${(order.contact_wechat || order.contact_phone) ? ' | ' : ''}邮箱: <b>${esc(order.contact_email)}</b>` : ''}
      </div>
    </div>` : ''}
    <h4>订单商品 (${items.length})</h4>
    ${items.length ? items.map(i => `<div class="small" style="padding:4px 0">${esc(i.product_title)} × ${i.quantity} = ¥${esc(String(i.amount_cny))}</div>`).join('') : '<div class="muted">无</div>'}
    <div class="hr"></div>
    <h4>审核后归属与权限</h4>
    ${fulfillmentItemsHtml(fulfillment.items)}
    ${fulfillment.mapping_status !== 'ready' ? `<div class="note">审核校验提示：${esc((fulfillment.blockers || []).map(reviewMessage).join('；') || '项目归属校验未通过')}</div>` : ''}
    <div class="hr"></div>
    <h4>支付凭证 (${proofs.length})</h4>
    ${proofHtml}
    ${order.remark ? `<div class="hr"></div><div class="small muted">备注: ${esc(order.remark)}</div>` : ''}
  `;

  // ★ Review checklist for pending orders
  const isPending = (order.status === 'pending_review' || order.status === 'pending_payment');
  const checklistHtml = isPending ? `
    <div class="hr"></div>
    <h4>审核清单</h4>
    <div style="padding:10px 12px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:8px;margin-bottom:8px">
      <label class="small" style="display:block;margin:4px 0;cursor:pointer">
        <input type="checkbox" class="review-check" id="reviewPaymentReceived" /> 已核对收款账户流水，确认款项实际到账
      </label>
      <label class="small" style="display:block;margin:4px 0;cursor:pointer">
        <input type="checkbox" class="review-check" /> 凭证金额与订单金额一致 (¥${esc(String(orderAmount))})
      </label>
      <label class="small" style="display:block;margin:4px 0;cursor:pointer">
        <input type="checkbox" class="review-check" /> 已查看凭证，收款方为本平台账户且付款记录真实有效
      </label>
      <label class="small" style="display:block;margin:4px 0;cursor:pointer">
        <input type="checkbox" class="review-check" /> 已核对上方商品、项目、班期及权限期限与本次购买一致
      </label>
    </div>
  ` : '';

  const isRejected = order.status === 'rejected';
  const isApproved = order.status === 'approved';
  const issue = enrollmentIssues.get(orderId);
  const repairAllowed = canRepairEnrollment(order, fulfillment, issue);
  const repairHtml = isApproved && issue ? `<div class="hr"></div><h4>报名异常修复</h4>
    <div class="note">${esc(reviewMessage(issue.issue_code))}。${repairAllowed ? '依据已批准订单的现有有效权益补齐缺失报名，保留原审核日期和已有权益期限。' : '当前归属不能安全修复，请先核实异常原因。'}</div>
    ${repairAllowed ? fulfillmentItemsHtml(issue.items.filter(item => item.repair_required).map(item => ({ ...fulfillment.items.find(current => current.order_item_id === item.order_item_id), ...item }))) : ''}
    ${repairAllowed ? '<label class="small"><input type="checkbox" id="repairConfirmed" /> 已确认上述项目和班期为本订单的正确归属</label>' : ''}` : '';
  const footer = isPending ? `
    <button class="btn primary" id="modalApprove" type="button" disabled title="请先完成审核清单">通过</button>
    <button class="btn danger" id="modalReject" type="button">驳回</button>
  ` : isRejected ? `
    <button class="btn primary" id="modalRevertReject" type="button">撤回驳回（恢复待审核）</button>
  ` : isApproved ? `
    ${repairAllowed ? '<button class="btn primary" id="modalRepairEnrollment" type="button" disabled>补齐缺失报名</button>' : ''}
    <button class="btn danger" id="modalRevokeApproval" type="button">撤销通过（恢复待审核）</button>
  ` : '';

  showModal(`订单详情 ${esc(order.order_no)}`, body + checklistHtml + repairHtml, footer);

  // ★ Bind checklist: enable approve button only when all checked
  if (isPending) {
    const modalBody = document.getElementById('modalBody');
    const approveBtn = document.getElementById('modalApprove');
    if (modalBody && approveBtn) {
      modalBody.addEventListener('change', () => {
        const checks = modalBody.querySelectorAll('.review-check');
        const state = reviewApprovalState(order, fulfillment, [...checks].map(check => check.checked));
        approveBtn.disabled = !state.allowed || reviewRequests.has(orderId);
        approveBtn.title = state.reason;
      });
    }
  }

  // Bind proof view
  document.getElementById('modalBody')?.addEventListener('click', async e => {
    const btn = e.target.closest('button[data-view-proof]');
    if (!btn) return;
    const bucket = btn.dataset.bucket;
    const path = btn.dataset.path;
    try {
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 600);
      if (error) throw error;
      window.open(data.signedUrl, '_blank');
    } catch (err) {
      toast('查看失败', err.message, 'err');
    }
  });

  // Bind approve/reject in modal
  document.getElementById('modalApprove')?.addEventListener('click', async () => {
    const checks = [...document.querySelectorAll('#modalBody .review-check')].map(check => check.checked);
    await approveOrder(order, fulfillment, checks);
  });
  document.getElementById('repairConfirmed')?.addEventListener('change', event => {
    document.getElementById('modalRepairEnrollment').disabled = !event.target.checked || reviewRequests.has(orderId);
  });
  document.getElementById('modalRepairEnrollment')?.addEventListener('click', () => {
    if (repairAllowed && document.getElementById('repairConfirmed')?.checked) repairOrderEnrollment(orderId);
  });
  document.getElementById('modalReject')?.addEventListener('click', async () => {
    const note = prompt('驳回原因（可选）:');
    if (note === null) return;
    if (await rejectOrder(orderId, note)) closeModal();
  });

  document.getElementById('modalRevertReject')?.addEventListener('click', async () => {
    if (!confirm('确定撤回驳回？订单将恢复为「待审核」状态。')) return;
    if (await revertRejection(orderId)) closeModal();
  });

  document.getElementById('modalRevokeApproval')?.addEventListener('click', async () => {
    const note = prompt('撤销原因（可选）:');
    if (note === null) return; // user cancelled prompt
    if (await revokeApproval(orderId, note)) closeModal();
  });
}

async function approveOrder(order, fulfillment, checks) {
  const state = reviewApprovalState(order, fulfillment, checks);
  if (!state.allowed) { toast('暂不能通过审核', state.reason, 'err'); return; }
  const orderId = order.id;
  if (reviewRequests.has(orderId)) return;
  reviewRequests.add(orderId);
  const button = document.getElementById('modalApprove');
  if (button) button.disabled = true;
  try {
    const { data, error } = await supabase.rpc('admin_approve_order_verified', {
      p_order_id: orderId,
      p_payment_received: checks[0] === true,
      p_review_fingerprint: fulfillment.review_fingerprint,
      p_note: null,
    });
    if (error) throw error;
    if (data?.ok !== true) throw new Error('服务端未确认审核完成，请刷新订单状态后重试');
    toast(data.already_approved ? '订单已通过' : '已通过', data.already_approved ? '此订单已完成审核，无需重复发放。' : '已按订单归属发放权益，并建立所需项目报名。', 'ok');
    closeModal();
    await loadOrders();
  } catch (err) {
    toast('审核失败', `${err.message}。如审核信息发生变化，请重新打开详情核对。`, 'err');
  } finally {
    reviewRequests.delete(orderId);
    if (button?.isConnected) {
      const currentChecks = [...document.querySelectorAll('#modalBody .review-check')].map(check => check.checked);
      button.disabled = !reviewApprovalState(order, fulfillment, currentChecks).allowed;
    }
  }
}

async function repairOrderEnrollment(orderId) {
  if (reviewRequests.has(orderId)) return;
  reviewRequests.add(orderId);
  const button = document.getElementById('modalRepairEnrollment');
  if (button) button.disabled = true;
  try {
    const { data, error } = await supabase.rpc('admin_repair_order_enrollment', {
      p_order_id: orderId, p_note: '管理员核对订单归属后补齐缺失报名',
    });
    if (error) throw error;
    if (data?.ok !== true) throw new Error('服务端未确认修复完成，请刷新后核实');
    toast('报名已核实', data.already_complete ? '报名已齐全，无需重复修复。' : `已补齐 ${data.repaired_count ?? 0} 条报名，保留原权益期限。`, 'ok');
    closeModal();
    await loadOrders();
  } catch (error) {
    toast('修复失败', error.message, 'err');
  } finally {
    reviewRequests.delete(orderId);
    if (button?.isConnected) button.disabled = !document.getElementById('repairConfirmed')?.checked;
  }
}

async function runOrderAction(orderId, rpcName, note, successTitle, successMessage, refresh = true) {
  if (reviewRequests.has(orderId)) return false;
  reviewRequests.add(orderId);
  try {
    const { data, error } = await supabase.rpc(rpcName, {
      p_order_id: orderId, p_note: note || null,
    });
    if (error) throw error;
    if (data?.ok !== true) throw new Error('服务端未确认操作完成，请刷新订单状态');
    if (refresh) {
      toast(successTitle, successMessage, 'ok');
      await loadOrders();
    }
    return true;
  } catch (error) {
    toast('订单操作失败', error.message, 'err');
    return false;
  } finally {
    reviewRequests.delete(orderId);
  }
}

async function rejectOrder(orderId, note) {
  return runOrderAction(orderId, 'admin_reject_order', note, '已驳回', '订单已驳回，关联权益和报名已同步处理。');
}

async function revertRejection(orderId) {
  return runOrderAction(orderId, 'admin_revert_rejection', null, '已撤回', '订单已恢复为待审核状态。');
}

async function revokeApproval(orderId, note) {
  if (!confirm('确定撤销通过？将同步撤销该订单关联权益和报名，订单恢复为「待审核」状态。已撤销权益的订单需另行核实，不能直接再次通过来恢复权益。')) return false;
  return runOrderAction(orderId, 'admin_revoke_order_approval', note, '已撤销', '订单已恢复待审核，关联权益和报名已同步撤销。');
}

const NO_PROOF_REJECT_REASON = '未上传付款凭证';

async function rejectNoProofOrder(orderId, orderNo) {
  if (!confirm(`确定驳回订单 ${orderNo}？理由：${NO_PROOF_REJECT_REASON}。将同步撤销该订单关联权益和报名。`)) return;
  await rejectOrder(orderId, NO_PROOF_REJECT_REASON);
}

let batchRejecting = false;
async function batchRejectNoProofOrders() {
  if (batchRejecting) return;
  const approvedOrders = (window._noProofOrders || []).filter(row => row.status === 'approved');
  if (!approvedOrders.length) { toast('无数据', '没有需要驳回的订单。', 'err'); return; }
  if (!confirm(`确定批量驳回 ${approvedOrders.length} 个无凭证订单？将逐单同步撤销关联权益和报名。`)) return;
  batchRejecting = true;
  const button = document.getElementById('batchRejectBtn');
  if (button) button.disabled = true;
  let rejected = 0;
  try {
    for (const order of approvedOrders) {
      if (await runOrderAction(order.id, 'admin_reject_order', NO_PROOF_REJECT_REASON, '', '', false)) rejected++;
    }
    const failed = approvedOrders.length - rejected;
    toast('批量驳回完成', `已驳回 ${rejected} 个订单${failed ? `，${failed} 个未完成，请刷新核实` : ''}。`, failed ? 'err' : 'ok');
    await loadOrders();
  } finally {
    batchRejecting = false;
    if (button?.isConnected) button.disabled = false;
  }
}

function bindEvents() {
  const wrap = document.getElementById('ordersTableWrap');
  wrap?.addEventListener('click', e => {
    const batchBtn = e.target.closest('#batchRejectBtn');
    if (batchBtn) { batchRejectNoProofOrders(); return; }

    const rejectNP = e.target.closest('button[data-reject-noproof]');
    if (rejectNP) { rejectNoProofOrder(rejectNP.dataset.rejectNoproof, rejectNP.dataset.orderNo); return; }

    const detail = e.target.closest('button[data-detail]');
    if (detail) { showOrderDetail(detail.dataset.detail); return; }

    const reject = e.target.closest('button[data-reject]');
    if (reject) {
      const note = prompt('驳回原因（可选）:');
      if (note === null) return;
      rejectOrder(reject.dataset.reject, note);
    }
  });

  document.getElementById('refreshOrders')?.addEventListener('click', loadOrders);
  document.getElementById('orderFilterStatus')?.addEventListener('change', () => { issueOffset = 0; loadOrders(); });
}

export function init() {
  bindEvents();
  loadOrders();
}
