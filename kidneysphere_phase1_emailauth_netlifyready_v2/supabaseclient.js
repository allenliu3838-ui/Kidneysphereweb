import { SUPABASE_URL, SUPABASE_ANON_KEY } from './assets/config.js';
// NOTE: keep this reasonably up-to-date to ensure compatibility with newer Supabase API keys.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.89.0/+esm';

export const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export function isConfigured(){
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

// Normalize role for permission checks (do NOT trust user_metadata for admin privileges)
export function normalizeRole(role){
  return (role || '').toString().trim().toLowerCase();
}

export function toast(title, message='', type='ok'){
  const el = document.querySelector('[data-toast]');
  if(!el) return alert(`${title}\n${message}`);
  el.className = `toast show ${type === 'err' ? 'err' : 'ok'}`;
  el.innerHTML = `<b>${escapeHtml(title)}</b><div class="small">${escapeHtml(message)}</div>`;
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(()=> el.classList.remove('show'), 4200);
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

/**
 * Minimal profile strategy:
 * - We store user profile in table public.profiles (id uuid = auth.users.id).
 * - If table doesn't exist yet, site still works with auth + user_metadata only.
 * - Later you can enable doctor verification with role = 'Doctor' / 'Verified'.
 */
export async function getUserProfile(user){
  if(!isConfigured() || !supabase) return null;
  try{
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, role, avatar_url')
      .eq('id', user.id)
      .maybeSingle();
    if(error) return null;
    return data || null;
  }catch(e){
    return null;
  }
}

export async function getSession(){
  if(!isConfigured() || !supabase) return null;
  try{
    const { data: { session }, error } = await supabase.auth.getSession();
    if(error) throw error;
    return session || null;
  }catch(_e){
    // Caller (e.g., health.html) can surface the error if needed.
    return null;
  }
}

export async function getCurrentUser(){
  const session = await getSession();
  return session?.user || null;
}

export function isAdminRole(role){
  const r = normalizeRole(role);
  return r === 'admin' || r === 'super_admin' || r === 'owner';
}

export async function ensureAuthed(redirectTo='login.html'){
  if(!isConfigured() || !supabase) return true; // allow demo mode
  let session = null;
  try{
    const res = await supabase.auth.getSession();
    session = res?.data?.session || null;
  }catch(_e){
    session = null;
  }
  if(!session){
    const next = encodeURIComponent((location.pathname.split('/').pop() || 'index.html') + location.search);
    // If caller already provided next=, keep it.
    if(String(redirectTo).includes('next=')){
      location.href = redirectTo;
    }else{
      const join = String(redirectTo).includes('?') ? '&' : '?';
      location.href = `${redirectTo}${join}next=${next}`;
    }
    return false;
  }
  return true;
}

export async function signOut(){
  if(!isConfigured() || !supabase){
    toast('已退出（演示模式）','Supabase 还未配置。','ok');
    location.href = 'index.html';
    return;
  }
  const { error } = await supabase.auth.signOut();
  if(error){
    toast('退出失败', error.message, 'err');
    return;
  }
  toast('已退出','期待你下次回来。','ok');
  setTimeout(()=> location.href='index.html', 600);
}
