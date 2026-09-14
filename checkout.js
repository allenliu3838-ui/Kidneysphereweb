/**
 * checkout.js — 统一结账页逻辑
 * URL 参数: ?product=PRODUCT_CODE 或 ?product_id=UUID
 */
import {
  supabase, ensureSupabase, isConfigured,
  getCurrentUser, getUserProfile, toast, formatBeijingDateTime,
} from './supabaseClient.js?v=20260401_fix';
import { classifyTrainingProduct, isRetiredTrainingReplay, checkoutOrderSummary } from './training-commerce.js?v=20260914_pricing1';

/* ── helpers ── */
function esc(s) {
  return String(s ?? '').replace(/[&<>'"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

/* ── state ── */
let _user = null;
let _product = null;
let _order = null;
let _channel = 'wechat';
let _sysConfig = {};

/* ── DOM refs ── */
const gate = document.getElementById('checkoutGate');
const main = document.getElementById('checkoutMain');

function setStep(n) {
  [1, 2, 3].forEach(i => {
    const el = document.getElementById(`step${i}`);
    if (el) el.hidden = i !== n;
  });
  document.querySelectorAll('.step-indicator .step').forEach(s => {
    const si = parseInt(s.dataset.step);
    s.classList.toggle('active', si === n);
    s.classList.toggle('done', si < n);
  });
}

/* ── load existing order (for rejected / pending_payment resubmission) ── */
async function loadExistingOrder() {
  const params = new URLSearchParams(location.search);
  const orderId = params.get('order_id');
  if (!orderId) return false;

  const { data: order, error } = await supabase
    .from('orders')
    .select('id, user_id, order_no, total_amount_cny, status, channel, order_items(product_id, product_title, amount_cny, quantity)')
    .eq('id', orderId)
    .eq('user_id', _user.id)
    .single();

  if (error || !order) {
    gate.innerHTML = `<b>订单未找到。</b>${error ? esc(error.message) : '该订单不存在或不属于您。'}`;
    return false;
  }

  if (order.status !== 'pending_payment' && order.status !== 'rejected') {
    const labels = { pending_review: '待审核', approved: '已通过', cancelled: '已取消', refunded: '已退款' };
    gate.innerHTML = `<b>该订单${esc(labels[order.status] || '状态已改变')}。</b>请到 <a href="my-learning.html">我的学习</a> 查看进度，无需重复付款。`;
    return false;
  }

  try {
    _product = checkoutOrderSummary(order, _user.id);
  } catch (err) {
    gate.innerHTML = `<b>${esc(err.message)}</b>`;
    return false;
  }
  _order = { id: order.id, order_no: order.order_no, status: order.status };
  if (order.channel) _channel = order.channel;

  return true;
}

/* ── load product ── */
async function loadProduct() {
  const params = new URLSearchParams(location.search);
  const code = params.get('product');
  const pid = params.get('product_id');

  if (!code && !pid) {
    gate.innerHTML = '<b>缺少商品参数。</b>请从商品页面进入结算。';
    return false;
  }

  // Use RPC to avoid PostgREST schema-cache uuid cast issues
  const { data, error } = await supabase.rpc('get_product_for_checkout', {
    p_code: code || null,
    p_id: pid || null,
  });

  if (error) {
    gate.innerHTML = `<b>商品查询失败。</b>${esc(error.message)}`;
    return false;
  }
  if (!data) {
    gate.innerHTML = '<b>商品未找到。</b>该商品可能已下架或编码有误。';
    return false;
  }
  if (isRetiredTrainingReplay(data)) {
    gate.innerHTML = '<b>该回放版已停止销售。</b>请到 <a href="academy.html">肾域学院</a>选择培训报名或专科整套课。已购课程可在 <a href="my-learning.html">我的学习</a>中访问。';
    return false;
  }

  _product = data;
  return true;
}

/* ── load system config ── */
async function loadSysConfig() {
  try {
    const { data } = await supabase.rpc('get_system_config');
    _sysConfig = data || {};
  } catch { _sysConfig = {}; }
}

/* ── render order summary (step 1) ── */
function renderSummary() {
  const wrap = document.getElementById('orderSummary');
  if (!wrap || !_product) return;
  wrap.innerHTML = `
    <div class="line"><span>${esc(_product.title)}</span><span>¥${esc(String(_product.price_cny))}</span></div>
    ${_product.subtitle ? `<div class="small muted" style="padding:2px 0">${esc(_product.subtitle)}</div>` : ''}
    ${_product.list_price_cny && !classifyTrainingProduct(_product) ? `<div class="line small muted"><span>原价</span><span><s>¥${esc(String(_product.list_price_cny))}</s></span></div>` : ''}
    <div class="line total"><span>合计</span><span>¥${esc(String(_product.price_cny))}</span></div>
  `;
}

/* ── create order (step 1 → step 2) ── */
let _creatingOrder = false;
async function createOrder() {
  if (_creatingOrder) return;
  _creatingOrder = true;
  const btn = document.getElementById('btnConfirmOrder');
  btn.disabled = true;
  btn.textContent = '创建订单中…';

  try {
    // Use server-side RPC to create order (price is read from products table server-side, tamper-proof)
    const { data, error } = await supabase.rpc('create_order_with_items', {
      p_product_id: _product.id,
      p_channel: _channel,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.message || '创建订单失败');

    // The RPC can reuse an older pending order. Its stored amount is authoritative.
    const { data: storedOrder, error: orderError } = await supabase.from('orders')
      .select('id, user_id, order_no, total_amount_cny, status, channel, order_items(product_id, product_title, amount_cny, quantity)')
      .eq('id', data.order_id).eq('user_id', _user.id).single();
    if (orderError) throw orderError;
    if (storedOrder?.user_id === _user.id && storedOrder.id && storedOrder.order_no
        && ['pending_review', 'approved'].includes(storedOrder.status)
        && storedOrder.order_items?.length === 1
        && storedOrder.order_items[0].product_id === _product.id
        && storedOrder.order_items[0].quantity === 1) {
      _order = { id: storedOrder.id, order_no: storedOrder.order_no, status: storedOrder.status };
      showSubmissionDone(storedOrder.status);
      return;
    }
    const summary = checkoutOrderSummary(storedOrder, _user.id);
    if (storedOrder.order_items.length !== 1 || summary.id !== _product.id
        || storedOrder.order_items[0].quantity !== 1) {
      throw new Error('返回的订单与所选商品不一致，请在“我的学习”核对订单。');
    }
    _product = summary;
    _order = { id: storedOrder.id, order_no: storedOrder.order_no, status: storedOrder.status };
    if (storedOrder.channel) _channel = storedOrder.channel;
    document.getElementById('displayOrderNo').textContent = _order.order_no;
    renderSummary();
    toast('订单已确认', `订单号: ${_order.order_no}`, 'ok');
    showPayStep();
  } catch (err) {
    toast('创建订单失败', err.message, 'err');
    btn.disabled = false;
    btn.textContent = '确认并生成订单';
    _creatingOrder = false;
  }
}

/* ── show payment step ── */
function showPayStep() {
  const amount = document.getElementById('displayOrderAmount');
  if (amount) amount.textContent = `¥${Number(_product.price_cny).toFixed(2)}`;
  setStep(2);
  updatePayUI();
}

function showProofStep() {
  const amount = document.querySelector('[name="paid_amount"]');
  if (amount && !amount.value) amount.value = Number(_product.price_cny).toFixed(2);
  const notice = document.getElementById('proofOrderNotice');
  if (notice) notice.textContent = `订单 ${_order.order_no} · 应付 ¥${Number(_product.price_cny).toFixed(2)}。已付款的订单请补交凭证，无需重复付款。`;
  setStep(3);
}

function showSubmissionDone(status = 'pending_review') {
  [1, 2, 3].forEach(i => { document.getElementById(`step${i}`).hidden = true; });
  document.getElementById('stepDone').hidden = false;
  document.getElementById('doneOrderNo').textContent = _order.order_no;
  const approved = status === 'approved';
  document.getElementById('proofDoneTitle').textContent = approved ? '订单已审核通过' : '凭证已提交，等待核款';
  document.getElementById('proofDoneMessage').textContent = approved
    ? '请进入“我的学习”查看已开通课程和项目。'
    : '管理员核实到账后，会自动开通所购权益。无需重复付款或重复上传。';
  document.querySelectorAll('.step-indicator .step').forEach(s => s.classList.add('done'));
}

function updatePayUI() {
  document.getElementById('payWechat').classList.toggle('selected', _channel === 'wechat');
  document.getElementById('payAlipay').classList.toggle('selected', _channel === 'alipay');
  document.getElementById('payBank').classList.toggle('selected', _channel === 'bank_transfer');

  const qrBox = document.getElementById('qrBox');
  const bankInfo = document.getElementById('bankInfo');
  const qrImg = document.getElementById('payQrImg');

  if (_channel === 'bank_transfer') {
    qrBox.hidden = true;
    bankInfo.hidden = false;
    document.getElementById('bankName').textContent = _sysConfig.bank_name || '—';
    document.getElementById('bankAccount').textContent = _sysConfig.bank_account || '—';
    document.getElementById('bankAccountName').textContent = _sysConfig.bank_account_name || '—';
  } else {
    qrBox.hidden = false;
    bankInfo.hidden = true;
    const src = _channel === 'wechat'
      ? (_sysConfig.wechat_pay_qr_url || '')
      : (_sysConfig.alipay_pay_qr_url || '');
    if (src) {
      qrImg.src = src;
      qrImg.hidden = false;
      qrBox.querySelector('p').textContent = '请扫描二维码完成支付';
    } else {
      qrImg.hidden = true;
      qrBox.querySelector('p').textContent = '当前支付方式暂不可用，请联系 china@kidneysphere.com 咨询。';
    }
  }

  const notice = document.getElementById('paymentNotice');
  notice.textContent = _sysConfig.payment_notice || '请在付款备注中填写您的订单号。';
}

/* ── compute SHA-256 hash of a File ── */
async function hashFile(file) {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ── upload proof (step 3) ── */
let _submittingProof = false;
let _proofUpload = null;
async function submitProof(e) {
  e.preventDefault();
  if (_submittingProof) return;
  _submittingProof = true;
  const form = document.getElementById('proofForm');
  const hint = document.getElementById('proofHint');
  const button = form.querySelector('button[type="submit"]');
  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = '提交中…';
  try {
    const fd = new FormData(form);
    const file = fd.get('proof');
    if (!(file instanceof File) || !file.size) throw new Error('请选择支付截图或 PDF。');
    const ext = file.name.split('.').pop()?.toLowerCase();
    const types = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
    if (!types[ext] || (file.type && file.type !== types[ext])) throw new Error('请上传 JPG、PNG、WebP 图片或 PDF。');
    if (file.size > 10 * 1024 * 1024) throw new Error('凭证文件不能超过 10 MB。');
    if (!_order?.id || !_user?.id) throw new Error('订单信息已失效，请重新打开本订单。');

    const contactWechat = String(fd.get('contact_wechat') || '').trim();
    const contactPhone = String(fd.get('contact_phone') || '').trim();
    const contactEmail = String(fd.get('contact_email') || '').trim();
    const contactHint = document.getElementById('contactHint');
    if (contactHint) contactHint.style.display = contactWechat || contactPhone || contactEmail ? 'none' : 'block';
    if (!contactWechat && !contactPhone && !contactEmail) throw new Error('请至少填写一种联系方式。');
    const rawAmount = String(fd.get('paid_amount') || '').trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(rawAmount)) throw new Error('请填写实际付款金额，最多两位小数。');
    const paidAmount = Number(rawAmount);
    if (!Number.isFinite(paidAmount) || paidAmount <= 0
        || Math.round(paidAmount * 100) !== Math.round(Number(_product.price_cny) * 100)) {
      throw new Error(`实际付款金额应与本订单应付 ¥${Number(_product.price_cny).toFixed(2)} 一致；如有差额请先联系管理员核对。`);
    }

    hint.textContent = '正在校验凭证…';
    const fileHash = await hashFile(file);
    const uploadKey = `${_user.id}:${_order.id}:${fileHash}`;
    if (_proofUpload?.key !== uploadKey) {
      hint.textContent = '正在上传凭证…';
      const path = `${_user.id}/${_order.id}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('payment_proofs').upload(path, file, {
        upsert: false, contentType: types[ext],
      });
      if (upErr) throw upErr;
      // Reuse the uploaded object if the following atomic request is interrupted.
      _proofUpload = { key: uploadKey, path, fileHash };
    }

    hint.textContent = '正在提交审核…';
    const { data, error } = await supabase.rpc('submit_payment_proof', {
      p_order_id: _order.id,
      p_channel: _channel,
      p_amount_cny: paidAmount,
      p_proof_path: _proofUpload.path,
      p_file_hash: fileHash,
      p_payer_name: String(fd.get('payer_name') || '').trim() || null,
      p_transfer_ref_last4: String(fd.get('ref_last4') || '').trim() || null,
      p_contact_wechat: contactWechat || null,
      p_contact_phone: contactPhone || null,
      p_contact_email: contactEmail || null,
      p_note: String(fd.get('note') || '').trim() || null,
    });
    if (error) throw error;
    if (data?.ok !== true || !['pending_review', 'approved'].includes(data.status)) {
      throw new Error(data?.message || '未能确认提交结果，请重试或在“我的学习”查看订单状态。');
    }
    _proofUpload = null;
    showSubmissionDone(data.status);
    toast(data.status === 'approved' ? '订单已通过' : '已提交',
      data.status === 'approved' ? '请进入“我的学习”查看已开通权益。' : '管理员核实到账后开通所购权益。', 'ok');
    void loadMyOrders().catch(() => {});
  } catch (err) {
    hint.textContent = `未完成提交：${err.message} 可修改后重试，无需再次付款。`;
    toast('提交未完成', err.message, 'err');
  } finally {
    _submittingProof = false;
    button.disabled = false;
    button.textContent = previousText;
  }
}

/* ── my orders list ── */
async function loadMyOrders() {
  const card = document.getElementById('myOrdersCard');
  const wrap = document.getElementById('myOrdersList');
  if (!card || !wrap || !_user) return;
  card.hidden = false;

  const { data, error } = await supabase
    .from('orders')
    .select('id, order_no, total_amount_cny, status, channel, remark, created_at, order_items(product_title)')
    .eq('user_id', _user.id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    wrap.innerHTML = `<div class="note">${esc(error.message)}</div>`;
    return;
  }

  const rows = data || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="muted">暂无订单。</div>';
    return;
  }

  const STATUS_ZH = {
    pending_payment: '待付款', pending_review: '待审核',
    approved: '已通过', rejected: '已驳回',
    cancelled: '已取消', refunded: '已退款',
  };

  wrap.innerHTML = rows.map(r => {
    const items = Array.isArray(r.order_items) ? r.order_items : [];
    const productName = items.map(i => i.product_title).filter(Boolean).join('、') || '—';
    const rejectReason = (r.status === 'rejected' && r.remark)
      ? `<div class="small" style="color:#f87171;margin-top:4px">驳回原因：${esc(r.remark)}</div>` : '';
    const resubmitBtn = (r.status === 'rejected')
      ? `<a class="btn tiny primary" href="checkout.html?order_id=${r.id}" style="margin-top:6px">重新提交凭证</a>` : '';
    return `
    <div class="card soft" style="padding:10px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
      <div>
        <div><b class="small">${esc(productName)}</b></div>
        <code class="small muted">${esc(r.order_no)}</code>
        <span class="small muted" style="margin-left:8px">${esc(formatBeijingDateTime(r.created_at))}</span>
        ${rejectReason}
        ${resubmitBtn}
      </div>
      <div>
        <b>¥${esc(String(r.total_amount_cny))}</b>
        <span class="badge" style="margin-left:8px">${esc(STATUS_ZH[r.status] || r.status)}</span>
      </div>
    </div>`;
  }).join('');
}

/* ── init ── */
async function init() {
  if (isConfigured() && !supabase) await ensureSupabase();
  if (!isConfigured() || !supabase) {
    gate.innerHTML = '<b>演示模式：</b>未配置 Supabase。';
    return;
  }

  _user = await getCurrentUser();
  if (!_user) {
    const next = encodeURIComponent(location.pathname + location.search);
    gate.innerHTML = `请先 <a href="login.html?next=${next}">登录</a> 再进行结算。`;
    return;
  }

  // Check if resuming an existing order (rejected / pending_payment)
  const params = new URLSearchParams(location.search);
  const hasOrderId = !!params.get('order_id');

  if (hasOrderId) {
    const [orderOk] = await Promise.all([loadExistingOrder(), loadSysConfig()]);
    if (!orderOk) return;

    gate.hidden = true;
    main.hidden = false;
    const trustInfo = document.getElementById('checkoutTrustInfo');
    if (trustInfo) trustInfo.hidden = true;

    renderSummary();
    // Resume the saved order; rejected receipts go straight to proof correction.
    document.getElementById('displayOrderNo').textContent = _order.order_no;
    if (_order.status === 'rejected') showProofStep();
    else showPayStep();
  } else {
    // Normal flow: load product and create new order
    const [productOk] = await Promise.all([loadProduct(), loadSysConfig()]);
    if (!productOk) return;

    gate.hidden = true;
    main.hidden = false;
    const trustInfo = document.getElementById('checkoutTrustInfo');
    if (trustInfo) trustInfo.hidden = true;

    renderSummary();
    setStep(1);
  }

  // Bind events
  document.getElementById('btnConfirmOrder').addEventListener('click', createOrder);

  document.getElementById('payWechat').addEventListener('click', () => { _channel = 'wechat'; updatePayUI(); });
  document.getElementById('payAlipay').addEventListener('click', () => { _channel = 'alipay'; updatePayUI(); });
  document.getElementById('payBank').addEventListener('click', () => { _channel = 'bank_transfer'; updatePayUI(); });

  document.getElementById('btnGoUpload').addEventListener('click', showProofStep);

  document.getElementById('proofForm').addEventListener('submit', submitProof);

  document.getElementById('refreshMyOrders')?.addEventListener('click', loadMyOrders);

  loadMyOrders();
}

init();
