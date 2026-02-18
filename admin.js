import {
  supabase,
  ensureSupabase,
  isConfigured,
  getCurrentUser,
  getUserProfile,
  normalizeRole,
  isAdminRole,
  toast,
} from './supabaseClient.js?v=20260128_030';

const gate = document.getElementById('adminGate');

async function initAdminGate(){
  if(!gate) return;

  if(isConfigured() && !supabase){
    await ensureSupabase();
  }

  if(!isConfigured() || !supabase){
    gate.innerHTML = '<b>演示模式：</b>未配置 Supabase，无法进入管理后台。';
    return;
  }

  try{
    const u = await getCurrentUser();
    if(!u){
      gate.innerHTML = '请先 <a href="login.html?next=admin.html">登录</a> 管理员账号。';
      return;
    }
    const p = await getUserProfile(u);
    const role = normalizeRole(p?.role || u?.user_metadata?.role);
    const ok = isAdminRole(role);

    if(!ok){
      gate.innerHTML = '当前账号无管理员权限。请切换管理员/超级管理员账号后再试。';
      return;
    }

    gate.textContent = '已登录管理员：你可以在下方管理内容。';

    // If hash provided, scroll to section
    const h = String(location.hash || '');
    if(h && h.length > 1){
      const el = document.getElementById(h.replace('#',''));
      if(el) el.scrollIntoView({ behavior:'smooth', block:'start' });
    }
  }catch(e){
    gate.textContent = '无法读取登录状态：' + (e?.message || String(e));
    toast('管理后台初始化失败', e?.message || String(e), 'err');
  }
}

initAdminGate();
