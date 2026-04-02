/**
 * admin-commerce-orders.js — 订单审核模块
 */
import {
  supabase, toast, formatBeijingDateTime,
} from './supabaseClient.js?v=20260401_fix';
import { esc, statusDot, badge, showModal, closeModal } from './admin-commerce.js?v=20260325_002';

const STATUS_MAP = {
  pending_payment: { label: '待付款', dot: 'yellow' },
  pending_review:  { label: '待审核', dot: 'yellow' },
  approved:        { label: '已通过', dot: 'green' },
  rejected:        { label: '已驳回', dot: 'red' },
  cancelled:       { label: '已取消', dot: 'gray' },
  refunded:        { label: '已退款', dot: 'gray' },
};

function statusLabel(s) {
  const m = STATUS_MAP[s] || { label: s, dot: 'gray' };
  return `${statusDot(m.dot)}${esc(m.label)}`;
}

async function loadOrders() {
  const wrap = document.getElementById('ordersTableWrap');
  if (!wrap) return;

  const filter = document.getElementById('orderFilterStatus')?.value || 'pending_all';

  let q = supabase
    .from('orders')
    .select(`
      id, order_no, user_id, total_amount_cny, status, channel,
      contact_wechat, contact_phone, contact_email,
      remark, created_at, paid_at, approved_at,
      order_items ( id, product_title, quantity, unit_price_cny, amount_cny ),
      payment_proofs ( id, channel, amount_cny, proof_image_url, proof_bucket, proof_path, submitted_at, payer_name, transfer_ref_last4 )
    `)
    .order('created_at', { ascending: false })
    .limit(100);

  if (filter === 'approved_no_proof') {
    q = q.in('status', ['approved', 'rejected']);
  } else if (filter === 'pending_all') {
    q = q.in('status', ['pending_payment', 'pending_review']);
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
        payment_proofs ( id, channel, amount_cny, proof_image_url, proof_bucket, proof_path, submitted_at, payer_name, transfer_ref_last4 )
      `)
      .order('created_at', { ascending: false })
      .limit(100);
    if (filter === 'approved_no_proof') {
      q2 = q2.in('status', ['approved', 'rejected']);
    } else if (filter === 'pending_all') {
      q2 = q2.in('status', ['pending_payment', 'pending_review']);
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
    wrap.innerHTML = '<div class="muted">没有符合条件的订单。</div>';
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
    ${warningBanner}
    <table class="data-table">
      <thead><tr>
        <th>订单号</th>${isNoProof ? '<th>用户</th>' : ''}<th>金额</th><th>渠道</th><th>联系方式</th><th>状态</th><th>创建时间</th><th>操作</th>
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
          return `
          <tr${isDone ? ' style="opacity:0.5"' : ''}>
            <td><code>${esc(r.order_no)}</code></td>
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
                <button class="btn tiny primary" data-approve="${r.id}" type="button">通过</button>
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

async function showOrderDetail(orderId) {
  const { data: order, error } = await supabase
    .from('orders')
    .select(`
      *, order_items(*), payment_proofs(*)
    `)
    .eq('id', orderId)
    .single();

  if (error || !order) {
    toast('加载失败', error?.message || '未找到订单', 'err');
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
      return `
      <div class="card soft" style="padding:12px;margin-bottom:8px${mismatch ? ';border:2px solid #ef4444' : ''}">
        <div>渠道: ${esc(p.channel || '—')} | 付款人: ${esc(p.payer_name || '—')}</div>
        <div style="${mismatchStyle};margin:4px 0">
          ${mismatchIcon} 凭证金额: ¥${esc(String(p.amount_cny ?? '—'))} vs 订单金额: ¥${esc(String(orderAmount))}
          ${mismatch ? ' — 金额不一致！请仔细核对' : ' — 金额一致'}
        </div>
        <div class="small muted">流水后4位: ${esc(p.transfer_ref_last4 || '—')} | 提交: ${esc(formatBeijingDateTime(p.submitted_at))}</div>
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
        <input type="checkbox" class="review-check" /> 已查看凭证截图，确认为真实支付记录
      </label>
      <label class="small" style="display:block;margin:4px 0;cursor:pointer">
        <input type="checkbox" class="review-check" /> 凭证金额与订单金额一致 (¥${esc(String(orderAmount))})
      </label>
      <label class="small" style="display:block;margin:4px 0;cursor:pointer">
        <input type="checkbox" class="review-check" /> 收款方为本平台账户
      </label>
      <label class="small" style="display:block;margin:4px 0;cursor:pointer">
        <input type="checkbox" class="review-check" /> 付款时间合理（非过期截图）
      </label>
    </div>
  ` : '';

  const isRejected = order.status === 'rejected';
  const footer = isPending ? `
    <button class="btn primary" id="modalApprove" type="button" disabled title="请先完成审核清单">通过</button>
    <button class="btn danger" id="modalReject" type="button">驳回</button>
  ` : isRejected ? `
    <button class="btn primary" id="modalRevertReject" type="button">撤回驳回（恢复待审核）</button>
  ` : '';

  showModal(`订单详情 ${order.order_no}`, body + checklistHtml, footer);

  // ★ Bind checklist: enable approve button only when all checked
  if (isPending) {
    const modalBody = document.getElementById('modalBody');
    const approveBtn = document.getElementById('modalApprove');
    if (modalBody && approveBtn) {
      modalBody.addEventListener('change', () => {
        const checks = modalBody.querySelectorAll('.review-check');
        const allChecked = checks.length > 0 && [...checks].every(c => c.checked);
        approveBtn.disabled = !allChecked;
        approveBtn.title = allChecked ? '' : '请先完成审核清单';
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
    await approveOrder(orderId);
    closeModal();
  });
  document.getElementById('modalReject')?.addEventListener('click', async () => {
    const note = prompt('驳回原因（可选）:');
    await rejectOrder(orderId, note);
    closeModal();
  });

  document.getElementById('modalRevertReject')?.addEventListener('click', async () => {
    if (!confirm('确定撤回驳回？订单将恢复为「待审核」状态。')) return;
    await revertRejection(orderId);
    closeModal();
  });
}

async function approveOrder(orderId) {
  try {
    const { data, error } = await supabase.rpc('admin_approve_order', {
      p_order_id: orderId,
      p_note: null,
    });
    if (error) throw error;
    toast('已通过', '订单已审核通过，权益已自动发放。', 'ok');
    loadOrders();
  } catch (err) {
    toast('审核失败', err.message, 'err');
  }
}

async function rejectOrder(orderId, note) {
  try {
    const { data, error } = await supabase.rpc('admin_reject_order', {
      p_order_id: orderId,
      p_note: note || null,
    });
    if (error) throw error;
    toast('已驳回', '订单已驳回。', 'ok');
    loadOrders();
  } catch (err) {
    toast('驳回失败', err.message, 'err');
  }
}

async function revertRejection(orderId) {
  try {
    const { data, error } = await supabase.rpc('admin_revert_rejection', {
      p_order_id: orderId,
      p_note: null,
    });
    if (error) throw error;
    toast('已撤回', '订单已恢复为待审核状态。', 'ok');
    loadOrders();
  } catch (err) {
    toast('撤回失败', err.message, 'err');
  }
}

const NO_PROOF_REJECT_REASON = '未上传付款凭证';

async function rejectNoProofOrder(orderId, orderNo) {
  if (!confirm(`确定驳回订单 ${orderNo}？\n理由: ${NO_PROOF_REJECT_REASON}\n\n将同时撤销该订单关联的所有权益。`)) return;

  // 1. Revoke active entitlements
  const { data: ents } = await supabase
    .from('user_entitlements')
    .select('id')
    .eq('source_order_id', orderId)
    .eq('status', 'active');

  if (ents && ents.length) {
    const { error: revErr } = await supabase
      .from('user_entitlements')
      .update({ status: 'revoked' })
      .in('id', ents.map(e => e.id));
    if (revErr) {
      toast('撤销权益失败', revErr.message, 'err');
      return;
    }
  }

  // 2. Reject the order
  try {
    const { error } = await supabase.rpc('admin_reject_order', {
      p_order_id: orderId,
      p_note: NO_PROOF_REJECT_REASON,
    });
    if (error) throw error;
  } catch (err) {
    toast('驳回失败', err.message, 'err');
    return;
  }

  const entCount = ents?.length || 0;
  toast('已驳回', `订单 ${orderNo} 已驳回，${entCount ? `撤销 ${entCount} 条权益。` : '无关联权益。'}`, 'ok');
  loadOrders();
}

async function batchRejectNoProofOrders() {
  const orders = window._noProofOrders;
  if (!orders || !orders.length) {
    toast('无数据', '没有需要驳回的订单。', 'err');
    return;
  }

  // Only process orders still in approved status
  const approvedOrders = orders.filter(r => r.status === 'approved');
  if (!approvedOrders.length) {
    toast('已完成', '所有订单均已驳回。', 'ok');
    return;
  }

  const orderIds = approvedOrders.map(r => r.id);
  const msg = `确定批量驳回 ${approvedOrders.length} 个无凭证订单？\n理由: ${NO_PROOF_REJECT_REASON}\n\n将同时撤销所有关联权益，此操作不可撤销！`;
  if (!confirm(msg)) return;

  // 1. Batch revoke entitlements
  const { data: ents } = await supabase
    .from('user_entitlements')
    .select('id')
    .in('source_order_id', orderIds)
    .eq('status', 'active');

  if (ents && ents.length) {
    const { error: revErr } = await supabase
      .from('user_entitlements')
      .update({ status: 'revoked' })
      .in('id', ents.map(e => e.id));
    if (revErr) {
      toast('撤销权益失败', revErr.message, 'err');
      return;
    }
  }

  // 2. Reject each order
  let rejected = 0;
  for (const r of approvedOrders) {
    const { error } = await supabase.rpc('admin_reject_order', {
      p_order_id: r.id,
      p_note: NO_PROOF_REJECT_REASON,
    });
    if (!error) rejected++;
  }

  const entCount = ents?.length || 0;
  toast('批量驳回完成', `已驳回 ${rejected} 个订单，撤销 ${entCount} 条权益。`, 'ok');
  loadOrders();
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

    const approve = e.target.closest('button[data-approve]');
    if (approve) { approveOrder(approve.dataset.approve); return; }

    const reject = e.target.closest('button[data-reject]');
    if (reject) {
      const note = prompt('驳回原因（可选）:');
      rejectOrder(reject.dataset.reject, note);
    }
  });

  document.getElementById('refreshOrders')?.addEventListener('click', loadOrders);
  document.getElementById('orderFilterStatus')?.addEventListener('change', loadOrders);
}

export function init() {
  bindEvents();
  loadOrders();
}
