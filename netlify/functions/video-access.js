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

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

const json = (statusCode, payload) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
  body: JSON.stringify(payload),
});

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

async function sbQuery(path) {
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
}

exports.handler = async (event) => {
  try {
    const ip = getClientIp(event);
    if (!rateCheck(ip)) return json(429, { error: 'rate_limited' });

    if (event.httpMethod !== 'GET') return json(405, { error: 'method_not_allowed' });

    // Extract video ID from path
    const pathMatch = (event.path || '').match(/\/api\/videos\/([^/]+)\/access/);
    if (!pathMatch) return json(400, { error: 'missing_video_id' });
    const videoId = decodeURIComponent(pathMatch[1]);

    if (!SUPABASE_URL) return json(500, { error: 'server_not_configured' });

    // Fetch video info (no sensitive URLs)
    const videoRes = await sbQuery(
      `learning_videos?id=eq.${encodeURIComponent(videoId)}&select=id,title,access_type,price,cover_image,description,speaker,category,kind,bvid,specialty_id,product_id,aliyun_vid,is_paid,membership_accessible,is_published,deleted_at&limit=1`
    );
    if (!videoRes.ok) return json(500, { error: 'db_error' });
    const videos = await videoRes.json();
    const video = videos?.[0];

    if (!video || video.deleted_at) return json(404, { error: 'video_not_found' });
    if (!video.is_published && video.is_published !== null) return json(404, { error: 'video_not_published' });

    const accessType = video.access_type || (video.is_paid ? 'paid_single' : 'registered_free');

    // Check user auth
    const token = pickToken(event);
    let user = null;
    if (token) {
      const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      });
      if (userRes.ok) user = await userRes.json();
    }

    let canPlay = false;
    let needLogin = false;
    let needPurchase = false;
    let reason = '';

    if (!user) {
      needLogin = true;
      if (accessType === 'registered_free') {
        reason = 'login_required';
      } else {
        reason = 'login_then_purchase';
        needPurchase = true;
      }
    } else if (accessType === 'registered_free') {
      canPlay = true;
      reason = 'free';
    } else {
      // Check access via service role RPC
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_video_access`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          p_user_id: user.id,
          p_video_id: videoId,
          p_specialty_id: video.specialty_id || null,
        }),
      });
      if (rpcRes.ok) {
        canPlay = await rpcRes.json();
      }
      if (canPlay) {
        reason = 'entitled';
      } else {
        needPurchase = true;
        reason = 'purchase_required';
      }
    }

    // Build safe video info (no URLs!)
    // Include kind/bvid so frontend can render bilibili iframe directly
    const safeVideo = {
      id: video.id,
      title: video.title,
      accessType: accessType,
      price: video.price || 0,
      coverImage: video.cover_image || '',
      description: video.description || '',
      speaker: video.speaker || '',
      category: video.category || '',
      kind: video.kind || 'external',
      bvid: video.bvid || null,
      specialtyId: video.specialty_id || null,
      productId: video.product_id || null,
      hasAliyunVod: !!(video.aliyun_vid),
      membershipAccessible: video.membership_accessible || false,
    };

    return json(200, {
      canPlay,
      needLogin,
      needPurchase,
      reason,
      video: safeVideo,
    });
  } catch (e) {
    console.error('[video-access] error:', e);
    return json(500, { error: 'internal_error', message: String(e?.message || e) });
  }
};
