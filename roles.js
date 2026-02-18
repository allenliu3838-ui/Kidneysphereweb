import {
  getSupabase,
  getCurrentUser,
  getUserProfile,
} from './supabaseClient.js?v=20260128_030';

const input = document.getElementById('roleSearchInput');
const searchBtn = document.getElementById('roleSearchBtn');
const refreshBtn = document.getElementById('roleRefreshBtn');
const list = document.getElementById('roleSearchResults');

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function isUuid(s){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s||'').trim());
}

function roleLabel(r){
  const x = String(r||'').toLowerCase();
  if(x === 'super_admin') return '超级管理员';
  if(x === 'admin') return '管理员';
  if(x === 'moderator') return '版主';
  if(x === 'member') return '成员';
  return r || 'member';
}

function renderUserRow(p){
  const id = p.id;
  const name = p.full_name || '(未填写姓名)';
  const role = String(p.role || 'member');

  return `
    <div class="list-item">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap">
        <div style="min-width:260px">
          <b>${esc(name)}</b>
          <div class="small muted" style="margin-top:6px;word-break:break-all">${esc(id)}</div>
          <div class="small muted" style="margin-top:6px">当前角色：<b>${esc(roleLabel(role))}</b></div>
        </div>

        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <select class="input roleSelect" data-user-id="${esc(id)}" style="min-width:160px">
            <option value="member" ${role==='member'?'selected':''}>member（成员）</option>
            <option value="moderator" ${role==='moderator'?'selected':''}>moderator（版主）</option>
            <option value="admin" ${role==='admin'?'selected':''}>admin（管理员）</option>
            <option value="super_admin" ${role==='super_admin'?'selected':''}>super_admin（超管）</option>
          </select>
          <button class="btn roleSaveBtn" data-user-id="${esc(id)}" type="button">保存</button>
          <button class="btn roleCopyBtn" data-user-id="${esc(id)}" type="button">复制ID</button>
        </div>
      </div>
    </div>
  `;
}

function setListLoading(msg='加载中…'){
  if(list) list.innerHTML = `<div class="muted small">${esc(msg)}</div>`;
}

function setListEmpty(msg='暂无结果。'){
  if(list) list.innerHTML = `<div class="muted small">${esc(msg)}</div>`;
}

async function setUserRole(supabase, targetId, newRole){
  // Prefer RPC (recommended): public.set_user_role(target_user uuid, new_role text)
  const r1 = await supabase.rpc('set_user_role', { target_user: targetId, new_role: newRole });
  if(!r1.error) return;

  const msg = String(r1.error.message || '');
  // Backward compatibility fallback: direct update (may be blocked by RLS)
  if(msg.toLowerCase().includes('function') || msg.toLowerCase().includes('rpc') || msg.toLowerCase().includes('not found')){
    const r2 = await supabase.from('profiles').update({ role: newRole }).eq('id', targetId);
    if(r2.error) throw r2.error;
    return;
  }
  throw r1.error;
}

async function loadUsers(){
  if(!list) return;
  setListLoading();

  const supabase = await getSupabase();
  const user = await getCurrentUser();
  if(!user){
    setListEmpty('未登录。');
    return;
  }

  const me = await getUserProfile(user.id);
  const myRole = String(me?.role || '').toLowerCase();

  // Toggle super-admin-only UI
  document.querySelectorAll('[data-super-only]').forEach(el=>{
    el.hidden = (myRole !== 'super_admin');
  });

  if(myRole !== 'super_admin'){
    setListEmpty(`你当前角色为：${roleLabel(myRole)}。只有超级管理员可管理权限。`);
    return;
  }

  const q = String(input?.value || '').trim();

  try{
    let query = supabase.from('profiles').select('id, full_name, role, avatar_url, updated_at');
    // Backward compatibility: some older schemas may not have updated_at on profiles.
    // If the first query fails due to missing column, we'll retry with a smaller column set.

    if(q){
      if(isUuid(q)){
        query = query.eq('id', q);
      }else{
        // We only have full_name in profiles by default. (email is in auth.users, not exposed)
        query = query.ilike('full_name', `%${q}%`);
      }
    }

    const { data, error } = await query.order('updated_at', { ascending: false }).limit(30);
    if(error) throw error;

    const items = data || [];
    if(items.length === 0){
      setListEmpty('暂无结果。可尝试输入用户ID（UUID）或姓名关键字。');
      return;
    }

    list.innerHTML = items.map(renderUserRow).join('');

    // wire buttons
    list.querySelectorAll('.roleCopyBtn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = btn.getAttribute('data-user-id');
        if(!id) return;
        navigator.clipboard?.writeText(id);
        btn.textContent = '已复制';
        setTimeout(()=> btn.textContent='复制ID', 900);
      });
    });

    list.querySelectorAll('.roleSaveBtn').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const id = btn.getAttribute('data-user-id');
        const sel = list.querySelector(`select.roleSelect[data-user-id="${CSS.escape(id)}"]`);
        const newRole = sel ? sel.value : '';
        if(!id || !newRole) return;

        btn.disabled = true;
        const oldText = btn.textContent;
        btn.textContent = '保存中…';
        try{
          await setUserRole(supabase, id, newRole);
          btn.textContent = '已保存';
          setTimeout(()=> btn.textContent = oldText, 900);
        }catch(e){
          alert(`保存失败：${e?.message || String(e)}`);
          btn.textContent = oldText;
        }finally{
          btn.disabled = false;
        }
      });
    });

  }catch(e){
    setListEmpty(`加载失败：${e?.message || String(e)}\n\n提示：请确认 Supabase 已运行 MIGRATION_20260107_NEXT.sql，并已刷新 schema。`);
  }
}

searchBtn?.addEventListener('click', loadUsers);
refreshBtn?.addEventListener('click', loadUsers);
input?.addEventListener('keydown', (e)=>{ if(e.key==='Enter') loadUsers(); });

// Auto-init
loadUsers();
