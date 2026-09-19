import { getSupabase, getCurrentUser } from './supabaseClient.js?v=20260918_daily1';
import { DAILY_SPECIALTIES, DAILY_SPECIALTY_LABELS, normalizeDailySpecialties } from './daily-learning-core.js?v=20260918_daily1';

const STORAGE_KEY = 'ks_daily_literature_preferences_v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function readPreferences() {
  try { return normalizeDailySpecialties(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')); }
  catch { return []; }
}

function dateLabel(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date)
    : '';
}

function renderArticle(item) {
  const shell = el('article', 'literature-card');
  shell.dataset.specialty = item.specialty;
  const label = DAILY_SPECIALTY_LABELS[item.specialty];
  shell.setAttribute('aria-label', `${label}最新文献解读`);
  const meta = el('div', 'literature-meta');
  meta.append(el('span', 'literature-specialty', label));
  shell.append(meta);

  if (!item.available || !UUID.test(String(item.article_id || ''))) {
    shell.classList.add('literature-card-pending');
    shell.append(el('h3', '', '本方向文献解读待发布'),
      el('p', 'literature-summary', '审核发布后会自动显示在这里。'));
    return shell;
  }

  meta.append(el('span', '', '约 3 分钟'));
  const title = el('h3');
  const titleLink = el('a', '', item.title);
  const href = `article.html?id=${encodeURIComponent(item.article_id)}`;
  titleLink.href = href;
  title.append(titleLink);
  shell.append(title, el('p', 'literature-summary', item.summary || '阅读全文，查看研究结果、适用边界与原始出处。'));
  const actions = el('div', 'literature-actions');
  const link = el('a', 'btn primary', '阅读全文与出处');
  link.href = href;
  const favorite = el('button', 'btn', '收藏');
  favorite.type = 'button';
  favorite.setAttribute('aria-label', `收藏：${item.title}`);
  favorite.addEventListener('click', async () => {
    favorite.disabled = true;
    try {
      const user = await getCurrentUser();
      if (!user) {
        location.href = `login.html?next=${encodeURIComponent(location.pathname + location.search + '#daily-learning')}`;
        return;
      }
      const supabase = await getSupabase();
      const { error } = await supabase.from('article_favorites').upsert(
        { article_id: item.article_id, user_id: user.id },
        { onConflict: 'article_id,user_id' },
      );
      if (error) throw error;
      favorite.textContent = '已收藏';
    } catch {
      favorite.textContent = '重试收藏';
      favorite.disabled = false;
    }
  });
  actions.append(link, favorite);
  shell.append(actions);
  const date = dateLabel(item.published_at);
  shell.append(el('p', 'literature-source', date ? `解读发布于 ${date} · 原文日期及出处见全文` : '原文日期及出处见全文'));
  return shell;
}

export async function initDailyLiterature(root = document) {
  const section = root.querySelector('[data-daily-learning]');
  const container = section?.querySelector('[data-daily-card]');
  const preferences = section?.querySelector('[data-daily-preferences]');
  if (!section || !container || !preferences) return;
  section.classList.add('daily-literature-section');
  let selected = readPreferences();
  let request = 0;
  let lastSuccess = 0;

  function renderPreferences() {
    preferences.replaceChildren();
    const choices = [['all', '全部专科'], ...DAILY_SPECIALTIES.map(key => [key, DAILY_SPECIALTY_LABELS[key]])];
    for (const [key, label] of choices) {
      const pressed = key === 'all' ? selected.length === 0 : selected.includes(key);
      const button = el('button', `daily-topic-button${pressed ? ' is-selected' : ''}`, label);
      button.type = 'button';
      button.dataset.specialty = key;
      button.setAttribute('aria-pressed', String(pressed));
      button.addEventListener('click', () => {
        selected = key === 'all' ? [] : normalizeDailySpecialties(selected.includes(key)
          ? selected.filter(value => value !== key) : [...selected, key]);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(selected)); } catch {}
        renderPreferences();
        load();
      });
      preferences.append(button);
    }
  }

  async function load(background = false) {
    const current = ++request;
    if (!background) container.replaceChildren(el('div', 'daily-loading', '正在读取各专科文献解读…'));
    container.setAttribute('aria-busy', 'true');
    try {
      const supabase = await getSupabase();
      const { data, error } = await supabase.rpc('get_daily_literature_by_specialty', {
        p_specialties: selected.length ? selected : null,
      });
      if (current !== request) return;
      if (error || !Array.isArray(data)) throw error || new Error('INVALID_FEED');
      const keys = selected.length ? selected : DAILY_SPECIALTIES;
      // Strictly map one row per requested specialty; never fill a missing slot with another topic.
      const bySpecialty = new Map(data.filter(item => DAILY_SPECIALTIES.includes(item.specialty)).map(item => [item.specialty, item]));
      const grid = el('div', 'literature-grid');
      for (const specialty of DAILY_SPECIALTIES.filter(key => keys.includes(key))) {
        grid.append(renderArticle(bySpecialty.get(specialty) || { specialty, available: false }));
      }
      container.replaceChildren(grid);
      lastSuccess = Date.now();
    } catch {
      if (current !== request) return;
      const error = el('div', 'daily-empty');
      error.append(el('strong', '', '文献解读暂时未能加载'), el('p', '', '请重试，或前往文献列表。'));
      const retry = el('button', 'btn', '重新加载');
      retry.type = 'button';
      retry.addEventListener('click', () => load());
      const browse = el('a', 'btn', '浏览文献');
      browse.href = 'articles.html';
      error.append(retry, browse);
      container.replaceChildren(error);
    } finally {
      if (current === request) container.removeAttribute('aria-busy');
    }
  }

  renderPreferences();
  await load();
  // Refresh an open tab after publication without waiting for a manual page reload.
  const refresh = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastSuccess > 300000) load(true);
  };
  const timer = setInterval(refresh, 300000);
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('pagehide', event => {
    if (!event.persisted) {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    }
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => initDailyLiterature(), { once: true });
else initDailyLiterature();
