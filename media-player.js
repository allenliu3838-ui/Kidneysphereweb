// Receives an already authorized URL. Access checks remain in watch.html and
// the existing /api/videos/:id/play-auth endpoint; this module calls no API.
const AUDIO_FORMATS = new Set(['mp3', 'm4a', 'm4b', 'aac', 'wav', 'wave', 'flac', 'oga', 'opus']);
const FORMAT_ALIASES = Object.freeze({
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/flac': 'flac', 'audio/ogg': 'oga', 'video/mp4': 'mp4',
  'application/vnd.apple.mpegurl': 'm3u8', 'application/x-mpegurl': 'm3u8',
});

export function describeMedia(playback = {}) {
  let format = String(playback.format || '').trim().toLowerCase().split(';')[0].replace(/^\./, '');
  format = Object.hasOwn(FORMAT_ALIASES, format) ? FORMAT_ALIASES[format] : format;
  if (!format) {
    try { format = new URL(playback.playURL, 'https://kidneysphere.com/').pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || ''; }
    catch (_) { /* An invalid URL is rejected before player construction. */ }
  }
  const mediaType = String(playback.mediaType || '').trim().toLowerCase();
  const streamType = String(playback.streamType || '').trim().toLowerCase();
  const explicitType = ['audio', 'video'].includes(streamType) ? streamType : ['audio', 'video'].includes(mediaType) ? mediaType : '';
  const audio = explicitType ? explicitType === 'audio' : AUDIO_FORMATS.has(format);
  let mime = '';
  if (format === 'm3u8') mime = 'application/vnd.apple.mpegurl';
  else if (audio) mime = ({ mp3: 'audio/mpeg', mp4: 'audio/mp4', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
    wav: 'audio/wav', wave: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm' })[format] || '';
  else mime = ({ mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg', ogv: 'video/ogg', mov: 'video/quicktime' })[format] || '';
  return { type: audio ? 'audio' : 'video', format, mime: typeof mime === 'string' ? mime : '' };
}

export function safeMediaUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value, base);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch (_) { return ''; }
}

export function boundedSeek(current, delta, duration) {
  if (!Number.isFinite(current) || !Number.isFinite(delta) || !Number.isFinite(duration) || duration <= 0) return null;
  return Math.max(0, Math.min(duration, current + delta));
}

export function renderMediaPlayer(wrap, playback = {}, info = {}) {
  const doc = wrap.ownerDocument;
  const base = doc.baseURI;
  const url = safeMediaUrl(playback.playURL, base);
  const description = describeMedia(playback);
  for (const previous of wrap.querySelectorAll('audio,video')) previous.pause();
  wrap.replaceChildren();
  const el = (name, className, text) => {
    const node = doc.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const shell = el('div', description.type === 'audio' ? 'ks-audio-player' : 'ks-video-player');
  const status = el('p', 'ks-media-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const fail = message => {
    status.dataset.state = 'error';
    status.textContent = message;
  };
  wrap.append(shell);
  if (!url) {
    shell.append(status);
    fail('没有可用的播放地址，请刷新页面重新获取权限；仍有问题请联系平台。');
    return null;
  }
  const audio = description.type === 'audio';
  const title = typeof info.title === 'string' && info.title.trim() ? info.title.trim() : audio ? '音频课程' : '视频课程';
  const media = el(audio ? 'audio' : 'video', audio ? 'ks-native-audio' : 'ks-native-video');
  media.controls = true;
  media.preload = 'metadata';
  media.autoplay = false;
  media.setAttribute('aria-label', `${audio ? '音频' : '视频'}播放：${title}`);
  if (!audio) media.setAttribute('playsinline', '');
  const actions = [];
  if (audio) {
    const header = el('div', 'ks-audio-heading');
    const art = el('div', 'ks-audio-art');
    const cover = el('img');
    cover.alt = '';
    const coverUrl = safeMediaUrl(info.coverURL || info.coverUrl || info.cover_url || info.coverImage || info.cover_image, base);
    cover.src = coverUrl || safeMediaUrl('/assets/logo.png', base);
    // The fallback is the portal logo, not an invented lecturer portrait.
    cover.addEventListener('error', () => { cover.hidden = true; art.textContent = '♪'; });
    art.append(cover);
    const heading = el('div', 'ks-audio-title');
    heading.append(el('span', 'ks-audio-label', '音频课程'), el('h3', '', title));
    if (typeof info.speaker === 'string' && info.speaker.trim()) heading.append(el('p', '', `主讲：${info.speaker.trim()}`));
    header.append(art, heading);
    shell.append(header);
  }
  shell.append(media);
  if (audio) {
    const seekBar = el('div', 'ks-audio-seek');
    for (const [delta, label] of [[-15, '后退 15 秒'], [15, '前进 15 秒']]) {
      const button = el('button', '', label);
      button.type = 'button';
      button.disabled = true;
      button.addEventListener('click', () => {
        const time = boundedSeek(media.currentTime, delta, media.duration);
        if (time !== null) media.currentTime = time;
      });
      actions.push(button);
      seekBar.append(button);
    }
    const speedBar = el('div', 'ks-audio-speed');
    speedBar.setAttribute('role', 'group');
    speedBar.setAttribute('aria-label', '音频播放速度');
    speedBar.append(el('span', '', '播放速度'));
    const speedButtons = [];
    for (const rate of [1, 1.25, 1.5, 2]) {
      const button = el('button', '', `${rate}×`);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(rate === 1));
      button.addEventListener('click', () => {
        try { media.playbackRate = rate; }
        catch (_) { status.textContent = '当前浏览器暂不支持调整此音频的播放速度。'; }
      });
      speedButtons.push([button, rate]);
      actions.push(button);
      speedBar.append(button);
    }
    media.addEventListener('ratechange', () => {
      for (const [button, rate] of speedButtons) button.setAttribute('aria-pressed', String(media.playbackRate === rate));
    });
    media.addEventListener('loadedmetadata', () => {
      for (const button of seekBar.children) button.disabled = !Number.isFinite(media.duration) || media.duration <= 0;
      status.textContent = '音频已就绪，点击播放开始收听。';
    });
    shell.append(seekBar, speedBar);
  }
  shell.append(status);
  status.textContent = audio ? '正在准备音频，加载后可播放或调整速度。' : '';
  const playbackError = () => {
    for (const action of actions) action.disabled = true;
    fail(audio ? '音频暂时无法播放。播放链接可能已过期，或文件尚未处理完成。请刷新页面重试；仍有问题请联系平台。' :
      '视频暂时无法播放，请刷新页面重新获取播放权限；仍有问题请联系平台。');
  };
  media.addEventListener('error', playbackError);
  if (description.format === 'mpd' || (description.format === 'm3u8' &&
      !media.canPlayType('application/vnd.apple.mpegurl') && !media.canPlayType('application/x-mpegURL'))) {
    for (const action of actions) action.disabled = true;
    media.hidden = true;
    fail(`当前浏览器暂不支持这份${audio ? '音频' : '视频'}的播放格式。可尝试 Safari，或联系平台提供${audio ? ' MP3' : ' MP4'} 格式。`);
    return media;
  }
  const source = el('source');
  source.src = url;
  if (description.mime) source.type = description.mime;
  source.addEventListener('error', playbackError);
  media.append(source, doc.createTextNode('当前浏览器不支持播放，请尝试更新浏览器。'));
  return media;
}
