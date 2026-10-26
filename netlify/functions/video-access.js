/**
 * Netlify Function: video-access
 *
 * Returns access status for a video, including whether the user can play it.
 * Does NOT return any playback URL/auth — that's handled by video-play-auth.
 *
 * GET /api/videos/:id/access
 * Headers: Authorization: Bearer <supabase_jwt> (optional)
 * Response: { canPlay, needLogin, needPurchase, reason, video: {...} }
 */

const https = require('https');
const http = require('http');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

const json = (statusCode, payload) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
  body: JSON.stringify(payload),
});

// ── HTTP helper using Node built-in modules (no fetch dependency) ──
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = mod.request(reqOptions, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusCode: res.statusCode,
          text: () => Promise.resolve(body),
          json: () => Promise.resolve(JSON.parse(body)),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

const rateMap = new Map();
function rateCheck(ip) {
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now - entry.ts > 60000) { entry = { ts: now, count: 0 }; rateMap.set(ip, entry); }
  entry.count++;
  if (rateMap.size > 5000) { for (const [k, v] of rateMap) { if (now - v.ts > 60000) rateMap.delete(k); } }
  return entry.count <= 60;
}

function getClientIp(event) {
  const h = event.headers || {};
  return h['x-nf-client-connection-ip'] || h['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

function pickToken(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

// PostgREST verifies the JWT and the RPC binds authorization to auth.uid().
// Never decode an unverified token here or read original media locators.
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') return json(405, { error: 'method_not_allowed' });
    if (!rateCheck(getClientIp(event))) return json(429, { error: 'rate_limited' });
    const match = (event.path || '').match(/\/api\/videos\/([^/]+)\/access\/?$/);
    if (!match) return json(400, { error: 'missing_video_id' });
    let videoId;
    try { videoId = decodeURIComponent(match[1]); } catch (_) { return json(400, { error: 'invalid_video_id' }); }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(videoId)) {
      return json(400, { error: 'invalid_video_id' });
    }
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json(503, { error: 'server_not_configured' });
    const token = pickToken(event);
    if (token.length > 8192) return json(401, { error: 'invalid_token', canPlay: false, needLogin: true });
    const response = await httpRequest(`${SUPABASE_URL}/rest/v1/rpc/get_video_access_info`, {
      method: 'POST', headers: { apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ p_video_id: videoId }),
    });
    if (response.status === 401 || response.status === 403) return json(401, {
      error: 'invalid_token', canPlay: false, needLogin: true,
    });
    if (!response.ok) return json(503, { error: 'access_check_unavailable', canPlay: false });
    const result = await response.json();
    if (result?.error === 'not_found') return json(404, { error: 'video_not_found', canPlay: false });
    const row = result?.video;
    if (!row || !['unclassified','weekly_replay','training','other_paid'].includes(row.membershipScope) ||
      typeof result.canPlay !== 'boolean') return json(503, { error: 'access_schema_not_ready', canPlay: false });
    const video = {};
    for (const field of ['id','title','accessType','price','coverImage','description','speaker','category',
      'specialtyId','productId','membershipScope','hasAliyunVod','membershipAccessible']) {
      if (Object.hasOwn(row, field)) video[field] = row[field];
    }
    return json(200, { canPlay: !!token && result.canPlay === true,
      needLogin: !token || result.needLogin === true, needPurchase: result.needPurchase === true,
      reason: typeof result.reason === 'string' ? result.reason : 'access_check', video });
  } catch (_) {
    return json(503, { error: 'access_check_unavailable', canPlay: false });
  }
};
