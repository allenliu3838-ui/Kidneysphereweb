/**
 * qbank-test.js
 * UWorld-style question test interface.
 *
 * URL params:
 *   subjects  — comma-separated subject filter (empty = all)
 *   count     — number of questions (default 20)
 *   filter    — all | unused | incorrect | bookmarked
 */

import { ensureSupabase, supabase, getCurrentUser, toast } from './supabaseClient.js';
import { readAllQbankRows, latestQbankAnswers, isMultipleChoice, qbankQuestionProblem, scoreQbankAnswer } from './qbank-data.js?v=20260917_qbank_integrity';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/** Render text with line breaks and markdown images ![alt](url) */
function renderText(s) {
  return esc(s)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="qb-img" />')
    .replace(/\n/g, '<br>');
}

// ── State ──
let _user = null;
let _questions = [];    // loaded question objects
let _answers = {};      // questionId → { chosen, correct, submitted }
let _bookmarks = new Set();
let _excludedQuestions = 0;
let _current = 0;       // current index

async function init() {
  await ensureSupabase();
  _user = await getCurrentUser();
  if (!_user) { location.replace('login.html?next=' + encodeURIComponent(location.pathname + location.search)); return; }

  const params = new URLSearchParams(location.search);
  const bank = params.get('bank') || '';
  const subjects = params.get('subjects') ? params.get('subjects').split(',').map(s => s.trim()).filter(Boolean) : [];
  const requestedCount = Number.parseInt(params.get('count') || '20', 10);
  const count = Number.isFinite(requestedCount) ? Math.min(200, Math.max(1, requestedCount)) : 20;
  const filter = params.get('filter') || 'all';

  await loadBookmarks();
  await loadQuestions(bank, subjects, count, filter);

  if (_questions.length === 0) {
    document.getElementById('questionCard').innerHTML = `
      <div style="text-align:center;padding:60px 20px">
        <h3>没有找到符合条件的题目</h3>
        <p class="muted">${_excludedQuestions ? `有 ${_excludedQuestions} 道题的答案标记或题目结构异常，已跳过并等待核对。` : '请返回题库重新选择筛选条件。'}</p>
        <a href="qbank.html" class="btn primary" style="margin-top:16px">返回题库</a>
      </div>`;
    return;
  }

  renderQuestion();
  renderDots();
  bindEvents();
}

async function loadQuestions(bank, subjects, count, filter) {
  const allQuestions = await readAllQbankRows(() => {
    let query = supabase.from('qbank_questions').select('*').eq('status', 'published');
    if (bank) query = query.eq('bank', bank);
    if (subjects.length > 0) query = query.in('subject', subjects);
    return query.order('id');
  });
  _questions = allQuestions.filter(question => !qbankQuestionProblem(question));
  _excludedQuestions = allQuestions.length - _questions.length;

  if (filter === 'bookmarked') {
    _questions = _questions.filter(question => _bookmarks.has(question.id));
  } else if (filter === 'unused' || filter === 'incorrect') {
    const answers = await readAllQbankRows(() => supabase.from('qbank_user_answers')
      .select('id, question_id, is_correct, created_at').eq('user_id', _user.id)
      .order('created_at', { ascending: false }).order('id', { ascending: false }));
    const latest = latestQbankAnswers(answers);
    _questions = _questions.filter(question => filter === 'unused'
      ? !latest.has(question.id)
      : latest.get(question.id)?.is_correct === false);
  }
  shuffle(_questions);
  _questions = _questions.slice(0, count);
}

async function loadBookmarks() {
  const data = await readAllQbankRows(() => supabase.from('qbank_bookmarks')
    .select('question_id').eq('user_id', _user.id).order('id'));
  _bookmarks = new Set(data.map(bookmark => bookmark.question_id));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ── Rendering ──

function renderQuestion() {
  const q = _questions[_current];
  if (!q) return;

  const ans = _answers[q.id];
  const submitted = ans?.submitted;
  const isBookmarked = _bookmarks.has(q.id);

  // Progress
  const answeredCount = Object.values(_answers).filter(a => a.submitted).length;
  document.getElementById('progressText').textContent = `第 ${_current + 1} / ${_questions.length} 题（已答 ${answeredCount}）`;

  // Bookmark button
  const bmBtn = document.getElementById('btnBookmark');
  bmBtn.textContent = isBookmarked ? '★ 已收藏' : '☆ 收藏';
  bmBtn.className = isBookmarked ? 'btn tiny qb-bookmarked' : 'btn tiny';

  // Build question HTML
  let html = _excludedQuestions ? `<div class="note small" style="margin-bottom:12px">有 ${_excludedQuestions} 道题的答案标记或题目结构异常，已跳过并等待核对。</div>` : '';

  // Question number + subject badge
  html += `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:16px">
    <div>
      <code style="font-size:12px;color:var(--brand);margin-right:8px">${esc(q.qid || '')}</code>
      <span class="badge">${esc(q.subject)}</span>
    </div>
  </div>`;

  // Stem
  html += `<div class="qb-stem">${renderText(q.stem)}</div>`;

  // Question text
  if (q.question_text) {
    html += `<div class="qb-question-text">${renderText(q.question_text)}</div>`;
  }

  if (isMultipleChoice(q)) {
    html += '<div class="small muted" style="margin-bottom:10px">多选题：请选择所有正确选项；漏选或多选均计为错误。</div>';
  }

  // Choices
  html += `<div class="qb-choices">`;
  for (const c of (q.choices || [])) {
    let cls = 'qb-choice';
    let icon = '';

    if (submitted) {
      if (c.correct === true) {
        cls += ' qb-correct';
        icon = '✓';
      } else if (ans.chosen.includes(c.label)) {
        cls += ' qb-incorrect';
        icon = '✗';
      } else {
        cls += ' qb-dimmed';
      }
    } else {
      if (ans?.chosen?.includes(c.label)) {
        cls += ' qb-selected';
      }
    }

    html += `<div class="${cls}" data-label="${esc(c.label)}" ${submitted ? '' : 'role="button" tabindex="0"'}>
      <span class="qb-choice-icon">${icon || esc(c.label)}</span>
      <span class="qb-choice-text">${esc(c.text)}</span>
    </div>`;
  }
  html += `</div>`;

  // Submit button (only if not yet submitted)
  if (!submitted) {
    html += `<div style="text-align:center;margin-top:20px">
      <button class="btn primary" id="btnSubmit" ${ans?.chosen?.length && !ans.pending ? '' : 'disabled'}>${ans?.pending ? '保存中…' : '提交答案'}</button>
    </div>`;
  }

  // Explanation (only after submit)
  if (submitted) {
    const isCorrect = ans.correct;
    html += `<div class="qb-result ${isCorrect ? 'qb-result-correct' : 'qb-result-incorrect'}">
      ${isCorrect ? '✅ 回答正确！' : '❌ 回答错误'}
    </div>`;

    // General explanation
    if (q.explanation) {
      html += `<div class="qb-explanation">
        <div class="qb-explanation-title">解析</div>
        <div>${renderText(q.explanation)}</div>
      </div>`;
    }

    // Per-choice explanations
    if (q.choice_explanations && q.choice_explanations.length > 0) {
      html += `<div class="qb-choice-explanations">`;
      for (const ce of q.choice_explanations) {
        const choice = (q.choices || []).find(c => c.label === ce.label);
        const isRight = choice?.correct;
        html += `<div class="qb-ce-item ${isRight ? 'qb-ce-correct' : 'qb-ce-wrong'}">
          <span class="qb-ce-label">${esc(ce.label)}.</span>
          <span>${esc(ce.text)}</span>
        </div>`;
      }
      html += `</div>`;
    }

    // References
    if (q.references) {
      html += `<div class="qb-references">
        <div class="qb-explanation-title">参考文献</div>
        <div class="small">${renderText(q.references)}</div>
      </div>`;
    }
  }

  document.getElementById('questionCard').innerHTML = html;

  // Nav buttons
  document.getElementById('btnPrev').disabled = _current === 0;
  document.getElementById('btnNext').disabled = _current === _questions.length - 1;

  // Update dots
  updateDots();
}

function renderDots() {
  const container = document.getElementById('dotNav');
  let html = '';
  for (let i = 0; i < _questions.length; i++) {
    html += `<span class="qb-dot" data-idx="${i}">${i + 1}</span>`;
  }
  container.innerHTML = html;
  updateDots();
}

function updateDots() {
  const dots = document.querySelectorAll('.qb-dot');
  dots.forEach((dot, i) => {
    const q = _questions[i];
    const ans = _answers[q?.id];
    dot.className = 'qb-dot';

    if (i === _current) dot.classList.add('qb-dot-current');

    if (ans?.submitted) {
      dot.classList.add(ans.correct ? 'qb-dot-correct' : 'qb-dot-incorrect');
    }
  });
}

// ── Events ──

function bindEvents() {
  // Choice selection
  document.getElementById('questionCard').addEventListener('click', (e) => {
    const choiceEl = e.target.closest('.qb-choice[data-label]');
    if (!choiceEl) return;

    const q = _questions[_current];
    const ans = _answers[q.id];
    if (ans?.submitted || ans?.pending) return;

    const label = choiceEl.dataset.label;
    const selected = new Set(ans?.chosen || []);
    if (!isMultipleChoice(q)) { selected.clear(); selected.add(label); }
    else if (selected.has(label)) selected.delete(label);
    else selected.add(label);
    _answers[q.id] = { ...(ans || {}), chosen: [...selected].sort() };
    renderQuestion();
  });

  // Submit answer
  document.getElementById('questionCard').addEventListener('click', async (e) => {
    if (!e.target.closest('#btnSubmit')) return;
    const q = _questions[_current];
    const ans = _answers[q.id];
    if (!ans?.chosen?.length || ans.submitted || ans.pending) return;

    const isCorrect = scoreQbankAnswer(q, ans.chosen);
    _answers[q.id] = { ...ans, pending: true };
    renderQuestion();
    try {
      const { error } = await supabase.from('qbank_user_answers').insert({
        user_id: _user.id,
        question_id: q.id,
        chosen_label: [...ans.chosen].sort().join(','),
        is_correct: isCorrect,
      });
      if (error) throw error;
      _answers[q.id] = { ...ans, submitted: true, correct: isCorrect };
    } catch (_error) {
      _answers[q.id] = { ...ans, pending: false };
      toast('答题记录保存失败', '请重试，当前选择已保留', 'err');
    }

    renderQuestion();
  });

  // Prev / Next
  document.getElementById('btnPrev').addEventListener('click', () => {
    if (_current > 0) { _current--; renderQuestion(); }
  });
  document.getElementById('btnNext').addEventListener('click', () => {
    if (_current < _questions.length - 1) { _current++; renderQuestion(); }
  });

  // Dot navigation
  document.getElementById('dotNav').addEventListener('click', (e) => {
    const dot = e.target.closest('.qb-dot');
    if (!dot) return;
    _current = parseInt(dot.dataset.idx, 10);
    renderQuestion();
  });

  // Bookmark
  document.getElementById('btnBookmark').addEventListener('click', async () => {
    const q = _questions[_current];
    try {
      if (_bookmarks.has(q.id)) {
        const { error } = await supabase.from('qbank_bookmarks').delete().eq('user_id', _user.id).eq('question_id', q.id);
        if (error) throw error;
        _bookmarks.delete(q.id);
        toast('取消收藏', q.qid || '');
      } else {
        const { error } = await supabase.from('qbank_bookmarks').insert({ user_id: _user.id, question_id: q.id });
        if (error) throw error;
        _bookmarks.add(q.id);
        toast('已收藏', q.qid || '');
      }
    } catch (_error) {
      toast('收藏操作失败', '请重试', 'err');
    }
    renderQuestion();
  });

  // End test
  document.getElementById('btnEndTest').addEventListener('click', () => {
    const answered = Object.values(_answers).filter(a => a.submitted).length;
    const correct = Object.values(_answers).filter(a => a.submitted && a.correct).length;
    const total = _questions.length;

    if (answered < total && !confirm(`你还有 ${total - answered} 道题未答，确定结束？`)) return;

    // Show summary
    const pct = answered > 0 ? Math.round((correct / answered) * 100) : 0;
    document.getElementById('questionCard').innerHTML = `
      <div style="text-align:center;padding:40px 20px">
        <h2>练习完成</h2>
        <div style="font-size:48px;font-weight:700;color:${pct >= 60 ? 'var(--ok)' : 'var(--danger)'};margin:20px 0">${pct}%</div>
        <div class="muted" style="font-size:16px">
          ${correct} / ${answered} 题正确
          ${answered < total ? `（${total - answered} 题未答）` : ''}
        </div>
        <div style="margin-top:30px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
          <button class="btn primary" id="btnReviewAll">逐题回顾</button>
          <a href="qbank.html" class="btn">返回题库</a>
        </div>
      </div>`;

    document.getElementById('btnReviewAll')?.addEventListener('click', () => {
      _current = 0;
      renderQuestion();
    });
  });

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft' && _current > 0) { _current--; renderQuestion(); }
    if (e.key === 'ArrowRight' && _current < _questions.length - 1) { _current++; renderQuestion(); }
  });
}

init().catch(() => {
  document.getElementById('questionCard').innerHTML = '<div class="note">题库加载失败，请刷新重试；暂不显示可能不完整的练习结果。</div>';
});
