/** Display-only interpretation of server-returned records. Never grants access. */
const DAY_MS = 86400000;

function timestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const calendar = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/);
  if (!calendar) return NaN;
  const [year, month, day] = calendar.slice(1).map(Number);
  const civilDate = new Date(Date.UTC(year, month - 1, day));
  if (civilDate.getUTCFullYear() !== year || civilDate.getUTCMonth() !== month - 1 || civilDate.getUTCDate() !== day) return NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function formatLearningDate(value) {
  const time = timestamp(value);
  if (time === null) return '—';
  if (!Number.isFinite(time)) return '日期待核实';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date(time).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function entitlementDisplayState(entitlement, now = Date.now()) {
  const ent = entitlement || {};
  const inactiveLabels = { revoked: '已撤销', refunded: '已退款', cancelled: '已取消', expired: '已过期', pending: '待生效' };
  if (ent.status !== 'active') {
    return { active: false, tone: 'expired', label: inactiveLabels[ent.status] || '权益待核实' };
  }
  const start = timestamp(ent.start_at);
  const end = timestamp(ent.end_at);
  if ((start !== null && !Number.isFinite(start)) || (end !== null && !Number.isFinite(end)) ||
      (start !== null && end !== null && end <= start)) {
    return { active: false, tone: 'expired', label: '权益日期待核实' };
  }
  if (end !== null && end <= now) return { active: false, tone: 'expired', label: '已过期' };
  if (start !== null && start > now) return { active: false, tone: 'expiring', label: `${formatLearningDate(ent.start_at)} 起生效` };
  if (end === null) return { active: true, tone: 'active', label: '长期有效', days: null };
  const days = Math.ceil((end - now) / DAY_MS);
  return { active: true, tone: days <= 30 ? 'expiring' : 'active', label: days <= 30 ? `剩余 ${days} 天` : `有效至 ${formatLearningDate(ent.end_at)}`, days };
}

export function currentLearningMembership(entitlements, now = Date.now()) {
  return (entitlements || []).filter(ent => ent.entitlement_type === 'membership' && entitlementDisplayState(ent, now).active)
    .sort((a, b) => {
      const aEnd = timestamp(a.end_at);
      const bEnd = timestamp(b.end_at);
      if (aEnd === bEnd) return 0;
      if (aEnd === null) return -1;
      if (bEnd === null) return 1;
      return bEnd - aEnd;
    })[0] || null;
}

export function learningPeriod(entitlement) {
  const start = entitlement?.start_at == null ? '未注明起始日' : formatLearningDate(entitlement.start_at);
  const end = entitlement?.end_at == null ? '长期有效' : formatLearningDate(entitlement.end_at);
  return `${start} 至 ${end}`;
}

export function learningCourseLink(entitlement) {
  if (!entitlementDisplayState(entitlement).active) return null;
  if (entitlement.entitlement_type === 'single_video' && entitlement.video_id) {
    return { href: `watch.html?id=${encodeURIComponent(entitlement.video_id)}`, label: '立即观看' };
  }
  if (entitlement.entitlement_type === 'membership') {
    return { href: 'videos.html?source=glomcon', label: '进入 GlomCon 视频库' };
  }
  if (['specialty_bundle', 'project_access', 'cohort_access'].includes(entitlement.entitlement_type) && entitlement.specialty_id) {
    return { href: `videos.html?specialty=${encodeURIComponent(entitlement.specialty_id)}`, label: '进入课程' };
  }
  return null;
}

export function safeLearningImageUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function enrollmentDisplayState(enrollment, now = Date.now()) {
  const entry = enrollment || {};
  if (entry.enrollment_status === 'cancelled') return { active: false, tone: 'expired', label: '报名已取消' };
  if (entry.enrollment_status === 'expired') return { active: false, tone: 'expired', label: '报名已过期' };
  if (entry.approval_status === 'rejected') return { active: false, tone: 'expired', label: '报名已驳回' };
  if (entry.access_status === 'ambiguous') return { active: false, tone: 'expired', label: '权益归属待核实' };
  if (entry.is_access_active !== true || entry.access_status !== 'active') {
    const labels = { refunded: '订单已退款', revoked: '权益已撤销', expired: '权益已过期', upcoming: '权益尚未生效' };
    return { active: false, tone: 'expired', label: labels[entry.access_status] || '当前无有效报名权益' };
  }
  if (entry.enrollment_status !== 'confirmed' || entry.approval_status !== 'approved') {
    return { active: false, tone: 'expiring', label: '报名待确认' };
  }
  return entitlementDisplayState({ status: 'active', start_at: entry.access_start_at, end_at: entry.access_end_at }, now);
}
