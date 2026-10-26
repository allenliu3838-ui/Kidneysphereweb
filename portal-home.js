import { buildCourseSeries, courseMediaType, courseAccessLevel } from './course-catalog.js?v=20260916_learn2';
import { getCourseArtwork } from './course-art.js?v=20260917_visual1';

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
  da: '血管通路',
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
const PUBLIC_VIDEO_FIELDS = 'id,title,speaker,category,source,is_paid,membership_accessible,created_at,enabled,deleted_at,kind,is_published';
const OPTIONAL_PORTAL_FIELDS = ['media_type', 'series_id', 'series_title', 'chapter_number', 'membership_scope', 'access_type', 'cover_image'];

// These are catalogue labels, not a permission decision. The existing watch
// page remains responsible for login, purchase and playback authorization.
export function portalVideoAccess(video = {}) {
  const kind = courseAccessLevel(video);
  const labels = {
    free: '免费课程', member: '周日/周三会员回放', training: '培训 · 另行付费',
    paid: '付费内容 · 查看权限', unknown: '以课程页为准',
  };
  return { kind, label: labels[kind] || labels.unknown };
}

export function normalizePortalVideo(row, origin = 'database') {
  if (!row || typeof row !== 'object' || row.enabled === false || row.deleted_at || row.is_published === false) return null;
  const id = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id).trim() : '';
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  if (!id || !title) return null;
  const legacyGlomcon = row.category === 'glomcon';
  const category = legacyGlomcon ? 'glom' : row.category === 'patho' ? 'path' : row.category;
  const video = {
    id,
    title,
    speaker: typeof row.speaker === 'string' ? row.speaker.trim() : '',
    category: Object.prototype.hasOwnProperty.call(PORTAL_CATEGORIES, category) ? category : 'other',
    source: legacyGlomcon ? 'glomcon' : (typeof row.source === 'string' ? row.source : ''),
    is_paid: typeof row.is_paid === 'boolean' ? row.is_paid : null,
    membership_accessible: typeof row.membership_accessible === 'boolean' ? row.membership_accessible : null,
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
    media_type: ['audio', 'video'].includes(row.media_type) ? row.media_type : null,
    kind: typeof row.kind === 'string' ? row.kind.trim() : '',
    membership_scope: row.membership_scope == null ? 'unclassified' : String(row.membership_scope),
    access_type: typeof row.access_type === 'string' && row.access_type.trim() ? row.access_type.trim() : null,
    series_id: typeof row.series_id === 'string' ? row.series_id.trim() : null,
    series_title: typeof row.series_title === 'string' ? row.series_title.trim() : '',
    cover_image: typeof row.cover_image === 'string' ? row.cover_image.trim() : '',
    chapter_number: typeof row.chapter_number === 'number' || typeof row.chapter_number === 'string' ? row.chapter_number : null,
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

export function filterPortalVideos(videos, { query = '', category = 'all', access = 'all' } = {}) {
  const terms = searchText(query).split(' ').filter(Boolean);
  return videos.filter(video => {
    if (access !== 'all' && portalVideoAccess(video).kind !== access) return false;
    if (category !== 'all' && video.category !== category) return false;
    const haystack = searchText([
      video.title, video.speaker, video.series_title, PORTAL_CATEGORIES[video.category],
      PORTAL_SOURCES[video.source], video.source,
    ].join(' '));
    return terms.every(term => haystack.includes(term));
  });
}

export function selectPortalVideos(videos, { query = '', category = 'all', access = 'all', limit } = {}) {
  const filtering = Boolean(searchText(query)) || category !== 'all';
  const max = filtering ? 6 : 3;
  const count = Number.isFinite(limit) ? Math.max(0, Math.min(max, Math.floor(limit))) : max;
  const matching = filterPortalVideos(videos, { query, category, access });
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

export function portalCatalogueUrl({ query = '', category = 'all', access = 'all' } = {}) {
  const params = new URLSearchParams();
  if (String(query).trim()) params.set('q', String(query).trim().slice(0, 120));
  if (Object.prototype.hasOwnProperty.call(PORTAL_CATEGORIES, category)) params.set('category', category);
  if (access === 'free' || access === 'member') params.set('access', access);
  if (access === 'training') params.set('access', 'training');
  return `videos.html${params.size ? `?${params}` : ''}`;
}

// Keep the free-course introduction before membership and training at every
// breakpoint; move actual nodes so keyboard and reading order agree.
export function initMobileCourseOrder(root, media = root.defaultView?.matchMedia?.('(max-width: 800px)')) {
  const videos = root.querySelector('#videos');
  const training = root.querySelector('#training');
  const membership = root.querySelector('#membership');
  const resume = root.querySelector('.portal-resume-section');
  const series = root.querySelector('#series');
  const assistant = root.querySelector('#learning-assistant');
  if (!videos || !training) return;
  const update = () => {
    (assistant || series || membership || training).before(videos);
    if (resume) videos.before(resume);
  };
  update();
  media?.addEventListener?.('change', update);
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
    let optionalFields = [...OPTIONAL_PORTAL_FIELDS];
    while (true) {
      let query = provider.supabase.from('learning_videos')
        .select([PUBLIC_VIDEO_FIELDS, ...optionalFields].join(','))
        .eq('enabled', true)
        .is('deleted_at', null)
        .or('is_published.is.null,is_published.eq.true')
        .order('created_at', { ascending: false })
        .limit(200);
      if (controller && typeof query.abortSignal === 'function') query = query.abortSignal(controller.signal);
      const { data, error } = await query;
      if (error) {
        // Older catalogues can lack new presentation metadata. Only a precise
        // missing-column error permits retrying with a smaller field list.
        const message = String(error.message || '');
        const missing = message.match(/column\s+(?:["\w]+\.)?"?([a-z_]+)"?\s+does not exist/i)?.[1]
          || message.match(/Could not find the '([a-z_]+)' column of 'learning_videos'/i)?.[1];
        if (['42703', 'PGRST204'].includes(String(error.code)) && optionalFields.includes(missing)) {
          optionalFields = optionalFields.filter(field => field !== missing);
          continue;
        }
        throw error;
      }
      if (!Array.isArray(data)) throw new Error('Invalid video catalogue response');
      return {
        videos: data.filter(video => video.enabled === true && video.deleted_at == null && video.is_published !== false),
        capped: data.length >= 200,
      };
    }
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

// Images never decide course access. Remote editor covers fall back to bundled
// topic art once; a failed bundled asset leaves a readable colored cover.
export function createPortalArtwork(doc, video = {}) {
  const art = getCourseArtwork(video);
  const fallback = getCourseArtwork({ ...video, cover_image: null });
  const img = doc.createElement('img');
  img.src = art.src;
  img.alt = '';
  img.width = 960;
  img.height = 540;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.dataset.portalArt = '';
  img.dataset.artFallback = fallback.src;
  return img;
}

export function initPortalArtwork(root) {
  const fail = img => {
    if (!img?.dataset || !Object.hasOwn(img.dataset, 'portalArt')) return;
    const fallback = img.dataset.artFallback;
    if (fallback && !img.dataset.artRetried && img.getAttribute('src') !== fallback) {
      img.dataset.artRetried = 'true';
      img.src = fallback;
    } else {
      img.hidden = true;
    }
  };
  // Capturing handles later-rendered catalogue covers and static hero art.
  root.addEventListener('error', event => fail(event.target), true);
  root.querySelectorAll('img[data-portal-art]').forEach(img => {
    if (img.complete && img.naturalWidth === 0) fail(img);
  });
}

export function makeVideoCard(doc, video) {
  const card = doc.createElement('a');
  card.className = 'portal-video-card';
  card.href = portalWatchUrl(video);
  const access = portalVideoAccess(video);
  const media = courseMediaType(video);
  const mediaLabel = media === 'audio' ? '音频' : media === 'video' ? '视频' : '课程';
  card.dataset.media = media;
  card.setAttribute('aria-label', `${mediaLabel}：${video.title}；${access.label}`);

  const cover = doc.createElement('div');
  const coverCategory = ['glom', 'icu', 'tx', 'path', 'da', 'peds'].includes(video.category) ? video.category : 'other';
  cover.className = `portal-video-cover portal-cover--${coverCategory}`;
  cover.setAttribute('aria-hidden', 'true');
  const specialty = doc.createElement('span');
  specialty.textContent = PORTAL_CATEGORIES[video.category];
  const play = doc.createElement('span');
  play.className = 'portal-play-icon';
  play.textContent = media === 'audio' ? '♫' : media === 'video' ? '▶' : '≡';
  cover.append(createPortalArtwork(doc, video), specialty, play);

  const body = doc.createElement('div');
  body.className = 'portal-video-body';
  const badges = doc.createElement('div');
  badges.className = 'portal-card-badges';
  const mediaBadge = doc.createElement('span');
  mediaBadge.className = 'portal-media-type';
  mediaBadge.dataset.media = media;
  const mediaIcon = doc.createElement('span');
  mediaIcon.setAttribute('aria-hidden', 'true');
  mediaIcon.textContent = media === 'audio' ? '♫' : media === 'video' ? '▶' : '≡';
  const mediaText = doc.createElement('span');
  mediaText.textContent = mediaLabel;
  mediaBadge.append(mediaIcon, mediaText);
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
  action.textContent = media === 'audio' ? '收听课程 →' : media === 'video' ? '观看课程 →' : '查看课程 →';
  badges.append(mediaBadge, label);
  body.append(badges, title, speaker, action);
  card.append(cover, body);
  return card;
}

export function renderPortalSeries(root, videos) {
  const grid = root.querySelector('[data-portal-series-grid]');
  if (!grid) return;
  const seriesList = buildCourseSeries(videos).slice(0, 3);
  // Keep the useful directory link when metadata has no trustworthy series.
  if (!seriesList.length) return;
  const doc = grid.ownerDocument;
  const cards = seriesList.map(series => {
    const card = doc.createElement('a');
    card.className = 'portal-series-card';
    card.href = `videos.html?view=series&series=${encodeURIComponent(series.id)}`;
    const cover = doc.createElement('div');
    const category = series.courses[0]?.category;
    cover.className = `portal-series-cover portal-cover--${['glom', 'icu', 'tx', 'path', 'da', 'peds'].includes(category) ? category : 'other'}`;
    cover.setAttribute('aria-hidden', 'true');
    const motif = doc.createElement('span');
    motif.textContent = '≡';
    cover.append(createPortalArtwork(doc, series.courses[0] || {}), motif);
    const body = doc.createElement('div');
    body.className = 'portal-series-body';
    const label = doc.createElement('p');
    label.className = 'portal-series-overline';
    const media = new Set(series.courses.map(courseMediaType));
    const types = [media.has('audio') ? '♫ 音频' : '', media.has('video') ? '▶ 视频' : '', media.has('unknown') ? '课程' : ''].filter(Boolean);
    label.textContent = types.join(' / ');
    const title = doc.createElement('h3');
    title.textContent = series.title;
    const note = doc.createElement('p');
    note.className = 'portal-series-meta';
    note.textContent = '按章节学习 · 各节权益以课程说明为准';
    const action = doc.createElement('span');
    action.className = 'portal-text-link';
    action.textContent = '打开系列目录 →';
    body.append(label, title, note, action);
    card.append(cover, body);
    return card;
  });
  grid.replaceChildren(...cards);
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
  const accessButtons = [...root.querySelectorAll('[data-portal-video-access]')];
  const title = root.querySelector('#videos-title');
  const description = root.querySelector('[data-portal-video-description]');
  const reset = root.querySelector('[data-portal-video-reset]');
  const viewAll = root.querySelector('[data-portal-video-all]');
  const state = { videos: [], query: input?.value || '', category: 'all', access: 'free', loading: true, partial: false };
  let debounce;

  function render() {
    renderPortalSeries(root, state.videos);
    const weeklyAvailable = state.videos.some(video => portalVideoAccess(video).kind === 'member');
    root.querySelectorAll('[data-portal-member-nav]').forEach(label => {
      label.textContent = weeklyAvailable ? '开通会员' : '会员说明';
    });
    root.querySelectorAll('[data-portal-member-cta]').forEach(link => {
      link.textContent = weeklyAvailable ? '查看权益并开通周日/周三回放 →' : '查看会员说明 →';
    });
    const options = { query: state.query, category: state.category, access: state.access };
    const free = state.access === 'free';
    if (title) title.textContent = free ? '精选免费课程' : state.access === 'member' ? '发现会员回放' : state.access === 'training' ? '发现专科培训课程' : '发现音视频课程';
    if (description) description.textContent = free
      ? '免费音频与视频，按你的节奏开始。'
      : state.access === 'member' ? '周日/周三学术活动视频回放，¥299／年；不含培训与教材音频。' : state.access === 'training' ? '按课程说明单独购买，培训与教材音频不包含在年费会员内。' : '先选内容类型，再按课程标签确认权益。';
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
      : free ? '以下为目录中明确标为免费的课程；进入课程页即可了解观看方式。' : '按专科精选展示，完整课程与观看权限请以视频库及课程页为准。');
    if (state.partial) message += ' 部分视频暂未载入，可进入视频库查看。';
    status.textContent = message;
    filterButtons.forEach(button => {
      const active = (button.value || button.dataset.portalVideoFilter) === state.category;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('is-active', active);
    });
    accessButtons.forEach(button => {
      const active = button.dataset.portalVideoAccess === state.access;
      button.setAttribute('aria-pressed', String(active));
      button.classList.toggle('is-active', active);
    });
    if (reset) reset.hidden = !filtering;
    if (viewAll) {
      viewAll.href = portalCatalogueUrl(options);
      viewAll.textContent = free ? '查看全部免费课程 →' : state.access === 'member' ? '查看会员回放 →' : state.access === 'training' ? '查看培训课程 →' : '查看全部课程 →';
    }
  }

  filterButtons.forEach(button => button.addEventListener('click', () => {
    clearTimeout(debounce);
    state.query = input?.value || '';
    state.category = button.value || button.dataset.portalVideoFilter || 'all';
    render();
  }));
  accessButtons.forEach(button => button.addEventListener('click', () => {
    clearTimeout(debounce);
    state.query = input?.value || '';
    const access = button.dataset.portalVideoAccess;
    state.access = ['free', 'member', 'training', 'all'].includes(access) ? access : 'free';
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
    import('./assets/videos.js?v=20260917_visual1'),
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
  initPortalArtwork(document);
  initContactCopy(document, globalThis.navigator?.clipboard);
  initMobileCourseOrder(document);
  initPortalVideos(document);
}
