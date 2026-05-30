/**
 * Netlify Function: video-upload-auth
 *
 * Admin-only endpoint to issue Aliyun VOD upload credentials.
 * Frontend calls this, gets UploadAuth + UploadAddress + VideoId,
 * then uploads directly to Aliyun OSS via aliyun-oss-sdk.
 *
 * POST /api/videos/upload-credentials
 * Headers: Authorization: Bearer <supabase_jwt>
 * Body: { title: string, fileName: string }
 * Response: { videoId, uploadAuth, uploadAddress, region }
 *
 * Required Aliyun RAM permissions on the AccessKey:
 *   vod:CreateUploadVideo
 *   vod:RefreshUploadVideo (used by the refresh endpoint below)
 *   (AliyunVODFullAccess covers both.)
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
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Light rate limit. Admin endpoint, but defend against brute force / misuse.
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

async function sbQuery(path, token) {
  const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
  return httpRequest(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${token || key}`,
      Accept: 'application/json',
    },
  });
}

// ── Aliyun signing (identical pattern to video-play-auth.js) ──
// 但加强了 percentEncode: encodeURIComponent 不编码 ! ' ( ) *,
// 阿里云签名按 RFC 3986 严格模式, 必须编码这些字符. 否则文件名带括号
// (比如 "video (Connor).mp4") 就会签名不匹配, 报 SignatureDoesNotMatch.
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

async function aliyunCall(action, extra) {
  const params = {
    Action: action,
    Format: 'JSON',
    Version: '2017-03-21',
    AccessKeyId: ALIYUN_VOD_ACCESS_KEY_ID,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: generateNonce(),
    Timestamp: formatISODate(),
    ...extra,
  };
  const url = buildAliyunSignedUrl(params);
  const res = await httpRequest(url);
  const data = await res.json();
  return data;
}

// ── Main handler (dispatches by path) ──
// Netlify functions only have one default exports.handler, so dispatch
// internally based on event.path:
//   /api/videos/upload-credentials          -> issueUploadCreds (main)
//   /api/videos/upload-credentials/refresh  -> refreshUploadCreds
//   /api/videos/upload-credentials/delete   -> deleteUploadedVideo (cleanup)
exports.handler = async (event) => {
  const p = event.path || '';
  if (p.endsWith('/refresh')) return refreshUploadCreds(event);
  if (p.endsWith('/delete')) return deleteUploadedVideo(event);
  return issueUploadCreds(event);
};

// Express server compat: separate names still work so server/index.js
// can route each path cleanly without relying on path matching.
exports.refreshHandler = (event) => refreshUploadCreds(event);
exports.deleteHandler = (event) => deleteUploadedVideo(event);

async function issueUploadCreds(event) {
  console.log('[video-upload-auth] invoked, path:', event.path, 'method:', event.httpMethod);
  try {
    const ip = getClientIp(event);
    if (!rateCheck(ip, 30)) {
      return json(429, { error: 'rate_limited', message: '请求过于频繁，请稍后再试。' });
    }

    if (event.httpMethod !== 'POST') {
      return json(405, { error: 'method_not_allowed' });
    }

    const token = pickToken(event);
    if (!token) {
      return json(401, { error: 'unauthorized', message: '请先登录。' });
    }

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return json(500, { error: 'server_not_configured' });
    }
    if (!ALIYUN_VOD_ACCESS_KEY_ID || !ALIYUN_VOD_ACCESS_KEY_SECRET) {
      return json(500, { error: 'aliyun_not_configured', message: '阿里云 VOD 未配置。' });
    }

    // Decode JWT, fetch profile, verify admin
    let user = null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      if (payload.sub && payload.aud === 'authenticated' && payload.exp > Date.now() / 1000) {
        user = { id: payload.sub, email: payload.email };
      }
    } catch (_e) { /* invalid token */ }
    if (!user) {
      return json(401, { error: 'invalid_token', message: '登录已过期，请重新登录。' });
    }

    const profRes = await sbQuery(`profiles?id=eq.${encodeURIComponent(user.id)}&select=role&limit=1`, token);
    if (!profRes.ok) {
      return json(500, { error: 'db_error' });
    }
    const profile = (await profRes.json())[0];
    const role = String(profile?.role || '').toLowerCase().trim();
    if (!['admin', 'super_admin', 'owner'].includes(role)) {
      return json(403, { error: 'admin_required', message: '仅管理员可上传视频。' });
    }
    console.log('[video-upload-auth] admin authed:', user.id);

    // Parse body
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {}
    const title = String(body.title || '').trim().slice(0, 200);
    const fileName = String(body.fileName || '').trim().slice(0, 255);
    if (!title || !fileName) {
      return json(400, { error: 'missing_fields', message: '需要 title 和 fileName' });
    }
    const okExt = /\.(mp4|mov|m4v|mkv|avi|flv|wmv|webm|ts)$/i.test(fileName);
    if (!okExt) {
      return json(400, { error: 'unsupported_file_type', message: '只支持常见视频格式 (mp4/mov/mkv/avi 等)' });
    }

    const data = await aliyunCall('CreateUploadVideo', { Title: title, FileName: fileName });
    if (data.Code) {
      console.log('[video-upload-auth] Aliyun error:', data.Code, data.Message);
      return json(502, { error: 'aliyun_create_failed', code: data.Code, message: data.Message || '' });
    }
    if (!data.VideoId || !data.UploadAuth || !data.UploadAddress) {
      console.log('[video-upload-auth] Aliyun unexpected response:', JSON.stringify(data).slice(0, 200));
      return json(502, { error: 'aliyun_no_credentials' });
    }
    console.log('[video-upload-auth] issued upload creds for videoId:', data.VideoId);
    return json(200, {
      videoId: data.VideoId,
      uploadAuth: data.UploadAuth,
      uploadAddress: data.UploadAddress,
      region: ALIYUN_VOD_REGION,
    });
  } catch (e) {
    console.error('[video-upload-auth] error:', e);
    return json(500, { error: 'internal_error', message: String(e?.message || e) });
  }
}

// 删除 Aliyun VOD 上的视频. 三种场景:
//   1. 用户中途取消上传 -> 清理半成品 "Uploading" 状态的孤儿记录
//   2. 上传失败 (timeout etc) -> 同上, 清理 orphan
//   3. admin 在视频列表里 "永久删除" -> 清掉 OSS 存储 (省钱)
// Aliyun DeleteVideo API 接受逗号分隔的多个 VideoId, 这里只支持单个.
async function deleteUploadedVideo(event) {
  try {
    if (!rateCheck(getClientIp(event), 30)) return json(429, { error: 'rate_limited' });
    if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
    const token = pickToken(event);
    if (!token) return json(401, { error: 'unauthorized' });

    let user = null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      if (payload.sub && payload.aud === 'authenticated' && payload.exp > Date.now() / 1000) {
        user = { id: payload.sub };
      }
    } catch {}
    if (!user) return json(401, { error: 'invalid_token' });

    const profRes = await sbQuery(`profiles?id=eq.${encodeURIComponent(user.id)}&select=role&limit=1`, token);
    const profile = (await profRes.json())[0];
    const role = String(profile?.role || '').toLowerCase().trim();
    if (!['admin', 'super_admin', 'owner'].includes(role)) return json(403, { error: 'admin_required' });

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {}
    const videoId = String(body.videoId || '').trim();
    if (!videoId) return json(400, { error: 'missing_videoId' });

    console.log('[video-upload-auth] DeleteVideo:', videoId);
    const data = await aliyunCall('DeleteVideo', { VideoIds: videoId });
    if (data.Code) {
      // Aliyun DeleteVideo 对不存在的 videoId 返回错误, 我们不应该让这个拖累
      // 调用方的 "删除" 流程. 仍然记录但不阻塞.
      console.log('[video-upload-auth] DeleteVideo soft-failed:', data.Code, data.Message);
      // 把 NotFound 当成成功 (幂等)
      if (/NotFound|InvalidVideo\.NotFound/i.test(data.Code)) {
        return json(200, { ok: true, alreadyDeleted: true });
      }
      return json(502, { error: 'aliyun_delete_failed', code: data.Code, message: data.Message || '' });
    }
    return json(200, { ok: true, videoId, requestId: data.RequestId });
  } catch (e) {
    return json(500, { error: 'internal_error', message: String(e?.message || e) });
  }
}

async function refreshUploadCreds(event) {
  try {
    if (!rateCheck(getClientIp(event), 30)) return json(429, { error: 'rate_limited' });
    if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
    const token = pickToken(event);
    if (!token) return json(401, { error: 'unauthorized' });

    let user = null;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      if (payload.sub && payload.aud === 'authenticated' && payload.exp > Date.now() / 1000) {
        user = { id: payload.sub };
      }
    } catch {}
    if (!user) return json(401, { error: 'invalid_token' });

    const profRes = await sbQuery(`profiles?id=eq.${encodeURIComponent(user.id)}&select=role&limit=1`, token);
    const profile = (await profRes.json())[0];
    const role = String(profile?.role || '').toLowerCase().trim();
    if (!['admin', 'super_admin', 'owner'].includes(role)) return json(403, { error: 'admin_required' });

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch {}
    const videoId = String(body.videoId || '').trim();
    if (!videoId) return json(400, { error: 'missing_videoId' });

    const data = await aliyunCall('RefreshUploadVideo', { VideoId: videoId });
    if (data.Code) return json(502, { error: 'aliyun_refresh_failed', code: data.Code, message: data.Message || '' });
    return json(200, {
      videoId: data.VideoId,
      uploadAuth: data.UploadAuth,
      uploadAddress: data.UploadAddress,
      region: ALIYUN_VOD_REGION,
    });
  } catch (e) {
    return json(500, { error: 'internal_error', message: String(e?.message || e) });
  }
}
