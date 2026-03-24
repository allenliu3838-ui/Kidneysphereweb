import {
  ensureAuthed,
  getSession,
  getUserProfile,
  getSupabase,
  normalizeRole,
  isAdminRole,
  toast,
} from './supabaseClient.js?v=20260128_030';

function isDoctorRole(role){
  const r = normalizeRole(role);
  return r === 'doctor_verified' || r === 'doctor' || r === 'moderator';
}

const statusEl = document.getElementById('verifyStatus');

// Tabs
const tabInviteBtn = document.getElementById('tabInvite');
const tabManualBtn = document.getElementById('tabManual');
const inviteSection = document.getElementById('inviteSection');
const manualSection = document.getElementById('manualSection');

// Channel A
const inviteForm = document.getElementById('inviteForm');
const submitA = document.getElementById('submitA');
const hintA = document.getElementById('submitHintA');
const inviteHintA = document.getElementById('inviteHintA');

const nameA = document.getElementById('realNameA');
const hospitalA = document.getElementById('hospitalA');
const deptA = document.getElementById('departmentA');
const titleA = document.getElementById('titleA');
const codeA = document.getElementById('inviteCodeA');

// Channel B
const manualForm = document.getElementById('manualForm');
const submitB = document.getElementById('submitB');
const hintB = document.getElementById('submitHintB');

const nameB = document.getElementById('realNameB');
const hospitalB = document.getElementById('hospitalB');
const deptB = document.getElementById('departmentB');
const titleB = document.getElementById('titleB');
const proofFile = document.getElementById('proofFile');

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, (c)=>({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function doctorRoleOk(role){
  const r = normalizeRole(role);
  if(isAdminRole(r)) return true;
  return r === 'doctor_verified' || r === 'doctor' || r === 'moderator';
}

function setStatus(html){
  if(statusEl) statusEl.innerHTML = html;
}

function getNext(){
  try{
    const u = new URL(location.href);
    const raw = String(u.searchParams.get('next') || '').trim();
    // Prevent open redirect: only allow relative paths, block absolute URLs and path traversal.
    if(raw && !raw.startsWith('http') && !raw.startsWith('//') && !raw.includes('..')){
      return raw;
    }
    return '';
  }catch(_e){
    return '';
  }
}

function safeFileName(name){
  // Supabase Storage validates object keys as URL-safe strings.
  // Non-ASCII (e.g. Chinese) may cause "Invalid key". We therefore
  // use an ASCII-only safe filename for storage, while keeping the
  // original filename for display if needed.
  const raw = String(name || 'proof').trim();
  const parts = raw.split('.');
  const extRaw = parts.length > 1 ? parts.pop() : '';
  const stemRaw = parts.join('.') || 'proof';
  const stem = stemRaw
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'proof';
  const ext = String(extRaw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 10);
  return ext ? `${stem}.${ext}` : stem;
}

function setActiveTab(tab){
  const isInvite = tab === 'invite';
  if(inviteSection) inviteSection.hidden = !isInvite;
  if(manualSection) manualSection.hidden = isInvite;
  if(tabInviteBtn){
    tabInviteBtn.classList.toggle('primary', isInvite);
  }
  if(tabManualBtn){
    tabManualBtn.classList.toggle('primary', !isInvite);
  }
}

async function load(){
  const nextForLogin = encodeURIComponent('verify-doctor.html' + location.search);
  await ensureAuthed(`login.html?next=${nextForLogin}`);

  const session = await getSession();
  const user = session?.user || null;
  if(!user){
    setStatus('<b>请先登录</b>');
    return;
  }

  const supabase = await getSupabase();
  if(!supabase){
    toast('Supabase 未配置', '请先在 assets/config.js 填入 SUPABASE_URL 与 SUPABASE_ANON_KEY。', 'err');
    return;
  }

  const profile = await getUserProfile(user);
  const roleRaw = profile?.role || user.user_metadata?.role || 'member';
  const role = normalizeRole(roleRaw);
  const isVerified = doctorRoleOk(role);

  // Load existing verification record (optional)
  let ver = null;
  try{
    const { data, error } = await supabase
      .from('doctor_verifications')
      .select('status, method, created_at, reviewed_at, verified_at, note, real_name, hospital, department, title')
      .eq('user_id', user.id)
      .maybeSingle();
    if(!error) ver = data || null;
  }catch(_e){
    ver = null;
  }

  // Prefill
  const preName = profile?.full_name || user.user_metadata?.full_name || ver?.real_name || '';
  const preHosp = profile?.doctor_hospital || ver?.hospital || '';
  const preDept = profile?.doctor_department || ver?.department || '';
  const preTitle = profile?.doctor_title || ver?.title || '';

  [nameA, nameB].forEach(el=>{ if(el && !el.value && preName) el.value = preName; });
  [hospitalA, hospitalB].forEach(el=>{ if(el && !el.value && preHosp) el.value = preHosp; });
  [deptA, deptB].forEach(el=>{ if(el && !el.value && preDept) el.value = preDept; });
  [titleA, titleB].forEach(el=>{ if(el && !el.value && preTitle) el.value = preTitle; });

  // Status banner
  if(isVerified){
    setStatus(
      `<b>已完成医生认证 ✅</b>` +
      `<div class="small muted" style="margin-top:6px">` +
      `你当前身份：<b>${esc(isAdminRole(role) ? '管理员/超级管理员' : '认证医生')}</b>。` +
      `已具备发布病例、病例讨论回复与附件上传权限。` +
      `</div>`
    );
    if(inviteHintA) inviteHintA.textContent = '（已认证后可不填邀请码，仅用于更新信息）';
    if(codeA) codeA.placeholder = '已认证可留空';
  }else if(ver?.status === 'pending'){
    setStatus(
      `<b>医生认证申请已提交 🕒</b>` +
      `<div class="small muted" style="margin-top:6px">` +
      `状态：<b>待审核</b>。管理员审核通过后，你即可发布病例与参与讨论。` +
      `</div>`
    );
    // Default to manual tab to reflect pending
    setActiveTab('manual');
  }else if(ver?.status === 'rejected'){
    const note = String(ver?.note || '').trim();
    setStatus(
      `<b>医生认证未通过（已驳回）</b>` +
      `<div class="small muted" style="margin-top:6px">` +
      `${note ? `原因：${esc(note)}<br/>` : ''}` +
      `你可以重新提交材料，或向管理员获取邀请码进行快速认证。` +
      `</div>`
    );
    setActiveTab('manual');
  }else{
    setStatus(
      `<b>未认证</b>` +
      `<div class="small muted" style="margin-top:6px">` +
      `建议优先使用 <b>邀请码快速认证</b>；如暂时没有邀请码，可走 <b>人工审核认证</b>。` +
      `</div>`
    );
  }

  // Tabs
  tabInviteBtn?.addEventListener('click', ()=> setActiveTab('invite'));
  tabManualBtn?.addEventListener('click', ()=> setActiveTab('manual'));

  // Default tab
  if(isVerified) setActiveTab('invite');
  else if(ver?.status === 'pending' || ver?.status === 'rejected') setActiveTab('manual');
  else setActiveTab('invite');

  // --------------------
  // Channel A submit
  // --------------------
  inviteForm?.addEventListener('submit', async (e)=>{
    e.preventDefault();

    const real_name = String(nameA?.value || '').trim();
    const hospital = String(hospitalA?.value || '').trim();
    const department = String(deptA?.value || '').trim();
    const title = String(titleA?.value || '').trim();
    const invite_code = String(codeA?.value || '').trim();

    if(real_name.length < 2){
      toast('请填写真实姓名', '用于医生身份核验。', 'err');
      nameA?.focus();
      return;
    }
    if(hospital.length < 2){
      toast('请填写单位/医院', '用于医生身份核验。', 'err');
      hospitalA?.focus();
      return;
    }
    if(!isVerified && invite_code.length < 4){
      toast('请输入邀请码', '没有邀请码请切换到"人工审核认证"。', 'err');
      codeA?.focus();
      return;
    }

    if(submitA){ submitA.disabled = true; submitA.textContent = '提交中…'; }
    if(hintA) hintA.textContent = '';

    try{
      const { error } = await supabase.rpc('verify_doctor_with_code', {
        invite_code: invite_code || '',
        real_name,
        hospital,
        department,
        title,
      });
      if(error) throw error;

      // Re-check persisted role after RPC (prevents a false-positive UI state
      // when profiles row is missing or a migration failed to apply).
      let isNowVerified = false;
      try{
        const freshProfile = await getUserProfile(user);
        const freshRole = normalizeRole(freshProfile?.role || '');
        isNowVerified = isAdminRole(freshRole) || isDoctorRole(freshRole);
      }catch(_e){ /* ignore */ }

      toast('提交成功', isVerified ? '信息已更新。' : '认证成功，已升级为"认证医生"。', 'ok');

      if(!isNowVerified && !isVerified){
        // The RPC returned OK but the persisted role still isn't verified.
        // This typically means the profiles row doesn't exist or migrations didn't run fully.
        // Keep the UI honest and show guidance.
        if(hintA) hintA.textContent = '提示：认证已提交，但刷新后仍显示未认证。请确认已执行最新 MIGRATION 文件，并在 Supabase 控制台 Settings → API 点击 "Reload schema"，然后刷新页面。';
      }

      if(!isVerified && !isNowVerified){
        setStatus(
          `<b>已提交认证申请 ✅</b>` +
          `<div class="small muted" style="margin-top:6px">系统返回成功，但当前账号的认证状态尚未写入/生效。请按上方提示完成数据库迁移与 Reload schema 后刷新。</div>`
        );
      }else{
        setStatus(
          `<b>已完成医生认证 ✅</b>` +
          `<div class="small muted" style="margin-top:6px">认证已生效。你已具备发布病例与病例讨论权限。</div>`
        );
      }

      // Redirect if next is provided
      const next = getNext();
      if(next){
        setTimeout(()=>{ location.href = next; }, 700);
      }

    }catch(err){
      const msg = String(err?.message || err || '提交失败');
      toast('提交失败', msg, 'err');
      if(hintA) hintA.textContent = msg;
    }finally{
      if(submitA){ submitA.disabled = false; submitA.textContent = '提交'; }
    }
  });

  // --------------------
  // Channel B submit
  // --------------------
  manualForm?.addEventListener('submit', async (e)=>{
    e.preventDefault();

    const real_name = String(nameB?.value || '').trim();
    const hospital = String(hospitalB?.value || '').trim();
    const department = String(deptB?.value || '').trim();
    const title = String(titleB?.value || '').trim();

    if(real_name.length < 2){
      toast('请填写真实姓名', '用于医生身份核验。', 'err');
      nameB?.focus();
      return;
    }
    if(hospital.length < 2){
      toast('请填写单位/医院', '用于医生身份核验。', 'err');
      hospitalB?.focus();
      return;
    }

    const file = proofFile?.files?.[0] || null;
    if(!file){
      toast('请上传证明材料', '建议上传工牌/胸牌/执业证（图片或PDF）。', 'err');
      proofFile?.focus();
      return;
    }

    const maxMB = 20;
    if(file.size > maxMB * 1024 * 1024){
      toast('文件过大', `单个文件请控制在 ≤${maxMB}MB。`, 'err');
      return;
    }

    if(submitB){ submitB.disabled = true; submitB.textContent = '提交中…'; }
    if(hintB) hintB.textContent = '';

    try{
      // 1) Upload to private bucket
      const path = `${user.id}/${Date.now()}_${safeFileName(file.name)}`;
      const up = await supabase.storage
        .from('doctor_verification')
        .upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
      if(up?.error) throw up.error;

      // 2) Create a manual verification request
      const { error } = await supabase.rpc('request_doctor_verification_manual', {
        real_name,
        hospital,
        department,
        title,
        document_bucket: 'doctor_verification',
        document_path: path,
        document_name: file.name,
        document_type: file.type || '',
      });
      if(error) throw error;

      toast('已提交审核', '管理员审核通过后，你将获得发布病例与参与讨论权限。', 'ok');

      setStatus(
        `<b>医生认证申请已提交 🕒</b>` +
        `<div class="small muted" style="margin-top:6px">状态：<b>待审核</b>。你可关闭此页，等待管理员审核。</div>`
      );

      setActiveTab('manual');

      if(hintB) hintB.textContent = '已提交，等待审核…';

    }catch(err){
      const msg = String(err?.message || err || '提交失败');
      toast('提交失败', msg, 'err');
      if(hintB) hintB.textContent = msg;
    }finally{
      if(submitB){ submitB.disabled = false; submitB.textContent = '提交审核'; }
    }
  });
}

load();
