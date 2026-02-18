import {
  supabase,
  ensureSupabase,
  isConfigured,
  getCurrentUser,
  getUserProfile,
  normalizeRole,
  isAdminRole,
  toast,
  formatBeijingDateTime,
} from './supabaseClient.js?v=20260122_001';

const wrap = document.getElementById('membershipOrders');
const hint = document.getElementById('membershipOrdersHint');
const refreshBtn = document.getElementById('refreshMembershipOrders');
const filterWrap = document.getElementById('membershipOrderFilters');

let _rows = [];
let _filter = 'pending'; // pending | paid | rejected | all

function esc(s){
  return String(s ?? '').replace(/[&<>'"]/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
  }[c]));
}

async function ensureAdmin(){
  if(isConfigured() && !supabase){
    await ensureSupabase();
  }
  if(!isConfigured() || !supabase) return { ok:false, reason:'Supabase 未配置' };

  const u = await getCurrentUser();
  if(!u) return { ok:false, reason:'未登录' };

  const p = await getUserProfile(u);
  const role = normalizeRole(p?.role || u?.user_metadata?.role || 'member');

  let ok = isAdminRole(role);

  if(!ok){
    try{
      const { data } = await supabase.rpc('is_admin');
      if(data === true) ok = true;
    }catch(_e){}
  }
  if(!ok){
    try{
      const { data } = await supabase.rpc('is_super_admin');
      if(data === true) ok = true;
    }catch(_e){}
  }

  if(!ok) return { ok:false, reason:'无管理员权限' };
  return { ok:true, user:u, profile:p, role };
}

function statusBadge(s){
  const st = String(s||'').toLowerCase();
  if(st === 'pending') return '<span class="badge" style="border-color:rgba(245,158,11,.35);background:rgba(245,158,11,.08)">待审核</span>';
  if(st === 'paid') return '<span class="badge">已通过</span>';
  if(st === 'rejected') return '<span class="badge" style="opacity:.7">已驳回</span>';
  return `<span class="badge" style="opacity:.7">${esc(st||'—')}</span>`;
}

function applyFilter(){
  if(!wrap) return;
  const f = String(_filter || 'pending').toLowerCase();
  const list = Array.isArray(_rows) ? _rows : [];
  const rows = (f === 'all') ? list : list.filter(r => String(r.status||'').toLowerCase() === f);
  render(rows);

  if(filterWrap){
    filterWrap.querySelectorAll('button[data-filter]').forEach(btn=>{
      const bf = String(btn.getAttribute('data-filter')||'').toLowerCase();
      btn.classList.toggle('primary', bf === f);
    });
  }
}

function render(rows){
  if(!wrap) return;
  const list = Array.isArray(rows) ? rows : [];
  if(list.length === 0){
    wrap.innerHTML = '<div class="muted">暂无订单。</div>';
    return;
  }

  wrap.innerHTML = `
    <div class="stack">
      ${list.map(r=>{
        const st = String(r.status||'').toLowerCase();
        const pending = st === 'pending';
        const when = r.created_at ? esc(formatBeijingDateTime(r.created_at)) : '';
        const amount = r.amount_cny != null ? `¥${esc(String(r.amount_cny))}` : '—';
        const channel = r.channel === 'wechat' ? '微信' : (r.channel === 'alipay' ? '支付宝' : esc(r.channel||'—'));
        const ref = r.reference || '';
        const who = [r.real_name, r.hospital].filter(Boolean).join(' · ');

        return `
          <div class="card" style="margin:0">
            <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start">
              <div style="min-width:0">
                <b>${esc(who || '成员')}</b> ${statusBadge(r.status)}
                <div class="small muted" style="margin-top:6px">
                  金额：<b>${amount}</b> · 渠道：${esc(channel)} · 参考号：<code>${esc(ref || '')}</code>
                </div>
                <div class="small muted" style="margin-top:2px">提交：${when || '—'}</div>
                <div class="small muted" style="margin-top:2px">用户ID：<code>${esc(String(r.user_id || ''))}</code></div>
              </div>

              <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
                <button class="btn tiny" type="button" data-view="1" data-bucket="${esc(r.proof_bucket || '')}" data-path="${esc(r.proof_path || '')}">查看截图</button>
                <button class="btn tiny primary" type="button" data-approve="1" data-id="${esc(String(r.id))}" ${pending ? '' : 'disabled'}>通过</button>
                <button class="btn tiny danger" type="button" data-reject="1" data-id="${esc(String(r.id))}" ${pending ? '' : 'disabled'}>驳回</button>
              </div>
            </div>

            <div style="margin-top:10px">
              <label class="small muted">管理员备注（可选）</label>
              <textarea class="input" rows="2" data-note-for="${esc(String(r.id))}" placeholder="例如：已核对付款，已开通会员">${esc(r.admin_note || '')}</textarea>
              ${r.user_note ? `<div class="small muted" style="margin-top:8px">用户备注：${esc(r.user_note)}</div>` : ''}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function getNote(id){
  const el = document.querySelector(`[data-note-for="${CSS.escape(String(id))}"]`);
  return String(el?.value || '').trim();
}

async function loadOrders(){
  if(!hint) return;

  hint.textContent = '加载中…';
  try{
    const { data, error } = await supabase
      .from('membership_orders')
      .select('id, user_id, real_name, hospital, channel, plan, amount_cny, status, reference, created_at, proof_bucket, proof_path, proof_name, user_note, admin_note')
      .order('created_at', { ascending:false });
    if(error) throw error;

    const rows = Array.isArray(data) ? data : [];
    rows.sort((a,b)=>{
      const rank = (x)=> String(x?.status||'').toLowerCase() === 'pending' ? 0 : 1;
      const ra = rank(a), rb = rank(b);
      if(ra != rb) return ra - rb;
      return new Date(b.created_at||0).getTime() - new Date(a.created_at||0).getTime();
    });

    _rows = rows;

    const counts = { pending:0, paid:0, rejected:0, other:0 };
    rows.forEach(r=>{
      const st = String(r.status||'').toLowerCase();
      if(st === 'pending') counts.pending++;
      else if(st === 'paid') counts.paid++;
      else if(st === 'rejected') counts.rejected++;
      else counts.other++;
    });

    hint.textContent = `待审核 ${counts.pending} · 已通过 ${counts.paid} · 已驳回 ${counts.rejected}${counts.other ? ' · 其他 ' + counts.other : ''}`;

    applyFilter();
  }catch(err){
    const msg = err?.message || String(err);
    hint.textContent = msg;
    if(wrap) wrap.innerHTML = `<div class="note"><b>加载失败：</b>${esc(msg)}</div>`;
  }
}

function bindFilters(){
  if(!filterWrap) return;
  filterWrap.addEventListener('click', (e)=>{
    const btn = e.target?.closest?.('button[data-filter]');
    if(!btn) return;
    _filter = String(btn.getAttribute('data-filter') || 'pending').toLowerCase();
    applyFilter();
  });
}

function bindActions(){
  if(!wrap) return;
  wrap.addEventListener('click', async (e)=>{
    const btn = e.target?.closest?.('button');
    if(!btn) return;

    const view = btn.getAttribute('data-view');
    const approve = btn.getAttribute('data-approve');
    const reject = btn.getAttribute('data-reject');

    try{
      if(view){
        const bucket = String(btn.getAttribute('data-bucket') || '').trim();
        const path = String(btn.getAttribute('data-path') || '').trim();
        if(!bucket || !path){
          toast('无法查看', '未找到截图路径。', 'err');
          return;
        }
        const { data, error } = await supabase.storage
          .from(bucket)
          .createSignedUrl(path, 60 * 60);
        if(error) throw error;
        const url = data?.signedUrl;
        if(!url) throw new Error('signedUrl empty');
        window.open(url, '_blank');
        return;
      }

      if(approve || reject){
        const id = String(btn.getAttribute('data-id') || '').trim();
        if(!id) return;

        const row = _rows.find(r => String(r.id) === id);
        const st = String(row?.status || '').toLowerCase();
        if(st && st !== 'pending'){
          toast('无需处理', '该订单已处理过。', 'warn');
          return;
        }

        const note = getNote(id);
        const isApprove = !!approve;

        if(!confirm(isApprove ? '确认通过并开通会员？' : '确认驳回该订单？')) return;

        btn.disabled = true;
        const { error } = await supabase
          .rpc('admin_review_membership_order', {
            target_order_id: Number(id),
            approve: isApprove,
            note: note || null,
          });
        if(error) throw error;

        toast('已处理', isApprove ? '已开通会员。' : '已驳回。', 'ok');
        await loadOrders();
      }
    }catch(err){
      const msg = err?.message || String(err);
      // A bit more helpful on RLS errors
      if(/row-level security|permission denied|not authorized/i.test(msg)){
        toast('权限不足（RLS）', '请先运行 MIGRATION_20260122_MEMBERSHIP_PAYMENTS.sql，并在 Supabase 里 Reload schema。', 'err');
      }else{
        toast('操作失败', msg, 'err');
      }
    }finally{
      try{ btn.disabled = false; }catch(_e){}
    }
  });
}

(async function init(){
  if(!wrap) return;

  const chk = await ensureAdmin();
  if(!chk.ok) return;

  bindFilters();
  bindActions();
  refreshBtn?.addEventListener('click', loadOrders);

  _filter = 'pending';
  applyFilter();
  await loadOrders();
})();
