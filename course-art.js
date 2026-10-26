// Presentation-only artwork; course access and purchase rules are unchanged.
const ART = Object.freeze({
  glom: { src: 'assets/portal/glomerular-v1.webp', alt: '肾小球病学习主题插图', theme: 'coral' },
  tx: { src: 'assets/portal/transplant-v1.webp', alt: '肾移植学习主题插图', theme: 'teal' },
  icu: { src: 'assets/portal/critical-v1.webp', alt: '重症肾内学习主题插图', theme: 'blue' },
  path: { src: 'assets/portal/pathology-v1.webp', alt: '肾脏病理学习主题插图', theme: 'violet' },
  da: { src: 'assets/portal/vascular-v1.webp', alt: '血管通路学习主题插图', theme: 'aqua' },
  peds: { src: 'assets/portal/pediatric-v1.webp', alt: '儿童肾脏学习主题插图', theme: 'apricot' },
});
const DEFAULT = Object.freeze({ src: 'assets/portal/learning-v1.webp', alt: '视频、音频与阅读学习主题插图', theme: 'blue' });

export function safeCourseCover(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return null;
  const candidate = value.trim();
  if (/[\u0000-\u0020\u007f\\]/.test(candidate) || candidate.startsWith('//')) return null;
  if (!candidate.startsWith('https://') && !/^(?:\/)?assets\//.test(candidate)) return null;
  try {
    const url = new URL(candidate, 'https://kidneysphere.com/');
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (!candidate.startsWith('https://') && !url.pathname.startsWith('/assets/')) return null;
    return candidate;
  } catch (_) { return null; }
}

export function getCourseArtwork(video = {}) {
  const raw = String(video.category || '').trim();
  const category = raw === 'patho' ? 'path' : raw === 'glomcon' ? 'glom' : raw;
  const fallback = Object.hasOwn(ART, category) ? ART[category] : DEFAULT;
  const custom = safeCourseCover(video.cover_image);
  return { ...fallback, ...(custom ? { src: custom, alt: '课程封面' } : {}), fallbackSrc: fallback.src };
}
