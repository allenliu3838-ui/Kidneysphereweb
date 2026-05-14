/**
 * GET /api/atlas/assets/:id/url
 * Returns short-lived signed URL for Pro HD asset when authorized.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) };
}

function getToken(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

async function sbFetch(path, opt = {}, useServiceRole = false) {
  const key = useServiceRole ? SUPABASE_SERVICE_ROLE_KEY : SUPABASE_ANON_KEY;
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opt,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(opt.headers || {}),
    },
  });
}

async function getUser(token) {
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return r.json();
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') return json(405, { error: 'method_not_allowed' });
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'server_not_configured' });

    const match = (event.path || '').match(/\/api\/atlas\/assets\/([^/]+)\/url/);
    const assetId = match?.[1];
    if (!assetId) return json(400, { error: 'missing_asset_id' });

    const token = getToken(event);
    const user = await getUser(token);

    const assetRes = await sbFetch(`atlas_assets?id=eq.${encodeURIComponent(assetId)}&select=id,series_id,image_path,preview_image_path,thumbnail_path,visibility,is_preview&limit=1`);
    const assets = await assetRes.json();
    const asset = assets?.[0];
    if (!asset) return json(404, { error: 'asset_not_found' });

    const seriesRes = await sbFetch(`atlas_series?id=eq.${encodeURIComponent(asset.series_id)}&select=id,visibility,status&limit=1`);
    const series = (await seriesRes.json())?.[0];
    if (!series || series.status !== 'published' || series.visibility === 'hidden') return json(404, { error: 'series_not_available' });

    // Free path
    if (asset.visibility === 'free' || series.visibility === 'free' || asset.is_preview) {
      return json(200, { access: 'preview', url: asset.preview_image_path || asset.thumbnail_path || null });
    }

    if (!user) return json(401, { error: 'login_required' });

    // Admin or atlas entitlement
    const profileRes = await sbFetch(`profiles?id=eq.${encodeURIComponent(user.id)}&select=role&limit=1`, {}, true);
    const role = ((await profileRes.json())?.[0]?.role || '').toLowerCase();
    const isAdmin = ['admin', 'super_admin', 'owner'].includes(role);

    let entitled = isAdmin;
    if (!entitled) {
      const now = new Date().toISOString();
      const entRes = await sbFetch(`user_entitlements?user_id=eq.${encodeURIComponent(user.id)}&status=eq.active&entitlement_type=in.(atlas_pro,membership)&or=(end_at.is.null,end_at.gt.${encodeURIComponent(now)})&select=id&limit=1`, {}, true);
      const ent = await entRes.json();
      entitled = !!ent?.length;
    }
    if (!entitled) return json(403, { error: 'entitlement_required' });

    if (!asset.image_path) return json(404, { error: 'hd_asset_missing' });

    const body = { paths: [asset.image_path], expiresIn: 120 };
    const signRes = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/atlas_hd`, { method: 'POST', headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!signRes.ok) return json(500, { error: 'sign_failed' });
    const signed = await signRes.json();
    const signedPath = signed?.signedURL || signed?.[0]?.signedURL || null;
    if (!signedPath) return json(500, { error: 'sign_empty' });

    return json(200, { access: 'pro', signedURL: `${SUPABASE_URL}/storage/v1${signedPath}`, expiresIn: 120 });
  } catch (e) {
    return json(500, { error: 'internal_error', message: String(e?.message || e) });
  }
};
