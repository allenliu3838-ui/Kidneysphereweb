import { ensureSupabase } from './supabaseClient.js?v=20260401_fix';
import { getCategoryMeta } from './assets/videos.js?v=20260917_permissions1';
import { renderMediaPlayer } from './media-player.js?v=20260916_learn2';
import { createLearningProgress } from './learning-progress.js?v=20260915_mobile1';
import { requestAuthorizedPlayback, withTimeout, createPreviewProgress } from './watch-playback.js?v=20260916_learn2';

const byId = id => document.getElementById(id);
const wrap = byId('playerWrap');
const titleEl = byId('title');
const metaEl = byId('meta');
const id = new URLSearchParams(location.search).get('id') || '';
const arrivedFromAutoNext = new URLSearchParams(location.search).get('autoplay') === '1';
const returnTo = `${location.pathname}${location.search}${location.hash}`;
const checkoutReturn = `/watch.html?id=${encodeURIComponent(id)}`;
const checkoutHref = query => `checkout.html?${query}&next=${encodeURIComponent(checkoutReturn)}`;
let previewStorage;
try { previewStorage = window.sessionStorage; } catch (_) { /* Optional in private browsing. */ }
const previewProgress = createPreviewProgress({ storage: previewStorage });
byId('loginBtn').href = `login.html?next=${encodeURIComponent(returnTo)}`;
byId('registerBtn').href = `register.html?next=${encodeURIComponent(returnTo)}`;
window.__watchCancelTimeout?.();

function element(tag, text, className = '') {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
let client, clientPromise, session, activeMedia, requestVersion = 0, pendingRequest = false, recoveryAttempts = 0;
let knownUserId, subscribed = false, identityTimer = null;
const SERIES_TIMEOUT_MS = 30000;
let seriesView = null, seriesAbort = null, seriesTimer = null, seriesVersion = 0, removeNextPrompt = null, autoNextConsumed = false;
const stopMedia = () => {
  seriesVersion += 1;
  clearTimeout(seriesTimer); seriesTimer = null;
  seriesAbort?.abort(); seriesAbort = null;
  seriesView?.dispose(); seriesView = null;
  byId('courseSeries')?.replaceChildren();
  if (byId('courseSeries')) byId('courseSeries').hidden = true;
  removeNextPrompt?.(); removeNextPrompt = null;
  activeMedia?.ksDispose?.(); activeMedia?.pause(); activeMedia = null;
  // Embedded players do not share the native media lifecycle. Destroy them on
  // logout/account change so a hidden Bilibili frame cannot keep playing.
  for (const frame of wrap.querySelectorAll('iframe')) { frame.src = 'about:blank'; frame.remove(); }
};
function changeIdentity(nextSession) {
  clearTimeout(identityTimer); identityTimer = null;
  knownUserId = nextSession?.user?.id || null; session = nextSession;
  requestVersion += 1; pendingRequest = false; recoveryAttempts = 0; stopMedia();
  if (!knownUserId) showLogin();
  else {
    const version = requestVersion;
    identityTimer = setTimeout(() => { identityTimer = null; if (version === requestVersion) void loadPlayback(); }, 0);
  }
}

async function startSeries(version, progressStore, canAutoplay) {
  const generation = ++seriesVersion;
  const current = () => version === requestVersion && generation === seriesVersion;
  const container = byId('courseSeries');
  if (!container || !current()) return;
  clearTimeout(seriesTimer);
  seriesAbort?.abort(); seriesView?.dispose(); seriesView = null;
  const controller = new AbortController(); seriesAbort = controller;
  const active = () => current() && !controller.signal.aborted;
  const retry = () => { if (current()) void startSeries(version, progressStore, canAutoplay); };
  const fail = () => {
    if (!active()) return;
    // Import downloads cannot be canceled, but the signal and generation check
    // discard late modules/pages. A stalled metadata fetch is actually aborted.
    controller.abort();
    if (seriesView) seriesView.failed(retry);
    else {
      const note = element('p', '章节目录暂时无法加载，本节课程可继续播放。', 'ks-series-status'); note.setAttribute('role', 'status');
      const button = element('button', '重试章节目录', 'btn'); button.type = 'button';
      button.addEventListener('click', retry); container.replaceChildren(note, button);
    }
  };
  // One deadline covers both the lazy module download and all catalog pages.
  // It never blocks the mounted player, and logout/navigation clear this timer.
  const timer = setTimeout(fail, SERIES_TIMEOUT_MS); seriesTimer = timer;
  const waiting = element('p', '正在整理章节目录…', 'ks-series-status'); waiting.setAttribute('role', 'status');
  container.replaceChildren(waiting); container.hidden = false;
  try {
    // Even optional module downloads begin after the authorized media is mounted.
    const [{ loadCourseCatalog }, { createWatchSeries }] = await Promise.all([
      import('./course-catalog.js?v=20260916_learn2'),
      import('./watch-series.js?v=20260916_learn2'),
    ]);
    if (!active()) return;
    const view = createWatchSeries({ container, courseId: id,
      progressStore, baseHref: location.href, canAutoplay,
      onNavigate: href => {
        if (!active()) return;
        // A new document always obtains new authorization. Never transfer a
        // signed media URL, a session, or an access decision to another chapter.
        location.assign(href);
        requestVersion += 1; pendingRequest = false; stopMedia();
      },
    });
    seriesView = view;
    view.loading();
    const rows = await loadCourseCatalog(client, { signal: controller.signal,
      onPage: (page, details) => { if (active()) view.loading(details?.rows?.length || page.length); } });
    if (active()) view.setRows(rows);
  } catch (_) { fail(); }
  finally {
    clearTimeout(timer);
    if (seriesTimer === timer) seriesTimer = null;
  }
}

function showNextPlaybackPrompt(media, version) {
  const prompt = byId('nextPlayback');
  const message = element('p', '下一节已准备好。如未自动播放，请点击下方按钮继续。');
  const play = element('button', '▶ 播放下一节', 'btn primary'); play.type = 'button';
  prompt.replaceChildren(message, play); prompt.hidden = false;
  const isCurrent = () => version === requestVersion && media === activeMedia;
  play.addEventListener('click', () => {
    if (!isCurrent()) return;
    try {
      Promise.resolve(media.play()).catch(() => {
        if (isCurrent()) message.textContent = '未能开始播放，请点击播放器上的播放按钮，或重新加载课程。';
      });
    } catch (_) { if (isCurrent()) message.textContent = '请点击播放器上的播放按钮继续。'; }
  });
  const onPlaying = () => { if (isCurrent()) prompt.hidden = true; };
  media.addEventListener?.('playing', onPlaying);
  removeNextPrompt = () => {
    media.removeEventListener?.('playing', onPlaying); prompt.replaceChildren(); prompt.hidden = true;
  };
}
async function getClient() {
  if (!client) {
    clientPromise ||= withTimeout(() => ensureSupabase()).finally(() => { clientPromise = null; });
    client = await clientPromise;
  }
  if (client && !subscribed) {
    subscribed = true;
    client.auth.onAuthStateChange((event, nextSession) => {
      // getSession owns the initial snapshot. Later identity changes invalidate
      // every in-flight result before it can render or choose a history store.
      if (event === 'INITIAL_SESSION') return;
      const nextUserId = nextSession?.user?.id || null;
      if (event === 'SIGNED_OUT' || nextUserId !== knownUserId) changeIdentity(nextSession);
      else session = nextSession;
    });
  }
  return client;
}
const resetGates = () => {
  byId('loginGate').hidden = true; byId('paidGate').hidden = true; wrap.hidden = false;
  byId('previewGate').hidden = true;
  byId('openExternal').hidden = true;
};
const showInfo = (video = {}, playback = {}) => {
  titleEl.textContent = video.title || '课程播放';
  document.title = `${video.title || '课程播放'} · 肾域`;
  const cat = getCategoryMeta(video.category);
  metaEl.textContent = [video.speaker ? `主讲：${video.speaker}` : '', cat?.zh || ''].filter(Boolean).join(' · ');
  byId('desc').textContent = video.description || '';
  byId('courseDescription').hidden = !video.description;
  const audio = (playback.mediaType || video.mediaType) === 'audio';
  byId('courseMedia').textContent = audio ? '♪ 音频课程' : '▶ 视频课程';
  byId('courseMedia').setAttribute('aria-label', audio ? '音频课程' : '视频课程');
};
function showError(message, state = {}) {
  stopMedia(); resetGates();
  if (titleEl.textContent === '正在加载…') titleEl.textContent = '课程加载失败';
  const note = element('div', '', 'note ks-watch-error'); note.setAttribute('role', 'alert');
  note.append(element('p', message));
  const retry = element('button', '重新加载', 'btn primary'); retry.type = 'button';
  retry.addEventListener('click', () => { recoveryAttempts = 0; void loadPlayback(state); });
  note.append(retry); wrap.replaceChildren(note);
}
function showLogin(video = {}) {
  stopMedia(); resetGates(); showInfo(video); wrap.hidden = true; byId('loginGate').hidden = false;
}
function showPurchase(video) {
  stopMedia(); resetGates(); wrap.hidden = true; byId('paidGate').hidden = false;
  const memberCourse = isMemberCourse(video);
  byId('paidGateTitle').textContent = memberCourse ? '开通会员后观看' : '解锁这节课程';
  byId('paidGateMsg').textContent = memberCourse ? '本课程为教育会员每周直播回放，开通后即可学习。' :
    `本课程为付费内容${Number(video.price) > 0 ? `（¥${video.price}）` : ''}，购买后即可观看。`;
  const buttons = byId('paidGateBtns'); buttons.replaceChildren();
  const addLink = (label, href, primary) => { const link = element('a', label, primary ? 'btn primary' : 'btn'); link.href = href; buttons.append(link); };
  if (memberCourse) addLink('开通教育会员', checkoutHref('product=MEMBERSHIP-YEARLY'), true);
  else if (video.productId) addLink('购买单集', checkoutHref(`product_id=${encodeURIComponent(video.productId)}`), true);
  addLink('我的学习 / 查看订单', 'my-learning.html');
  // Optional bundle lookup never holds up the purchase or login prompt.
  if (!memberCourse && video.specialtyId && client) {
    void (async () => {
      try {
        const { data } = await withTimeout(() => client.from('specialties').select('name,bundle_product_id').eq('id', video.specialtyId).maybeSingle(), 5000);
        if (data?.bundle_product_id && !byId('paidGate').hidden) addLink(`购买${data.name || '专科'}整套课`, checkoutHref(`product_id=${encodeURIComponent(data.bundle_product_id)}`));
      } catch (_) { /* The single-course purchase remains available. */ }
    })();
  }
}
function isMemberCourse(video = {}, playback = {}) {
  return video.membershipAccessible === true && video.membershipScope === 'weekly_replay' &&
    (playback.mediaType || video.mediaType || 'video') === 'video';
}
function showPreviewGate(response, ended = false) {
  const { video, playback } = response;
  const audio = playback.mediaType === 'audio';
  const verb = audio ? '试听' : '试看';
  const seconds = playback.previewSeconds;
  const panel = byId('previewGate'); panel.hidden = false;
  byId('previewGateTitle').textContent = ended ? `本次${verb}已结束` : `免费${verb} · 最多3分钟`;
  byId('previewGateMsg').textContent = ended ? `本节${verb}片段共 ${seconds} 秒。解锁后可从当前进度继续学习。` :
    `本节提供 ${seconds} 秒独立预览。${playback.needLogin ? '登录后可查看完整课程的学习权限。' : '解锁后可继续完整课程。'}`;
  const buttons = byId('previewGateBtns'); buttons.replaceChildren();
  const addLink = (label, href, primary = false) => {
    const link = element('a', label, primary ? 'btn primary' : 'btn'); link.href = href; buttons.append(link);
  };
  if (playback.needLogin) {
    addLink('登录并继续', `login.html?next=${encodeURIComponent(returnTo)}`, true);
    addLink('注册账号', `register.html?next=${encodeURIComponent(returnTo)}`);
  } else if (isMemberCourse(video, playback)) {
    addLink('开通教育会员', checkoutHref('product=MEMBERSHIP-YEARLY'), true);
  } else if (video.productId) {
    addLink('解锁完整课程', checkoutHref(`product_id=${encodeURIComponent(video.productId)}`), true);
  } else addLink('查看学习权限', 'my-learning.html', true);
}
function renderBilibili(bvid) {
  if (!/^BV[0-9A-Za-z]+$/.test(bvid)) { showError('课程缺少播放信息，请联系平台。'); return; }
  const url = `https://www.bilibili.com/video/${bvid}/`;
  const box = element('div', '', 'video-embed');
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) {
    box.className += ' bili-mobile-card';
    const link = element('a', '▶ 点击前往 B 站观看', 'bili-mobile-link'); link.href = url; link.target = '_blank'; link.rel = 'noopener'; box.append(link);
  } else {
    const frame = document.createElement('iframe'); frame.src = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&page=1&high_quality=1&danmaku=0&autoplay=0`;
    frame.title = titleEl.textContent; frame.allowFullscreen = true; box.append(frame);
  }
  wrap.replaceChildren(box);
  const link = byId('openExternal'); link.href = url; link.textContent = '打开 B 站'; link.hidden = false;
}
async function loadPlayback(state = {}) {
  if (pendingRequest) return;
  pendingRequest = true;
  const version = ++requestVersion;
  try {
    stopMedia(); resetGates();
    wrap.replaceChildren(element('div', '正在准备课程…', 'ks-watch-loading'));
    await getClient();
    if (version !== requestVersion) return;
    if (!client) throw new Error('暂时无法连接登录服务，请检查网络后重试。');
    const result = await withTimeout(() => client.auth.getSession());
    if (version !== requestVersion) return;
    if (result.error) throw new Error('读取登录状态失败，请重试。');
    const requestSession = result.data?.session || null;
    const requestUserId = requestSession?.user?.id || null;
    session = requestSession; knownUserId = requestUserId;
    // getSession already resolves initial restoration; there is no extra wait.
    const response = await requestAuthorizedPlayback(id, { token: requestSession?.access_token,
      refreshSession: async () => {
        const refreshed = await client.auth.refreshSession();
        if (refreshed.error) return null;
        const nextSession = refreshed.data?.session || null;
        if ((nextSession?.user?.id || null) !== requestUserId) {
          if (version === requestVersion) changeIdentity(nextSession);
          return null;
        }
        session = nextSession; return nextSession;
      } });
    if (version !== requestVersion) return;
    showInfo(response.video, response.playback);
    if (response.kind === 'login') { showLogin(response.video); return; }
    if (response.kind === 'purchase') { showPurchase(response.video); return; }
    if (response.kind === 'error') { showError(response.message, state); return; }
    if (response.kind === 'bilibili') {
      renderBilibili(response.playback.bvid);
      void startSeries(version, createLearningProgress({ userId: requestUserId }), false); return;
    }
    if (response.kind === 'preview') {
      showPreviewGate(response);
      activeMedia = renderMediaPlayer(wrap, response.playback, response.video, {
        previewStore: previewProgress, videoId: id, ...state, resumePlayback: false,
        onPreviewEnded: () => { if (version === requestVersion) showPreviewGate(response, true); },
        onRetry: async details => {
          if (version !== requestVersion) return;
          if (details.automatic && recoveryAttempts >= 1) throw new Error('Automatic recovery already attempted');
          recoveryAttempts = details.automatic ? recoveryAttempts + 1 : 0;
          await loadPlayback({ initialPosition: details.position, initialRate: details.rate });
        },
      });
      return;
    }
    const progressStore = createLearningProgress({ userId: requestUserId });
    let savedProgress;
    try { savedProgress = progressStore.get?.(id); } catch (_) {}
    const trialProgress = savedProgress ? null : previewProgress.get(id);
    const autoNext = arrivedFromAutoNext && !autoNextConsumed;
    autoNextConsumed = true;
    activeMedia = renderMediaPlayer(wrap, response.playback, response.video, {
      progressStore, videoId: id, resumePlayback: autoNext,
      ...(trialProgress ? { initialPosition: trialProgress.position, initialRate: trialProgress.rate } : {}), ...state,
      onNext: () => { if (version === requestVersion) seriesView?.next(); },
      onEnded: () => { if (version === requestVersion) seriesView?.ended(); },
      onRetry: async details => {
        if (version !== requestVersion) return;
        if (details.automatic && recoveryAttempts >= 1) throw new Error('Automatic recovery already attempted');
        recoveryAttempts = details.automatic ? recoveryAttempts + 1 : 0;
        await loadPlayback({ initialPosition: details.position, initialRate: details.rate, resumePlayback: details.resumePlayback });
      },
    });
    if (autoNext && activeMedia) showNextPlaybackPrompt(activeMedia, version);
    void startSeries(version, progressStore, true);
    activeMedia?.addEventListener?.('pause', () => { if (version === requestVersion) seriesView?.refresh(); });
  } catch (error) {
    if (version === requestVersion) showError(error?.name === 'TimeoutError' ? '加载超时，请检查网络后重试。' :
      '暂时无法加载课程，请检查网络连接后重试。', state);
  } finally { if (version === requestVersion) pendingRequest = false; }
}

// The inline renderer only contains the same 13 public Bilibili IDs as before.
// Every database course, including a free one, goes through server play-auth.
if (!window.__watchRendered) {
  if (!id) { titleEl.textContent = '请从课程目录进入'; wrap.replaceChildren(element('p', '课程链接缺少参数，请返回目录选择课程。', 'note')); }
  else {
    await loadPlayback();
  }
}
window.addEventListener('pagehide', () => {
  requestVersion += 1; pendingRequest = false;
  clearTimeout(identityTimer); identityTimer = null; stopMedia();
});
window.addEventListener('pageshow', event => {
  if (event.persisted && !window.__watchRendered && id) void loadPlayback();
});
