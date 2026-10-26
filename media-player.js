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

// Only URLs returned by the authorized response enter this list. A stored
// progress record is never allowed to contain, or supply, a playback URL.
export function playableRenditions(playback, media, base) {
  const kind = describeMedia(playback).type;
  const seen = new Set();
  return [playback, ...(playback.isPreview ? [] : Array.isArray(playback.renditions) ? playback.renditions : [])].flatMap(item => {
    const candidate = { ...item, mediaType: kind, streamType: kind };
    const description = describeMedia(candidate);
    const playURL = safeMediaUrl(candidate.playURL, base);
    if (!playURL || seen.has(playURL) || description.format === 'mpd') return [];
    if (description.format === 'm3u8' && !media.canPlayType('application/vnd.apple.mpegurl') &&
        !media.canPlayType('application/x-mpegURL')) return [];
    if (description.mime && description.format !== 'm3u8' && !media.canPlayType(description.mime)) return [];
    seen.add(playURL);
    return [{ ...candidate, playURL, description }];
  });
}

export function attachAudioSleepTimer(shell, media, { now = Date.now,
  schedule = setTimeout, cancel = clearTimeout } = {}) {
  const doc = shell.ownerDocument;
  const label = doc.createElement('label'); label.className = 'ks-audio-sleep';
  const caption = doc.createElement('span'); caption.textContent = '定时停止';
  const select = doc.createElement('select'); select.setAttribute('aria-label', '音频定时停止');
  for (const minutes of [0, 15, 30, 60]) {
    const option = doc.createElement('option'); option.value = String(minutes);
    option.textContent = minutes ? `${minutes} 分钟` : '不设置'; select.append(option);
  }
  select.value = '0';
  const status = doc.createElement('span'); status.className = 'ks-sleep-status'; status.setAttribute('role', 'status');
  label.append(caption, select, status); shell.append(label);
  let deadline = 0, timer = null, disposed = false;
  const clear = () => { if (timer !== null) cancel(timer); timer = null; };
  const check = () => {
    if (disposed || !deadline || now() < deadline) return;
    clear(); deadline = 0; select.value = '0'; media.pause(); status.textContent = '定时已到，已暂停播放。';
  };
  const change = () => {
    if (disposed) return;
    clear(); const minutes = Number(select.value);
    deadline = [15, 30, 60].includes(minutes) ? now() + minutes * 60000 : 0;
    status.textContent = deadline ? `已设置 ${minutes} 分钟定时停止` : '已取消定时停止';
    if (deadline) timer = schedule(check, Math.max(0, deadline - now()));
  };
  select.addEventListener('change', change);
  media.addEventListener('timeupdate', check); media.addEventListener('playing', check);
  doc.addEventListener?.('visibilitychange', check);
  doc.defaultView?.addEventListener?.('pageshow', check);
  return { select, dispose() {
    disposed = true; deadline = 0; clear();
    select.removeEventListener?.('change', change);
    media.removeEventListener?.('timeupdate', check); media.removeEventListener?.('playing', check);
    doc.removeEventListener?.('visibilitychange', check);
    doc.defaultView?.removeEventListener?.('pageshow', check);
  } };
}

// Native video fullscreen is a separate API on iPhone. Where fullscreen is
// denied (including embedded browsers), keep the same authorized media element
// and expand it within the page. Never reload a stream to change display mode.
export function attachVideoFullscreen(shell, media, button) {
  const doc = shell.ownerDocument, win = doc.defaultView;
  const schedule = win?.setTimeout?.bind(win) || setTimeout;
  const cancel = win?.clearTimeout?.bind(win) || clearTimeout;
  let disposed = false, pending = false, mode = '', timer = null, serial = 0, videoNative = false;
  let pageState = null, previousFocus = null;
  const bar = doc.createElement('div'); bar.className = 'ks-media-fullscreen-bar'; bar.hidden = true;
  const caption = doc.createElement('span'); caption.setAttribute('role', 'status');
  const close = doc.createElement('button'); close.className = 'ks-media-fullscreen-exit';
  close.type = 'button'; close.textContent = '退出全屏';
  bar.append(caption, close); shell.append(bar);
  const focus = node => { try { node?.focus?.({ preventScroll: true }); } catch (_) {} };
  const clearTimer = () => { if (timer !== null) cancel(timer); timer = null; };
  const currentElement = () => doc.fullscreenElement || doc.webkitFullscreenElement || doc.webkitCurrentFullScreenElement;
  const ownsNative = () => currentElement() === shell || currentElement() === media || videoNative || !!media.webkitDisplayingFullscreen;
  const setMode = value => {
    mode = value;
    if (value) shell.dataset.fullscreen = value; else delete shell.dataset.fullscreen;
    button.textContent = value ? '退出全屏' : '全屏';
    button.setAttribute('aria-pressed', String(!!value));
    bar.hidden = !value;
    caption.textContent = value === 'page' ? '网页内全屏' : '全屏播放';
  };
  const preserveStyle = (node, values) => {
    const before = Object.keys(values).map(key => [key, node.style.getPropertyValue(key), node.style.getPropertyPriority(key)]);
    for (const [key, value] of Object.entries(values)) node.style.setProperty(key, value);
    return () => { for (const [key, value, priority] of before) {
      if (value) node.style.setProperty(key, value, priority); else node.style.removeProperty(key);
    } };
  };
  const move = (parent, before = null) => {
    const playing = !media.paused;
    // moveBefore preserves element state on browsers that implement it.
    if (typeof parent.moveBefore === 'function' && shell.isConnected && parent.isConnected) parent.moveBefore(shell, before);
    else parent.insertBefore(shell, before);
    if (playing && media.paused && !disposed) {
      try { Promise.resolve(media.play()).catch(() => {}); } catch (_) {}
    }
  };
  const leavePage = () => {
    if (!pageState) return;
    const state = pageState; pageState = null;
    if (state.marker.parentNode) { move(state.marker.parentNode, state.marker); state.marker.remove(); }
    else shell.remove(); // Its owning watch page was removed while fullscreen.
    for (const [node, inert] of state.inert) node.inert = inert;
    for (const restore of state.styles) restore();
    for (const [name, value] of state.attributes) {
      if (value === null) shell.removeAttribute(name); else shell.setAttribute(name, value);
    }
    try { win?.scrollTo?.(state.x, state.y); } catch (_) {}
    state.restoreScrollBehavior();
  };
  const enterPage = token => {
    if (disposed || token !== serial || mode === 'native' || ownsNative()) return;
    clearTimer(); pending = false;
    if (!pageState) {
      const marker = doc.createElement('div'); marker.setAttribute('aria-hidden', 'true');
      marker.style.height = `${shell.getBoundingClientRect().height}px`;
      shell.parentNode.insertBefore(marker, shell);
      const x = win?.scrollX || 0, y = win?.scrollY || 0;
      const attributes = ['role', 'aria-modal'].map(name => [name, shell.getAttribute(name)]);
      move(doc.body);
      const inert = [...doc.body.children].filter(node => node !== shell).map(node => [node, node.inert]);
      for (const [node] of inert) node.inert = true;
      pageState = { marker, x, y, attributes, inert,
        restoreScrollBehavior: preserveStyle(doc.documentElement, { 'scroll-behavior': 'auto' }),
        styles: [preserveStyle(doc.documentElement, { overflow: 'hidden' }), preserveStyle(doc.body, {
          overflow: 'hidden', position: 'fixed', top: `${-y}px`, left: `${-x}px`, width: '100%',
        })],
      };
      shell.setAttribute('role', 'dialog'); shell.setAttribute('aria-modal', 'true');
    }
    setMode('page'); focus(close);
  };
  const exitNative = () => {
    try {
      let result;
      if ((videoNative || media.webkitDisplayingFullscreen) && typeof media.webkitExitFullscreen === 'function') {
        result = media.webkitExitFullscreen();
      } else if (currentElement() === shell || currentElement() === media) {
        const exit = doc.exitFullscreen || doc.webkitExitFullscreen || doc.webkitCancelFullScreen;
        result = exit?.call(doc);
      }
      Promise.resolve(result).catch(() => { if (!disposed && ownsNative()) setMode('native'); });
    } catch (_) { if (!disposed && ownsNative()) setMode('native'); }
  };
  const exit = () => {
    const wasActive = !!mode || pending;
    serial++; pending = false; clearTimer(); leavePage(); setMode('');
    exitNative(); if (wasActive) focus(previousFocus || button);
  };
  const syncNative = () => {
    if (disposed) return;
    if (ownsNative()) {
      clearTimer(); pending = false; leavePage(); setMode('native');
    } else if (mode === 'native') {
      setMode(''); focus(previousFocus || button);
    }
  };
  const onClick = () => {
    if (disposed) return;
    if (mode || pending) { exit(); return; }
    previousFocus = doc.activeElement;
    const token = ++serial;
    // Invoke the chosen API in this click's synchronous user-activation stack.
    let request;
    if (typeof media.webkitEnterFullscreen === 'function' && media.webkitSupportsFullscreen !== false) {
      request = () => media.webkitEnterFullscreen();
    } else if (typeof shell.requestFullscreen === 'function' && doc.fullscreenEnabled !== false) {
      request = () => shell.requestFullscreen();
    } else if (doc.webkitFullscreenEnabled !== false &&
        (typeof shell.webkitRequestFullscreen === 'function' || typeof shell.webkitRequestFullScreen === 'function')) {
      request = () => (shell.webkitRequestFullscreen || shell.webkitRequestFullScreen).call(shell);
    }
    if (!request) { enterPage(token); return; }
    pending = true;
    // Some embedded browsers expose a stub that neither rejects nor enters.
    timer = schedule(() => enterPage(token), 1200);
    try {
      const result = request();
      syncNative();
      Promise.resolve(result).then(() => {
        if (disposed || token !== serial) {
          if (ownsNative() && (disposed || (!pending && !mode))) exitNative();
          return;
        }
        syncNative();
      }, () => enterPage(token));
    } catch (_) { enterPage(token); }
  };
  const onError = () => { if (pending) enterPage(serial); };
  const onBegin = () => { videoNative = true; syncNative(); };
  const onEnd = () => { videoNative = false; syncNative(); };
  const onKey = event => {
    if (mode !== 'page') return;
    if (event.key === 'Escape') { event.preventDefault(); exit(); }
    if (event.key === 'Tab') {
      const items = [...shell.querySelectorAll('button,select,video')].filter(node => !node.disabled && !node.hidden && node.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (doc.activeElement === first || !shell.contains(doc.activeElement))) {
        event.preventDefault(); focus(last);
      } else if (!event.shiftKey && (doc.activeElement === last || !shell.contains(doc.activeElement))) {
        event.preventDefault(); focus(first);
      }
    }
  };
  button.addEventListener('click', onClick); close.addEventListener('click', exit);
  for (const name of ['fullscreenchange', 'webkitfullscreenchange']) doc.addEventListener?.(name, syncNative);
  for (const name of ['fullscreenerror', 'webkitfullscreenerror']) shell.addEventListener(name, onError);
  media.addEventListener('webkitbeginfullscreen', onBegin); media.addEventListener('webkitendfullscreen', onEnd);
  doc.addEventListener?.('keydown', onKey);
  setMode('');
  return () => {
    if (disposed) return;
    disposed = true; exit();
    button.removeEventListener?.('click', onClick); close.removeEventListener?.('click', exit);
    for (const name of ['fullscreenchange', 'webkitfullscreenchange']) doc.removeEventListener?.(name, syncNative);
    for (const name of ['fullscreenerror', 'webkitfullscreenerror']) shell.removeEventListener?.(name, onError);
    media.removeEventListener?.('webkitbeginfullscreen', onBegin); media.removeEventListener?.('webkitendfullscreen', onEnd);
    doc.removeEventListener?.('keydown', onKey);
    bar.remove?.();
  };
}

const activePlayers = new WeakMap();
let mediaSessionOwner = null;
export function renderMediaPlayer(wrap, playback = {}, info = {}, options = {}) {
  activePlayers.get(wrap)?.();
  const doc = wrap.ownerDocument;
  const base = doc.baseURI;
  const description = describeMedia(playback);
  for (const previous of wrap.querySelectorAll('audio,video')) previous.pause();
  wrap.replaceChildren();
  const el = (name, className, text) => {
    const node = doc.createElement(name);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const audio = description.type === 'audio';
  const preview = playback.isPreview === true;
  const previewLimit = preview && Number.isFinite(playback.previewSeconds) && playback.previewSeconds > 0 &&
    playback.previewSeconds <= 180 && playback.previewLimitSeconds === 180 ? playback.previewSeconds : 0;
  const shell = el('div', audio ? 'ks-audio-player' : 'ks-video-player');
  const status = el('p', 'ks-media-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const fail = message => { status.dataset.state = 'error'; status.textContent = message; };
  wrap.append(shell);
  if (!safeMediaUrl(playback.playURL, base) || (preview && !previewLimit)) {
    shell.append(status);
    fail('没有可用的播放地址，请重试；仍有问题请联系平台。');
    return null;
  }
  const title = typeof info.title === 'string' && info.title.trim() ? info.title.trim() : audio ? '音频课程' : '视频课程';
  const media = el(audio ? 'audio' : 'video', audio ? 'ks-native-audio' : 'ks-native-video');
  const effectiveDuration = () => preview ? Math.min(previewLimit, Number.isFinite(media.duration) && media.duration > 0 ? media.duration : previewLimit) : media.duration;
  media.controls = true;
  media.preload = 'metadata';
  media.autoplay = false;
  media.setAttribute('aria-label', `${audio ? '音频' : '视频'}播放：${title}`);
  if (!audio) { media.setAttribute('playsinline', ''); media.setAttribute('webkit-playsinline', ''); }
  const coverUrl = safeMediaUrl(info.coverURL || info.coverUrl || info.cover_url || info.coverImage || info.cover_image, base);
  if (audio) {
    const header = el('div', 'ks-audio-heading');
    const art = el('div', 'ks-audio-art');
    const cover = el('img');
    cover.alt = '';
    cover.src = coverUrl || safeMediaUrl('/assets/logo.png', base);
    cover.addEventListener('error', () => { cover.hidden = true; art.textContent = '♪'; });
    art.append(cover);
    const heading = el('div', 'ks-audio-title');
    heading.append(el('span', 'ks-audio-label', '♪ 音频课程'), el('h3', '', title));
    if (typeof info.speaker === 'string' && info.speaker.trim()) heading.append(el('p', '', `主讲：${info.speaker.trim()}`));
    header.append(art, heading); shell.append(header);
  } else if (coverUrl) media.poster = coverUrl;
  const stage = el('div', 'ks-media-stage');
  stage.append(media); shell.append(stage);
  const playButton = el('button', 'ks-media-play', '▶ 开始播放');
  playButton.type = 'button';
  if (!audio) stage.append(playButton);
  const play = () => {
    if (preview && media.currentTime >= effectiveDuration()) {
      try { media.currentTime = 0; } catch (_) {}
    }
    try { Promise.resolve(media.play()).catch(() => { status.textContent = '请点击播放器上的播放按钮继续。'; }); }
    catch (_) { status.textContent = '请点击播放器上的播放按钮继续。'; }
  };
  playButton.addEventListener('click', play);
  const actions = [];
  const seekBar = el('div', 'ks-audio-seek');
  for (const [delta, label] of [[-15, '后退 15 秒'], [15, '前进 15 秒']]) {
    const button = el('button', '', label);
    button.type = 'button'; button.disabled = true;
    button.addEventListener('click', () => {
      const time = boundedSeek(media.currentTime, delta, effectiveDuration());
      if (time !== null) media.currentTime = time;
    });
    actions.push(button); seekBar.append(button);
  }
  const speedBar = el('div', 'ks-audio-speed');
  speedBar.setAttribute('role', 'group'); speedBar.setAttribute('aria-label', '播放速度');
  speedBar.append(el('span', '', '播放速度'));
  const speedButtons = [];
  for (const rate of [1, 1.25, 1.5, 2]) {
    const button = el('button', '', `${rate}×`);
    button.type = 'button'; button.setAttribute('aria-pressed', String(rate === 1));
    button.addEventListener('click', () => {
      try { media.playbackRate = rate; }
      catch (_) { status.textContent = '当前浏览器暂不支持调整播放速度。'; }
    });
    speedButtons.push([button, rate]); actions.push(button); speedBar.append(button);
  }
  shell.append(seekBar, speedBar);
  let disposeFullscreen = null;
  if (!audio) {
    const fullscreen = el('button', 'ks-media-fullscreen', '全屏'); fullscreen.type = 'button';
    speedBar.append(fullscreen);
    disposeFullscreen = attachVideoFullscreen(shell, media, fullscreen);
    // Exit remains available even when a stream error disables playback controls.
  }
  const retry = el('button', 'ks-media-retry', '重新加载并继续'); retry.type = 'button'; retry.hidden = true;
  shell.append(status, retry);
  let disposed = false, retrying = false, autoRetried = false, lastSaved = 0, finished = false;
  const schedule = doc.defaultView?.setTimeout?.bind(doc.defaultView) || setTimeout;
  const cancel = doc.defaultView?.clearTimeout?.bind(doc.defaultView) || clearTimeout;
  const sleep = audio ? attachAudioSleepTimer(shell, media, { schedule, cancel }) : null;
  if (sleep) actions.push(sleep.select);
  const progressStore = preview ? options.previewStore : options.progressStore;
  let stored = null;
  try { stored = progressStore?.get(options.videoId); } catch (_) { /* Storage may be disabled. */ }
  const initialPosition = Number.isFinite(options.initialPosition) ? options.initialPosition : stored?.completed ? 0 : stored?.position;
  const initialRate = Number.isFinite(options.initialRate) ? options.initialRate : stored?.rate;
  let restore = { position: initialPosition || 0, rate: initialRate || 1, resume: !!options.resumePlayback };
  let sourceChanging = false;
  const save = (force = false, completed = finished) => {
    if (disposed || sourceChanging || !options.videoId || !Number.isFinite(media.duration) || media.duration <= 0 ||
        !Number.isFinite(media.currentTime) || media.currentTime <= 0) return;
    const now = Date.now();
    if (!force && now - lastSaved < 5000) return;
    lastSaved = now;
    try { progressStore?.save({ videoId: options.videoId, title, speaker: info.speaker || '', kind: audio ? 'audio' : 'video',
      position: Math.min(media.currentTime, effectiveDuration()), duration: effectiveDuration(), rate: media.playbackRate, updatedAt: now, completed: preview ? false : completed }); }
    catch (_) { /* Playback continues when private browsing/storage quota prevents saving. */ }
  };
  let previewTimer = null, previewEnded = false;
  const clearPreviewTimer = () => { if (previewTimer !== null) cancel(previewTimer); previewTimer = null; };
  const finishPreview = () => {
    if (!preview || disposed) return;
    const wasEnded = previewEnded;
    previewEnded = true; clearPreviewTimer();
    if (media.currentTime > effectiveDuration()) try { media.currentTime = effectiveDuration(); } catch (_) {}
    media.pause(); save(true, false);
    status.textContent = `本次${audio ? '试听' : '试看'}已结束，请登录或解锁后继续完整课程。`;
    playButton.textContent = '↻ 重新体验'; playButton.hidden = audio;
    if (!wasEnded) options.onPreviewEnded?.();
  };
  const checkPreview = () => {
    clearPreviewTimer();
    if (!preview || disposed) return;
    const remaining = effectiveDuration() - media.currentTime;
    if (remaining <= 0) { finishPreview(); return; }
    previewEnded = false;
    if (!media.paused) previewTimer = schedule(checkPreview, Math.max(50, remaining * 1000 / (media.playbackRate || 1)));
  };
  const retryPlayback = async automatic => {
    if (disposed || retrying || typeof options.onRetry !== 'function') return;
    save(true); retrying = true; retry.disabled = true;
    status.dataset.state = ''; status.textContent = '正在重新获取播放地址…';
    try {
      await options.onRetry({ position: media.currentTime || initialPosition || 0, duration: media.duration,
        rate: media.playbackRate, resumePlayback: !media.paused, automatic });
    } catch (_) { if (!disposed) fail('重新加载失败，请检查网络后重试。'); }
    finally { retrying = false; retry.disabled = false; }
  };
  retry.addEventListener('click', () => retryPlayback(false));
  const playbackError = () => {
    if (disposed || retrying) return;
    for (const action of actions) action.disabled = true;
    playButton.hidden = true;
    fail(`${audio ? '音频' : '视频'}暂时无法播放。可重新加载并继续；仍有问题请联系平台。`);
    retry.hidden = typeof options.onRetry !== 'function';
    if (!autoRetried && typeof options.onRetry === 'function') { autoRetried = true; void retryPlayback(true); }
  };
  const nav = doc.defaultView?.navigator;
  const session = nav?.mediaSession;
  const sessionActions = ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'nexttrack'];
  const sessionPosition = () => {
    if (mediaSessionOwner !== media || !session?.setPositionState || !Number.isFinite(media.duration) || media.duration <= 0) return;
    try { session.setPositionState({ duration: effectiveDuration(), playbackRate: media.playbackRate,
      position: Math.max(0, Math.min(media.currentTime, effectiveDuration())) }); } catch (_) { /* Optional browser capability. */ }
  };
  const claimMediaSession = () => {
    if (!session) return;
    mediaSessionOwner = media;
    const Metadata = doc.defaultView?.MediaMetadata;
    if (Metadata) try { session.metadata = new Metadata({ title, artist: info.speaker || '肾域学院', album: '肾域医学课程',
      ...(coverUrl ? { artwork: [{ src: coverUrl }] } : {}) }); } catch (_) { /* Optional metadata. */ }
    const seek = delta => { const target = boundedSeek(media.currentTime, delta, effectiveDuration()); if (target !== null) media.currentTime = target; };
    const handlers = { play, pause: () => media.pause(), seekbackward: event => seek(-(event.seekOffset || 15)),
      seekforward: event => seek(event.seekOffset || 15), seekto: event => {
        const target = boundedSeek(0, event.seekTime, effectiveDuration()); if (target !== null) media.currentTime = target;
      }, nexttrack: !preview && typeof options.onNext === 'function' ? options.onNext : null };
    for (const name of sessionActions) try { session.setActionHandler(name, handlers[name]); } catch (_) { /* Unsupported action. */ }
    try { session.playbackState = 'playing'; } catch (_) {}
    sessionPosition();
  };
  const onHide = () => save(true);
  const onVisibility = () => { if (doc.visibilityState === 'hidden') save(true); };
  doc.defaultView?.addEventListener?.('pagehide', onHide);
  doc.addEventListener?.('visibilitychange', onVisibility);
  const cleanup = () => {
    if (disposed) return;
    save(true); disposed = true; clearPreviewTimer(); sleep?.dispose();
    disposeFullscreen?.();
    for (const source of media.querySelectorAll('source')) source.removeAttribute?.('src');
    media.removeAttribute?.('src');
    media.load?.(); // Release the old signed stream and stop background buffering.
    doc.defaultView?.removeEventListener?.('pagehide', onHide);
    doc.removeEventListener?.('visibilitychange', onVisibility);
    if (session && mediaSessionOwner === media) {
      for (const name of sessionActions) try { session.setActionHandler(name, null); } catch (_) {}
      try { session.metadata = null; session.playbackState = 'none'; } catch (_) {}
      mediaSessionOwner = null;
    }
  };
  activePlayers.set(wrap, cleanup);
  // Watch can release lifecycle listeners when replacing playback with an access gate.
  media.ksDispose = cleanup;
  media.addEventListener('play', () => { if (!disposed) playButton.hidden = true; });
  media.addEventListener('playing', () => { if (disposed) return; status.dataset.state = ''; status.textContent = ''; retry.hidden = true; claimMediaSession(); checkPreview(); });
  media.addEventListener('pause', () => { if (disposed) return; clearPreviewTimer(); save(true); if (session && mediaSessionOwner === media) try { session.playbackState = 'paused'; } catch (_) {} });
  media.addEventListener('timeupdate', () => { if (disposed) return; checkPreview(); save(); sessionPosition(); });
  media.addEventListener('seeked', () => { if (disposed) return; if (media.currentTime < media.duration - 2) finished = false; checkPreview(); save(true); sessionPosition(); });
  media.addEventListener('ratechange', () => {
    if (disposed) return;
    for (const [button, rate] of speedButtons) button.setAttribute('aria-pressed', String(media.playbackRate === rate));
    checkPreview(); save(true); sessionPosition();
  });
  media.addEventListener('ended', () => { if (disposed) return; if (preview) { finishPreview(); return; } finished = true; save(true); options.onEnded?.(); });
  media.addEventListener('waiting', () => { if (!disposed && !retrying) status.textContent = '正在缓冲，请稍候…'; });
  media.addEventListener('error', playbackError);
  media.addEventListener('loadedmetadata', () => {
    if (disposed) return;
    for (const button of actions) button.disabled = false;
    for (const button of seekBar.children) button.disabled = !Number.isFinite(media.duration) || media.duration <= 0;
    if (restore) {
      const state = restore; restore = null;
      const position = boundedSeek(0, state.position, effectiveDuration());
      if (position !== null && position < effectiveDuration() - 2) try { media.currentTime = position; } catch (_) {}
      try { media.playbackRate = Math.min(2, Math.max(.5, state.rate)); } catch (_) {}
      sourceChanging = false;
      status.dataset.state = ''; status.textContent = position > 0 ? '已恢复上次进度，点击播放继续。' : `${audio ? '音频' : '视频'}已就绪，点击播放开始${audio ? '收听' : '学习'}。`;
      if (position > 0) playButton.textContent = '▶ 继续播放';
      if (state.resume) play();
    }
  });
  const renditions = playableRenditions(playback, media, base);
  if (!renditions.length) {
    for (const action of actions) action.disabled = true;
    playButton.disabled = true; playButton.hidden = true; media.hidden = true;
    fail(`当前浏览器暂不支持这份${audio ? '音频' : '视频'}的播放格式。可尝试 Safari，或联系平台提供${audio ? ' MP3' : ' MP4'} 格式。`);
    return media;
  }
  const source = el('source');
  source.addEventListener('error', playbackError);
  const setSource = item => { source.src = item.playURL; source.type = item.description.mime; };
  setSource(renditions[0]);
  media.append(source, doc.createTextNode('当前浏览器不支持播放，请尝试更新浏览器。'));
  if (renditions.length > 1) {
    const quality = el('label', 'ks-media-quality', '画质 ');
    const select = el('select'); select.setAttribute('aria-label', '选择画质');
    renditions.forEach((item, index) => {
      const definition = String(item.definition || '').toUpperCase();
      const name = item.height ? `${item.height}p` : ({ OD: '原画', FD: '流畅', LD: '标清', SD: '标清', HD: '高清', '2K': '2K', '4K': '4K' })[definition] || definition || '默认';
      const option = el('option', '', `${name} · ${item.description.format.toUpperCase() || '视频'}${index === 0 ? '（当前）' : ''}`);
      option.value = String(index); select.append(option);
    });
    select.addEventListener('change', () => {
      const item = renditions[Number(select.value)]; if (!item) return;
      save(true); restore = { position: media.currentTime, rate: media.playbackRate, resume: !media.paused };
      sourceChanging = true; setSource(item); media.load();
      status.textContent = '正在切换画质，将保留播放进度…';
    });
    quality.append(select); shell.append(quality);
  }
  return media;
}
