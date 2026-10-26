// Account-scoped display only. Playback always goes through watch.html's authorization.
export function recentLearningRecords(records) {
  return (Array.isArray(records) ? records : []).filter(record => record &&
    typeof record.videoId === 'string' && record.videoId.trim() &&
    typeof record.title === 'string' && record.title.trim() &&
    Number.isFinite(record.position) && record.position > 0 && !record.completed)
    .sort((a, b) => (Number(b.updatedAt) || Date.parse(b.updatedAt) || 0) - (Number(a.updatedAt) || Date.parse(a.updatedAt) || 0))
    .slice(0, 3);
}

export function learningTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(value / 3600);
  const m = Math.floor(value / 60) % 60;
  const s = value % 60;
  return `${h ? `${h}:` : ''}${h ? String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`;
}

export function renderLearningResume(section, records) {
  const content = section.querySelector('[data-learning-resume-content]');
  if (!content) return;
  content.replaceChildren();
  const recent = recentLearningRecords(records);
  section.hidden = recent.length === 0;
  if (!recent.length) return;
  const doc = section.ownerDocument;
  const head = doc.createElement('div'); head.className = 'learning-resume-head';
  const heading = doc.createElement('h2'); heading.textContent = '继续学习';
  const library = doc.createElement('a'); library.href = 'videos.html'; library.textContent = '找新课程 →';
  head.append(heading, library);
  const note = doc.createElement('p'); note.className = 'learning-resume-note';
  note.textContent = '本机记录 · 打开课程后确认当前学习权限';
  const list = doc.createElement('div'); list.className = 'learning-resume-list';
  for (const record of recent) {
    const link = doc.createElement('a'); link.className = 'learning-resume-card';
    link.href = `watch.html?id=${encodeURIComponent(record.videoId)}`;
    const icon = doc.createElement('span'); icon.className = 'learning-resume-play'; icon.textContent = record.kind === 'audio' ? '♫' : '▶'; icon.setAttribute('aria-hidden', 'true');
    const body = doc.createElement('div'); body.className = 'learning-resume-body';
    const title = doc.createElement('h3'); title.textContent = record.title;
    const detail = doc.createElement('p');
    detail.textContent = `${record.kind === 'audio' ? '已听' : '已看'}至 ${learningTime(record.position)}${record.speaker ? ` · ${record.speaker}` : ''}`;
    body.append(title, detail);
    if (Number.isFinite(record.duration) && record.duration > 0) {
      const progress = doc.createElement('progress'); progress.max = record.duration;
      progress.value = Math.min(record.duration, record.position); progress.setAttribute('aria-label', `${record.title}的学习进度`);
      body.append(progress);
    }
    const action = doc.createElement('span'); action.className = 'learning-resume-action'; action.textContent = record.kind === 'audio' ? '继续收听' : '继续观看';
    link.append(icon, body, action); list.append(link);
  }
  content.append(head, note, list);
}

export async function initLearningResume(root, {
  loadClient = () => import('./supabaseClient.js?v=20260401_fix'),
  loadProgress = () => import('./learning-progress.js?v=20260915_mobile1'),
} = {}) {
  const sections = [...root.querySelectorAll('[data-learning-resume]')];
  if (!sections.length) return;
  let generation = 0;
  let currentUserId = null;
  const clear = () => sections.forEach(section => renderLearningResume(section, []));
  const update = async userId => {
    const request = ++generation;
    currentUserId = typeof userId === 'string' && userId ? userId : null;
    clear(); // Never leave the prior account's records visible during a transition.
    if (!currentUserId) return;
    try {
      const { createLearningProgress } = await loadProgress();
      if (request !== generation) return;
      const records = createLearningProgress({ userId: currentUserId }).list();
      sections.forEach(section => renderLearningResume(section, records));
    } catch { if (request === generation) clear(); }
  };
  try {
    const provider = await loadClient();
    if (!provider.isConfigured()) return;
    await provider.ensureSupabase();
    const auth = provider.supabase?.auth;
    if (!auth) return;
    // Register first so a late initial-session read cannot restore a signed-out account.
    let authRevision = 0;
    auth.onAuthStateChange((_event, session) => {
      authRevision++;
      void update(session?.user?.id);
    });
    const startedAt = authRevision;
    const user = await provider.getCurrentUser();
    if (startedAt === authRevision) await update(user?.id);
    root.addEventListener('visibilitychange', () => {
      if (!root.hidden && currentUserId) void update(currentUserId);
    });
    root.defaultView?.addEventListener('storage', () => {
      // Session changes are handled by the auth subscription; progress uses the
      // verified current account key, never a key taken from the storage event.
      if (currentUserId) void update(currentUserId);
    });
  } catch { clear(); }
}

// The homepage keeps its static fallback. Other learning pages share the same
// destinations, icons and accessible 52px targets; never append a second bar.
export function initLearningNavigation(root) {
  if (!root.body.classList.contains('learning-mobile-page')) return;
  if (root.querySelector('.portal-mobile-bar')) return;
  const nav = root.createElement('nav'); nav.className = 'portal-mobile-bar';
  nav.setAttribute('aria-label', '手机学习快捷入口');
  const routes = [
    ['videos.html', '视频课程', '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4z"/>'],
    ['academy.html', '培训报名', '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 2v6M16 2v6M4 11h16m-12 5 3 2 5-4"/>'],
    ['my-learning.html', '我的学习', '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>'],
  ];
  for (const [href, title, icon] of routes) {
    const link = root.createElement('a'); link.href = href;
    // All markup here is a literal owned by this module, never catalogue input.
    link.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${icon}</svg>`;
    const label = root.createElement('span'); label.textContent = title; link.append(label);
    if (root.defaultView?.location.pathname.endsWith(`/${href}`)) link.setAttribute('aria-current', 'page');
    nav.append(link);
  }
  root.body.append(nav);
}

if (typeof document !== 'undefined') {
  initLearningNavigation(document);
  void initLearningResume(document);
}
