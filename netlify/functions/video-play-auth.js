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
 * Optional body { includeVideo: true } adds safe public video metadata and
 * access state, including on 401/403, so mobile opens use one request.
 * { allowPreview: true } may return a separately clipped preview to visitors
 * without full access. canPlay remains the FULL-access flag; isPreview is true.
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
const PREVIEW_LIMIT_SECONDS = 180;
const PREVIEW_URL_SECONDS = 900;

const json = (statusCode, payload) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(statusCode === 429 ? { 'retry-after': '60' } : {}),
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
function rateCheck(key, maxPerMin = 30) {
  const now = Date.now();
  let entry = rateMap.get(key);
  if (!entry || now - entry.ts > 60000) {
    entry = { ts: now, count: 0 };
    rateMap.set(key, entry);
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

function safePlaybackUrl(value, httpsOnly = false) {
  try {
    const url = new URL(value);
    const validProtocol = httpsOnly ? url.protocol === 'https:' : ['https:', 'http:'].includes(url.protocol);
    return validProtocol && !url.username && !url.password ? String(value) : '';
  } catch (_) { return ''; }
}

function streamIsReady(info) {
  return (!info.Status || info.Status === 'Normal') &&
    Number(info.Encrypt || 0) === 0 &&
    (!info.EncryptType || info.EncryptType === 'Unencrypted') &&
    info.EncryptMode !== 'License' && safePlaybackUrl(info.PlayURL);
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function streamRank(info) {
  // H.264 MP4 is the broadest native mobile option. Keep 480/720p ahead of
  // large originals for startup; expose other prepared renditions to the user.
  const format = String(info.Format || '').toLowerCase();
  const codec = String(info.CodecName || info.Specification || '').toUpperCase();
  const compatibility = codec && !codec.startsWith('H264') ? 4 : 0;
  const formatRank = format === 'mp4' ? 0 : 1;
  const height = positiveNumber(info.Height);
  const knownDefinition = { SD: 0, LD: 1, HD: 2, FD: 3, OD: 5, '2K': 6, '4K': 7 };
  let quality = knownDefinition[String(info.Definition || '').toUpperCase()] ?? 4;
  if (height) quality = height >= 480 && height <= 720 ? 0 : height < 480 ? 1 : 2 + height / 1080;
  const transport = safePlaybackUrl(info.PlayURL, true) ? 0 : 1;
  return [transport, compatibility + formatRank, quality, positiveNumber(info.Bitrate) || Number.MAX_SAFE_INTEGER];
}

function selectPlaybackStream(data) {
  const streams = (data.PlayInfoList?.PlayInfo || []).filter(info => info?.PlayURL);
  const explicitType = String(data.VideoBase?.MediaType || '').toLowerCase();
  const streamIsAudio = info => String(info.StreamType || '').toLowerCase() === 'audio' ||
    (!info.StreamType && String(info.Format || '').toLowerCase() === 'mp3');
  const mediaType = explicitType === 'audio' ? 'audio' : explicitType === 'video' ? 'video' :
    (streams.length && streams.every(streamIsAudio) ? 'audio' : 'video');
  if (mediaType === 'audio') {
    // Aliyun can return HTTP until CDN HTTPS is enabled. Preserve legacy MP3
    // compatibility, prefer HTTPS when present, and never rewrite signed URLs.
    const audioStreams = streams.filter(info => streamIsAudio(info) &&
      String(info.Format || '').toLowerCase() === 'mp3' && streamIsReady(info));
    const audio = audioStreams.find(info => safePlaybackUrl(info.PlayURL, true)) || audioStreams[0];
    if (!audio) return {
      error: 'audio_not_ready',
      mediaType: 'audio',
      message: '音频尚未生成可播放的 MP3。请稍后重试；若持续出现，请管理员在阿里云点播检查音频转码任务和模板。',
    };
    return { info: audio, mediaType: 'audio', streamType: 'audio' };
  }
  const videos = streams.filter(info => !streamIsAudio(info) && streamIsReady(info) &&
    ['mp4', 'm3u8'].includes(String(info.Format || '').toLowerCase()));
  videos.sort((a, b) => {
    const first = streamRank(a), second = streamRank(b);
    for (let i = 0; i < first.length; i++) if (first[i] !== second[i]) return first[i] - second[i];
    return 0;
  });
  const seen = new Set();
  const renditions = videos.filter(info => {
    // New quality choices are HTTPS only; primary URL retains HTTP legacy
    // compatibility when the configured VOD domain has not enabled HTTPS yet.
    if (!safePlaybackUrl(info.PlayURL, true) || seen.has(info.PlayURL)) return false;
    seen.add(info.PlayURL);
    return true;
  }).map(info => ({
    playURL: info.PlayURL,
    format: String(info.Format).toLowerCase(),
    definition: info.Definition || '',
    width: positiveNumber(info.Width),
    height: positiveNumber(info.Height),
    // Aliyun GetPlayInfo specifies Bitrate in Kbps (not bits per second).
    bitrate: positiveNumber(info.Bitrate),
  }));
  return videos.length ? {
    info: videos[0], mediaType: 'video', streamType: 'video', renditions,
  } : { error: 'no_play_info' };
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
    // Never log the response: PlayInfo contains signed media URLs.
    if (data.VideoBase?.Status && data.VideoBase.Status !== 'Normal') {
      return { error: 'media_not_ready' };
    }
    if (data.PlayInfoList?.PlayInfo?.length > 0 || data.VideoBase?.MediaType === 'audio') {
      const selected = selectPlaybackStream(data);
      if (!selected.info) return selected;
      const info = selected.info;
      return {
        playURL: info.PlayURL,
        format: info.Format,
        duration: info.Duration,
        definition: info.Definition,
        mediaType: selected.mediaType,
        streamType: selected.streamType,
        ...(selected.renditions ? { renditions: selected.renditions } : {}),
      };
    }
    return { error: data.Code || 'no_play_info', message: data.Message || '' };
  } catch (e) {
    return { error: 'aliyun_fetch_failed', message: String(e?.message || e) };
  }
}

// Preview media must be separately clipped/uploaded by a trusted administrator.
// Aliyun's PreviewTime is CDN enforced, but only supports MP4/HLS and can round
// up to a keyframe/TS boundary. It cannot enforce a strict 180s limit for this
// site's MP3 audio. Never substitute a full URL plus a browser timer:
// https://help.aliyun.com/zh/vod/use-cases/configure-the-preview-feature
async function aliyunPreviewRequest(action, videoId) {
  const params = {
    Action: action, VideoId: videoId, Format: 'JSON', Version: '2017-03-21',
    AccessKeyId: ALIYUN_VOD_ACCESS_KEY_ID, SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0', SignatureNonce: generateNonce(), Timestamp: formatISODate(),
    ...(action === 'GetPlayInfo' ? { AuthTimeout: String(PREVIEW_URL_SECONDS), Formats: 'mp4,mp3' } : {}),
  };
  const response = await httpRequest(buildAliyunSignedUrl(params));
  if (!response.ok) throw new Error('preview_upstream_unavailable');
  return response.json();
}

function signedPreviewUrl(value) {
  if (!safePlaybackUrl(value, true)) return false;
  const url = new URL(value);
  // Require the VOD CDN's type-A signature. Unsigned/misconfigured domains
  // stay unavailable until URL authentication is configured.
  const signatures = url.searchParams.getAll('auth_key');
  return signatures.length === 1 && /^\d+-[^-\s]+-[^-\s]+-[a-f\d]{32}$/i.test(signatures[0]);
}

function previewDurationNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return 0;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) return 0;
  return positiveNumber(value);
}

async function aliyunGetPreviewInfo(video) {
  const originalId = typeof video.aliyun_vid === 'string' ? video.aliyun_vid.trim() : '';
  if (!originalId || !SUPABASE_SERVICE_ROLE_KEY ||
      !ALIYUN_VOD_ACCESS_KEY_ID || !ALIYUN_VOD_ACCESS_KEY_SECRET) return null;
  try {
    // The mapping lives in a private table, never in publicly selectable course
    // metadata. Only this service-role RPC may retrieve its VOD identifier.
    const mapping = await sbRpc('get_learning_video_preview', { p_video_id: video.id });
    if (!mapping.ok) return null;
    const mappedId = await mapping.json();
    const previewId = typeof mappedId === 'string' ? mappedId.trim() : '';
    if (!previewId || previewId === originalId) return null;
    // GetVideoInfo reads original duration WITHOUT requesting a full play URL.
    // Database duration alone may be stale or rounded and is never trusted.
    const [original, preview] = await Promise.all([
      aliyunPreviewRequest('GetVideoInfo', originalId),
      aliyunPreviewRequest('GetPlayInfo', previewId),
    ]);
    const originalDuration = previewDurationNumber(original.Video?.Duration);
    const previewDuration = previewDurationNumber(preview.VideoBase?.Duration);
    const mediaType = String(preview.VideoBase?.MediaType || '').toLowerCase();
    if (original.Video?.VideoId !== originalId || original.Video?.Status !== 'Normal' ||
        preview.VideoBase?.VideoId !== previewId || preview.VideoBase?.Status !== 'Normal' ||
        !originalDuration || !previewDuration || previewDuration > PREVIEW_LIMIT_SECONDS ||
        previewDuration >= originalDuration || !['audio', 'video'].includes(mediaType) ||
        (video.media_type && video.media_type !== mediaType)) return null;
    const streams = (preview.PlayInfoList?.PlayInfo || []).filter(info => {
      const duration = previewDurationNumber(info?.Duration);
      const format = String(info?.Format || '').toLowerCase();
      return duration && duration <= PREVIEW_LIMIT_SECONDS && duration < originalDuration &&
        format === (mediaType === 'audio' ? 'mp3' : 'mp4') && signedPreviewUrl(info.PlayURL);
    });
    const selected = selectPlaybackStream({ ...preview, PlayInfoList: { PlayInfo: streams } });
    if (!selected.info) return null;
    // Intentionally return one verified clipped stream, never the complete
    // PlayInfo response, source URL, BVID, PlayAuth or unvalidated renditions.
    return {
      playerType: 'signed_url', playURL: selected.info.PlayURL,
      format: String(selected.info.Format).toLowerCase(),
      duration: positiveNumber(selected.info.Duration),
      mediaType, streamType: mediaType, expiresIn: PREVIEW_URL_SECONDS,
      isPreview: true, previewSeconds: positiveNumber(selected.info.Duration),
      previewLimitSeconds: PREVIEW_LIMIT_SECONDS,
    };
  } catch (_) { return null; }
}

async function deniedPlayback(video, metadata, state, allowPreview, ip) {
  const { statusCode, ...access } = state;
  if (!allowPreview) return json(statusCode, { ...metadata, ...access });
  if (!rateCheck(`preview:${ip}`, 120)) return json(429, {
    ...metadata, error: 'rate_limited', message: '请求过于频繁，请稍后再试。',
  });
  const preview = await aliyunGetPreviewInfo(video);
  if (preview) return json(200, {
    ...metadata, ...access, ...preview, error: undefined,
    ...(metadata.video ? { video: { ...metadata.video, mediaType: preview.mediaType } } : {}),
    message: '正在播放课程预览，完整学习需取得对应课程权益。',
    previewAvailable: true,
  });
  return json(statusCode, {
    ...metadata, ...access, isPreview: false, previewAvailable: false,
    previewError: 'preview_unavailable', previewLimitSeconds: PREVIEW_LIMIT_SECONDS,
    previewMessage: '本课试听/试看正在准备中，暂时无法播放预览。',
  });
}

// /auth/v1/user verifies the token signature, expiry and actual current user.
// Decoding JWT claims alone cannot authenticate a user (including free media).
async function authenticateUser(token) {
  if (!token || token.length > 8192) return { user: null };
  try {
    const response = await httpRequest(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (response.status === 401 || response.status === 403) return { user: null };
    if (!response.ok) return { unavailable: true };
    const user = await response.json();
    return typeof user?.id === 'string' && user.id && user.aud === 'authenticated' ?
      { user: { id: user.id } } : { user: null };
  } catch (_) { return { unavailable: true }; }
}

function accessTypeFor(video) {
  if (video.membership_scope === 'weekly_replay') return 'paid_membership';
  if (['training', 'other_paid'].includes(video.membership_scope)) {
    return video.specialty_id ? 'paid_specialty' : 'paid_single';
  }
  return video.access_type || (video.is_paid ?
    (video.membership_accessible ? 'paid_membership' : 'paid_single') : 'registered_free');
}

function safeVideoInfo(video, accessType) {
  // Explicit whitelist: no playback identifiers or media URLs, even if future
  // database migrations introduce new private columns.
  return {
    id: video.id,
    title: video.title || '',
    accessType,
    price: video.price || 0,
    coverImage: video.cover_image || '',
    description: video.description || '',
    speaker: video.speaker || '',
    category: video.category || '',
    kind: video.kind || 'external',
    source: video.source || 'external',
    specialtyId: video.specialty_id || null,
    productId: video.product_id || null,
    mediaType: ['audio', 'video'].includes(video.media_type) ? video.media_type : null,
    seriesId: video.series_id || null,
    seriesTitle: video.series_title || '',
    chapterNumber: positiveNumber(video.chapter_number) || null,
    hasAliyunVod: !!video.aliyun_vid,
    membershipScope: ['unclassified', 'weekly_replay', 'training', 'other_paid'].includes(video.membership_scope) ? video.membership_scope : null,
    membershipAccessible: video.membership_scope === 'weekly_replay' && video.media_type === 'video' &&
      video.is_paid === true && (video.access_type === 'paid_membership' || video.membership_accessible === true),
  };
}

// ── Main handler ──
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
    const pathMatch = (event.path || '').match(/\/api\/videos\/([^/]+)\/play-auth\/?$/);
    if (!pathMatch) return json(400, { error: 'missing_video_id' });
    let videoId;
    try { videoId = decodeURIComponent(pathMatch[1]); }
    catch (_) { return json(400, { error: 'invalid_video_id' }); }
    if (!videoId || videoId.length > 200) return json(400, { error: 'invalid_video_id' });
    let includeVideo = false;
    let allowPreview = false;
    if (event.body) {
      try {
        const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
        const parsed = JSON.parse(body);
        includeVideo = parsed?.includeVideo === true;
        allowPreview = parsed?.allowPreview === true;
      } catch (_) { return json(400, { error: 'invalid_json' }); }
    }

    const ip = getClientIp(event);
    // A broad IP ceiling protects the auth lookup; verified user limits below
    // prevent one person from issuing excessive signatures on a hospital NAT.
    if (!rateCheck(`ip:${ip}`, 600)) return json(429, {
      error: 'rate_limited', message: '请求过于频繁，请稍后再试。',
    });
    const token = pickToken(event);
    if (!token && !includeVideo && !allowPreview) return json(401, { error: 'unauthorized', message: '请先登录。' });
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return json(500, { error: 'server_not_configured' });

    // One browser request; independent metadata and identity checks run together.
    // select=* avoids failing older installations on optional display columns.
    // Only safeVideoInfo() is ever serialized; the row stays server-side.
    const [videoResult, authResult] = await Promise.allSettled([
      sbQuery(`learning_videos?id=eq.${encodeURIComponent(videoId)}&select=*&limit=1`),
      authenticateUser(token),
    ]);
    if (videoResult.status !== 'fulfilled' || !videoResult.value.ok) return json(500, { error: 'db_error' });
    const videos = await videoResult.value.json();
    const video = videos?.[0];
    if (!video || video.deleted_at) return json(404, { error: 'video_not_found' });
    if (video.enabled !== true || video.is_published !== true) {
      return json(403, { error: 'video_not_published' });
    }
    const accessType = accessTypeFor(video);
    const metadata = includeVideo ? { video: safeVideoInfo(video, accessType) } : {};
    // The scope column and the strict access RPC are installed atomically.
    // Never consult the old broad-membership RPC if migration is missing, nor
    // assume an unknown scope is a free unclassified course.
    if (!['unclassified', 'weekly_replay', 'training', 'other_paid'].includes(video.membership_scope)) return json(503, {
      ...metadata, error: 'access_schema_not_ready', message: '课程权限配置正在更新，请稍后重试。',
      canPlay: false, needLogin: false, needPurchase: false, reason: 'temporarily_unavailable',
    });
    const auth = authResult.status === 'fulfilled' ? authResult.value : { unavailable: true };
    if (auth.unavailable) return json(503, {
      ...metadata, error: 'auth_unavailable', message: '暂时无法验证登录状态，请稍后重试。',
      canPlay: false, needLogin: false, needPurchase: false, reason: 'temporarily_unavailable',
    });
    const user = auth.user;
    if (!user) return deniedPlayback(video, metadata, {
      statusCode: 401, error: token ? 'invalid_token' : 'unauthorized',
      message: token ? '登录已过期，请重新登录。' : '请先登录。',
      canPlay: false, needLogin: true, needPurchase: false, reason: 'login_required',
    }, allowPreview && !token, ip);
    if (!rateCheck(`user:${user.id}`, 30)) return json(429, {
      ...metadata, error: 'rate_limited', message: '请求过于频繁，请稍后再试。',
    });

    // An old inconsistent row must not use the RPC's registered_free fast path
    // to grant GlomCon/paid access. Fix the row through existing admin workflows;
    // do not change prices, entitlements, or SQL from this playback endpoint.
    const contradictoryFreeFlag = video.access_type === 'registered_free' &&
      (video.is_paid === true || video.membership_accessible === true);
    if (contradictoryFreeFlag) return json(503, {
      ...metadata, error: 'access_configuration_error', message: '课程权限配置暂时异常，请联系管理员。',
      canPlay: false, needLogin: false, needPurchase: false, reason: 'temporarily_unavailable',
    });

    let canPlay = accessType === 'registered_free';
    if (!canPlay) {
      let unavailable = false;
      try {
        const rpcRes = await sbRpc('check_video_access', {
          p_user_id: user.id, p_video_id: videoId, p_specialty_id: video.specialty_id || null,
        }, token);
        if (rpcRes.ok) {
          // The SQL RPC returns one boolean. Do not turn objects/strings into grants.
          const granted = await rpcRes.json();
          canPlay = granted === true;
          unavailable = typeof granted !== 'boolean';
        } else unavailable = true;
      } catch (error) {
        if (!includeVideo) throw error;
        unavailable = true;
      }
      if ((includeVideo || allowPreview) && unavailable) return json(503, {
        ...metadata, error: 'access_check_unavailable', message: '暂时无法确认课程权限，请稍后重试。',
        canPlay: false, needLogin: false, needPurchase: false, reason: 'temporarily_unavailable',
      });
    }
    sbInsert('play_logs', {
      user_id: user.id, video_id: videoId, status: canPlay ? 'authorized' : 'denied',
      ip, user_agent: (event.headers || {})['user-agent'] || '',
    }).catch(() => {});
    if (!canPlay) return deniedPlayback(video, metadata, {
      statusCode: 403, error: 'access_denied', message: '你尚未获得该视频的观看权限。',
      canPlay: false, needLogin: false, needPurchase: true, reason: 'purchase_required',
    }, allowPreview, ip);
    const access = {
      ...metadata, canPlay: true, needLogin: false, needPurchase: false,
      reason: accessType === 'registered_free' ? 'free' : 'entitled',
    };
    if (video.kind === 'bilibili' && video.bvid) return json(200, {
      ...access, playerType: 'bilibili', bvid: video.bvid, title: video.title || '',
      mediaType: 'video', streamType: 'video',
    });
    if (video.aliyun_vid && ALIYUN_VOD_ACCESS_KEY_ID && ALIYUN_VOD_ACCESS_KEY_SECRET) {
      const playInfo = await aliyunGetPlayInfo(video.aliyun_vid);
      if (playInfo.playURL) return json(200, {
        ...access, playerType: 'signed_url', playURL: playInfo.playURL,
        format: playInfo.format || 'mp4', duration: playInfo.duration || 0,
        definition: playInfo.definition || '', expiresIn: 3600,
        mediaType: playInfo.mediaType, streamType: playInfo.streamType,
        ...(metadata.video ? { video: { ...metadata.video, mediaType: playInfo.mediaType } } : {}),
        ...(playInfo.renditions ? { renditions: playInfo.renditions } : {}),
      });
      // Do not disguise missing audio transcodes as MP4 or use stale source URLs.
      if (playInfo.error === 'audio_not_ready' || playInfo.error === 'media_not_ready') return json(409, {
        ...metadata, error: playInfo.error, message: playInfo.message || '课程正在准备中，请稍后重试。',
        ...(playInfo.mediaType ? { mediaType: playInfo.mediaType } : {}),
      });
    }
    const fallbackUrl = video.mp4_url || video.source_url || '';
    if (safePlaybackUrl(fallbackUrl)) {
      const extension = new URL(fallbackUrl).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
      const mediaType = ['audio', 'video'].includes(video.media_type) ? video.media_type :
        ['mp3', 'm4a', 'wav', 'aac', 'flac', 'wma', 'ape', 'ogg'].includes(extension) ? 'audio' : 'video';
      return json(200, {
        ...access, playerType: 'direct_url', playURL: fallbackUrl,
        format: extension || (mediaType === 'audio' ? 'mp3' : 'mp4'), expiresIn: 0,
        mediaType, streamType: mediaType,
        ...(metadata.video ? { video: { ...metadata.video, mediaType } } : {}),
      });
    }
    return json(500, {
      ...metadata, error: 'no_playback_source', message: '该视频没有可用的播放源。',
    });
  } catch (e) {
    // Upstream error messages may contain private URLs; keep them out of responses.
    console.error('[video-play-auth] internal error');
    return json(500, { error: 'internal_error', message: '播放服务暂时不可用，请稍后重试。' });
  }
};
