import { validateMediaFile } from './media-upload.js?v=20260914_audio1';

const SDK_URL = 'https://gosspublic.alicdn.com/aliyun-oss-sdk-6.20.0.min.js';
let sdkPromise;
function loadSdk() {
  if (window.OSS) return Promise.resolve(window.OSS);
  if (!sdkPromise) sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SDK_URL; script.async = true;
    script.onload = () => window.OSS ? resolve(window.OSS) : reject(new Error('上传组件加载失败，请重试。'));
    script.onerror = () => { script.remove(); reject(new Error('上传组件加载失败，请检查网络后重试。')); };
    document.head.appendChild(script);
  }).catch(error => { sdkPromise = null; throw error; });
  return sdkPromise;
}
function aborted() { const error = new Error('上传已停止'); error.name = 'AbortError'; return error; }
function check(signal) { if (signal?.aborted) throw aborted(); }
function cancellable(promise, signal) {
  check(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted());
    signal?.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener('abort', cancel));
  });
}
function wait(ms, signal) {
  check(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

// One shared scheduler for create, refresh and cleanup: the server counts all
// three endpoints against the same per-IP limit. No credentials are persisted.
export function createVodUploader({ getToken, fetchImpl = globalThis.fetch,
  sdkLoader = loadSdk, waitImpl = wait, now = () => Date.now(), minRequestIntervalMs = 3000 } = {}) {
  if (typeof getToken !== 'function') throw new TypeError('需要提供登录会话读取方法。');
  let tail = Promise.resolve();
  let nextRequestAt = 0;
  function credentials(suffix, body, signal, onStatus, retry = true) {
    const task = tail.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
        check(signal);
        const delay = nextRequestAt - now();
        if (delay > 0) await waitImpl(delay, signal);
        check(signal);
        const token = await getToken();
        if (!token) throw new Error('登录已失效，请重新登录后重试。');
        check(signal);
        nextRequestAt = now() + minRequestIntervalMs;
        // Do not cancel a credential-creation response: it may already have
        // created a VOD ID which must be known for cleanup after stopping.
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), 30000);
        let response, data;
        try {
          response = await fetchImpl('/api/videos/upload-credentials' + suffix, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body), signal: timeout.signal,
          });
          data = await response.json().catch(() => ({}));
        } finally { clearTimeout(timer); }
        if (response.status === 429 && attempt === 0 && retry) {
          const header = response.headers?.get('Retry-After');
          const seconds = header && /^\d+$/.test(header) ? Number(header) : 60;
          nextRequestAt = Math.max(nextRequestAt, now() + Math.max(1, seconds) * 1000);
          onStatus?.('上传请求较多，正在等待后自动重试…');
          continue;
        }
        if (!response.ok) throw new Error(data.message || data.error || `上传凭证请求失败（HTTP ${response.status}）`);
        return data;
      }
    });
    tail = task.catch(() => {});
    return task;
  }

  return async function upload(file, { title, onProgress, onStatus, signal } = {}) {
    const validation = validateMediaFile(file);
    if (validation.error) throw new Error(validation.error);
    check(signal);
    let videoId, client;
    const cancel = () => { try { client?.cancel(); } catch (_) { /* SDK best effort */ } };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      onStatus?.('请求上传凭证…');
      const cred = await credentials('', { title: title || file.name.replace(/\.[^.]+$/, ''), fileName: file.name }, signal, onStatus);
      videoId = cred.videoId;
      if (!videoId) throw new Error('上传凭证缺少媒体 ID，请重试。');
      check(signal);
      const auth = JSON.parse(atob(cred.uploadAuth));
      const address = JSON.parse(atob(cred.uploadAddress));
      onStatus?.('加载上传组件…');
      const OSS = await cancellable(sdkLoader(), signal);
      check(signal);
      client = new OSS({
        region: 'oss-' + auth.Region, accessKeyId: auth.AccessKeyId,
        accessKeySecret: auth.AccessKeySecret, stsToken: auth.SecurityToken,
        bucket: address.Bucket, endpoint: address.Endpoint, secure: true, timeout: 120000,
        refreshSTSToken: async () => {
          const fresh = await credentials('/refresh', { videoId }, signal, onStatus);
          check(signal);
          const value = JSON.parse(atob(fresh.uploadAuth));
          return { accessKeyId: value.AccessKeyId, accessKeySecret: value.AccessKeySecret, stsToken: value.SecurityToken };
        },
      });
      check(signal);
      onStatus?.('上传中…');
      const sizeMB = file.size / 1024 / 1024;
      await client.multipartUpload(address.FileName, file, {
        partSize: (sizeMB < 100 ? 1 : sizeMB < 500 ? 4 : 8) * 1024 * 1024,
        parallel: 2, timeout: 120000,
        progress: value => { if (!signal?.aborted) onProgress?.(Math.max(0, Math.min(1, Number(value) || 0))); },
      });
      // A successful multipart completion owns the uploaded media even if a
      // stop arrived with its final response. The queue retains it as uploaded
      // and resumes at saving, rather than deleting and uploading it again.
      return { videoId, mediaType: validation.mediaType };
    } catch (error) {
      cancel();
      // Only failed/cancelled uploads are cleaned up. A successful return is
      // owned by the course-saving stage, including any retry of that stage.
      if (videoId) credentials('/delete', { videoId }, undefined, undefined, false).catch(() => {});
      if (signal?.aborted) throw aborted();
      throw error;
    } finally { signal?.removeEventListener('abort', cancel); }
  };
}
