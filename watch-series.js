import { findCourseSeries, courseMediaType, formatCourseDuration } from './course-catalog.js?v=20260916_learn2';

// Navigation carries only a public course ID. The destination must obtain its
// own play-auth response; catalog/history data can never supply a media URL.
export function watchCourseHref(courseId, baseHref, { autoplay = false } = {}) {
  if (typeof courseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(courseId)) return '';
  try {
    const base = new URL(baseHref);
    if (!['https:', 'http:'].includes(base.protocol)) return '';
    const url = new URL('watch.html', base);
    url.search = ''; url.hash = '';
    url.searchParams.set('id', courseId);
    if (autoplay) url.searchParams.set('autoplay', '1');
    return url.origin === base.origin ? url.href : '';
  } catch (_) { return ''; }
}

function resumeTime(seconds) {
  const total = Math.floor(Math.max(0, Number(seconds) || 0));
  const minutes = Math.floor(total / 60), remainder = String(total % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}

export function createWatchSeries({ container, courseId, progressStore, baseHref,
  onNavigate, canAutoplay = true } = {}) {
  const doc = container.ownerDocument;
  let disposed = false, series = null, nextCourse = null, status = null, autoplay = null;
  let markers = [];
  const element = (tag, text = '', className = '') => {
    const node = doc.createElement(tag); node.textContent = text; node.className = className; return node;
  };
  const announce = message => { if (!disposed && status) status.textContent = message; };
  const navigate = (course, automatic = false) => {
    if (disposed || !course) return false;
    const href = watchCourseHref(String(course.id), baseHref, { autoplay: automatic });
    if (!href) return false;
    try { onNavigate(href); return true; }
    catch (_) { announce('暂时无法打开下一节，请点击课程链接继续。'); return false; }
  };
  const link = (course, label, className = '') => {
    const node = element('a', label, className);
    node.href = watchCourseHref(String(course.id), baseHref);
    node.addEventListener('click', event => {
      if (disposed) { event.preventDefault(); return; }
      if (event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); navigate(course);
    });
    return node;
  };
  const refresh = () => {
    if (disposed) return;
    let records = [];
    try { records = progressStore?.list?.() || []; } catch (_) { /* Local history is optional. */ }
    const byId = new Map(records.map(record => [String(record.videoId), record]));
    for (const { id, marker } of markers) {
      const record = byId.get(id);
      marker.textContent = record?.completed ? '已完成' : record?.position > 0 ? `续播 ${resumeTime(record.position)}` : '';
      marker.hidden = !marker.textContent;
    }
  };
  const showMessage = (message, retry) => {
    if (disposed) return;
    series = null; nextCourse = null; markers = []; autoplay = null;
    container.hidden = false;
    status = element('p', message, 'ks-series-status'); status.setAttribute('role', 'status');
    container.replaceChildren(status);
    if (retry) {
      const button = element('button', '重试章节目录', 'btn'); button.type = 'button';
      button.addEventListener('click', () => { if (!disposed) retry(); }); container.append(button);
    }
  };
  return {
    loading(count = 0) { showMessage(count > 0 ? `正在整理章节目录…已读取 ${count} 节课程` : '正在整理章节目录…'); },
    failed(retry) { showMessage('章节目录暂时无法加载，本节课程可继续播放。', retry); },
    setRows(rows) {
      if (disposed) return;
      series = findCourseSeries(rows, courseId);
      if (!series || series.courses.length < 2) {
        series = null; nextCourse = null; markers = []; container.replaceChildren(); container.hidden = true; return;
      }
      const index = series.courses.findIndex(course => String(course.id) === String(courseId));
      if (index < 0) { container.hidden = true; return; }
      nextCourse = series.courses[index + 1] || null;
      markers = []; container.hidden = false;
      const heading = element('div', '', 'ks-series-heading');
      heading.append(element('h2', series.title), element('span', `第 ${index + 1} / ${series.courses.length} 节`, 'ks-series-count'));
      const navigation = element('nav', '', 'ks-series-navigation'); navigation.setAttribute('aria-label', '本系列相邻章节');
      if (index > 0) navigation.append(link(series.courses[index - 1], `← 上一节 · ${series.courses[index - 1].title}`, 'ks-series-adjacent'));
      else navigation.append(element('span', '已是第一节', 'ks-series-boundary'));
      if (nextCourse) navigation.append(link(nextCourse, `下一节 · ${nextCourse.title} →`, 'ks-series-adjacent'));
      else navigation.append(element('span', '已是最后一节', 'ks-series-boundary'));
      const list = element('ol', '', 'ks-series-chapters'); list.setAttribute('aria-label', '按顺序排列的章节');
      for (const [position, course] of series.courses.entries()) {
        const item = element('li');
        const chapter = link(course, '', 'ks-series-chapter');
        const current = String(course.id) === String(courseId);
        if (current) chapter.setAttribute('aria-current', 'page');
        const text = element('span', '', 'ks-series-chapter-text');
        text.append(element('strong', course.title || '课程'));
        const kind = courseMediaType(course), duration = formatCourseDuration(course);
        text.append(element('span', [kind === 'audio' ? '音频' : kind === 'video' ? '视频' : '课程', duration].filter(Boolean).join(' · '), 'ks-series-chapter-meta'));
        const badges = element('span', '', 'ks-series-markers');
        if (current) badges.append(element('span', '正在学习', 'ks-series-current'));
        const marker = element('span', '', 'ks-series-progress'); badges.append(marker);
        markers.push({ id: String(course.id), marker });
        chapter.append(element('span', String(position + 1), 'ks-series-number'), text, badges);
        item.append(chapter); list.append(item);
      }
      status = element('p', '', 'ks-series-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const preference = element('label', '', 'ks-series-autoplay');
      autoplay = element('input'); autoplay.type = 'checkbox'; autoplay.checked = false;
      autoplay.disabled = !nextCourse;
      preference.append(autoplay, element('span', '本节结束后自动播放下一节（仅本次）'));
      const local = element('p', '学习进度仅保存在当前设备、当前账号。', 'ks-series-local');
      container.replaceChildren(heading, navigation);
      if (canAutoplay) container.append(preference);
      container.append(status, list, local); refresh();
    },
    refresh,
    next() { return navigate(nextCourse); },
    ended() {
      if (disposed) return;
      refresh();
      if (!nextCourse) { if (series) announce('本系列已到最后一节。'); return; }
      announce(`本节已结束，点击“下一节”继续学习：${nextCourse.title}`);
      if (canAutoplay && autoplay?.checked) navigate(nextCourse, true);
    },
    dispose() {
      disposed = true; series = null; nextCourse = null; markers = []; autoplay = null;
      container.replaceChildren(); container.hidden = true;
    },
  };
}
