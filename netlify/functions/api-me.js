const json = (statusCode, payload) => ({ statusCode, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) });

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

function pickToken(event){
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  if(/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

async function sb(path){
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY}`,
      Accept: 'application/json',
    },
  });
  return res;
}

exports.handler = async (event) => {
  try{
    const token = pickToken(event);
    if(!token || !SUPABASE_URL || !SUPABASE_ANON_KEY){
      return json(200, { user: null, membership: null, permissions: ['guest'], role: 'guest' });
    }

    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if(!userRes.ok) return json(200, { user: null, membership: null, permissions: ['guest'], role: 'guest' });

    const user = await userRes.json();
    const pid = encodeURIComponent(user.id);

    const [profileRes, memberRes] = await Promise.all([
      sb(`profiles?id=eq.${pid}&select=role,full_name,membership_status&limit=1`),
      sb(`memberships?user_id=eq.${pid}&select=status,current_period_end,plan_id,provider&limit=1`),
    ]);

    const profile = profileRes.ok ? (await profileRes.json())?.[0] : null;
    const membership = memberRes.ok ? (await memberRes.json())?.[0] : null;

    let role = String(profile?.role || '').toLowerCase() || 'member';
    const permissions = new Set(['member']);
    if(['admin','owner'].includes(role)) permissions.add('admin');
    if(['admin','owner','editor'].includes(role)) permissions.add('editor');

    const membershipActive = membership?.status === 'active' || String(profile?.membership_status || '').toLowerCase() === 'member';
    if(membershipActive) permissions.add('member');

    return json(200, {
      user: { id: user.id, email: user.email || null, full_name: profile?.full_name || null },
      membership: membership || null,
      permissions: Array.from(permissions),
      role,
    });
  }catch(e){
    return json(500, { error: 'internal_error', message: e?.message || String(e) });
  }
};
