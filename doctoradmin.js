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
} from './supabaseClient.js?v=20260128_030';

const codeForm = document.getElementById('inviteCodeForm');
const codeHint = document.getElementById('inviteCodeHint');
const codeList = document.getElementById('inviteCodeList');

const queueWrap = document.getElementById('doctorQueue');
const queueHint = document.getElementById('doctorQueueHint');
const refreshBtn = document.getElementById('refreshDoctorQueue');

function esc(s){
  return String(s ?? '').replace(/[&<>'"]/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
  }[c]));
}

function setHint(el, text){
  if(el) el.textContent = String(text || '');
}

function toIsoIfLocal(dtLocal){
  const v = String(dtLocal || '').trim();
  if(!v) return null;
  try{
    const d = new Date(v);
    if(Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }catch(_e){
    return null;
  }
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
  if(!isAdminRole(role)) return { ok:false, reason:'无管理员权限' };
  return { ok:true, user:u, profile:p, role };
}

// ---------------------
// Invite code management
// ---------------------

function renderCodes(rows){
  if(!codeList) return;
  const list = Array.isArray(rows) ? rows : [];
  if(list.length === 0){
    codeList.innerHTML = '<div class="muted">暂无邀请码。</div>';
    return;
  }

  const fmt = (ts)=> ts ? esc(formatBeijingDateTime(ts)) : '';

  codeList.innerHTML = `
    <div class="table" style="overflow:auto">
      <table>
        <thead>
          <tr>
            <th>邀请码</th>
            <th>状态</th>
            <th>使用</th>
            <th>过期</th>
            <th>备注</th>
            <th style="min-width:180px">操作</th>
          </tr>
        </thead>
        <tbody>
          ${list.map(r=>{
            const active = !!r.active;
            const used = Number(r.used_count || 0);
            const max = r.max_uses == null ? '' : String(r.max_uses);
            const exp = r.expires_at ? fmt(r.expires_at) : '';
            return `
              <tr>
                <td><code>${esc(r.code)}</code></td>
                <td>${active ? '<span class="badge">启用</span>' : '<span class="badge" style="opacity:.7">停用</span>'}</td>
                <td>${esc(String(used))}${max ? ' / ' + esc(max) : ''}</td>
                <td>${exp || '<span class="muted">—</span>'}</td>
                <td class="small">${esc(r.note || '')}</td>
                <td>
                  <button class="btn tiny" type="button" data-code-toggle="${esc(r.code)}" data-next="${active ? 'false' : 'true'}">${active ? '停用' : '启用'}</button>
                  <button class="btn tiny" type="button" data-code-edit="${esc(r.code)}">填入表单</button>
                  <button class="btn tiny danger" type="button" data-code-del="${esc(r.code)}">删除</button>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function loadCodes(){
  const { data, error } = await supabase
    .from('doctor_invite_codes')
    .select('code, active, note, created_at, expires_at, max_uses, used_count')
    .order('created_at', { ascending:false });
  if(error) throw error;
  renderCodes(data);
}

function bindCodeActions(){
  if(!codeList) return;

  codeList.addEventListener('click', async (e)=>{
    const btn = e.target?.closest?.('button');
    if(!btn) return;

    const toggleCode = btn.getAttribute('data-code-toggle');
    const delCode = btn.getAttribute('data-code-del');
    const editCode = btn.getAttribute('data-code-edit');

    try{
      if(toggleCode){
        const next = btn.getAttribute('data-next') === 'true';
        const { error } = await supabase
          .from('doctor_invite_codes')
          .update({ active: next })
          .eq('code', toggleCode);
        if(error) throw error;
        toast('已更新', `邀请码 ${toggleCode} 已${next ? '启用' : '停用'}`, 'ok');
        await loadCodes();
        return;
      }

      if(editCode){
        if(!codeForm) return;
        const { data, error } = await supabase
          .from('doctor_invite_codes')
          .select('code, active, note, expires_at, max_uses')
          .eq('code', editCode)
          .maybeSingle();
        if(error) throw error;
        if(!data) return;

        codeForm.querySelector('[name="code"]').value = data.code;
        codeForm.querySelector('[name="active"]').value = String(!!data.active);
        codeForm.querySelector('[name="note"]').value = data.note || '';
        codeForm.querySelector('[name="max_uses"]').value = data.max_uses == null ? '' : String(data.max_uses);

        const expEl = codeForm.querySelector('[name="expires_at"]');
        if(expEl){
          if(data.expires_at){
            const d = new Date(data.expires_at);
            const pad = (n)=> String(n).padStart(2,'0');
            const v = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
            expEl.value = v;
          }else{
            expEl.value = '';
          }
        }

        toast('已填入', '已将邀请码信息填入表单，可直接修改后提交。', 'ok');
        return;
      }

      if(delCode){
        if(!confirm(`确定删除邀请码 ${delCode} 吗？`)) return;
        const { error } = await supabase
          .from('doctor_invite_codes')
          .delete()
          .eq('code', delCode);
        if(error) throw error;
        toast('已删除', `邀请码 ${delCode} 已删除。`, 'ok');
        await loadCodes();
        return;
      }

    }catch(err){
      toast('操作失败', err?.message || String(err), 'err');
    }
  });
}

async function submitCodeForm(e){
  e.preventDefault();
  if(!codeForm) return;

  const fd = new FormData(codeForm);
  const code = String(fd.get('code') || '').trim();
  const active = String(fd.get('active') || 'true') === 'true';
  const note = String(fd.get('note') || '').trim();
  const maxUsesRaw = String(fd.get('max_uses') || '').trim();
  const expiresLocal = String(fd.get('expires_at') || '').trim();

  if(code.length < 4){
    toast('邀请码太短', '请至少 4 位。', 'err');
    return;
  }

  let max_uses = null;
  if(maxUsesRaw){
    const n = Number(maxUsesRaw);
    if(!Number.isFinite(n) || n < 1){
      toast('使用次数上限不合法', '请填写 ≥1 的整数，或留空。', 'err');
      return;
    }
    max_uses = Math.floor(n);
  }

  const expires_at = toIsoIfLocal(expiresLocal);

  setHint(codeHint, '保存中…');
  try{
    const row = {
      code,
      active,
      note: note || null,
      max_uses,
      expires_at,
    };

    const { error } = await supabase
      .from('doctor_invite_codes')
      .upsert(row, { onConflict: 'code' });
    if(error) throw error;

    toast('已保存', '邀请码已新增/更新。', 'ok');
    setHint(codeHint, '已保存');
    await loadCodes();

  }catch(err){
    const msg = err?.message || String(err);
    toast('保存失败', msg, 'err');
    setHint(codeHint, msg);
  }
}

// ---------------------
// Manual verification queue
// ---------------------

function renderQueue(rows){
  if(!queueWrap) return;
  const list = Array.isArray(rows) ? rows : [];
  if(list.length === 0){
    queueWrap.innerHTML = '<div class="muted">暂无人工审核申请。</div>';
    return;
  }

  const badge = (s)=>{
    const st = String(s || '').toLowerCase();
    if(st === 'pending') return '<span class="badge" style="border-color:rgba(245,158,11,.35);background:rgba(245,158,11,.08)">待审核</span>';
    if(st === 'approved') return '<span class="badge">已通过</span>';
    if(st === 'rejected') return '<span class="badge" style="opacity:.7">已驳回</span>';
    return `<span class="badge" style="opacity:.7">${esc(st||'—')}</span>`;
  };

  queueWrap.innerHTML = `
    <div class="stack">
      ${list.map(r=>{
        const when = r.created_at ? esc(formatBeijingDateTime(r.created_at)) : '';
        const hosp = [r.hospital, r.department, r.title].filter(Boolean).join(' · ');
        const docName = r.document_name || r.document_path || '材料';
        return `
          <div class="card" style="margin:0">
            <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start">
              <div style="min-width:0">
                <b>${esc(r.real_name || '成员')}</b> ${badge(r.status)}
                <div class="small muted" style="margin-top:6px">单位：${esc(hosp || '')}</div>
                <div class="small muted" style="margin-top:2px">提交：${when || '—'}</div>
                <div class="small muted" style="margin-top:2px">用户ID：<code>${esc(String(r.user_id || ''))}</code></div>
              </div>
              <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
                <button class="btn tiny" type="button" data-view-doc="1" data-bucket="${esc(r.document_bucket || '')}" data-path="${esc(r.document_path || '')}">查看材料</button>
                <button class="btn tiny primary" type="button" data-approve="1" data-uid="${esc(String(r.user_id || ''))}">通过</button>
                <button class="btn tiny danger" type="button" data-reject="1" data-uid="${esc(String(r.user_id || ''))}">驳回</button>
              </div>
            </div>

            <div style="margin-top:10px">
              <label class="small muted">审核备注（可选，驳回建议填写原因）</label>
              <textarea class="input" rows="2" data-note-for="${esc(String(r.user_id || ''))}" placeholder="例如：请遮挡证件号后重新提交">${esc(r.note || '')}</textarea>
              <div class="small muted" style="margin-top:6px">材料：${esc(docName)}</div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

async function loadQueue(){
  setHint(queueHint, '加载中…');
  try{
    const onlyPending = (document.getElementById('dvOnlyPending')?.checked ?? true);

    let q = supabase
      .from('doctor_verifications')
      .select('user_id, real_name, hospital, department, title, status, created_at, note, method, document_bucket, document_path, document_name')
      .eq('method', 'manual');

    if (onlyPending) q = q.eq('status', 'pending');

    const { data, error } = await q
      .order('created_at', { ascending:false });
if(error) throw error;

    const rows = Array.isArray(data) ? data : [];
    // Prefer pending first
    rows.sort((a,b)=>{
      const rank = (x)=> String(x?.status||'').toLowerCase() === 'pending' ? 0 : 1;
      const ra = rank(a), rb = rank(b);
      if(ra != rb) return ra - rb;
      return new Date(b.created_at||0).getTime() - new Date(a.created_at||0).getTime();
    });

    renderQueue(rows);
    setHint(queueHint, `共 ${rows.length} 条`);
  }catch(err){
    const msg = err?.message || String(err);
    setHint(queueHint, msg);
    if(queueWrap) queueWrap.innerHTML = `<div class="note"><b>加载失败：</b>${esc(msg)}</div>`;
  }
}

function getNote(uid){
  if(!uid) return '';
  const el = document.querySelector(`[data-note-for="${CSS.escape(uid)}"]`);
  return String(el?.value || '').trim();
}

function bindQueueActions(){
  if(!queueWrap) return;

  queueWrap.addEventListener('click', async (e)=>{
    const btn = e.target?.closest?.('button');
    if(!btn) return;

    const view = btn.getAttribute('data-view-doc');
    const approve = btn.getAttribute('data-approve');
    const reject = btn.getAttribute('data-reject');

    try{
      if(view){
        const bucket = String(btn.getAttribute('data-bucket') || '').trim();
        const path = String(btn.getAttribute('data-path') || '').trim();
        if(!bucket || !path){
          toast('无法查看', '未找到材料路径。', 'err');
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
        const uid = String(btn.getAttribute('data-uid') || '').trim();
        if(!uid){
          toast('参数缺失', '缺少用户ID。', 'err');
          return;
        }
        const note = getNote(uid);
        const isApprove = !!approve;

        if(!confirm(isApprove ? `确认通过该用户医生认证？` : `确认驳回该用户医生认证？`)) return;

        btn.disabled = true;
        const { error } = await supabase
          .rpc('admin_review_doctor_verification', {
            target_user_id: uid,
            approve: isApprove,
            note: note || null,
          });
        if(error) throw error;

        toast('已处理', isApprove ? '已通过认证。' : '已驳回申请。', 'ok');
        await loadQueue();
        return;
      }

    }catch(err){
      toast('操作失败', err?.message || String(err), 'err');
    }finally{
      try{ btn.disabled = false; }catch(_e){}
    }
  });
}

// ---------------------
// Boot
// ---------------------

(async function init(){
  const chk = await ensureAdmin();
  if(!chk.ok){
    // Admin gate is handled by admin.js; keep quiet.
    return;
  }

  // Bind
  codeForm?.addEventListener('submit', submitCodeForm);
  bindCodeActions();
  bindQueueActions();
  refreshBtn?.addEventListener('click', loadQueue);
  const onlyPendingEl = document.getElementById('dvOnlyPending');
  onlyPendingEl?.addEventListener('change', loadQueue);

  // Load initial
  try{ await loadCodes(); }catch(err){
    setHint(codeHint, err?.message || String(err));
  }
  await loadQueue();
})();
