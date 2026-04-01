/**
 * checkout.js — 统一结账页逻辑
 * URL 参数: ?product=PRODUCT_CODE 或 ?product_id=UUID
 */
import {
  supabase, ensureSupabase, isConfigured,
  getCurrentUser, getUserProfile, toast, formatBeijingDateTime,
} from './supabaseClient.js?v=20260322_001';

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
    ${_product.list_price_cny ? `<div class="line small muted"><span>原价</span><span><s>¥${esc(String(_product.list_price_cny))}</s></span></div>` : ''}
    <div class="line total"><span>合计</span><span>¥${esc(String(_product.price_cny))}</span></div>
  `;
}

/* ── create order (step 1 → step 2) ── */
async function createOrder() {
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

    _order = { id: data.order_id, order_no: data.order_no };
    document.getElementById('displayOrderNo').textContent = data.order_no;
    toast('订单已创建', `订单号: ${data.order_no}`, 'ok');
    showPayStep();
  } catch (err) {
    toast('创建订单失败', err.message, 'err');
    btn.disabled = false;
    btn.textContent = '确认并生成订单';
  }
}

/* ── show payment step ── */
function showPayStep() {
  setStep(2);
  updatePayUI();
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
async function submitProof(e) {
  e.preventDefault();
  const form = document.getElementById('proofForm');
  const hint = document.getElementById('proofHint');
  const fd = new FormData(form);
  const file = fd.get('proof');

  if (!(file instanceof File) || !file.size) {
    hint.textContent = '请选择支付截图。';
    return;
  }

  // Validate at least one contact method
  const contactWechat = fd.get('contact_wechat')?.trim() || '';
  const contactPhone = fd.get('contact_phone')?.trim() || '';
  const contactEmail = fd.get('contact_email')?.trim() || '';
  const contactHint = document.getElementById('contactHint');
  if (!contactWechat && !contactPhone && !contactEmail) {
    if (contactHint) contactHint.style.display = 'block';
    hint.textContent = '请至少填写一种联系方式。';
    return;
  }
  if (contactHint) contactHint.style.display = 'none';

  hint.textContent = '正在校验凭证…';

  // Compute file hash and check for duplicate proofs
  let fileHash = null;
  try {
    fileHash = await hashFile(file);
    const { data: dupCheck } = await supabase.rpc('check_proof_duplicate', { p_file_hash: fileHash });
    if (dupCheck?.duplicate) {
      hint.textContent = dupCheck.message || '该凭证图片已被使用过，请上传新的凭证。';
      toast('凭证重复', dupCheck.message, 'err');
      return;
    }
  } catch { /* hash check is best-effort, continue if it fails */ }

  hint.textContent = '上传中…';

  const bucket = 'payment_proofs';
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'proof';
  const path = `${_user.id}/${Date.now()}_${safeName}`;

  try {
    const { error: upErr } = await supabase.storage.from(bucket).upload(path, file, {
      upsert: true,
      contentType: file.type || undefined,
    });
    if (upErr) throw upErr;

    const { error: ppErr } = await supabase
      .from('payment_proofs')
      .insert({
        order_id: _order.id,
        user_id: _user.id,
        channel: _channel,
        payer_name: fd.get('payer_name')?.trim() || null,
        transfer_ref_last4: fd.get('ref_last4')?.trim() || null,
        amount_cny: _product.price_cny,
        proof_file_hash: fileHash,
        proof_bucket: bucket,
        proof_path: path,
        submitted_at: new Date().toISOString(),
      });
    if (ppErr) throw ppErr;

    // Update order status via RPC (server-side validates proof exists)
    const { error: reviewErr } = await supabase.rpc('submit_order_for_review', {
      p_order_id: _order.id,
      p_contact_wechat: contactWechat || null,
      p_contact_phone: contactPhone || null,
      p_contact_email: contactEmail || null,
    });
    if (reviewErr) throw reviewErr;

    // Also save channel on order (best-effort)
    await supabase.from('orders').update({ channel: _channel }).eq('id', _order.id).then(() => {});

    // Show done
    document.getElementById('step3').hidden = true;
    document.getElementById('stepDone').hidden = false;
    document.getElementById('doneOrderNo').textContent = _order.order_no;
    document.querySelectorAll('.step-indicator .step').forEach(s => s.classList.add('done'));

    toast('已提交', '凭证上传成功，等待管理员审核。', 'ok');
    loadMyOrders();
  } catch (err) {
    hint.textContent = `上传失败: ${err.message}`;
    toast('上传失败', err.message, 'err');
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
    .select('id, order_no, total_amount_cny, status, channel, created_at, order_items(product_title)')
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
    return `
    <div class="card soft" style="padding:10px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
      <div>
        <div><b class="small">${esc(productName)}</b></div>
        <code class="small muted">${esc(r.order_no)}</code>
        <span class="small muted" style="margin-left:8px">${esc(formatBeijingDateTime(r.created_at))}</span>
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

  // Load product and config in parallel
  const [productOk] = await Promise.all([loadProduct(), loadSysConfig()]);
  if (!productOk) return;

  gate.hidden = true;
  main.hidden = false;
  const trustInfo = document.getElementById('checkoutTrustInfo');
  if (trustInfo) trustInfo.hidden = true;

  renderSummary();
  setStep(1);

  // Bind events
  document.getElementById('btnConfirmOrder').addEventListener('click', createOrder);

  document.getElementById('payWechat').addEventListener('click', () => { _channel = 'wechat'; updatePayUI(); });
  document.getElementById('payAlipay').addEventListener('click', () => { _channel = 'alipay'; updatePayUI(); });
  document.getElementById('payBank').addEventListener('click', () => { _channel = 'bank_transfer'; updatePayUI(); });

  document.getElementById('btnGoUpload').addEventListener('click', () => setStep(3));

  document.getElementById('proofForm').addEventListener('submit', submitProof);

  document.getElementById('refreshMyOrders')?.addEventListener('click', loadMyOrders);

  loadMyOrders();
}

init();
