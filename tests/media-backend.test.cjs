'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Exercise real handlers with fake HTTP boundaries. No live accounts, files,
// uploads, payment records or Aliyun services are touched by these tests.
const token = `test.${Buffer.from(JSON.stringify({
  sub: 'test-user', aud: 'authenticated', exp: 4102444800,
})).toString('base64url')}.test`;
const audioStream = { StreamType: 'audio', Format: 'mp3', PlayURL: 'https://media.example/audio.mp3', Duration: '60' };
const videoStream = { StreamType: 'video', Format: 'mp4', PlayURL: 'https://media.example/video.mp4', Duration: '120' };

function fixture(name, options = {}) {
  const requests = [];
  const net = {
    request(requestOptions, callback) {
      const req = new EventEmitter();
      req.body = '';
      req.write = chunk => { req.body += chunk; };
      req.setTimeout = () => req;
      req.destroy = error => req.emit('error', error);
      req.end = () => queueMicrotask(() => {
        const url = new URL(requestOptions.path, `https://${requestOptions.hostname}`);
        const record = { url, headers: requestOptions.headers, body: req.body };
        requests.push(record);
        let payload;
        let status = 200;
        if (url.pathname === '/rest/v1/profiles') {
          status = options.profileStatus || 200;
          payload = [{ role: options.role || 'admin' }];
        } else if (url.pathname === '/rest/v1/learning_videos') {
          payload = [{
            id: 'lesson-1', title: 'Test lesson', kind: 'aliyun', aliyun_vid: 'vod-1',
            is_published: true, access_type: 'paid_membership', specialty_id: 'specialty-1',
            ...(options.video || {}),
          }];
        } else if (url.pathname === '/rest/v1/rpc/check_video_access') {
          status = options.rpcStatus || 200;
          payload = options.allowed !== false;
        } else if (url.pathname === '/rest/v1/play_logs') {
          payload = {};
        } else if (url.searchParams.get('Action') === 'CreateUploadVideo') {
          payload = { VideoId: 'vod-1', UploadAuth: 'temporary-test-auth', UploadAddress: 'temporary-test-address' };
        } else if (url.searchParams.get('Action') === 'GetPlayInfo') {
          payload = options.playInfo || { VideoBase: { MediaType: 'video' }, PlayInfoList: { PlayInfo: [videoStream] } };
        } else {
          throw new Error(`Unexpected test request ${url.pathname}`);
        }
        const response = new EventEmitter();
        response.statusCode = status;
        callback(response);
        response.emit('data', JSON.stringify(payload));
        response.emit('end');
      });
      return req;
    },
  };
  const exported = {};
  const env = {
    SUPABASE_URL: 'https://db.example', SUPABASE_ANON_KEY: 'test-anon',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service', ALIYUN_VOD_ACCESS_KEY_ID: 'test-id',
    ALIYUN_VOD_ACCESS_KEY_SECRET: 'test-secret', ALIYUN_VOD_REGION: 'cn-shanghai',
    ...(options.env || {}),
  };
  const source = fs.readFileSync(path.join(__dirname, '../netlify/functions', name + '.js'), 'utf8');
  vm.runInNewContext(source, {
    exports: exported, process: { env }, Buffer, URL,
    require: key => ['https', 'http'].includes(key) ? net : require(key),
    console: { log() {}, error() {} },
  }, { filename: name + '.js' });
  return {
    requests,
    async run(extra = {}) {
      const result = await exported.handler({
        httpMethod: 'POST',
        path: name === 'video-upload-auth' ? '/api/videos/upload-credentials' : '/api/videos/lesson-1/play-auth',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: 'Learning media', fileName: 'lesson.mp3' }),
        ...extra,
      });
      return { status: result.statusCode, body: JSON.parse(result.body) };
    },
  };
}

for (const ext of ['mp3', 'm4a', 'wav', 'aac', 'flac', 'wma', 'ape']) {
  test(`admin can obtain VOD audio upload credentials for ${ext}`, async () => {
    const f = fixture('video-upload-auth');
    const result = await f.run({ body: JSON.stringify({ title: '肾脏课程', fileName: `课程 (一).${ext.toUpperCase()}` }) });
    assert.equal(result.status, 200);
    assert.equal(result.body.mediaType, 'audio');
    assert.equal(result.body.videoId, 'vod-1');
    const vod = f.requests.find(r => r.url.searchParams.get('Action') === 'CreateUploadVideo');
    assert.equal(vod.url.searchParams.get('FileName'), `课程 (一).${ext.toUpperCase()}`);
  });
}

for (const ext of ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'flv', 'wmv', 'webm', 'ts']) {
  test(`existing ${ext} video upload remains accepted`, async () => {
    const f = fixture('video-upload-auth');
    const result = await f.run({ body: JSON.stringify({ title: 'Video', fileName: `lesson.${ext}` }) });
    assert.equal(result.status, 200);
    assert.equal(result.body.mediaType, 'video');
  });
}

test('unsupported files are rejected before VOD credentials are issued', async () => {
  for (const fileName of ['lesson.ogg', 'script.js', 'song.mp3.exe', 'song', 'track.aiff']) {
    const f = fixture('video-upload-auth');
    const result = await f.run({ body: JSON.stringify({ title: 'Test', fileName }) });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'unsupported_file_type');
    assert.equal(f.requests.some(r => r.url.searchParams.has('Action')), false);
  }
});

test('optional audio transcoding template applies to audio only', async () => {
  for (const [fileName, template] of [['lesson.wav', 'audio-template'], ['lesson.mp4', null]]) {
    const f = fixture('video-upload-auth', { env: { ALIYUN_VOD_AUDIO_TEMPLATE_GROUP_ID: 'audio-template' } });
    assert.equal((await f.run({ body: JSON.stringify({ title: 'Test', fileName }) })).status, 200);
    const vod = f.requests.find(r => r.url.searchParams.get('Action') === 'CreateUploadVideo');
    assert.equal(vod.url.searchParams.get('TemplateGroupId'), template);
  }
});

test('upload requires login and verified admin profile', async () => {
  const anonymous = fixture('video-upload-auth');
  assert.equal((await anonymous.run({ headers: {} })).status, 401);
  assert.equal(anonymous.requests.length, 0);
  const member = fixture('video-upload-auth', { role: 'member' });
  assert.equal((await member.run()).status, 403);
  assert.equal(member.requests.some(r => r.url.searchParams.has('Action')), false);
  const invalidSession = fixture('video-upload-auth', { profileStatus: 401 });
  assert.notEqual((await invalidSession.run()).status, 200);
  assert.equal(invalidSession.requests.some(r => r.url.searchParams.has('Action')), false);
});

test('audio playback requires login before any media request', async () => {
  const f = fixture('video-play-auth');
  assert.equal((await f.run({ headers: {} })).status, 401);
  assert.equal(f.requests.length, 0);
});

for (const accessType of ['paid_single', 'paid_specialty', 'paid_membership']) {
  test(`${accessType} cannot play audio without an entitlement`, async () => {
    const f = fixture('video-play-auth', { allowed: false, video: { access_type: accessType } });
    const result = await f.run();
    assert.equal(result.status, 403);
    assert.equal(result.body.needPurchase, true);
    const rpc = f.requests.find(r => r.url.pathname.endsWith('/check_video_access'));
    assert.equal(rpc.headers.Authorization, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(rpc.body), { p_user_id: 'test-user', p_video_id: 'lesson-1', p_specialty_id: 'specialty-1' });
    assert.equal(f.requests.some(r => r.url.searchParams.get('Action') === 'GetPlayInfo'), false);
  });
}

test('failed entitlement RPC fails closed for paid media', async () => {
  const f = fixture('video-play-auth', { rpcStatus: 500 });
  assert.equal((await f.run()).status, 403);
  assert.equal(f.requests.some(r => r.url.searchParams.get('Action') === 'GetPlayInfo'), false);
});

test('authorized audio returns MP3 media type and temporary playback URL', async () => {
  const f = fixture('video-play-auth', { playInfo: { VideoBase: { MediaType: 'audio' }, PlayInfoList: { PlayInfo: [audioStream] } } });
  const result = await f.run();
  assert.equal(result.status, 200);
  assert.equal(result.body.playerType, 'signed_url');
  assert.equal(result.body.playURL, audioStream.PlayURL);
  assert.equal(result.body.format, 'mp3');
  assert.equal(result.body.mediaType, 'audio');
  assert.equal(result.body.streamType, 'audio');
  assert.equal(result.body.expiresIn, 3600);
});

test('video assets never select an extracted audio stream ahead of the video', async () => {
  const f = fixture('video-play-auth', { playInfo: { VideoBase: { MediaType: 'video' }, PlayInfoList: { PlayInfo: [audioStream, videoStream] } } });
  const result = await f.run();
  assert.equal(result.status, 200);
  assert.equal(result.body.playURL, videoStream.PlayURL);
  assert.equal(result.body.mediaType, 'video');
});

test('legacy video response without media metadata retains video selection', async () => {
  const f = fixture('video-play-auth', { playInfo: { PlayInfoList: { PlayInfo: [audioStream, { ...videoStream, StreamType: undefined }] } } });
  assert.equal((await f.run()).body.playURL, videoStream.PlayURL);
});

test('audio-only streams can identify audio when VideoBase metadata is absent', async () => {
  const f = fixture('video-play-auth', { playInfo: { PlayInfoList: { PlayInfo: [{ ...audioStream, StreamType: undefined }] } } });
  assert.equal((await f.run()).body.mediaType, 'audio');
});

test('video with only an audio rendition does not silently play that rendition', async () => {
  const f = fixture('video-play-auth', { playInfo: { VideoBase: { MediaType: 'video' }, PlayInfoList: { PlayInfo: [audioStream] } } });
  const result = await f.run();
  assert.notEqual(result.status, 200);
  assert.equal(result.body.playURL, undefined);
});

test('not-ready or incompatible audio gives a useful error, never stale URL fallback', async () => {
  for (const streams of [[], [{ ...audioStream, Format: 'flv' }], [{ ...audioStream, Encrypt: 1 }], [{ ...audioStream, Status: 'Invisible' }]]) {
    const f = fixture('video-play-auth', {
      video: { source_url: 'https://media.example/stale-video.mp4' },
      playInfo: { VideoBase: { MediaType: 'audio' }, PlayInfoList: { PlayInfo: streams } },
    });
    const result = await f.run();
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'audio_not_ready');
    assert.match(result.body.message, /MP3/);
    assert.equal(result.body.playURL, undefined);
  }
});

test('unpublished audio remains inaccessible', async () => {
  const f = fixture('video-play-auth', { video: { is_published: false } });
  assert.equal((await f.run()).status, 403);
  assert.equal(f.requests.some(r => r.url.searchParams.has('Action')), false);
});

test('registered-free media retains its existing login-gated behavior', async () => {
  const f = fixture('video-play-auth', { video: { access_type: 'registered_free' } });
  assert.equal((await f.run()).status, 200);
  assert.equal(f.requests.some(r => r.url.pathname.endsWith('/check_video_access')), false);
});
