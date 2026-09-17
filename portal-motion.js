// Presentation only. No catalogue, authentication, purchase or playback calls.
const TOPICS = Object.freeze({
  path: { title: '肾脏病理', description: '从形态到临床，让理解更进一步', english: 'RENAL PATHOLOGY', href: 'training-patho.html' },
  icu: { title: '重症肾内科', description: '围绕 AKI 与肾脏替代治疗，连接知识与实践', english: 'CRITICAL CARE NEPHROLOGY', href: 'training-icu.html' },
  tx: { title: '肾移植', description: '从围术期到长期管理，系统理解移植内科', english: 'TRANSPLANT NEPHROLOGY', href: 'training-tx.html' },
});

export function initPortalFeature(root) {
  const feature = root.querySelector('[data-portal-feature]');
  const tabs = root.querySelector('[data-feature-tabs]');
  if (!feature || !tabs || tabs.dataset.ready) return;
  tabs.dataset.ready = 'true';
  const buttons = [...tabs.querySelectorAll('[data-feature-topic]')];
  for (const button of buttons) button.addEventListener('click', () => {
    const key = button.dataset.featureTopic;
    const topic = Object.hasOwn(TOPICS, key) ? TOPICS[key] : null;
    if (!topic) return;
    for (const name of Object.keys(TOPICS)) feature.classList.remove(`portal-cover--${name}`);
    feature.classList.add(`portal-cover--${key}`);
    feature.setAttribute('href', topic.href);
    feature.setAttribute('aria-label', `了解${topic.title}培训课程`);
    feature.querySelector('[data-feature-title]').textContent = topic.title;
    feature.querySelector('[data-feature-description]').textContent = topic.description;
    feature.querySelector('[data-feature-english]').textContent = topic.english;
    for (const item of buttons) item.setAttribute('aria-pressed', String(item === button));
  });
  tabs.hidden = false;
}

export function initPortalMotion(root, view) {
  const hero = root.querySelector('.portal-hero');
  const button = root.querySelector('[data-portal-motion]');
  if (!hero || !button || hero.dataset.motionReady) return;
  hero.dataset.motionReady = 'true';
  const preference = view.matchMedia('(prefers-reduced-motion: reduce)');
  let paused = preference.matches;
  let visible = true;
  const sync = () => {
    hero.classList.toggle('portal-background-moving', !preference.matches && !paused && visible && !root.hidden);
    button.disabled = preference.matches;
    button.textContent = preference.matches ? '已按系统设置减少动效' : paused ? '开启背景动效' : '暂停背景动效';
    button.setAttribute('aria-pressed', String(paused));
  };
  button.addEventListener('click', () => { paused = !paused; sync(); });
  preference.addEventListener?.('change', () => { paused = preference.matches; sync(); });
  root.addEventListener('visibilitychange', sync);
  if (view.IntersectionObserver) {
    const observer = new view.IntersectionObserver(entries => {
      visible = entries[0]?.isIntersecting ?? true;
      sync();
    }, { threshold: 0.05 });
    observer.observe(hero);
  }
  button.hidden = false;
  sync();
}

if (typeof document !== 'undefined') {
  initPortalFeature(document);
  initPortalMotion(document, window);
}
