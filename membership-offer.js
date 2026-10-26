// Public catalogue readiness, not an entitlement check. Playback is authorized
// by the server for each lesson and account.
export const WEEKLY_MEMBERSHIP_COPY = '¥299/年，仅含周三、周日学术活动的视频回放；所有培训项目另行收费。';

export async function hasPublishedWeeklyReplays(client) {
  if (!client?.from) return false;
  try {
    const { data, error } = await client.from('learning_videos').select('id')
      .eq('enabled', true).eq('is_published', true).is('deleted_at', null)
      .eq('membership_scope', 'weekly_replay').eq('media_type', 'video').eq('is_paid', true)
      .or('access_type.eq.paid_membership,membership_accessible.eq.true').limit(1);
    return !error && Array.isArray(data) && data.length > 0;
  } catch (_) { return false; }
}

// A checkout return is only a public course identifier. Never accept arbitrary
// destinations, media URLs or access decisions from the query string.
export function checkoutCourseReturn(search = '') {
  try {
    const next = new URLSearchParams(search).get('next');
    if (!next || /[\\\u0000-\u001f\u007f]/.test(next) || next.startsWith('//')) return '';
    const url = new URL(next, 'https://kidneysphere.com/');
    if (url.origin !== 'https://kidneysphere.com' || url.pathname !== '/watch.html') return '';
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id)) return '';
    return `/watch.html?id=${encodeURIComponent(id)}`;
  } catch (_) { return ''; }
}
