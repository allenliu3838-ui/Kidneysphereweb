// Only explicit admin choices or metadata from the validated local file are used.
const SERIES_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const MAX_DURATION = 7 * 24 * 60 * 60;

export function createCourseSeriesId(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID !== 'function') throw new Error('当前浏览器无法生成课程系列编号，请使用新版浏览器重试。');
  return cryptoImpl.randomUUID();
}

export function trustedDuration(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_DURATION) return undefined;
  return Math.max(1, Math.round(value)); // learning_videos.duration is integer seconds.
}

export function courseUploadMetadata({ seriesId, seriesTitle, chapterNumber, mediaType, duration } = {}) {
  const title = String(seriesTitle || '').trim();
  const id = String(seriesId || '').trim();
  if (title.length > 200) throw new Error('课程系列名称不能超过 200 个字符。');
  if (title && !SERIES_ID.test(id)) throw new Error('课程系列编号无效，请重新选择系列后保存。');
  const chapter = chapterNumber === '' || chapterNumber == null ? null : Number(chapterNumber);
  if (chapter !== null && (!Number.isInteger(chapter) || chapter < 1 || chapter > 2147483647)) throw new Error('章节序号须为正整数，或留空。');
  if (mediaType && !['audio', 'video'].includes(mediaType)) throw new Error('请选择音频、视频，或保留未知类型。');
  const row = { series_id: title ? id : null, series_title: title || null,
    chapter_number: chapter, media_type: mediaType || null };
  const seconds = trustedDuration(duration);
  if (seconds !== undefined) row.duration = seconds;
  return row;
}

export function courseMetadataSchemaError(error) {
  const message = String(error?.message || '');
  if (!/series_id|series_title|chapter_number|media_type|duration/i.test(message) ||
      !(/column|schema cache|does not exist/i.test(message) || ['42703', 'PGRST204'].includes(error?.code))) return null;
  const failure = new Error('课程系列与媒体信息尚未完成数据库更新。已上传媒体会保留，请保持当前页面，管理员完成更新后重试保存。');
  failure.code = 'course_metadata_schema_required'; failure.cause = error;
  return failure;
}

// This reads a local object URL only; unknown/unsupported metadata never blocks upload.
export function readLocalMediaDuration(file, mediaType, { document: doc = globalThis.document,
  url: urls = globalThis.URL, timeoutMs = 3500 } = {}) {
  if (!file || !['audio', 'video'].includes(mediaType) || !doc?.createElement || !urls?.createObjectURL) return Promise.resolve(undefined);
  return new Promise(resolve => {
    let media, objectUrl, timer, settled = false;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (media) {
        media.onloadedmetadata = media.onerror = null;
        try { media.removeAttribute('src'); media.load?.(); } catch (_) {}
      }
      if (objectUrl) try { urls.revokeObjectURL(objectUrl); } catch (_) {}
      resolve(trustedDuration(value));
    };
    try {
      media = doc.createElement(mediaType);
      media.preload = 'metadata';
      media.onloadedmetadata = () => finish(media.duration);
      media.onerror = () => finish();
      objectUrl = urls.createObjectURL(file);
      timer = setTimeout(() => finish(), Math.max(1, Math.min(10000, Number(timeoutMs) || 3500)));
      media.src = objectUrl;
    } catch (_) { finish(); }
  });
}
