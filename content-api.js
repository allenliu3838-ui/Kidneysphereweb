import { supabase, ensureSupabase, getCurrentUser } from './supabaseClient.js?v=20260401_fix';

async function getAuthToken(){
  await ensureSupabase();
  const sess = await supabase?.auth?.getSession?.();
  return sess?.data?.session?.access_token || '';
}

async function apiFetch(path){
  const token = await getAuthToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(path, { headers });
  const data = await res.json().catch(()=> ({}));
  if(!res.ok){
    const err = new Error(data?.error || 'api_error');
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export async function fetchContentList(params={}){
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k,v])=>{
    if(v !== undefined && v !== null && String(v).trim() !== '') q.set(k, String(v));
  });
  return apiFetch(`/api/content${q.toString() ? `?${q}` : ''}`);
}

export async function fetchContentById(id, mode='preview'){
  const safeMode = mode === 'full' ? 'full' : 'preview';
  return apiFetch(`/api/content/${encodeURIComponent(id)}?mode=${safeMode}`);
}

export async function fetchMe(){
  try{
    return await apiFetch('/api/me');
  }catch(e){
    // 401 = unauthenticated — return guest payload for backward compatibility
    if(e?.status === 401 && e?.payload) return e.payload;
    throw e;
  }
}

export async function isLoggedIn(){
  return Boolean(await getCurrentUser());
}
