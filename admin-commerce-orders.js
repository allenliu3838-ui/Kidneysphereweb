/**
 * admin-commerce-orders.js — 订单审核模块
 */
import {
  supabase, toast, formatBeijingDateTime,
} from './supabaseClient.js?v=20260322_001';
import { esc, statusDot, badge, showModal, closeModal } from './admin-commerce.js?v=20260322_001';

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

  const filter = document.getElementById('orderFilterStatus')?.value || 'pending_review';

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

  if (filter !== 'all') q = q.eq('status', filter);

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
    if (filter !== 'all') q2 = q2.eq('status', filter);
    const r2 = await q2;
    data = r2.data;
    error = r2.error;
  }
  if (error) {
    wrap.innerHTML = `<div class="note">${esc(error.message)}</div>`;
    return;
  }

  const rows = data || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="muted">没有符合条件的订单。</div>';
    return;
  }

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>订单号</th><th>金额</th><th>渠道</th><th>联系方式</th><th>状态</th><th>创建时间</th><th>操作</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td><code>${esc(r.order_no)}</code></td>
            <td><b>¥${esc(String(r.total_amount_cny ?? 0))}</b></td>
            <td>${esc(r.channel || '—')}</td>
            <td class="small">${esc(r.contact_wechat || r.contact_phone || r.contact_email || '—')}</td>
            <td>${statusLabel(r.status)}</td>
            <td class="small">${esc(formatBeijingDateTime(r.created_at))}</td>
            <td>
              <button class="btn tiny" data-detail="${r.id}" type="button">详情</button>
              ${r.status === 'pending_review' ? `
                <button class="btn tiny primary" data-approve="${r.id}" type="button">通过</button>
                <button class="btn tiny danger" data-reject="${r.id}" type="button">驳回</button>
              ` : ''}
            </td>
          </tr>
        `).join('')}
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

  let proofHtml = '<div class="muted">无凭证</div>';
  if (proofs.length) {
    proofHtml = proofs.map(p => `
      <div class="card soft" style="padding:12px;margin-bottom:8px">
        <div>渠道: ${esc(p.channel || '—')} | 金额: ¥${esc(String(p.amount_cny ?? '—'))} | 付款人: ${esc(p.payer_name || '—')}</div>
        <div class="small muted">流水后4位: ${esc(p.transfer_ref_last4 || '—')} | 提交: ${esc(formatBeijingDateTime(p.submitted_at))}</div>
        ${p.proof_bucket && p.proof_path ? `<button class="btn tiny" data-view-proof="${p.id}" data-bucket="${esc(p.proof_bucket)}" data-path="${esc(p.proof_path)}" type="button" style="margin-top:6px">查看凭证图</button>` : ''}
      </div>
    `).join('');
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

  const footer = order.status === 'pending_review' ? `
    <button class="btn primary" id="modalApprove" type="button">通过</button>
    <button class="btn danger" id="modalReject" type="button">驳回</button>
  ` : '';

  showModal(`订单详情 ${order.order_no}`, body, footer);

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

function bindEvents() {
  const wrap = document.getElementById('ordersTableWrap');
  wrap?.addEventListener('click', e => {
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
