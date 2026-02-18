// moderatorsAdmin.js (v8.14)
// Admin management for public.board_moderators

import {
  supabase,
  ensureSupabase,
  isConfigured,
  toast,
  getCurrentUser,
  getUserProfile,
  normalizeRole,
  isAdminRole,
} from './supabaseClient.js?v=20260128_030';

const wrap = document.getElementById('moderatorsAdmin');
const need = document.getElementById('moderatorsNeedAdmin');
const form = document.getElementById('addModeratorForm');
const boardSel = document.getElementById('modBoardKey');
const listEl = document.getElementById('moderatorList');
const autoFillBtn = document.getElementById('modAutoFillBtn');
const hint = document.getElementById('modHint');

const BOARD_OPTIONS = [
  { key:'glom', label:'病例讨论 · 肾小球病板块' },
  { key:'tx', label:'病例讨论 · 肾移植板块' },
  { key:'icu', label:'病例讨论 · 重症肾内/透析板块' },
  { key:'peds', label:'病例讨论 · 儿童肾病板块' },
  { key:'rare', label:'病例讨论 · 罕见/遗传板块' },
  { key:'path', label:'病例讨论 · 病理板块（可选）' },
  { key:'literature', label:'文献学习' },
  { key:'research', label:'科研讨论' },
];

if(!wrap || !need || !form || !boardSel || !listEl){
  // not on this page
} else {
  init();
}

function esc(str){
  return String(str ?? '').replace(/[&<>'"]/g, s => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'
  }[s]));
}

function schemaHintFor(err){
  const msg = String(err?.message || err || '');
  if(/board_moderators/i.test(msg) && /(does not exist|relation|schema cache|could not find|not find)/i.test(msg)){
    return '未找到 board_moderators 表：请先在 Supabase 运行 MIGRATION_20260121_TRAINING_MODERATORS.sql 并 Reload schema。';
  }
  if(/schema cache/i.test(msg)){
    return 'Schema cache 可能未刷新：请在 Supabase Settings → API → Reload schema。';
  }
  return '';
}

async function init(){
  // populate select
  boardSel.innerHTML = BOARD_OPTIONS.map(o => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('');

  if(!isConfigured()){
    need.textContent = '未配置 Supabase：请先填写 supabaseClient.js 中的 URL / anon key。';
    need.hidden = false;
    return;
  }

  await ensureSupabase();
  if(!supabase){
    need.textContent = 'Supabase 客户端初始化失败。';
    need.hidden = false;
    return;
  }

  let user = null;
  try{ user = await getCurrentUser(); }catch(_e){ user = null; }
  if(!user){
    need.textContent = '请先登录后再进行版主管理。';
    need.hidden = false;
    return;
  }

  const profile = await getUserProfile(user.id);
  const role = normalizeRole(profile?.role || user.user_metadata?.role);
  let isAdmin = isAdminRole(role);

  // Fallback: if profile/role couldn't be read (schema cache / missing profiles row), ask DB helper.
  if(!isAdmin){
    try{
      const { data } = await supabase.rpc('is_admin');
      if(data === true) isAdmin = true;
    }catch(_e){ /* ignore */ }
  }

  if(!isAdmin){
    need.textContent = '需要管理员/超级管理员权限才能编辑版主。';
    need.hidden = false;
    return;
  }

  wrap.hidden = false;
  need.hidden = true;

  form.addEventListener('submit', onSubmit);
  autoFillBtn?.addEventListener('click', onAutoFill);
  listEl.addEventListener('click', onListClick);

  await refresh();
}

async function onAutoFill(){
  hint.textContent = '';
  const fd = new FormData(form);
  const user_id = String(fd.get('user_id') || '').trim();
  if(!user_id){
    hint.textContent = '请先填写用户ID（uuid）。';
    return;
  }
  try{
    const { data, error } = await supabase
      .from('profiles')
      .select('full_name, avatar_url')
      .eq('id', user_id)
      .maybeSingle();
    if(error) throw error;
    if(!data){
      hint.textContent = '未找到该用户的 profiles 记录（可能该用户尚未登录/未写入 profiles）。可手动填写展示姓名。';
      return;
    }
    const nameInput = form.querySelector('input[name="display_name"]');
    const avatarInput = form.querySelector('input[name="avatar_url"]');
    if(nameInput && !nameInput.value) nameInput.value = data.full_name || '';
    if(avatarInput && !avatarInput.value) avatarInput.value = data.avatar_url || '';
    hint.textContent = '已自动读取资料（可继续修改）。';
  }catch(e){
    const extra = schemaHintFor(e);
    toast('读取失败', (extra ? extra + ' ' : '') + (String(e?.message || e || '')), 'err');
  }
}

async function onSubmit(e){
  e.preventDefault();
  hint.textContent = '';
  const fd = new FormData(form);
  const board_key = String(fd.get('board_key') || '').trim();
  const user_id = String(fd.get('user_id') || '').trim();
  let display_name = String(fd.get('display_name') || '').trim();
  let avatar_url = String(fd.get('avatar_url') || '').trim();

  if(!board_key || !user_id){
    hint.textContent = '板块与用户ID不能为空。';
    return;
  }

  // if display_name missing, try auto-read once
  if(!display_name){
    try{
      const { data } = await supabase
        .from('profiles')
        .select('full_name, avatar_url')
        .eq('id', user_id)
        .maybeSingle();
      if(data){
        display_name = display_name || (data.full_name || '').trim();
        avatar_url = avatar_url || (data.avatar_url || '').trim();
      }
    }catch(_e){ /* ignore */ }
  }

  try{
    const payload = { board_key, user_id, display_name: display_name || null, avatar_url: avatar_url || null };
    const { error } = await supabase
      .from('board_moderators')
      .upsert(payload, { onConflict: 'board_key,user_id' });
    if(error) throw error;

    toast('成功', '已添加/更新该板块版主。');

    // keep board selection, clear inputs except board
    const nameInput = form.querySelector('input[name="display_name"]');
    const avatarInput = form.querySelector('input[name="avatar_url"]');
    const idInput = form.querySelector('input[name="user_id"]');
    if(idInput) idInput.value = '';
    if(nameInput) nameInput.value = '';
    if(avatarInput) avatarInput.value = '';

    await refresh();
  }catch(e){
    const extra = schemaHintFor(e);
    toast('保存失败', (extra ? extra + ' ' : '') + (String(e?.message || e || '')), 'err');
  }
}

async function refresh(){
  listEl.innerHTML = '<div class="muted small">加载中…</div>';
  try{
    const { data, error } = await supabase
      .from('board_moderators')
      .select('board_key, user_id, display_name, avatar_url, created_at')
      .order('board_key', { ascending: true })
      .order('created_at', { ascending: true });
    if(error) throw error;

    const rows = Array.isArray(data) ? data : [];
    if(rows.length === 0){
      listEl.innerHTML = '<div class="note">尚未设置任何版主。你可以先从“角色管理/权限管理”复制用户ID，然后在此添加。</div>';
      return;
    }

    // group by board
    const groups = new Map();
    for(const r of rows){
      const k = r.board_key || 'unknown';
      if(!groups.has(k)) groups.set(k, []);
      groups.get(k).append(r) if False else None
    }
  }catch(e):
    pass
}
