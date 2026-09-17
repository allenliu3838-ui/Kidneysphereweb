import { getSupabase, getCurrentUser } from './supabaseClient.js?v=20260918_daily1';
import { fetchContentList } from './content-api.js?v=20260328_002';
import {
  DAILY_ACCESS_LABELS,
  DAILY_SPECIALTIES,
  DAILY_SPECIALTY_LABELS,
  isDailyReviewDue,
  normalizeDailySpecialties,
  parseDailyPreferences,
  recordDailyLocalAnswer,
} from './daily-learning-core.js?v=20260918_daily1';

const PREFS_KEY = 'ks_daily_learning_preferences_v1';
const PROGRESS_KEY = 'ks_daily_learning_progress_v1';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || '') || fallback; }
  catch (_) { return fallback; }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (_) {}
}

function loadPreferences() {
  return parseDailyPreferences(readJson(PREFS_KEY, {}));
}

function savePreferences(specialties) {
  const normalized = normalizeDailySpecialties(specialties);
  writeJson(PREFS_KEY, { specialties: normalized, updatedAt: new Date().toISOString() });
  return normalized;
}

function loadProgress() {
  const value = readJson(PROGRESS_KEY, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function saveLocalAnswer(articleId, selectedOption, correctOption) {
  const all = loadProgress();
  all[articleId] = recordDailyLocalAnswer(all[articleId], selectedOption, correctOption);
  writeJson(PROGRESS_KEY, all);
  return all[articleId];
}

function validInternalHref(value) {
  const href = String(value || '').trim();
  if (!href || href.includes('..') || href.startsWith('/') || href.startsWith('//')) return '';
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?(?:#[A-Za-z0-9._~-]+)?$/.test(href) ? href : '';
}

async function fetchDailyCard(specialties) {
  try {
    const supabase = await getSupabase();
    const result = await supabase.rpc('get_daily_learning_today', {
      p_specialties: specialties.length ? specialties : null,
    });
    if (result.error) throw result.error;
    const data = Array.isArray(result.data) ? result.data[0] : result.data;
    if (data?.article_id) return { ...data, structured: true };
  } catch (error) {
    console.warn('daily learning RPC unavailable; using reviewed article fallback', error);
  }

  try {
    const response = await fetchContentList({ type: 'article', tag: '每日一学', limit: 1 });
    const item = response?.items?.[0];
    if (!item) return null;
    return {
      article_id: item.legacy_article_id || item.id,
      title: item.title_zh || item.title,
      summary: item.summary_zh || item.summary || '',
      specialty: 'other',
      estimated_minutes: 3,
      structured: false,
    };
  } catch (_) {
    return null;
  }
}

function renderPreferenceButtons(root, selected, onChange) {
  const wrap = root.querySelector('[data-daily-preferences]');
  if (!wrap) return;
  wrap.replaceChildren();
  DAILY_SPECIALTIES.forEach(key => {
    const button = element('button', 'daily-topic-button', DAILY_SPECIALTY_LABELS[key]);
    button.type = 'button';
    button.dataset.specialty = key;
    button.setAttribute('aria-pressed', selected.includes(key) ? 'true' : 'false');
    if (selected.includes(key)) button.classList.add('is-selected');
    button.addEventListener('click', () => {
      const next = selected.includes(key) ? selected.filter(value => value !== key) : [...selected, key];
      onChange(savePreferences(next));
    });
    wrap.appendChild(button);
  });
}

function renderEmpty(container) {
  container.replaceChildren();
  const card = element('div', 'daily-empty');
  card.append(
    element('strong', '', '今日内容正在准备中'),
    element('p', '', '已审核内容发布后会自动出现在这里。你也可以先浏览最新文献与病例。'),
  );
  const link = element('a', 'btn', '浏览最新内容');
  link.href = 'articles.html';
  card.append(link);
  container.append(card);
}

function renderCard(container, card) {
  container.replaceChildren();
  const articleId = String(card.article_id || '');
  const progress = loadProgress()[articleId] || null;
  const shell = element('article', `daily-card daily-theme-${card.specialty || 'other'}`);
  const visual = element('div', 'daily-visual');
  if (card.cover_url) {
    const image = element('img');
    image.src = String(card.cover_url);
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    visual.append(image);
  }
  const visualText = element('div', 'daily-visual-copy');
  visualText.append(
    element('span', 'daily-specialty', DAILY_SPECIALTY_LABELS[card.specialty] || DAILY_SPECIALTY_LABELS.other),
    element('strong', '', '每日 3–5 分钟'),
    element('small', '', '一个问题 · 三个要点 · 一次主动回忆'),
  );
  visual.append(visualText);

  const body = element('div', 'daily-body');
  const meta = element('div', 'daily-meta');
  meta.append(
    element('span', 'daily-free-label', '免费'),
    element('span', '', `约 ${Number(card.estimated_minutes) || 3} 分钟`),
  );
  if (isDailyReviewDue(progress)) meta.append(element('span', 'daily-due-label', '今天该复习'));
  body.append(meta, element('h3', '', card.title || '今日一学'));
  if (card.learning_objective) body.append(element('p', 'daily-objective', card.learning_objective));
  else if (card.summary) body.append(element('p', 'daily-objective', card.summary));

  if (Array.isArray(card.key_points) && card.key_points.length) {
    const points = element('ul', 'daily-points');
    card.key_points.slice(0, 5).forEach(value => points.append(element('li', '', value)));
    body.append(points);
  }

  if (card.structured && card.quiz_question && Array.isArray(card.quiz_options)) {
    const quiz = element('div', 'daily-quiz');
    quiz.append(element('p', 'daily-quiz-label', '用一道题检验一下'));
    quiz.append(element('h4', '', card.quiz_question));
    const options = element('div', 'daily-options');
    const result = element('div', 'daily-result');
    result.hidden = true;
    card.quiz_options.forEach((value, index) => {
      const button = element('button', 'daily-option', `${String.fromCharCode(65 + index)}. ${value}`);
      button.type = 'button';
      button.addEventListener('click', async () => {
        if (options.dataset.answered === 'true') return;
        options.dataset.answered = 'true';
        const correct = index === Number(card.correct_option);
        options.querySelectorAll('button').forEach((item, itemIndex) => {
          item.disabled = true;
          if (itemIndex === Number(card.correct_option)) item.classList.add('is-correct');
          else if (itemIndex === index) item.classList.add('is-wrong');
        });
        saveLocalAnswer(articleId, index, Number(card.correct_option));
        result.hidden = false;
        result.className = `daily-result ${correct ? 'is-correct' : 'is-wrong'}`;
        result.replaceChildren(
          element('strong', '', correct ? '回答正确' : '再想一步'),
          element('p', '', card.quiz_explanation || ''),
          element('small', '', '已安排 1/3/7/30 天间隔复习；登录后可同步学习记录。'),
        );
        try {
          const user = await getCurrentUser();
          if (user) {
            const supabase = await getSupabase();
            await supabase.rpc('record_daily_learning_answer', {
              p_article_id: articleId,
              p_selected_option: index,
            });
          }
        } catch (_) {}
      });
      options.append(button);
    });
    quiz.append(options, result);
    body.append(quiz);
  }

  const footer = element('div', 'daily-footer');
  const articleLink = element('a', 'btn primary', card.structured ? '阅读全文与出处' : '阅读全文');
  articleLink.href = `article.html?id=${encodeURIComponent(articleId)}`;
  const favorite = element('button', 'btn', '收藏');
  favorite.type = 'button';
  favorite.addEventListener('click', async () => {
    favorite.disabled = true;
    try {
      const user = await getCurrentUser();
      if (!user) {
        location.href = `login.html?next=${encodeURIComponent(location.pathname + location.search + '#daily-learning')}`;
        return;
      }
      const supabase = await getSupabase();
      const response = await supabase.from('article_favorites').upsert(
        { article_id: articleId, user_id: user.id },
        { onConflict: 'article_id,user_id' },
      );
      if (response.error) throw response.error;
      favorite.textContent = '已收藏';
      favorite.classList.add('is-saved');
    } catch (_) {
      favorite.textContent = '收藏失败，请重试';
      favorite.disabled = false;
    }
  });
  footer.append(articleLink, favorite);
  const relatedHref = validInternalHref(card.related_href);
  if (relatedHref && card.related_label) {
    const related = element('a', 'daily-related-link');
    related.href = relatedHref;
    related.append(
      element('span', '', card.related_label),
      element('small', '', DAILY_ACCESS_LABELS[card.related_access] || '查看详情'),
    );
    footer.append(related);
  }
  body.append(footer);

  if (card.source_label) {
    const source = element('p', 'daily-source');
    source.append(document.createTextNode('来源：'));
    if (/^https:\/\//i.test(String(card.source_url || ''))) {
      const link = element('a', '', card.source_label);
      link.href = card.source_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      source.append(link);
    } else source.append(document.createTextNode(card.source_label));
    source.append(document.createTextNode(' · 内容经审核后发布'));
    body.append(source);
  }
  shell.append(visual, body);
  container.append(shell);
}

export async function initDailyLearning(root = document) {
  const section = root.querySelector('[data-daily-learning]');
  const container = section?.querySelector('[data-daily-card]');
  if (!section || !container) return;
  let selected = loadPreferences();
  let requestId = 0;

  const load = async () => {
    const current = ++requestId;
    container.innerHTML = '<div class="daily-loading" role="status">正在准备今日学习…</div>';
    renderPreferenceButtons(section, selected, next => {
      selected = next;
      load();
    });
    const card = await fetchDailyCard(selected);
    if (current !== requestId) return;
    if (card) renderCard(container, card);
    else renderEmpty(container);
  };
  await load();
}

if (typeof document !== 'undefined') initDailyLearning(document);
