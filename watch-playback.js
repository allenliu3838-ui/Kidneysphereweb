// Authorization transport is independent of the DOM so denial, timeouts and
// session refresh can be checked without calling production endpoints.
export async function withTimeout(operation, timeoutMs = 10000) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); const error = new Error('请求超时，请检查网络后重试。'); error.name = 'TimeoutError'; reject(error);
      }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

// This exception is only for an independently signed short clip. An ordinary
// access denial, full-course URL, or unbounded preview must never mount media.
export function isSafePreview(body = {}) {
  if (body.isPreview !== true || body.canPlay !== false || body.previewAvailable !== true ||
      body.playerType !== 'signed_url' || body.previewLimitSeconds !== 180 ||
      typeof body.previewSeconds !== 'number' || !Number.isFinite(body.previewSeconds) ||
      body.previewSeconds <= 0 || body.previewSeconds > 180 ||
      !['audio', 'video'].includes(body.mediaType) || !(body.needLogin === true || body.needPurchase === true)) return false;
  try {
    const url = new URL(body.playURL);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch (_) { return false; }
}

// Tab-local preview positions can survive login/checkout, without entering the
// account's completed-course history or storing a signed media URL.
export function createPreviewProgress({ storage, now = Date.now } = {}) {
  const key = id => `ks.preview-progress.v1:${encodeURIComponent(id)}`;
  return {
    get(id) {
      try {
        const record = JSON.parse(storage?.getItem(key(id)) || 'null');
        if (!record || !Number.isFinite(record.position) || record.position < 0 || record.position > 180 ||
            !Number.isFinite(record.rate) || record.rate < .5 || record.rate > 2 ||
            !Number.isFinite(record.updatedAt) || now() - record.updatedAt > 6 * 60 * 60 * 1000 || record.updatedAt > now()) return null;
        return record;
      } catch (_) { return null; }
    },
    save(record) {
      if (!record?.videoId || !Number.isFinite(record.position) || record.position < 0 || record.position > 180) return;
      try { storage?.setItem(key(record.videoId), JSON.stringify({ position: record.position,
        rate: Number.isFinite(record.rate) ? Math.max(.5, Math.min(2, record.rate)) : 1, updatedAt: now() })); } catch (_) {}
    },
  };
}

export async function requestAuthorizedPlayback(videoId, { token = '', fetchImpl = globalThis.fetch,
  refreshSession, timeoutMs = 10000 } = {}) {
  let refreshed = false;
  while (true) {
    const { response, body } = await withTimeout(async signal => {
      const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetchImpl(`/api/videos/${encodeURIComponent(videoId)}/play-auth`, {
        method: 'POST', headers, body: JSON.stringify({ includeVideo: true, allowPreview: true }), signal, cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      return { response, body };
    }, timeoutMs);
    if (response.status === 401 && token && !refreshed && typeof refreshSession === 'function') {
      refreshed = true;
      try {
        const session = await withTimeout(() => refreshSession(), timeoutMs);
        if (session?.access_token) { token = session.access_token; continue; }
      } catch (_) { /* A failed refresh returns the original login gate. */ }
    }
    const video = body.video || {};
    if (response.status === 401) return { kind: 'login', video, token, reason: body.reason || 'login_required' };
    if (response.status === 403 && body.needPurchase === true) return { kind: 'purchase', video, token };
    if (!response.ok) return { kind: 'error', video, token, status: response.status,
      message: body.message || (response.status === 404 ? '未找到课程，可能已下架或链接已更新。' :
        response.status === 429 ? '请求较多，请稍候再试。' : response.status === 403 ? '当前账号无权播放此课程。' : '暂时无法加载课程，请重试。') };
    if (body.isPreview === true) {
      if (isSafePreview(body)) return { kind: 'preview', video, playback: body, token };
      return { kind: 'error', video, token, status: 502, message: '试听内容暂未准备好，请稍后重试。' };
    }
    // Outside the strictly bounded preview contract, a denial cannot play.
    if (body.canPlay === false || body.needLogin || body.needPurchase) return { kind: 'error', video, token, status: 403, message: '未获得课程播放权限，请重新登录后重试。' };
    if (body.playerType === 'bilibili' && /^BV[0-9A-Za-z]+$/.test(body.bvid || '')) return { kind: 'bilibili', video, playback: body, token };
    if (['signed_url', 'direct_url'].includes(body.playerType) && typeof body.playURL === 'string' && body.playURL) {
      return { kind: 'playback', video, playback: body, token };
    }
    return { kind: 'error', video, token, status: 502, message: '这节课程尚未准备好播放，请稍后重试或联系平台。' };
  }
}
