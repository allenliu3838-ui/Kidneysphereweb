// Independent of authentication/data loading: these utilities must work even if
// the external data source is unavailable. End is exclusive (Beijing midnight).
export function conferenceState(start, end, now = Date.now()) {
  const startAt = Date.parse(start);
  const endAt = Date.parse(end);
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt || !Number.isFinite(now)) {
    return { kind: 'unknown', label: '查看会议日程' };
  }
  if (now >= endAt) return { kind: 'ended', label: '往期会议 · 已结束' };
  if (now >= startAt) return { kind: 'live', label: '会议进行中' };
  const days = Math.ceil((startAt - now) / 86400000);
  return { kind: 'upcoming', label: days <= 1 ? '即将开幕' : `${days} 天后开幕` };
}

export function updateConferenceStatuses(root, now = Date.now()) {
  root.querySelectorAll('[data-conference-status]').forEach(el => {
    const state = conferenceState(el.dataset.start, el.dataset.end, now);
    el.textContent = state.label;
    el.dataset.state = state.kind;
  });
}

export function initContactCopy(root, clipboard) {
  const button = root.querySelector('[data-copy-contact]');
  const status = root.querySelector('[data-contact-status]');
  if (!button || !status || !clipboard?.writeText) return;
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await clipboard.writeText('china@kidneysphere.com');
      status.textContent = '邮箱已复制，可粘贴到您的邮件应用。';
    } catch (_) {
      status.textContent = '未能自动复制，请手动复制：china@kidneysphere.com';
    }
  });
}

const PORTAL_CATEGORIES = Object.freeze({
  glom: '肾小球与间质性肾病',
  icu: '重症肾内与透析',
  tx: '肾移植内科',
  path: '肾脏病理',
  peds: '儿童肾脏病',
  rare: '罕见肾脏病',
  meeting: '病例讨论会议',
  other: '其他肾脏病',
});
const PORTAL_SOURCES = Object.freeze({
  glomcon: 'GlomCon 中国',
  kidneysphere: '肾域原创',
  external: '外部资源',
});
const PUBLIC_VIDEO_FIELDS = 'id,title,speaker,category,source,is_paid,membership_accessible,created_at,enabled,deleted_at';

// These are catalogue labels, not a permission decision. The existing watch
// page remains responsible for login, purchase and playback authorization.
export function portalVideoAccess(video = {}) {
  if (video.source === 'glomcon' || video.category === 'glomcon') {
    return { kind: 'member', label: '会员课程' };
  }
  if (video.is_paid === false) return { kind: 'free', label: '免费课程' };
  if (video.membership_accessible === true) return { kind: 'member', label: '会员课程' };
  if (video.is_paid === true && video.membership_accessible === false) {
    return { kind: 'paid', label: '付费课程' };
  }
  return { kind: 'unknown', label: '以课程页为准' };
}

export function normalizePortalVideo(row, origin = 'database') {
  if (!row || typeof row !== 'object' || row.enabled === false || row.deleted_at) return null;
  const id = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id).trim() : '';
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  if (!id || !title) return null;
  const legacyGlomcon = row.category === 'glomcon';
  const category = legacyGlomcon ? 'glom' : row.category;
  const video = {
    id,
    title,
    speaker: typeof row.speaker === 'string' ? row.speaker.trim() : '',
    category: Object.prototype.hasOwnProperty.call(PORTAL_CATEGORIES, category) ? category : 'other',
    source: legacyGlomcon ? 'glomcon' : (typeof row.source === 'string' ? row.source : ''),
    is_paid: typeof row.is_paid === 'boolean' ? row.is_paid : null,
    membership_accessible: typeof row.membership_accessible === 'boolean' ? row.membership_accessible : null,
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
    origin: origin === 'static' ? 'static' : 'database',
  };
  // Preserve the existing static catalogue's public Bilibili identifier in its
  // watch link. Database rows are intentionally restricted to metadata only.
  if (video.origin === 'static' && /^BV[0-9A-Za-z]+$/.test(row.bvid || '')) {
    video.bvid = row.bvid;
  }
  return video;
}

export function mergePortalVideos(staticRows = [], dbRows = []) {
  const videos = new Map();
  for (const row of staticRows) {
    const video = normalizePortalVideo(row, 'static');
    if (video) videos.set(video.id, video);
  }
  for (const row of dbRows) {
    const video = normalizePortalVideo(row, 'database');
    if (video) videos.set(video.id, video);
  }
  return [...videos.values()].sort((a, b) => {
    const aDate = Date.parse(a.created_at) || 0;
    const bDate = Date.parse(b.created_at) || 0;
    return bDate - aDate;
  });
}

const searchText = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

export function filterPortalVideos(videos, { query = '', category = 'all' } = {}) {
  const terms = searchText(query).split(' ').filter(Boolean);
  return videos.filter(video => {
    if (category !== 'all' && video.category !== category) return false;
    const haystack = searchText([
      video.title, video.speaker, PORTAL_CATEGORIES[video.category],
      PORTAL_SOURCES[video.source], video.source,
    ].join(' '));
    return terms.every(term => haystack.includes(term));
  });
}

export function selectPortalVideos(videos, { query = '', category = 'all', limit } = {}) {
  const filtering = Boolean(searchText(query)) || category !== 'all';
  const max = filtering ? 6 : 3;
  const count = Number.isFinite(limit) ? Math.max(0, Math.min(max, Math.floor(limit))) : max;
  const matching = filterPortalVideos(videos, { query, category });
  if (filtering || !count) return matching.slice(0, count);
  // Give the homepage a small cross-specialty selection without excluding any
  // source from searching or filtering, including non-GlomCon paid courses.
  const selected = [];
  const categories = new Set();
  for (const video of matching) {
    if (categories.has(video.category)) continue;
    selected.push(video);
    categories.add(video.category);
    if (selected.length === count) return selected;
  }
  const ids = new Set(selected.map(video => video.id));
  return [...selected, ...matching.filter(video => !ids.has(video.id))].slice(0, count);
}

export function portalWatchUrl(video) {
  let url = `watch.html?id=${encodeURIComponent(String(video.id))}`;
  if (video.origin === 'static' && /^BV[0-9A-Za-z]+$/.test(video.bvid || '')) {
    url += `&bvid=${encodeURIComponent(video.bvid)}`;
  }
  return url;
}

export async function loadPortalVideoMetadata({
  loadClient = () => import('./supabaseClient.js?v=20260401_fix'),
  timeoutMs = 9000,
} = {}) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timeout;
  const operation = (async () => {
    const provider = await loadClient();
    if (!provider.isConfigured()) throw new Error('Video catalogue is not configured');
    await provider.ensureSupabase();
    if (!provider.supabase) throw new Error('Video catalogue is unavailable');
    let query = provider.supabase.from('learning_videos')
      .select(PUBLIC_VIDEO_FIELDS)
      .eq('enabled', true)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(200);
    if (controller && typeof query.abortSignal === 'function') query = query.abortSignal(controller.signal);
    const { data, error } = await query;
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Invalid video catalogue response');
    return {
      videos: data.filter(video => video.enabled === true && video.deleted_at == null),
      capped: data.length >= 200,
    };
  })();
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller?.abort();
          reject(new Error('Video catalogue request timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function makeVideoCard(doc, video) {
  const card = doc.createElement('a');
  card.className = 'portal-video-card';
  card.href = portalWatchUrl(video);
  const access = portalVideoAccess(video);
  card.setAttribute('aria-label', `观看：${video.title}；${access.label}`);

  const cover = doc.createElement('div');
  const coverCategory = ['glom', 'icu', 'tx', 'path'].includes(video.category) ? video.category : 'other';
  cover.className = `portal-video-cover portal-cover--${coverCategory}`;
  cover.setAttribute('aria-hidden', 'true');
  const specialty = doc.createElement('span');
  specialty.textContent = PORTAL_CATEGORIES[video.category];
  const play = doc.createElement('span');
  play.className = 'portal-play-icon';
  play.textContent = '▶';
  cover.append(specialty, play);

  const body = doc.createElement('div');
  body.className = 'portal-video-body';
  const label = doc.createElement('span');
  label.className = 'portal-access';
  label.dataset.access = access.kind;
  label.textContent = access.label;
  const title = doc.createElement('h3');
  title.className = 'portal-video-title';
  title.textContent = video.title;
  const speaker = doc.createElement('p');
  speaker.className = 'portal-video-speaker';
  speaker.textContent = video.speaker ? `主讲：${video.speaker}` : '主讲信息见课程页';
  const action = doc.createElement('span');
  action.className = 'portal-video-action';
  action.textContent = '观看课程 →';
  body.append(label, title, speaker, action);
  card.append(cover, body);
  return card;
}

export async function initPortalVideos(root) {
  const grid = root.querySelector('[data-portal-video-grid]');
  const status = root.querySelector('[data-portal-video-status]');
  if (!grid || !status || grid.dataset.portalVideoReady === 'true') return;
  grid.dataset.portalVideoReady = 'true';
  const doc = grid.ownerDocument;
  const form = root.querySelector('[data-portal-search]');
  const input = form?.querySelector('input[name="q"]');
  const filterButtons = [...root.querySelectorAll('[data-portal-video-filter]')];
  const reset = root.querySelector('[data-portal-video-reset]');
  const state = { videos: [], query: input?.value || '', category: 'all', loading: true, partial: false };
  let debounce;

  function render() {
    const options = { query: state.query, category: state.category };
    const selected = selectPortalVideos(state.videos, options);
    const matching = filterPortalVideos(state.videos, options);
    const filtering = Boolean(searchText(state.query)) || state.category !== 'all';
    const fragment = doc.createDocumentFragment();
    selected.forEach(video => fragment.append(makeVideoCard(doc, video)));
    if (!selected.length && !state.loading) {
      const empty = doc.createElement('p');
      empty.className = 'portal-video-empty';
      empty.textContent = '首页已载入目录中暂未找到匹配内容，请调整关键词或进入视频库查看。';
      fragment.append(empty);
    }
    grid.replaceChildren(fragment);
    let message = state.loading ? '正在载入视频目录…' : (filtering
      ? `在首页已载入目录中找到 ${matching.length} 个结果，展示 ${selected.length} 个。更多内容请进入视频库。`
      : '按专科精选展示，完整课程与观看权限请以视频库及课程页为准。');
    if (state.partial) message += ' 部分视频暂未载入，可进入视频库查看。';
    status.textContent = message;
    filterButtons.forEach(button => {
      const active = (button.value || button.dataset.portalVideoFilter) === state.category;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('is-active', active);
    });
    if (reset) reset.hidden = !filtering;
  }

  filterButtons.forEach(button => button.addEventListener('click', () => {
    clearTimeout(debounce);
    state.query = input?.value || '';
    state.category = button.value || button.dataset.portalVideoFilter || 'all';
    render();
  }));
  input?.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.query = input.value;
      render();
    }, 180);
  });
  form?.addEventListener('submit', event => {
    event.preventDefault();
    clearTimeout(debounce);
    state.query = input?.value || '';
    render();
    // Submitting explicitly moves to results. Typing never scrolls the page or
    // steals focus, and reduced-motion preferences are respected.
    const section = root.querySelector('#videos');
    const reducedMotion = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    section?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  });
  reset?.addEventListener('click', () => {
    clearTimeout(debounce);
    state.query = '';
    state.category = 'all';
    if (input) input.value = '';
    render();
    input?.focus({ preventScroll: true });
  });
  render();

  let staticRows = [];
  let databaseRows = [];
  let staticTimeout;
  // Metadata loading never blocks the static catalogue or binds it to an
  // authenticated session. Failure is visible rather than silently presenting
  // only GlomCon's static entries as the complete video library.
  const staticLoad = Promise.race([
    import('./assets/videos.js?v=20260326_001'),
    new Promise((_, reject) => {
      staticTimeout = setTimeout(() => reject(new Error('Static catalogue request timed out')), 9000);
    }),
  ])
    .then(module => {
      if (!Array.isArray(module.FREE_VIDEOS)) throw new Error('Invalid static video catalogue');
      staticRows = module.FREE_VIDEOS;
      state.videos = mergePortalVideos(staticRows, databaseRows);
      render();
    }).catch(() => { state.partial = true; })
    .finally(() => clearTimeout(staticTimeout));
  const databaseLoad = loadPortalVideoMetadata()
    .then(result => {
      databaseRows = result.videos;
      state.partial = state.partial || result.capped;
      state.videos = mergePortalVideos(staticRows, databaseRows);
      render();
    }).catch(() => { state.partial = true; });
  await Promise.allSettled([staticLoad, databaseLoad]);
  state.loading = false;
  render();
}

if (typeof document !== 'undefined') {
  if (document.querySelector('[data-conference-status]')) {
    updateConferenceStatuses(document);
    // Only pages that actually display a conference need a long-lived timer.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) updateConferenceStatuses(document);
    });
    setInterval(() => updateConferenceStatuses(document), 60000);
  }
  initContactCopy(document, globalThis.navigator?.clipboard);
  initPortalVideos(document);
}
