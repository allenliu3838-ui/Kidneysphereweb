import {
  supabase,
  ensureSupabase,
  isConfigured,
  getCurrentUser,
  getUserProfile,
  normalizeRole,
  toast,
  formatBeijingDateTime,
} from './supabaseClient.js?v=20260122_001';

import {
  MEMBERSHIP_ENABLED,
  MEMBERSHIP_PLAN,
  MEMBERSHIP_PRICE_CNY,
  WECHAT_PAY_QR_IMAGE,
  ALIPAY_PAY_QR_IMAGE,
} from './assets/config.js';

const gate = document.getElementById('memberGate');
const statusWrap = document.getElementById('memberStatus');

const priceEl = document.getElementById('membershipPrice');
const refEl = document.getElementById('payReference');
const qrEl = document.getElementById('payQr');

const btnWechat = document.getElementById('channelWechat');
const btnAlipay = document.getElementById('channelAlipay');

const form = document.getElementById('membershipForm');
const hint = document.getElementById('membershipHint');
const ordersWrap = document.getElementById('myOrders');

let _user = null;
let _profile = null;
let _channel = 'wechat';
let _reference = '';

function esc(s){
  return String(s ?? '').replace(/[&<>'"]/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
  }[c]));
}

function schemaHintFor(err){
  const msg = String(err?.message || err || '');
  if(/relation .*membership_orders.* does not exist/i.test(msg) || /membership_orders.* not found/i.test(msg)){
    return '未创建 membership_orders 表。请先在 Supabase SQL Editor 运行：MIGRATION_20260122_MEMBERSHIP_PAYMENTS.sql，然后 Settings → API → Reload schema。';
  }
  if(/bucket.*membership_payment/i.test(msg) || /not found.*membership_payment/i.test(msg)){
    return '未创建 membership_payment 存储桶。请先运行 MIGRATION_20260122_MEMBERSHIP_PAYMENTS.sql，或在 Storage 创建同名 bucket。';
  }
  return null;
}

function setGate(html){
  if(!gate) return;
  gate.innerHTML = html;
}

function setHint(text){
  if(!hint) return;
  hint.textContent = String(text || '');
}

function setOrders(html){
  if(!ordersWrap) return;
  ordersWrap.innerHTML = html;
}

function makeReference(uid){
  const short = String(uid || '').replace(/-/g,'').slice(-6).toUpperCase();
  const d = new Date();
  const pad = (n)=> String(n).padStart(2,'0');
  return `KS-${short}-${pad(d.getMonth()+1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function updatePaymentUI(){
  if(priceEl) priceEl.textContent = MEMBERSHIP_ENABLED ? `¥${Number(MEMBERSHIP_PRICE_CNY || 0)} / 年` : '暂未开放';
  if(refEl) refEl.textContent = _reference || '—';

  if(btnWechat) btnWechat.classList.toggle('primary', _channel === 'wechat');
  if(btnAlipay) btnAlipay.classList.toggle('primary', _channel === 'alipay');

  if(qrEl){
    const src = _channel === 'wechat' ? WECHAT_PAY_QR_IMAGE : ALIPAY_PAY_QR_IMAGE;
    qrEl.src = src || '';
  }
}

function renderStatus(){
  if(!statusWrap) return;
  if(!_user){
    statusWrap.innerHTML = '<div class="muted">未登录</div>';
    return;
  }
  const role = normalizeRole(_profile?.role || _user?.user_metadata?.role || 'member');
  const doctor = (role === 'doctor_verified' || role === 'doctor' || role === 'admin' || role === 'super_admin' || role === 'moderator' || role === 'owner');
  const membership = String(_profile?.membership_status || 'none');

  statusWrap.innerHTML = `
    <div class="stack">
      <div>
        <div class="small muted">账号</div>
        <div><b>${esc(_profile?.full_name || _user?.email || '成员')}</b></div>
      </div>

      <div>
        <div class="small muted">医生认证</div>
        <div>${doctor ? '<span class="badge">已认证</span>' : '<span class="badge" style="opacity:.7">未认证</span>'}</div>
      </div>

      <div>
        <div class="small muted">会员标识</div>
        <div>${(membership && membership !== 'none') ? '<span class="badge">会员</span>' : '<span class="badge" style="opacity:.7">未开通</span>'}</div>
      </div>
    </div>
  `;
}

function statusBadge(s){
  const st = String(s||'').toLowerCase();
  if(st === 'pending') return '<span class="badge" style="border-color:rgba(245,158,11,.35);background:rgba(245,158,11,.08)">待审核</span>';
  if(st === 'paid') return '<span class="badge">已通过</span>';
  if(st === 'rejected') return '<span class="badge" style="opacity:.7">已驳回</span>';
  return `<span class="badge" style="opacity:.7">${esc(st||'—')}</span>`;
}

async function loadMyOrders(){
  if(!_user) return;
  try{
    const { data, error } = await supabase
      .from('membership_orders')
      .select('id, plan, amount_cny, channel, status, reference, created_at, proof_bucket, proof_path, admin_note, user_note')
      .eq('user_id', _user.id)
      .order('created_at', { ascending:false });
    if(error) throw error;

    const rows = Array.isArray(data) ? data : [];
    if(rows.length === 0){
      setOrders('<div class="muted">暂无订单。</div>');
      return;
    }

    setOrders(`
      <div class="table" style="overflow:auto">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>渠道</th>
              <th>金额</th>
              <th>参考号</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r=>{
              const when = r.created_at ? esc(formatBeijingDateTime(r.created_at)) : '—';
              const channel = r.channel === 'wechat' ? '微信' : (r.channel === 'alipay' ? '支付宝' : esc(r.channel||'—'));
              const amount = r.amount_cny != null ? `¥${esc(String(r.amount_cny))}` : '—';
              const ref = r.reference || '';
              const view = (r.proof_bucket && r.proof_path) ? `<button class="btn tiny" type="button" data-view="1" data-bucket="${esc(r.proof_bucket)}" data-path="${esc(r.proof_path)}">查看截图</button>` : '<span class="muted">—</span>';

              return `
                <tr>
                  <td class="small">${when}</td>
                  <td>${esc(channel)}</td>
                  <td><b>${amount}</b></td>
                  <td><code>${esc(ref)}</code></td>
                  <td>${statusBadge(r.status)}</td>
                  <td>${view}</td>
                </tr>
                ${(r.admin_note || r.user_note) ? `
                  <tr>
                    <td colspan="6" class="small muted">
                      ${r.user_note ? `用户备注：${esc(r.user_note)}<br/>` : ''}
                      ${r.admin_note ? `管理员备注：${esc(r.admin_note)}` : ''}
                    </td>
                  </tr>
                ` : ''}
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `);

  }catch(err){
    const hintMsg = schemaHintFor(err);
    setOrders(`<div class="note"><b>加载失败：</b>${esc(hintMsg || err?.message || String(err))}</div>`);
  }
}

async function handleViewProof(e){
  const btn = e.target?.closest?.('button[data-view]');
  if(!btn) return;

  const bucket = String(btn.getAttribute('data-bucket') || '').trim();
  const path = String(btn.getAttribute('data-path') || '').trim();
  if(!bucket || !path) return;

  try{
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60*10);
    if(error) throw error;
    const url = data?.signedUrl;
    if(!url) throw new Error('signedUrl empty');
    window.open(url, '_blank');
  }catch(err){
    toast('无法查看截图', err?.message || String(err), 'err');
  }
}

function safeFilename(name){
  const n = String(name || 'proof').trim();
  // Keep it simple (avoid weird characters in object keys)
  return n.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'proof';
}

async function submit(e){
  e.preventDefault();
  if(!form) return;

  if(!MEMBERSHIP_ENABLED){
    toast('暂未开放', '管理员尚未开启会员开通。', 'warn');
    return;
  }

  if(!_user){
    toast('请先登录', '登录后才能提交订单。', 'err');
    return;
  }

  const fd = new FormData(form);
  const real_name = String(fd.get('real_name') || '').trim();
  const hospital = String(fd.get('hospital') || '').trim();
  const note = String(fd.get('note') || '').trim();
  const file = fd.get('proof');

  if(!(file instanceof File) || !file.name){
    toast('请上传凭证', '需要上传付款截图/凭证。', 'err');
    return;
  }

  setHint('上传中…');

  const bucket = 'membership_payment';
  const path = `${_user.id}/${Date.now()}_${safeFilename(file.name)}`;

  try{
    // 1) Upload proof
    const { error: upErr } = await supabase.storage.from(bucket).upload(path, file, {
      upsert: true,
      contentType: file.type || undefined,
    });
    if(upErr) throw upErr;

    // 2) Create order
    const row = {
      user_id: _user.id,
      plan: String(MEMBERSHIP_PLAN || 'annual'),
      amount_cny: Number(MEMBERSHIP_PRICE_CNY || 0),
      channel: _channel,
      status: 'pending',
      reference: _reference,
      real_name: real_name || null,
      hospital: hospital || null,
      user_note: note || null,
      proof_bucket: bucket,
      proof_path: path,
      proof_name: file.name || null,
    };

    const { error: insErr } = await supabase.from('membership_orders').insert(row);
    if(insErr) throw insErr;

    toast('已提交', '订单已提交，等待管理员审核。', 'ok');
    setHint('已提交，等待审核');

    // Reset file input
    const fileEl = form.querySelector('input[type="file"][name="proof"]');
    if(fileEl) fileEl.value = '';

    await loadMyOrders();

  }catch(err){
    const hintMsg = schemaHintFor(err);
    const msg = hintMsg || (err?.message || String(err));
    toast('提交失败', msg, 'err');
    setHint(msg);
  }
}

async function init(){
  if(isConfigured() && !supabase){
    await ensureSupabase();
  }
  if(!isConfigured() || !supabase){
    setGate('<b>演示模式：</b>未配置 Supabase，无法提交会员订单。');
    return;
  }

  const u = await getCurrentUser();
  if(!u){
    setGate('请先 <a href="login.html?next=membership.html">登录</a>，再进行会员开通。');
    return;
  }

  _user = u;
  _profile = await getUserProfile(u);

  _reference = makeReference(u.id);

  setGate('<b>已登录：</b>你可以选择支付方式并提交付款截图。');
  renderStatus();
  updatePaymentUI();

  // Bind
  btnWechat?.addEventListener('click', ()=>{
    _channel = 'wechat';
    updatePaymentUI();
  });
  btnAlipay?.addEventListener('click', ()=>{
    _channel = 'alipay';
    updatePaymentUI();
  });

  form?.addEventListener('submit', submit);
  ordersWrap?.addEventListener('click', handleViewProof);

  await loadMyOrders();
}

init();
