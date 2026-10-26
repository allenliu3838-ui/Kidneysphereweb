// Idempotent batch-course persistence using the existing UUID primary key.
// Never upsert, remove access fields, allocate a retry ID or delete VOD media.
import { courseUploadMetadata, courseMetadataSchemaError } from './course-upload-metadata.js?v=20260915_learning2';
import { buildCoursePermissions } from './course-permissions.js?v=20260917_permissions1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_TYPES = new Set(['registered_free', 'paid_single', 'paid_specialty', 'paid_membership']);
const CONTENT_SOURCES = new Set(['external', 'kidneysphere', 'glomcon']);
const MAX_SORT_ORDER = 2147483647;

function problem(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function uuid(value, label) {
  const result = String(value || '').trim();
  if (!UUID.test(result)) throw problem('batch_invalid_settings', `${label}无效，请保留当前队列并重新检查。`);
  return result.toLowerCase();
}

function optionalText(value) {
  return String(value ?? '').trim() || null;
}

function batchCoursePermissions(item, settings) {
  // New uploads use one audience selector. Keep the checked legacy branch for
  // already started queues: retrying a save must not rewrite frozen settings.
  if (settings?.audience !== undefined) {
    try {
      return buildCoursePermissions({ audience: settings.audience, specialtyIds: settings.specialtyIds,
        specialties: settings.specialties, mediaType: item?.mediaType });
    } catch (cause) {
      throw problem('batch_invalid_settings', cause?.message || '请重新选择课程权限。', cause);
    }
  }
  let accessType = String(settings?.accessType || '');
  if (!ACCESS_TYPES.has(accessType)) throw problem('batch_invalid_settings', '访问权限无效，不能保存课程。');
  if (!Array.isArray(settings?.specialtyIds)) throw problem('batch_invalid_settings', '专科设置无效，请重新选择。');
  let specialtyIds = [...new Set(settings.specialtyIds.map(value => uuid(value, '专科 ID')))];
  // Editorial scope, never content source or upload weekday, defines membership.
  const membershipScope = settings.membershipScope || 'unclassified';
  if (!['unclassified', 'weekly_replay', 'training', 'other_paid'].includes(membershipScope)) {
    throw problem('batch_invalid_settings', '请选择有效的会员内容范围。');
  }
  if (membershipScope !== 'unclassified' && accessType === 'registered_free') {
    throw problem('batch_invalid_settings', '免费公开课请将会员内容范围设为“未分类”，或更改访问权限。');
  }
  if (membershipScope === 'weekly_replay' && (item.mediaType !== 'video' || accessType !== 'paid_membership')) {
    throw problem('batch_invalid_settings', '周三/周日会员回放必须为视频，并选择会员权限。');
  }
  if (accessType === 'paid_membership' && membershipScope !== 'weekly_replay') {
    throw problem('batch_invalid_settings', '299元会员仅包含明确分类的周三/周日学术视频回放；培训及音频请使用其他权限。');
  }
  if (accessType === 'paid_specialty' && specialtyIds.length === 0) {
    throw problem('batch_invalid_settings', '跟随专科课程的内容必须选择至少一个所属专科。');
  }
  let price = 0;
  if (accessType === 'paid_single') {
    price = Number(settings.price);
    if (!Number.isFinite(price) || price <= 0 || price > 99999999.99 ||
        Math.abs(price * 100 - Math.round(price * 100)) > 0.000001) {
      throw problem('batch_invalid_settings', '单课程付费价格须大于 0，且最多保留两位小数。');
    }
    price = Math.round(price * 100) / 100;
  }
  return {
    access_type: accessType, is_paid: accessType !== 'registered_free',
    membership_accessible: membershipScope === 'weekly_replay', membership_scope: membershipScope,
    specialty_id: specialtyIds[0] || null, specialty_ids: specialtyIds, price,
  };
}

// Validate the whole selected queue before the first upload begins. A video
// first in a mixed queue must not hide an incompatible audio file later on.
export function validateBatchPermissions(items, settings) {
  for (const item of items || []) {
    try { batchCoursePermissions(item, item.settings || settings); }
    catch (cause) {
      const name = String(item?.file?.name || item?.title || '文件');
      throw problem('batch_invalid_settings', `${name}：${cause.message}`, cause);
    }
  }
}

function buildCourseRow(item, settings) {
  const id = uuid(item?.id, '课程固定 ID');
  const createdBy = uuid(settings?.createdBy, '批次管理员 ID');
  const title = optionalText(item?.title);
  const category = optionalText(settings?.category);
  const videoId = optionalText(item?.uploadResult?.videoId);
  if (!title || !category) throw problem('batch_invalid_settings', '请填写课程名称和分类。');
  if (!videoId) throw problem('batch_not_uploaded', '当前文件尚未完成上传，请先完成上传再保存。');

  const source = String(settings?.source || 'external');
  if (!CONTENT_SOURCES.has(source)) throw problem('batch_invalid_settings', '内容来源无效，不能保存课程。');
  const permissions = batchCoursePermissions(item, settings);
  if (typeof settings.publish !== 'boolean') {
    throw problem('batch_invalid_settings', '请选择保存草稿或上架。');
  }
  const sortStart = settings.sortStart === undefined ? 0 : Number(settings.sortStart);
  const chapter = Number(item.chapterNumber);
  const order = Number(item.order);
  const position = Number.isInteger(chapter) && chapter > 0 ? chapter : order;
  const sortOrder = sortStart + position - 1;
  if (!Number.isInteger(sortStart) || sortStart < 0 || !Number.isInteger(position) || position <= 0 ||
      !Number.isInteger(sortOrder) || sortOrder > MAX_SORT_ORDER) {
    throw problem('batch_invalid_settings', '章节顺序或起始序号无效，请重新检查。');
  }

  return {
    id,
    title,
    category,
    kind: 'aliyun',
    aliyun_vid: videoId,
    source_url: null,
    mp4_url: null,
    bvid: null,
    source,
    created_by: createdBy,
    enabled: settings.publish,
    is_published: settings.publish,
    deleted_at: null,
    ...permissions,
    speaker: optionalText(settings.speaker),
    description: optionalText(settings.description),
    cover_image: optionalText(settings.coverImage),
    sort_order: sortOrder,
    ...courseUploadMetadata({ seriesId: settings.seriesId, seriesTitle: settings.seriesTitle,
      chapterNumber: position, mediaType: item.mediaType, duration: item.uploadResult?.durationSeconds }),
  };
}

async function requireSameAdministrator(supabase, createdBy) {
  let result;
  try {
    result = await supabase.auth.getSession();
  } catch (cause) {
    throw problem('batch_login_required', '无法确认当前登录账号。已上传媒体会保留，请重新登录后继续保存。', cause);
  }
  const currentId = String(result?.data?.session?.user?.id || '').toLowerCase();
  if (result?.error || !currentId) {
    throw problem('batch_login_required', '登录已过期。已上传媒体会保留，请重新登录原管理员账号后继续保存。', result?.error);
  }
  if (currentId !== createdBy) {
    throw problem('batch_account_changed', '当前账号与本批次管理员不一致，请登录原账号后继续保存。');
  }
  // The existing table RLS remains responsible for verifying the admin role.
}

function equivalentRow(existing, expected) {
  return Object.keys(expected).every(key => {
    const actual = existing[key];
    const wanted = expected[key];
    if (key === 'price' && wanted === null) return actual === null;
    if (key === 'price' || key === 'sort_order' || key === 'duration' || (key === 'chapter_number' && wanted !== null)) {
      return actual !== null && actual !== undefined && actual !== '' && Number(actual) === wanted;
    }
    if (key === 'specialty_ids') {
      return Array.isArray(actual) && actual.length === wanted.length &&
        actual.every((value, index) => String(value).toLowerCase() === wanted[index]);
    }
    if (key === 'id' || key === 'created_by' || key === 'specialty_id') {
      return wanted === null ? actual === null : String(actual || '').toLowerCase() === wanted;
    }
    return actual === wanted;
  });
}

export async function saveBatchCourse(supabase, item, settings) {
  const row = buildCourseRow(item, settings);
  await requireSameAdministrator(supabase, row.created_by);
  let insertError;
  try {
    const result = await supabase.from('learning_videos').insert(row);
    if (result && !result.error) return { id: row.id, videoId: row.aliyun_vid, status: 'saved' };
    insertError = result?.error || new Error('未收到保存结果');
  } catch (cause) {
    insertError = cause;
  }
  const schemaError = courseMetadataSchemaError(insertError);
  if (schemaError) throw schemaError;

  // An interrupted response can hide a committed INSERT. Query the same UUID
  // after every insert error, including 23505; a duplicate alone is not proof.
  await requireSameAdministrator(supabase, row.created_by);
  let verification;
  try {
    verification = await supabase.rpc('list_learning_videos_admin')
      .eq('id', row.id)
      .maybeSingle();
  } catch (cause) {
    throw problem('batch_save_unconfirmed', '保存状态尚未确认。已上传媒体会保留，请恢复网络后重试保存。', cause);
  }
  if (!verification || verification.error) {
    const schemaError = courseMetadataSchemaError(verification?.error);
    if (schemaError) throw schemaError;
    throw problem('batch_save_unconfirmed', '保存状态尚未确认。已上传媒体会保留，请稍后用原管理员账号重试保存。', verification?.error || insertError);
  }
  const existing = verification.data;
  if (!existing) {
    throw problem('batch_save_failed', `课程尚未确认入库，已上传媒体会保留。${insertError?.message ? '保存错误：' + insertError.message : '请稍后重试保存。'}`, insertError);
  }
  if (existing.deleted_at !== null) {
    throw problem('batch_record_deleted', '该课程记录已删除或状态不完整，不能自动恢复。已上传媒体会保留，请管理员检查。');
  }
  if (!equivalentRow(existing, row)) {
    throw problem('batch_record_conflict', '已有课程记录与本次媒体或设置不一致，未覆盖原记录。请管理员检查后再处理。');
  }
  return { id: row.id, videoId: row.aliyun_vid, status: 'saved' };
}
