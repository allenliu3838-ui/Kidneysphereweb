/**
 * Netlify Function: video-play-auth
 *
 * Core secured endpoint for video playback authorization.
 * Flow:
 *   1. Authenticate user via Supabase JWT
 *   2. Check video access via check_video_access RPC
 *   3. If authorized, call Aliyun VOD GetVideoPlayAuth API
 *   4. Return temporary playAuth token (valid ~100s by default)
 *   5. Log the play attempt
 *
 * POST /api/videos/:id/play-auth
 * Headers: Authorization: Bearer <supabase_jwt>
 * Response: { playAuth, videoId, playerType, expiresIn }
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const ALIYUN_VOD_ACCESS_KEY_ID = process.env.ALIYUN_VOD_ACCESS_KEY_ID || '';
const ALIYUN_VOD_ACCESS_KEY_SECRET = process.env.ALIYUN_VOD_ACCESS_KEY_SECRET || '';
const ALIYUN_VOD_REGION = process.env.ALIYUN_VOD_REGION || 'cn-shanghai';

const json = (statusCode, payload) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
  body: JSON.stringify(payload),
});

// ── Rate limiter ──
const rateMap = new Map();
function rateCheck(ip, maxPerMin = 30) {
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now - entry.ts > 60000) {
    entry = { ts: now, count: 0 };
    rateMap.set(ip, entry);
  }
  entry.count++;
  if (rateMap.size > 5000) {
    for (const [k, v] of rateMap) { if (now - v.ts > 60000) rateMap.delete(k); }
  }
  return entry.count <= maxPerMin;
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

// ── Supabase REST helper (service role) ──
async function sbQuery(path) {
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  });
  return res;
}

async function sbRpc(fnName, params, userToken) {
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  // Use user's token so auth.uid() works inside the function
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${userToken || key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(params),
  });
  return res;
}

async function sbInsert(table, row) {
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
  return res;
}

// ── Aliyun VOD: GetVideoPlayAuth ──
// Uses HMAC-SHA1 signature per Alibaba Cloud OpenAPI spec
const { createHmac } = require('crypto');

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function formatISODate() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function generateNonce() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function aliyunGetVideoPlayAuth(videoId, authTimeout = 3000) {
  if (!ALIYUN_VOD_ACCESS_KEY_ID || !ALIYUN_VOD_ACCESS_KEY_SECRET) {
    return { error: 'aliyun_not_configured' };
  }

  const params = {
    Action: 'GetVideoPlayAuth',
    VideoId: videoId,
    AuthInfoTimeout: String(authTimeout), // seconds, default 3000 (~50min)
    Format: 'JSON',
    Version: '2017-03-21',
    AccessKeyId: ALIYUN_VOD_ACCESS_KEY_ID,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: generateNonce(),
    Timestamp: formatISODate(),
  };

  // Build canonical query string (sorted)
  const sortedKeys = Object.keys(params).sort();
  const canonicalQS = sortedKeys.map(k => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');

  // String to sign
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalQS)}`;

  // HMAC-SHA1 with key = AccessKeySecret + "&"
  const hmac = createHmac('sha1', ALIYUN_VOD_ACCESS_KEY_SECRET + '&');
  hmac.update(stringToSign);
  const signature = hmac.digest('base64');

  // Build request URL
  const endpoint = `https://vod.${ALIYUN_VOD_REGION}.aliyuncs.com`;
  const url = `${endpoint}/?${canonicalQS}&Signature=${percentEncode(signature)}`;

  try {
    const res = await fetch(url, { method: 'GET' });
    const data = await res.json();
    if (data.PlayAuth) {
      return {
        playAuth: data.PlayAuth,
        videoMeta: data.VideoMeta || {},
      };
    }
    return { error: data.Code || 'aliyun_error', message: data.Message || '' };
  } catch (e) {
    return { error: 'aliyun_fetch_failed', message: String(e?.message || e) };
  }
}

// ── Aliyun VOD: GetVideoInfo (for fallback signed URL) ──
async function aliyunGetVideoInfo(videoId) {
  if (!ALIYUN_VOD_ACCESS_KEY_ID || !ALIYUN_VOD_ACCESS_KEY_SECRET) {
    return { error: 'aliyun_not_configured' };
  }

  const params = {
    Action: 'GetPlayInfo',
    VideoId: videoId,
    Formats: '',
    AuthTimeout: '3600', // 1 hour signed URL
    Format: 'JSON',
    Version: '2017-03-21',
    AccessKeyId: ALIYUN_VOD_ACCESS_KEY_ID,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: generateNonce(),
    Timestamp: formatISODate(),
  };

  const sortedKeys = Object.keys(params).sort();
  const canonicalQS = sortedKeys.map(k => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalQS)}`;
  const hmac = createHmac('sha1', ALIYUN_VOD_ACCESS_KEY_SECRET + '&');
  hmac.update(stringToSign);
  const signature = hmac.digest('base64');

  const endpoint = `https://vod.${ALIYUN_VOD_REGION}.aliyuncs.com`;
  const url = `${endpoint}/?${canonicalQS}&Signature=${percentEncode(signature)}`;

  try {
    const res = await fetch(url, { method: 'GET' });
    const data = await res.json();
    if (data.PlayInfoList?.PlayInfo?.length > 0) {
      const info = data.PlayInfoList.PlayInfo[0];
      return {
        playURL: info.PlayURL,
        format: info.Format,
        duration: info.Duration,
        definition: info.Definition,
      };
    }
    return { error: data.Code || 'no_play_info', message: data.Message || '' };
  } catch (e) {
    return { error: 'aliyun_fetch_failed', message: String(e?.message || e) };
  }
}

// ── Main handler ──
exports.handler = async (event) => {
  console.log('[video-play-auth] invoked, path:', event.path, 'method:', event.httpMethod);
  console.log('[video-play-auth] env: SUPABASE_URL=', SUPABASE_URL ? 'SET' : 'MISSING',
    'ANON_KEY=', SUPABASE_ANON_KEY ? 'SET' : 'MISSING',
    'ALIYUN_KEY_ID=', ALIYUN_VOD_ACCESS_KEY_ID ? 'SET' : 'MISSING',
    'ALIYUN_SECRET=', ALIYUN_VOD_ACCESS_KEY_SECRET ? 'SET' : 'MISSING');
  try {
    const ip = getClientIp(event);
    if (!rateCheck(ip, 20)) {
      return json(429, { error: 'rate_limited', message: '请求过于频繁，请稍后再试。' });
    }

    if (event.httpMethod !== 'POST') {
      return json(405, { error: 'method_not_allowed' });
    }

    // Extract video ID from path: /api/videos/:id/play-auth
    const pathMatch = (event.path || '').match(/\/api\/videos\/([^/]+)\/play-auth/);
    if (!pathMatch) {
      return json(400, { error: 'missing_video_id' });
    }
    const videoId = decodeURIComponent(pathMatch[1]);

    // 1. Authenticate user
    const token = pickToken(event);
    if (!token) {
      return json(401, { error: 'unauthorized', message: '请先登录。' });
    }

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return json(500, { error: 'server_not_configured' });
    }

    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) {
      return json(401, { error: 'invalid_token', message: '登录已过期，请重新登录。' });
    }
    const user = await userRes.json();

    // 2. Fetch video info
    const videoRes = await sbQuery(
      `learning_videos?id=eq.${encodeURIComponent(videoId)}&select=id,title,access_type,aliyun_vid,source_url,mp4_url,bvid,kind,specialty_id,is_published,deleted_at,is_paid,membership_accessible&limit=1`
    );
    if (!videoRes.ok) {
      return json(500, { error: 'db_error' });
    }
    const videos = await videoRes.json();
    const video = videos?.[0];
    if (!video || video.deleted_at) {
      return json(404, { error: 'video_not_found' });
    }
    if (!video.is_published && video.is_published !== null) {
      return json(403, { error: 'video_not_published' });
    }

    // 3. Access check
    const accessType = video.access_type || (video.is_paid ? 'paid_single' : 'registered_free');
    let canPlay = false;

    if (accessType === 'registered_free') {
      canPlay = true;
    } else {
      // Call check_video_access RPC with user's token
      const rpcRes = await sbRpc('check_video_access', {
        p_user_id: user.id,
        p_video_id: videoId,
        p_specialty_id: video.specialty_id || null,
      }, token);
      if (rpcRes.ok) {
        canPlay = await rpcRes.json();
      }
    }

    // Log the attempt
    const logRow = {
      user_id: user.id,
      video_id: videoId,
      status: canPlay ? 'authorized' : 'denied',
      ip: ip,
      user_agent: (event.headers || {})['user-agent'] || '',
    };
    // Fire and forget — don't block response
    sbInsert('play_logs', logRow).catch(() => {});

    if (!canPlay) {
      return json(403, {
        error: 'access_denied',
        message: '你尚未获得该视频的观看权限。',
        needPurchase: true,
      });
    }

    // 4. Generate playback authorization

    // Bilibili videos: return bvid for iframe embed
    if (video.kind === 'bilibili' && video.bvid) {
      return json(200, {
        playerType: 'bilibili',
        bvid: video.bvid,
        title: video.title || '',
      });
    }

    const aliyunVid = video.aliyun_vid;

    if (aliyunVid && ALIYUN_VOD_ACCESS_KEY_ID && ALIYUN_VOD_ACCESS_KEY_SECRET) {
      // Use GetPlayInfo to get a temporary signed URL (works with native HTML5 video)
      // PlayAuth requires Aliplayer SDK License, so we prefer signed URLs
      const playInfo = await aliyunGetVideoInfo(aliyunVid);
      if (playInfo.playURL) {
        return json(200, {
          playerType: 'signed_url',
          playURL: playInfo.playURL,
          format: playInfo.format || 'mp4',
          duration: playInfo.duration || 0,
          expiresIn: 3600,
        });
      }
      // If GetPlayInfo fails, fall through to mp4_url fallback below
    }

    // Fallback: return source_url/mp4_url as temporary authorized URL
    // This is for videos not yet migrated to Aliyun VOD
    const fallbackUrl = video.mp4_url || video.source_url || '';
    if (fallbackUrl) {
      return json(200, {
        playerType: 'direct_url',
        playURL: fallbackUrl,
        format: 'mp4',
        expiresIn: 0,
        _warning: 'Using direct URL fallback. Migrate to Aliyun VOD for secure playback.',
      });
    }

    return json(500, {
      error: 'no_playback_source',
      message: '该视频没有可用的播放源。',
    });

  } catch (e) {
    console.error('[video-play-auth] error:', e);
    return json(500, { error: 'internal_error', message: String(e?.message || e) });
  }
};
