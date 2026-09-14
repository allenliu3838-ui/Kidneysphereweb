import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../media-player.js', import.meta.url), 'utf8');
const watch = readFileSync(new URL('../watch.html', import.meta.url), 'utf8');
const { describeMedia, safeMediaUrl, boundedSeek, renderMediaPlayer } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
);

class Node {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = [];
    this.attributes = {}; this.listeners = {}; this.dataset = {}; this.textContent = '';
    this.className = ''; this.hidden = false; this.disabled = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  dispatch(name) { for (const handler of this.listeners[name] || []) handler({ target: this }); }
  querySelectorAll(selector) {
    const keys = selector.split(',');
    const found = [];
    const walk = parent => {
      for (const child of parent.children || []) {
        if (keys.some(key => key[0] === '.' ? child.className?.split(' ').includes(key.slice(1)) : child.tagName === key.toUpperCase())) found.push(child);
        walk(child);
      }
    };
    walk(this); return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function playerFixture({ nativeHls = false } = {}) {
  const doc = {
    baseURI: 'https://kidneysphere.com/watch.html?id=fixture',
    createTextNode(textContent) { return { textContent }; },
    createElement(tag) {
      const node = new Node(tag, doc);
      if (tag === 'audio' || tag === 'video') {
        node.duration = NaN; node.currentTime = 0; node.pauseCalls = 0; node.playCalls = 0;
        node.pause = () => { node.pauseCalls += 1; };
        node.play = () => { node.playCalls += 1; return Promise.resolve(); };
        node.canPlayType = type => /mpegurl/i.test(type) ? (nativeHls ? 'probably' : '') : 'probably';
        let rate = 1;
        Object.defineProperty(node, 'playbackRate', { get: () => rate, set: value => { rate = value; node.dispatch('ratechange'); } });
      }
      return node;
    },
  };
  return { doc, wrap: doc.createElement('div') };
}

test('media recognition supports Aliyun audio metadata and MP3 format on older API responses', () => {
  assert.deepEqual(describeMedia({ mediaType: 'audio', format: 'mp4' }), { type: 'audio', format: 'mp4', mime: 'audio/mp4' });
  assert.deepEqual(describeMedia({ streamType: 'audio', format: 'm3u8' }), { type: 'audio', format: 'm3u8', mime: 'application/vnd.apple.mpegurl' });
  assert.deepEqual(describeMedia({ format: 'MP3' }), { type: 'audio', format: 'mp3', mime: 'audio/mpeg' });
  assert.equal(describeMedia({ mediaType: 'video', format: 'mp3' }).type, 'video', 'Explicit server metadata takes precedence over an extension');
  assert.equal(describeMedia({ mediaType: 'video', streamType: 'audio', format: 'mp3' }).type, 'audio', 'The actual selected stream determines the native player');
  for (const [format, mime] of [['m4a', 'audio/mp4'], ['wav', 'audio/wav'], ['aac', 'audio/aac'], ['flac', 'audio/flac'], ['audio/ogg', 'audio/ogg']]) {
    assert.equal(describeMedia({ format }).type, 'audio');
    assert.equal(describeMedia({ format }).mime, mime);
  }
});

test('ordinary MP4 and unknown media remain video; URL inference ignores signatures and query names', () => {
  assert.deepEqual(describeMedia({ format: 'mp4' }), { type: 'video', format: 'mp4', mime: 'video/mp4' });
  assert.equal(describeMedia({ playURL: 'https://vod.example/lesson.MP3?auth_key=signed.mp4' }).type, 'audio');
  assert.equal(describeMedia({ playURL: 'https://vod.example/lesson.mp4?download=audio.mp3' }).type, 'video');
  for (const format of ['unknown', '__proto__', 'constructor', '<script>']) assert.equal(describeMedia({ format }).mime, '');
});

test('source validation keeps authorized query parameters and rejects script/data/credential URLs', () => {
  const url = 'https://vod.example/lesson.mp3?auth_key=fixture-key&x=2';
  assert.equal(safeMediaUrl(url, 'https://kidneysphere.com/'), url);
  assert.equal(safeMediaUrl('/public/lesson.wav', 'https://kidneysphere.com/watch'), 'https://kidneysphere.com/public/lesson.wav');
  for (const bad of ['', null, 'javascript:alert(1)', 'data:audio/mp3;base64,AA', 'https://user:pass@vod.example/a.mp3']) {
    assert.equal(safeMediaUrl(bad, 'https://kidneysphere.com/'), '');
  }
});

test('authorized audio renders compact native controls and title without autoplay or HTML injection', () => {
  const f = playerFixture();
  const media = renderMediaPlayer(f.wrap, { playURL: 'https://vod.example/a.mp3?auth_key=fixture', format: 'mp3' },
    { title: '<img onerror=alert(1)>', speaker: '教学讲者' });
  assert.equal(media.tagName, 'AUDIO');
  assert.equal(media.controls, true); assert.equal(media.preload, 'metadata'); assert.equal(media.autoplay, false);
  assert.equal(media.playCalls, 0);
  assert.equal(media.querySelector('source').type, 'audio/mpeg');
  assert.equal(media.querySelector('source').src, 'https://vod.example/a.mp3?auth_key=fixture');
  assert.equal(f.wrap.querySelector('h3').textContent, '<img onerror=alert(1)>');
  assert.equal(f.wrap.querySelectorAll('video').length, 0);
  assert.equal(f.wrap.querySelectorAll('img').length, 1, 'Only the intentional cover image exists');
  assert.equal(f.wrap.querySelector('.ks-media-status').getAttribute('role'), 'status');
});

test('audio seek is disabled before metadata, clamps to both ends, and speed buttons follow actual rate', () => {
  const f = playerFixture();
  const media = renderMediaPlayer(f.wrap, { playURL: 'https://vod.example/a.m4a', mediaType: 'audio', format: 'm4a' });
  const seek = f.wrap.querySelector('.ks-audio-seek').children;
  assert.ok(seek.every(button => button.disabled));
  media.duration = 40; media.dispatch('loadedmetadata');
  assert.ok(seek.every(button => !button.disabled));
  media.currentTime = 4; seek[0].dispatch('click'); assert.equal(media.currentTime, 0);
  media.currentTime = 35; seek[1].dispatch('click'); assert.equal(media.currentTime, 40);
  const speeds = f.wrap.querySelector('.ks-audio-speed').querySelectorAll('button');
  speeds[2].dispatch('click');
  assert.equal(media.playbackRate, 1.5);
  assert.deepEqual(speeds.map(button => button.getAttribute('aria-pressed')), ['false', 'false', 'true', 'false']);
  media.playbackRate = 2;
  assert.deepEqual(speeds.map(button => button.getAttribute('aria-pressed')), ['false', 'false', 'false', 'true']);
  assert.equal(media.playCalls, 0, 'Changing speed must not start playback');
  for (const duration of [NaN, Infinity, 0, -1]) assert.equal(boundedSeek(0, 15, duration), null);
});

test('MP4 keeps video controls and playsinline, and replacing a player stops old playback', () => {
  const f = playerFixture();
  const original = renderMediaPlayer(f.wrap, { playURL: 'https://vod.example/video.mp4', format: 'mp4' });
  assert.equal(original.tagName, 'VIDEO'); assert.equal(original.getAttribute('playsinline'), '');
  assert.equal(original.querySelector('source').type, 'video/mp4');
  renderMediaPlayer(f.wrap, { playURL: 'https://vod.example/audio.mp3', format: 'mp3' });
  assert.equal(original.pauseCalls, 1);
  assert.equal(f.wrap.querySelectorAll('video').length, 0);
});

test('unsupported HLS and invalid sources explain failure instead of initializing a broken stream', () => {
  const f = playerFixture();
  const media = renderMediaPlayer(f.wrap, { playURL: 'https://vod.example/a.m3u8', format: 'm3u8', mediaType: 'audio' });
  assert.equal(media.hidden, true); assert.equal(media.querySelector('source'), null);
  assert.match(f.wrap.querySelector('.ks-media-status').textContent, /暂不支持.*MP3/);
  assert.ok(f.wrap.querySelectorAll('button').every(button => button.disabled));
  const supported = playerFixture({ nativeHls: true });
  const hls = renderMediaPlayer(supported.wrap, { playURL: 'https://vod.example/a.m3u8', format: 'm3u8', mediaType: 'audio' });
  assert.equal(hls.querySelector('source').type, 'application/vnd.apple.mpegurl');
  assert.equal(renderMediaPlayer(f.wrap, { playURL: 'javascript:alert(1)' }), null);
  assert.equal(f.wrap.querySelectorAll('audio,video').length, 0);
});

test('audio network/decoding errors present a retry explanation and disable custom controls', () => {
  const f = playerFixture();
  const media = renderMediaPlayer(f.wrap, { playURL: 'https://vod.example/a.mp3', format: 'mp3' });
  media.querySelector('source').dispatch('error');
  assert.equal(f.wrap.querySelector('.ks-media-status').dataset.state, 'error');
  assert.match(f.wrap.querySelector('.ks-media-status').textContent, /音频暂时无法播放.*刷新/);
  assert.ok(f.wrap.querySelectorAll('button').every(button => button.disabled));
});

test('watch initializes media only after a successful signed/direct play-auth response', async () => {
  const start = watch.indexOf('async function requestAndPlay(');
  const end = watch.indexOf('// ── PlayAuth player placeholder', start);
  assert.ok(start > 0 && end > start);
  const requestFunction = watch.slice(start, end);
  for (const status of [401, 403, 500, 200]) {
    const calls = [];
    const auth = { playerType: 'signed_url', playURL: 'https://vod.example/audio.mp3', format: 'mp3', mediaType: 'audio', streamType: 'audio' };
    const context = vm.createContext({
      wrap: { innerHTML: '' }, location: { href: 'https://kidneysphere.com/watch.html?id=fixture' },
      esc: value => String(value), console: { error() {} },
      fetch: async (url, options) => {
        assert.equal(url, '/api/videos/fixture/play-auth');
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.Authorization, 'Bearer fixture-token');
        return { ok: status === 200, status, json: async () => status === 200 ? auth : { message: 'Denied' } };
      },
      initUrlPlayer: (...args) => calls.push(args),
    });
    vm.runInContext(`${requestFunction}\nglobalThis.run = requestAndPlay;`, context);
    await context.run('fixture', 'fixture-token', { title: '测试课程' });
    assert.equal(calls.length, status === 200 ? 1 : 0, `HTTP ${status} must preserve the playback gate`);
    if (status === 200) { assert.equal(calls[0][0], auth.playURL); assert.equal(calls[0][3], auth); }
  }
});
