/**
 * Netlify Function: video-play-auth
 *
 * Core secured endpoint for video playback authorization.
 * Flow:
 *   1. Authenticate user via Supabase JWT
 *   2. Check video access via check_video_access RPC
 *   3. If authorized, call Aliyun VOD GetPlayInfo API
 *   4. Return temporary signed URL for playback
 *   5. Log the play attempt
 *
 * POST /api/videos/:id/play-auth
 * Headers: Authorization: Bearer <supabase_jwt>
 * Response: { playURL, playerType, expiresIn }
 */

const https = require('https');
const http = require('http');
const { createHmac } = require('crypto');

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

// ── Supabase REST helpers ──
async function sbQuery(path) {
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  return httpRequest(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
}

async function sbRpc(fnName, params, userToken) {
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  return httpRequest(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${userToken || key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(params),
  });
}

async function sbInsert(table, row) {
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  return httpRequest(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
}

// ── Aliyun VOD helpers ──
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

function buildAliyunSignedUrl(params) {
  const sortedKeys = Object.keys(params).sort();
  const canonicalQS = sortedKeys.map(k => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalQS)}`;
  const hmac = createHmac('sha1', ALIYUN_VOD_ACCESS_KEY_SECRET + '&');
  hmac.update(stringToSign);
  const signature = hmac.digest('base64');
  const endpoint = `https://vod.${ALIYUN_VOD_REGION}.aliyuncs.com`;
  return `${endpoint}/?${canonicalQS}&Signature=${percentEncode(signature)}`;
}

async function aliyunGetPlayInfo(videoId) {
  if (!ALIYUN_VOD_ACCESS_KEY_ID || !ALIYUN_VOD_ACCESS_KEY_SECRET) {
    return { error: 'aliyun_not_configured' };
  }

  const params = {
    Action: 'GetPlayInfo',
    VideoId: videoId,
    Formats: '',
    AuthTimeout: '3600',
    Format: 'JSON',
    Version: '2017-03-21',
    AccessKeyId: ALIYUN_VOD_ACCESS_KEY_ID,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: generateNonce(),
    Timestamp: formatISODate(),
  };

  try {
    const url = buildAliyunSignedUrl(params);
    const res = await httpRequest(url);
    const data = await res.json();
    console.log('[video-play-auth] Aliyun GetPlayInfo response:', JSON.stringify(data).substring(0, 200));
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

    const pathMatch = (event.path || '').match(/\/api\/videos\/([^/]+)\/play-auth/);
    if (!pathMatch) {
      return json(400, { error: 'missing_video_id' });
    }
    const videoId = decodeURIComponent(pathMatch[1]);
    console.log('[video-play-auth] videoId:', videoId);

    const token = pickToken(event);
    if (!token) {
      return json(401, { error: 'unauthorized', message: '请先登录。' });
    }

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return json(500, { error: 'server_not_configured' });
    }

    // 1. Authenticate user
    const userRes = await httpRequest(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) {
      return json(401, { error: 'invalid_token', message: '登录已过期，请重新登录。' });
    }
    const user = await userRes.json();
    console.log('[video-play-auth] user authenticated:', user.id);

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
    console.log('[video-play-auth] video:', video.id, 'aliyun_vid:', video.aliyun_vid, 'kind:', video.kind);

    // 3. Access check
    const accessType = video.access_type || (video.is_paid ? 'paid_single' : 'registered_free');
    let canPlay = false;

    if (accessType === 'registered_free') {
      canPlay = true;
    } else {
      const rpcRes = await sbRpc('check_video_access', {
        p_user_id: user.id,
        p_video_id: videoId,
        p_specialty_id: video.specialty_id || null,
      }, token);
      if (rpcRes.ok) {
        canPlay = await rpcRes.json();
      }
    }

    // Log the attempt (fire and forget)
    sbInsert('play_logs', {
      user_id: user.id,
      video_id: videoId,
      status: canPlay ? 'authorized' : 'denied',
      ip: ip,
      user_agent: (event.headers || {})['user-agent'] || '',
    }).catch(() => {});

    if (!canPlay) {
      return json(403, {
        error: 'access_denied',
        message: '你尚未获得该视频的观看权限。',
        needPurchase: true,
      });
    }

    console.log('[video-play-auth] access granted, generating playback URL...');

    // 4. Generate playback authorization

    // Bilibili videos
    if (video.kind === 'bilibili' && video.bvid) {
      return json(200, {
        playerType: 'bilibili',
        bvid: video.bvid,
        title: video.title || '',
      });
    }

    // Aliyun VOD signed URL
    const aliyunVid = video.aliyun_vid;
    if (aliyunVid && ALIYUN_VOD_ACCESS_KEY_ID && ALIYUN_VOD_ACCESS_KEY_SECRET) {
      const playInfo = await aliyunGetPlayInfo(aliyunVid);
      if (playInfo.playURL) {
        console.log('[video-play-auth] returning Aliyun signed URL');
        return json(200, {
          playerType: 'signed_url',
          playURL: playInfo.playURL,
          format: playInfo.format || 'mp4',
          duration: playInfo.duration || 0,
          expiresIn: 3600,
        });
      }
      console.log('[video-play-auth] Aliyun GetPlayInfo failed:', playInfo.error, playInfo.message);
    }

    // Fallback: direct URL
    const fallbackUrl = video.mp4_url || video.source_url || '';
    if (fallbackUrl) {
      console.log('[video-play-auth] returning fallback URL');
      return json(200, {
        playerType: 'direct_url',
        playURL: fallbackUrl,
        format: 'mp4',
        expiresIn: 0,
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
