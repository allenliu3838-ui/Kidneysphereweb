// Upload/edit metadata only. Playback authorization is enforced by database RPCs.
export const TRAINING_PROJECTS = Object.freeze([
  { code: 'glom', label: '肾小球病培训项目' },
  { code: 'tx', label: '肾移植内科培训项目' },
  { code: 'icu', label: '重症肾内培训项目' },
  { code: 'patho', label: '肾脏病理培训项目' },
  { code: 'da', label: '血管通路培训项目' },
  { code: 'peds', label: '儿童肾脏培训项目' },
].map(Object.freeze));

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = value => String(value ?? '').trim();
const ids = values => [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];

export function trainingProjectOptions(specialties) {
  const rows = specialties instanceof Map ? [...specialties.values()] :
    Array.isArray(specialties) ? specialties : [];
  return TRAINING_PROJECTS.flatMap(project => {
    const matches = rows.filter(row => row.code === project.code && row.is_active !== false && uuid.test(text(row.id)));
    // Duplicate codes or missing metadata must not silently select another project.
    return matches.length === 1 ? [{ ...project, id: text(matches[0].id) }] : [];
  });
}

export function buildCoursePermissions({ audience, specialtyIds = [], mediaType, specialties } = {}) {
  if (!['free', 'member', 'training'].includes(audience)) {
    throw new Error('请选择观看权限：免费课程、299 元年度会员回放或独立付费培训。');
  }
  if (audience === 'member' && mediaType !== 'video') {
    throw new Error('299 元年度会员仅包含周日或周三的学术视频回放；音频请选择免费或独立付费培训。');
  }
  const selected = audience === 'training' ? ids(specialtyIds) : [];
  if (audience === 'training') {
    const allowed = new Set(trainingProjectOptions(specialties).map(project => project.id));
    if (!selected.length) throw new Error('请选择至少一个所属培训项目；普通年度会员不包含培训课程。');
    if (selected.some(id => !allowed.has(id))) {
      throw new Error('培训项目已失效或尚未配置，请刷新项目列表后重新选择。');
    }
  }
  return {
    membership_scope: audience === 'member' ? 'weekly_replay' : audience === 'training' ? 'training' : 'unclassified',
    access_type: audience === 'member' ? 'paid_membership' : audience === 'training' ? 'paid_specialty' : 'registered_free',
    is_paid: audience !== 'free',
    membership_accessible: audience === 'member',
    specialty_id: selected[0] || null,
    specialty_ids: selected,
    price: null,
    product_id: null,
  };
}

export function coursePermissionForVideo(video = {}) {
  const specialtyIds = ids([...(Array.isArray(video.specialty_ids) ? video.specialty_ids : []), video.specialty_id]);
  const scope = video.membership_scope || 'unclassified';
  let audience = 'legacy';
  if (scope === 'unclassified' && video.access_type === 'registered_free' && video.is_paid === false &&
      video.membership_accessible !== true) audience = 'free';
  else if (scope === 'weekly_replay' && video.media_type === 'video' && video.is_paid === true &&
      video.access_type === 'paid_membership' && video.membership_accessible === true) audience = 'member';
  else if (scope === 'training' && video.access_type === 'paid_specialty' && video.is_paid === true &&
      video.membership_accessible !== true && specialtyIds.length) audience = 'training';
  // Old or contradictory records remain unchanged until an administrator explicitly chooses a new audience.
  return { audience, specialtyIds };
}
