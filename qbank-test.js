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

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ── State ──
let _user = null;
let _questions = [];    // loaded question objects
let _answers = {};      // questionId → { chosen, correct, submitted }
let _bookmarks = new Set();
let _current = 0;       // current index

async function init() {
  await ensureSupabase();
  _user = await getCurrentUser();
  if (!_user) { location.replace('login.html?next=' + encodeURIComponent(location.pathname + location.search)); return; }

  const params = new URLSearchParams(location.search);
  const bank = params.get('bank') || '';
  const subjects = params.get('subjects') ? params.get('subjects').split(',').map(s => s.trim()).filter(Boolean) : [];
  const count = Math.min(100, Math.max(1, parseInt(params.get('count') || '20', 10)));
  const filter = params.get('filter') || 'all';

  await loadQuestions(bank, subjects, count, filter);
  await loadBookmarks();

  if (_questions.length === 0) {
    document.getElementById('questionCard').innerHTML = `
      <div style="text-align:center;padding:60px 20px">
        <h3>没有找到符合条件的题目</h3>
        <p class="muted">请返回题库重新选择筛选条件。</p>
        <a href="qbank.html" class="btn primary" style="margin-top:16px">返回题库</a>
      </div>`;
    return;
  }

  renderQuestion();
  renderDots();
  bindEvents();
}

async function loadQuestions(bank, subjects, count, filter) {
  let query = supabase
    .from('qbank_questions')
    .select('*')
    .eq('status', 'published');

  if (bank) {
    query = query.eq('bank', bank);
  }

  if (subjects.length > 0) {
    query = query.in('subject', subjects);
  }

  // For filtered modes, we need user's answer history
  if (filter === 'unused' || filter === 'incorrect' || filter === 'bookmarked') {
    // Fetch all question IDs first, then filter
    const { data: allQ } = await query.order('question_number');
    if (!allQ || allQ.length === 0) { _questions = []; return; }

    if (filter === 'bookmarked') {
      const { data: bm } = await supabase
        .from('qbank_bookmarks')
        .select('question_id')
        .eq('user_id', _user.id);
      const bmSet = new Set((bm || []).map(b => b.question_id));
      _questions = allQ.filter(q => bmSet.has(q.id));
    } else {
      const { data: ans } = await supabase
        .from('qbank_user_answers')
        .select('question_id, is_correct')
        .eq('user_id', _user.id);

      if (filter === 'unused') {
        const answered = new Set((ans || []).map(a => a.question_id));
        _questions = allQ.filter(q => !answered.has(q.id));
      } else if (filter === 'incorrect') {
        // Questions where the most recent answer was incorrect
        const incorrectIds = new Set();
        const latest = {};
        for (const a of (ans || [])) {
          if (!latest[a.question_id] || a.created_at > latest[a.question_id].created_at) {
            latest[a.question_id] = a;
          }
        }
        for (const [qid, a] of Object.entries(latest)) {
          if (!a.is_correct) incorrectIds.add(qid);
        }
        _questions = allQ.filter(q => incorrectIds.has(q.id));
      }
    }

    // Shuffle and limit
    shuffle(_questions);
    _questions = _questions.slice(0, count);
  } else {
    // "all" — random selection
    const { data } = await query.order('question_number');
    _questions = data || [];
    shuffle(_questions);
    _questions = _questions.slice(0, count);
  }
}

async function loadBookmarks() {
  const { data } = await supabase
    .from('qbank_bookmarks')
    .select('question_id')
    .eq('user_id', _user.id);
  _bookmarks = new Set((data || []).map(b => b.question_id));
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
  let html = '';

  // Question number + subject badge
  html += `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:16px">
    <div>
      <span class="badge">第${q.question_number}题</span>
      <span class="badge" style="margin-left:6px">${esc(q.subject)}</span>
    </div>
  </div>`;

  // Stem
  html += `<div class="qb-stem">${esc(q.stem).replace(/\n/g, '<br>')}</div>`;

  // Question text
  if (q.question_text) {
    html += `<div class="qb-question-text">${esc(q.question_text).replace(/\n/g, '<br>')}</div>`;
  }

  // Choices
  html += `<div class="qb-choices">`;
  for (const c of (q.choices || [])) {
    let cls = 'qb-choice';
    let icon = '';

    if (submitted) {
      if (c.correct) {
        cls += ' qb-correct';
        icon = '✓';
      } else if (ans.chosen === c.label) {
        cls += ' qb-incorrect';
        icon = '✗';
      } else {
        cls += ' qb-dimmed';
      }
    } else {
      if (ans?.chosen === c.label) {
        cls += ' qb-selected';
      }
    }

    html += `<div class="${cls}" data-label="${c.label}" ${submitted ? '' : 'role="button" tabindex="0"'}>
      <span class="qb-choice-icon">${icon || c.label}</span>
      <span class="qb-choice-text">${esc(c.text)}</span>
    </div>`;
  }
  html += `</div>`;

  // Submit button (only if not yet submitted)
  if (!submitted) {
    html += `<div style="text-align:center;margin-top:20px">
      <button class="btn primary" id="btnSubmit" ${ans?.chosen ? '' : 'disabled'}>提交答案</button>
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
        <div>${esc(q.explanation).replace(/\n/g, '<br>')}</div>
      </div>`;
    }

    // Per-choice explanations
    if (q.choice_explanations && q.choice_explanations.length > 0) {
      html += `<div class="qb-choice-explanations">`;
      for (const ce of q.choice_explanations) {
        const choice = (q.choices || []).find(c => c.label === ce.label);
        const isRight = choice?.correct;
        html += `<div class="qb-ce-item ${isRight ? 'qb-ce-correct' : 'qb-ce-wrong'}">
          <span class="qb-ce-label">${ce.label}.</span>
          <span>${esc(ce.text)}</span>
        </div>`;
      }
      html += `</div>`;
    }

    // References
    if (q.references) {
      html += `<div class="qb-references">
        <div class="qb-explanation-title">参考文献</div>
        <div class="small">${esc(q.references).replace(/\n/g, '<br>')}</div>
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
    if (ans?.submitted) return; // already submitted

    const label = choiceEl.dataset.label;
    _answers[q.id] = { ...(ans || {}), chosen: label };
    renderQuestion();
  });

  // Submit answer
  document.getElementById('questionCard').addEventListener('click', async (e) => {
    if (!e.target.closest('#btnSubmit')) return;
    const q = _questions[_current];
    const ans = _answers[q.id];
    if (!ans?.chosen || ans.submitted) return;

    const correct = (q.choices || []).find(c => c.correct);
    const isCorrect = correct?.label === ans.chosen;

    _answers[q.id] = { ...ans, submitted: true, correct: isCorrect };

    // Save to database
    try {
      await supabase.from('qbank_user_answers').insert({
        user_id: _user.id,
        question_id: q.id,
        chosen_label: ans.chosen,
        is_correct: isCorrect,
      });
    } catch (_e) { /* ignore */ }

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
    if (_bookmarks.has(q.id)) {
      await supabase.from('qbank_bookmarks').delete().eq('user_id', _user.id).eq('question_id', q.id);
      _bookmarks.delete(q.id);
      toast('取消收藏', `第${q.question_number}题`);
    } else {
      await supabase.from('qbank_bookmarks').insert({ user_id: _user.id, question_id: q.id });
      _bookmarks.add(q.id);
      toast('已收藏', `第${q.question_number}题`);
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

init();
