import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';

const moduleUrl = file => 'data:text/javascript;base64,' + Buffer.from(readFileSync(new URL('../' + file, import.meta.url), 'utf8')).toString('base64');
const source = readFileSync(new URL('../vod-upload.js', import.meta.url), 'utf8')
  .replace("'./media-upload.js?v=20260914_audio1'", JSON.stringify(moduleUrl('media-upload.js')));
const { createVodUploader } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const file = (name = '第1章.mp3', size = 1024) => ({ name, size });
function response(data, status = 200, retryAfter = null) {
  return { ok: status >= 200 && status < 300, status, json: async () => data,
    headers: { get: name => name.toLowerCase() === 'retry-after' ? retryAfter : null } };
}
function fixture({ onRequest, onUpload, onWait, sdkLoader, tokens = ['admin-token'], startAt = 0 } = {}) {
  let time = startAt, tokenReads = 0, created = 0;
  const requests = [], waits = [], clients = [], uploads = [], statuses = [], progresses = [];
  class OSS {
    constructor(options) { this.options = options; this.cancelCount = 0; clients.push(this); }
    cancel() { this.cancelCount++; }
    async multipartUpload(name, media, options) {
      const entry = { name, media, options, client: this };
      uploads.push(entry);
      if (onUpload) return onUpload(entry);
      options.progress(1);
    }
  }
  const uploader = createVodUploader({
    getToken: async () => tokens[Math.min(tokenReads++, tokens.length - 1)],
    now: () => time,
    waitImpl: async (ms, signal) => {
      waits.push({ ms, signal, at: time });
      await onWait?.({ ms, signal, at: time });
      if (signal?.aborted) { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }
      time += ms;
    },
    sdkLoader: sdkLoader || (async () => OSS),
    fetchImpl: async (url, init) => {
      const request = { url, init, body: JSON.parse(init.body), at: time };
      requests.push(request);
      const override = await onRequest?.(request, requests);
      if (override) return override;
      if (url.endsWith('/delete')) return response({ ok: true });
      const videoId = url.endsWith('/refresh') ? request.body.videoId : `new-vod-${++created}`;
      return response({ videoId, mediaType: 'audio',
        uploadAuth: encode({ Region: 'cn-shanghai', AccessKeyId: `id-${tokenReads}`, AccessKeySecret: 'short-lived-test-secret', SecurityToken: `sts-${tokenReads}` }),
        uploadAddress: encode({ FileName: 'vod/source', Bucket: 'vod-test', Endpoint: 'https://oss.example' }),
      });
    },
  });
  return { uploader, requests, waits, clients, uploads, statuses, progresses,
    options: { onStatus: value => statuses.push(value), onProgress: value => progresses.push(value) },
    get tokenReads() { return tokenReads; } };
}

test('MP3 and existing MP4 use authenticated VOD credentials and OSS multipart upload', async () => {
  for (const [name, mediaType] of [['第1章.MP3', 'audio'], ['lecture.mp4', 'video']]) {
    const f = fixture();
    const result = await f.uploader(file(name), { ...f.options, title: '课程名称' });
    assert.deepEqual(result, { videoId: 'new-vod-1', mediaType });
    assert.equal(f.requests[0].url, '/api/videos/upload-credentials');
    assert.equal(f.requests[0].init.headers.Authorization, 'Bearer admin-token');
    assert.deepEqual(f.requests[0].body, { title: '课程名称', fileName: name });
    assert.equal(f.uploads.length, 1);
    assert.equal(f.uploads[0].media.name, name);
    assert.equal(f.uploads[0].options.partSize, 1024 * 1024);
    assert.equal(f.uploads[0].options.parallel, 2);
    assert.equal(f.clients[0].options.secure, true);
    assert.equal(f.requests.some(request => request.url.endsWith('/delete')), false);
  }
});

test('invalid extensions, empty and oversized files never request credentials or load a client', async () => {
  for (const media of [file('audio.ogg'), file('audio.mp3.exe'), file('mp3'), file('empty.mp3', 0), file('large.mp3', 2 * 1024 ** 3 + 1)]) {
    const f = fixture();
    await assert.rejects(f.uploader(media));
    assert.equal(f.requests.length, 0);
    assert.equal(f.clients.length, 0);
    assert.equal(f.tokenReads, 0);
  }
});

test('an already aborted upload never creates a VOD record', async () => {
  const f = fixture(), controller = new AbortController();
  controller.abort();
  await assert.rejects(f.uploader(file(), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.requests.length, 0);
});

test('stop remains responsive while the SDK script is still loading', async () => {
  const controller = new AbortController();
  const f = fixture({ sdkLoader: () => {
    queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  } });
  await assert.rejects(f.uploader(file(), { signal: controller.signal }), { name: 'AbortError' });
  await nextTurn();
  assert.equal(f.uploads.length, 0);
  assert.deepEqual(f.requests.find(request => request.url.endsWith('/delete')).body, { videoId: 'new-vod-1' });
});

test('stop during credential creation obtains the new ID before cleaning only that attempt', async () => {
  const controller = new AbortController();
  const f = fixture({ onRequest: request => {
    if (request.url === '/api/videos/upload-credentials') {
      controller.abort();
      assert.equal(request.init.signal.aborted, false, 'the in-flight credential response remains readable');
    }
  } });
  await assert.rejects(f.uploader(file(), { ...f.options, signal: controller.signal, videoId: 'previous-course-vod' }), { name: 'AbortError' });
  await nextTurn();
  assert.equal(f.uploads.length, 0);
  const deletions = f.requests.filter(request => request.url.endsWith('/delete'));
  assert.equal(deletions.length, 1);
  assert.deepEqual(deletions[0].body, { videoId: 'new-vod-1' });
  assert.ok(!JSON.stringify(f.requests).includes('previous-course-vod'));
  assert.equal(deletions[0].at, 3000);
});

test('STS renewal reads the fresh session token while retaining the same VOD ID', async () => {
  let renewed;
  const f = fixture({ tokens: ['initial-session', 'renewed-session'], onUpload: async ({ client }) => {
    renewed = await client.options.refreshSTSToken();
  } });
  await f.uploader(file());
  assert.deepEqual(f.requests.map(request => request.init.headers.Authorization), ['Bearer initial-session', 'Bearer renewed-session']);
  assert.equal(f.requests[1].url, '/api/videos/upload-credentials/refresh');
  assert.deepEqual(f.requests[1].body, { videoId: 'new-vod-1' });
  assert.equal(renewed.stsToken, 'sts-2');
  assert.equal(f.requests[1].at - f.requests[0].at, 3000);
});

test('create, refresh and cleanup all use the same three-second request scheduler', async () => {
  const f = fixture({ onUpload: async ({ client }) => {
    await client.options.refreshSTSToken();
    throw new Error('upload interrupted');
  } });
  await assert.rejects(f.uploader(file()), /upload interrupted/);
  await nextTurn();
  assert.deepEqual(f.requests.map(request => [request.url, request.at]), [
    ['/api/videos/upload-credentials', 0],
    ['/api/videos/upload-credentials/refresh', 3000],
    ['/api/videos/upload-credentials/delete', 6000],
  ]);
  assert.ok(f.requests.slice(1).every(request => request.body.videoId === 'new-vod-1'));
});

test('concurrent upload calls serialize their credential requests', async () => {
  const f = fixture();
  const results = await Promise.all([f.uploader(file('1.mp3')), f.uploader(file('2.mp3')), f.uploader(file('3.mp3'))]);
  assert.deepEqual(f.requests.map(request => request.at), [0, 3000, 6000]);
  assert.equal(new Set(results.map(result => result.videoId)).size, 3);
});

test('429 without Retry-After waits sixty seconds and retries the same create once', async () => {
  const f = fixture({ onRequest: (_request, requests) => requests.length === 1 ? response({ error: 'rate_limited' }, 429) : null });
  await f.uploader(file(), f.options);
  assert.deepEqual(f.requests.map(request => request.at), [0, 60000]);
  assert.deepEqual(f.requests[0].body, f.requests[1].body);
  assert.equal(f.waits[0].ms, 60000);
  assert.match(f.statuses.join(' '), /自动重试/);
});

test('Retry-After is honored without bypassing the minimum interval', async () => {
  for (const [retryAfter, at] of [['5', 5000], ['1', 3000], ['invalid', 60000]]) {
    const f = fixture({ onRequest: (_request, requests) => requests.length === 1 ? response({}, 429, retryAfter) : null });
    await f.uploader(file());
    assert.equal(f.requests[1].at, at);
  }
});

test('429 cooldown is cancellable and does not issue another credential request', async () => {
  const controller = new AbortController();
  const f = fixture({ onRequest: () => response({ error: 'rate_limited' }, 429), onWait: () => { controller.abort(); } });
  await assert.rejects(f.uploader(file(), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.requests.length, 1);
  assert.equal(f.waits[0].ms, 60000);
  assert.equal(f.waits[0].signal, controller.signal);
  assert.equal(f.uploads.length, 0);
});

test('persistent 429 stops after one retry instead of looping forever', async () => {
  const f = fixture({ onRequest: () => response({ message: '请稍后再试' }, 429) });
  await assert.rejects(f.uploader(file()), /请稍后再试/);
  assert.equal(f.requests.length, 2);
  assert.equal(f.uploads.length, 0);
});

test('a missing session fails before creating upload credentials', async () => {
  const f = fixture({ tokens: [''] });
  await assert.rejects(f.uploader(file()), /登录已失效/);
  assert.equal(f.requests.length, 0);
});

test('a later save failure or abort never deletes a successfully returned upload', async () => {
  const f = fixture(), controller = new AbortController();
  const result = await f.uploader(file(), { signal: controller.signal });
  await assert.rejects((async () => { throw new Error('database response lost'); })(), /database response lost/);
  controller.abort();
  await nextTurn();
  assert.equal(result.videoId, 'new-vod-1');
  assert.equal(f.requests.filter(request => request.url.endsWith('/delete')).length, 0);
  assert.equal(f.clients[0].cancelCount, 0);
});

test('a confirmed upload is retained if stop races with its final successful response', async () => {
  const controller = new AbortController();
  const f = fixture({ onUpload: async () => { controller.abort(); } });
  const result = await f.uploader(file(), { signal: controller.signal });
  await nextTurn();
  assert.equal(result.videoId, 'new-vod-1');
  assert.equal(f.requests.filter(request => request.url.endsWith('/delete')).length, 0);
});

test('a cancelled multipart transfer that rejects cleans only its incomplete VOD ID', async () => {
  const controller = new AbortController();
  const f = fixture({ onUpload: async () => {
    controller.abort();
    const error = new Error('multipart cancelled'); error.name = 'AbortError'; throw error;
  } });
  await assert.rejects(f.uploader(file(), { signal: controller.signal }), { name: 'AbortError' });
  await nextTurn();
  assert.equal(f.clients[0].cancelCount > 0, true);
  const deletion = f.requests.find(request => request.url.endsWith('/delete'));
  assert.deepEqual(deletion.body, { videoId: 'new-vod-1' });
});
