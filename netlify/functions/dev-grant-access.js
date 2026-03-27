/**
 * Netlify Function: dev-grant-access
 *
 * Development/admin utility to manually grant video access.
 * Allows testing the paid video flow without real payment.
 *
 * POST /api/dev/grant-access
 * Headers: Authorization: Bearer <supabase_jwt> (must be admin)
 * Body: { userId, videoId, specialtyId?, entitlementType?, durationDays? }
 *
 * IMPORTANT: This should only be enabled in development/staging.
 * In production, entitlements are granted by admin_approve_order RPC.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

const json = (statusCode, payload) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(payload),
});

function pickToken(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

async function sbQuery(path) {
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
}

async function sbInsert(table, row) {
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  return fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      Accept: 'application/json',
    },
    body: JSON.stringify(row),
  });
}

exports.handler = async (event) => {
  try {
    // Production safety: require DEV_GRANT_ENABLED=true environment variable
    // Without this, the endpoint returns 404 (as if it doesn't exist)
    const enabled = String(process.env.DEV_GRANT_ENABLED || '').toLowerCase();
    if (enabled !== 'true' && enabled !== '1') {
      return json(404, { error: 'not_found' });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

    const token = pickToken(event);
    if (!token) return json(401, { error: 'unauthorized' });
    if (!SUPABASE_URL) return json(500, { error: 'server_not_configured' });

    // Verify user is admin
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return json(401, { error: 'invalid_token' });
    const user = await userRes.json();

    const profileRes = await sbQuery(`profiles?id=eq.${encodeURIComponent(user.id)}&select=role&limit=1`);
    const profiles = profileRes.ok ? await profileRes.json() : [];
    const role = String(profiles?.[0]?.role || '').toLowerCase();
    if (!['admin', 'super_admin', 'owner'].includes(role)) {
      return json(403, { error: 'admin_only', message: '仅管理员可使用此接口。' });
    }

    // Parse body
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const targetUserId = body.userId || user.id; // Default to self
    const videoId = body.videoId;
    const specialtyId = body.specialtyId || null;
    const entitlementType = body.entitlementType || 'single_video';
    const durationDays = body.durationDays || null; // null = permanent

    if (!videoId && !specialtyId && entitlementType === 'single_video') {
      return json(400, { error: 'missing_params', message: '请提供 videoId 或 specialtyId。' });
    }

    // Build entitlement row
    const now = new Date();
    const endAt = durationDays ? new Date(now.getTime() + durationDays * 86400000).toISOString() : null;

    const entRow = {
      user_id: targetUserId,
      entitlement_type: entitlementType,
      start_at: now.toISOString(),
      end_at: endAt,
      status: 'active',
      granted_by: user.id,
      grant_reason: 'dev_manual_grant',
    };

    if (entitlementType === 'single_video' && videoId) entRow.video_id = videoId;
    if (specialtyId) entRow.specialty_id = specialtyId;

    const insertRes = await sbInsert('user_entitlements', entRow);
    if (!insertRes.ok) {
      const err = await insertRes.text();
      return json(500, { error: 'insert_failed', detail: err });
    }

    const created = await insertRes.json();
    return json(200, {
      success: true,
      message: `已为用户 ${targetUserId} 授予 ${entitlementType} 权限。`,
      entitlement: created?.[0] || created,
    });

  } catch (e) {
    console.error('[dev-grant-access] error:', e);
    return json(500, { error: 'internal_error', message: String(e?.message || e) });
  }
};
