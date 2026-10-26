// Shared public course metadata. Playback authorization and media URLs belong to watch-playback.
export const COURSE_CATALOG_PAGE_SIZE = 200;
const REQUIRED_COLUMNS = ['id', 'title', 'category', 'kind', 'bvid', 'speaker', 'created_at',
  'enabled', 'deleted_at', 'is_published', 'is_paid', 'membership_accessible', 'specialty_id',
  'specialty_ids', 'product_id', 'source'];
const OPTIONAL_COLUMNS = ['sort_order', 'description', 'cover_image', 'series_id',
  'series_title', 'chapter_number', 'media_type', 'duration', 'access_type', 'membership_scope'];
const PUBLIC_COLUMNS = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS];

function safeId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const id = String(value).trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id) ? id : '';
}
function text(value) { return typeof value === 'string' ? value.trim() : ''; }

export function normalizeCourseMetadata(row) {
  if (!row || typeof row !== 'object' || row.enabled !== true || row.deleted_at != null || row.is_published === false) return null;
  const id = safeId(row.id);
  if (!id || !text(row.title)) return null;
  // An allowlist also keeps unexpected response fields out of callbacks and UI state.
  const result = Object.fromEntries(PUBLIC_COLUMNS.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
  const legacyGlomcon = row.category === 'glomcon';
  Object.assign(result, {
    id, title: text(row.title), speaker: text(row.speaker),
    category: legacyGlomcon ? 'glom' : (text(row.category) || 'other'),
    source: legacyGlomcon ? 'glomcon' : (text(row.source) || 'external'),
    // Missing access metadata must never be presented as a free course.
    is_paid: typeof row.is_paid === 'boolean' ? row.is_paid : null,
    membership_accessible: typeof row.membership_accessible === 'boolean' ? row.membership_accessible : null,
    specialty_ids: Array.isArray(row.specialty_ids) ? row.specialty_ids.map(safeId).filter(Boolean)
      : (safeId(row.specialty_id) ? [safeId(row.specialty_id)] : []),
  });
  return result;
}

// Display classification only. The playback endpoint verifies current and legacy entitlements.
export function courseAccessLevel(row) {
  const scope = row?.membership_scope || 'unclassified';
  if (scope === 'weekly_replay' && row?.media_type === 'video' && row?.is_paid === true
      && (row?.access_type === 'paid_membership' || row?.membership_accessible === true)) return 'member';
  if (scope === 'training' || row?.access_type === 'paid_specialty') return 'training';
  if (['weekly_replay', 'other_paid'].includes(scope) || row?.is_paid === true
      || row?.membership_accessible === true || ['paid_single', 'paid_membership'].includes(row?.access_type)) return 'paid';
  if (scope === 'unclassified' && row?.is_paid === false && row?.membership_accessible === false
      && (row?.access_type == null || row.access_type === 'registered_free')) return 'free';
  return 'unknown';
}

export class CourseCatalogError extends Error {
  constructor(cause, rows) {
    super('课程目录尚未加载完整，请重试。', { cause });
    this.name = 'CourseCatalogError';
    this.partialRows = [...rows];
  }
}

function missingOptionalColumn(error, columns) {
  if (!error || !['42703', 'PGRST204'].includes(String(error.code))) return null;
  const message = String(error.message || '');
  // Do not infer schema problems from a substring in an arbitrary network/permission error.
  const pg = message.match(/column\s+(?:["\w]+\.)?"?([a-z_]+)"?\s+does not exist/i);
  const rest = message.match(/Could not find the '([a-z_]+)' column of 'learning_videos'/i);
  const name = pg?.[1] || rest?.[1];
  return OPTIONAL_COLUMNS.includes(name) && columns.includes(name) ? name : null;
}

/** Loads every visible published row; callbacks always distinguish partial and complete results. */
export async function loadCourseCatalog(client, { onPage, signal } = {}) {
  const rows = [], seen = new Set();
  let columns = [...PUBLIC_COLUMNS], offset = 0, pageNumber = 0;
  try {
    if (!client?.from) throw new Error('课程服务暂不可用');
    while (true) {
      if (signal?.aborted) throw signal.reason || new Error('Aborted');
      let query = client.from('learning_videos').select(columns.join(','), { count: 'exact' })
        .eq('enabled', true).is('deleted_at', null)
        .or('is_published.is.null,is_published.eq.true')
        .order('created_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
        .range(offset, offset + COURSE_CATALOG_PAGE_SIZE - 1);
      if (signal) query = query.abortSignal(signal);
      const { data, error, count } = await query;
      if (error) {
        const missing = missingOptionalColumn(error, columns);
        if (missing) { columns = columns.filter(key => key !== missing); continue; }
        throw error;
      }
      if (!Array.isArray(data)) throw new Error('Invalid course response');
      if (!data.length) {
        await onPage?.([], { rows: [...rows], complete: true, page: pageNumber });
        return rows;
      }
      const page = [];
      for (const raw of data) {
        const rawId = safeId(raw?.id);
        const isNew = rawId && !seen.has(rawId);
        // A repeated ID can mean the catalog changed between offset pages; ask for a fresh load.
        if (rawId && !isNew) throw new Error('Course pagination changed while loading');
        const row = normalizeCourseMetadata(raw);
        if (rawId) seen.add(rawId);
        if (row && isNew) { page.push(row); rows.push(row); }
      }
      offset += data.length;
      pageNumber += 1;
      const complete = Number.isSafeInteger(count) && count >= 0 && offset >= count;
      await onPage?.(page, { rows: [...rows], complete, page: pageNumber });
      if (complete) return rows;
      // A server may cap responses below our requested size. Without a count, continue to an empty page.
    }
  } catch (error) {
    throw error instanceof CourseCatalogError ? error : new CourseCatalogError(error, rows);
  }
}

function chapterNumber(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null;
  const valueText = text(value).normalize('NFKC');
  if (/^\d+$/.test(valueText)) {
    const number = Number(valueText);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }
  if (!/^[零〇一二两三四五六七八九十百千]+$/.test(valueText)) return null;
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100, 千: 1000 };
  if (!/[十百千]/.test(valueText)) {
    const number = Number([...valueText].map(char => digits[char]).join(''));
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }
  let total = 0, current = 0;
  for (const char of valueText) {
    if (char in units) { total += (current || 1) * units[char]; current = 0; }
    else current = digits[char];
  }
  const number = total + current;
  return number > 0 ? number : null;
}

function legacyChapter(row) {
  const title = text(row?.title).normalize('NFKC');
  const number = '[0-9零〇一二两三四五六七八九十百千]+';
  const marker = new RegExp(`第\\s*(${number})\\s*[章节讲课集]|\\b(?:part|chapter|lesson)\\s*(\\d+)\\b`, 'ig');
  const matches = [...title.matchAll(marker)];
  // Nested chapter/section markers have no unambiguous linear series position.
  if (matches.length !== 1) return null;
  const [match] = matches;
  const chapter = chapterNumber(match[1] || match[2]);
  const before = title.slice(0, match.index).replace(/[\s\-—–:：·,，（(]+$/g, '').trim();
  const after = title.slice(match.index + match[0].length).replace(/^[\s\-—–:：·,，)）]+/g, '').trim();
  // Without a shared title outside the chapter marker there is no series identity.
  const base = before || after;
  return chapter && base.length >= 2 ? { title: base, chapter } : null;
}

function eligibleCourse(row) {
  return row && safeId(row.id) && text(row.title) && row.enabled !== false && row.deleted_at == null && row.is_published !== false;
}

/** Explicit metadata wins. Legacy inference needs a shared title, speaker, category AND source. */
export function buildCourseSeries(rows = []) {
  const groups = new Map();
  const ids = new Set();
  for (const row of rows) {
    if (!eligibleCourse(row) || ids.has(String(row.id))) continue;
    ids.add(String(row.id));
    const explicitId = safeId(row.series_id);
    if (row.series_id != null && text(row.series_id) && !explicitId) continue;
    const legacy = explicitId ? null : legacyChapter(row);
    if (!explicitId && !legacy) continue;
    if (legacy && (!text(row.speaker) || !text(row.category) || !text(row.source))) continue;
    const chapter = explicitId ? chapterNumber(row.chapter_number) : legacy.chapter;
    const id = explicitId ? `series:${explicitId}` : `legacy:${JSON.stringify([legacy.title, text(row.speaker), text(row.category), text(row.source)])}`;
    if (!groups.has(id)) groups.set(id, { id, title: explicitId ? (text(row.series_title) || legacyChapter(row)?.title || text(row.title)) : legacy.title, entries: [], explicit: !!explicitId });
    groups.get(id).entries.push({ row, chapter });
  }
  return [...groups.values()].filter(group => {
    const chapters = group.entries.map(entry => entry.chapter);
    // Duplicate or missing chapter positions are ambiguous: keep these courses in normal browsing.
    return (group.explicit || chapters.length >= 2) && chapters.every(Boolean) && new Set(chapters).size === chapters.length;
  }).map(group => {
    const courses = group.entries.sort((a, b) => a.chapter - b.chapter).map(entry => entry.row);
    // A later response page may carry the series name missing from newer chapters.
    const title = group.explicit
      ? courses.map(row => text(row.series_title)).find(Boolean) || legacyChapter(courses[0])?.title || text(courses[0].title)
      : group.title;
    return { id: group.id, title, courses };
  });
}

export function findCourseSeries(rows, courseId) {
  return buildCourseSeries(rows).find(series => series.courses.some(row => String(row.id) === String(courseId))) || null;
}

export function courseMediaType(row) {
  const type = text(row?.media_type).toLowerCase();
  if (type === 'audio' || type === 'video') return type;
  const kind = text(row?.kind).toLowerCase();
  if (['audio', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac', 'wma', 'ape', 'opus'].includes(kind)) return 'audio';
  if (['video', 'mp4', 'mov', 'm4v', 'mkv', 'avi', 'flv', 'wmv', 'webm', 'ts', 'hls', 'bilibili', 'youtube'].includes(kind) || text(row?.bvid)) return 'video';
  // Cloud/external providers may host audio or video; do not guess from a provider name.
  return 'unknown';
}

// Fixed SVG paths only; course metadata is never interpolated into icon markup.
export function courseMediaIcon(row) {
  const type = courseMediaType(row);
  const paths = type === 'audio'
    ? '<path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/>'
    : type === 'video'
      ? '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3Z"/>'
      : '<path d="M5 4h14v16H5zM9 8h6M9 12h6M9 16h3"/>';
  return `<svg class="course-media-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

export function formatCourseDuration(row) {
  const raw = row?.duration ?? row?.duration_seconds;
  if (!['number', 'string'].includes(typeof raw) || raw === '') return '';
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return '';
  const seconds = Math.max(1, Math.round(value)), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
