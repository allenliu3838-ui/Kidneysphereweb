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
    location.replace('index.html');
    return;
  }

  try{
    const u = await getCurrentUser();
    if(!u){
      location.replace('login.html?next=' + encodeURIComponent(location.pathname.split('/').pop() + location.search + location.hash));
      return;
    }
    const p = await getUserProfile(u);
    const role = normalizeRole(p?.role || u?.user_metadata?.role);
    const ok = isAdminRole(role);

    if(!ok){
      location.replace('index.html');
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
    location.replace('login.html?next=' + encodeURIComponent(location.pathname.split('/').pop()));
  }
}

initAdminGate();
