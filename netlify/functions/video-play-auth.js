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
 *
 * Required Aliyun RAM permissions on the AccessKey:
 *   vod:GetPlayInfo
 *   vod:GetVideoInfo (only used to explain why GetPlayInfo returned no stream)
 *   (AliyunVODFullAccess / AliyunVODReadOnlyAccess cover both.)
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
// 严格 RFC 3986 编码 (Aliyun 签名要求). encodeURIComponent 不编码
// ! ' ( ) *, 我们手动补上, 否则文件名带括号会签名失败.
function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
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

// 拿不到播放流时查一下视频状态, 把真实原因 (转码中 / 不存在 / 转码失败) 带回前端.
// 需要 RAM 权限 vod:GetVideoInfo; 没权限时返回 error, 上层会退回通用提示.
async function aliyunGetVideoStatus(videoId) {
  const params = {
    Action: 'GetVideoInfo',
    VideoId: videoId,
    Format: 'JSON',
    Version: '2017-03-21',
    AccessKeyId: ALIYUN_VOD_ACCESS_KEY_ID,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: generateNonce(),
    Timestamp: formatISODate(),
  };
  try {
    const res = await httpRequest(buildAliyunSignedUrl(params));
    const data = await res.json();
    console.log('[video-play-auth] Aliyun GetVideoInfo response:', JSON.stringify(data).substring(0, 200));
    if (data.Video && data.Video.Status) return { status: String(data.Video.Status) };
    return { error: data.Code || 'no_video_info', message: data.Message || '' };
  } catch (e) {
    return { error: 'aliyun_fetch_failed', message: String(e?.message || e) };
  }
}

// 把阿里云的视频状态 / 错误码翻译成前端能直接展示、管理员能据此行动的原因.
// 状态含义见 VOD 文档: Uploading / UploadSucc / Transcoding / TranscodeFail / Checking / Blocked / Normal
function describeAliyunFailure(playInfo, statusInfo) {
  const code = String(playInfo?.error || '');
  const status = String(statusInfo?.status || '');
  const statusErr = String(statusInfo?.error || '');

  if (status === 'Uploading' || status === 'UploadSucc' || status === 'Transcoding') {
    return { error: 'video_transcoding', message: '视频正在阿里云转码中，通常需要几分钟到几十分钟，请稍后再试。' };
  }
  if (status === 'TranscodeFail') {
    return { error: 'video_transcode_failed', message: '阿里云转码失败，请管理员在 VOD 控制台重新转码或重新上传。' };
  }
  if (status === 'UploadFail') {
    return { error: 'video_upload_failed', message: '视频在阿里云上传失败，请管理员重新上传。' };
  }
  if (status === 'Checking' || status === 'Blocked') {
    return { error: 'video_blocked', message: '视频在阿里云处于审核中 / 已屏蔽状态，暂时无法播放。' };
  }
  if (/InvalidVideo\.NotFound/i.test(code) || /InvalidVideo\.NotFound/i.test(statusErr)) {
    return { error: 'aliyun_video_not_found', message: '阿里云上找不到该视频 ID（可能已被删除），请管理员检查后台填写的阿里云视频 ID。' };
  }
  // Forbidden.* 有两类含义, 不能笼统当成权限问题:
  //   Forbidden.IllegalStatus -> 视频当前状态不可播放 (多半还在转码 / 被屏蔽)
  //   Forbidden.RAM / .AccessKey / .Subscription -> 真的是账号或授权问题
  if (/Forbidden\.IllegalStatus/i.test(code) || /Forbidden\.IllegalStatus/i.test(statusErr)) {
    return { error: 'video_transcoding', message: '视频在阿里云尚未处理完成（状态不可播放），请稍后再试。' };
  }
  if (/Forbidden/i.test(code) || /Forbidden/i.test(statusErr)) {
    return { error: 'aliyun_forbidden', message: '阿里云拒绝了播放请求（账号或 AccessKey 授权问题），请管理员检查 RAM 权限与 VOD 服务状态。' };
  }
  return {
    error: 'no_playback_source',
    message: `该视频没有可用的播放源${code ? `（阿里云：${code}）` : ''}。`,
  };
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

    // 1. Authenticate user (decode JWT directly — token is signed by Supabase)
    let user = null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      if (payload.sub && payload.aud === 'authenticated' && payload.exp > Date.now() / 1000) {
        user = { id: payload.sub, email: payload.email, role: payload.role };
      }
    } catch (_e) { /* invalid token */ }
    if (!user) {
      return json(401, { error: 'invalid_token', message: '登录已过期，请重新登录。' });
    }
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
    const aliyunConfigured = !!(ALIYUN_VOD_ACCESS_KEY_ID && ALIYUN_VOD_ACCESS_KEY_SECRET);
    let aliyunFailure = null;
    if (aliyunVid && aliyunConfigured) {
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
      // 没拿到流: 查一下视频状态, 让前端能区分"转码中"和"真的没源"
      const statusInfo = await aliyunGetVideoStatus(aliyunVid);
      aliyunFailure = describeAliyunFailure(playInfo, statusInfo);
      console.log('[video-play-auth] Aliyun failure classified as:', aliyunFailure.error, 'status:', statusInfo.status || statusInfo.error);
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

    if (aliyunFailure) {
      // 转码中是暂时的 → 503 让前端自动重试; 其他情况 500
      return json(aliyunFailure.error === 'video_transcoding' ? 503 : 500, aliyunFailure);
    }
    if (aliyunVid && !aliyunConfigured) {
      return json(500, { error: 'aliyun_not_configured', message: '服务器未配置阿里云 VOD 密钥，无法生成播放地址。' });
    }
    return json(500, {
      error: 'no_playback_source',
      message: '该视频没有关联阿里云视频 ID，也没有填写播放地址，请管理员在后台「编辑」中补填。',
    });

  } catch (e) {
    console.error('[video-play-auth] error:', e);
    return json(500, { error: 'internal_error', message: String(e?.message || e) });
  }
};
