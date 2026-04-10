/**
 * qbank.js
 * Landing page: 3 bank cards → select bank → practice panel.
 */

import { ensureSupabase, supabase, getCurrentUser, getUserProfile, isAdminRole, normalizeRole, toast } from './supabaseClient.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const BANKS = ['大内科', '肾内科', '考研'];
let _currentBank = '';
let _selectedSubjects = new Set();
let _selectedCount = 20;
let _allSubjects = [];
let _user = null;

async function init() {
  await ensureSupabase();
  _user = await getCurrentUser();

  // Show admin link
  if (_user) {
    const profile = await getUserProfile(_user);
    if (isAdminRole(normalizeRole(profile?.role))) {
      document.getElementById('adminLink').hidden = false;
    }
  }

  await loadBankStats();
  bindEvents();

  // Check URL for pre-selected bank
  const params = new URLSearchParams(location.search);
  const urlBank = params.get('bank');
  if (urlBank && BANKS.includes(urlBank)) {
    selectBank(urlBank);
  }
}

async function loadBankStats() {
  const { data } = await supabase
    .from('qbank_questions')
    .select('bank')
    .eq('status', 'published');

  const counts = {};
  for (const q of (data || [])) {
    counts[q.bank] = (counts[q.bank] || 0) + 1;
  }

  for (const bank of BANKS) {
    const el = document.querySelector(`[data-bank-stat="${bank}"]`);
    if (el) {
      const c = counts[bank] || 0;
      el.textContent = c > 0 ? `${c} 道题` : '即将上线';
    }
  }
}

async function selectBank(bank) {
  _currentBank = bank;
  _selectedSubjects.clear();

  // Update UI
  document.getElementById('practicePanel').hidden = false;
  document.getElementById('currentBankBadge').textContent = bank;
  document.getElementById('currentBankTitle').textContent = bank + '题库';

  // Highlight selected bank card
  document.querySelectorAll('.qb-bank-card').forEach(c => {
    c.classList.toggle('qb-bank-selected', c.dataset.bank === bank);
  });

  // Update URL
  history.replaceState(null, '', `qbank.html?bank=${encodeURIComponent(bank)}`);

  // Load data for this bank
  await Promise.all([
    loadSubjects(bank),
    _user ? loadMyProgress(_user, bank) : showLoginPrompt(),
    loadSubjectStats(_user, bank),
  ]);
}

async function loadSubjects(bank) {
  const { data } = await supabase
    .from('qbank_questions')
    .select('subject')
    .eq('status', 'published')
    .eq('bank', bank);

  const set = new Set();
  for (const q of (data || [])) set.add(q.subject);
  _allSubjects = [...set].sort();

  const container = document.getElementById('subjectPills');
  if (_allSubjects.length === 0) {
    container.innerHTML = '<div class="muted small">暂无题目</div>';
    return;
  }

  container.innerHTML = _allSubjects.map(s =>
    `<button class="btn tiny qb-pill" data-subject="${esc(s)}">${esc(s)}</button>`
  ).join('');
}

async function loadMyProgress(user, bank) {
  const el = document.getElementById('myProgress');

  // Get question IDs for this bank
  const { data: bankQuestions } = await supabase
    .from('qbank_questions')
    .select('id')
    .eq('status', 'published')
    .eq('bank', bank);

  const bankQIds = new Set((bankQuestions || []).map(q => q.id));
  const total = bankQIds.size;

  // Get user answers
  const { data: myAnswers } = await supabase
    .from('qbank_user_answers')
    .select('question_id, is_correct')
    .eq('user_id', user.id);

  const answeredSet = new Set();
  let correctCount = 0;
  const latestByQ = {};

  for (const a of (myAnswers || [])) {
    if (!bankQIds.has(a.question_id)) continue;
    answeredSet.add(a.question_id);
    latestByQ[a.question_id] = a;
  }

  for (const a of Object.values(latestByQ)) {
    if (a.is_correct) correctCount++;
  }

  const answered = answeredSet.size;
  const pct = total > 0 ? Math.round((answered / total) * 100) : 0;
  const correctPct = answered > 0 ? Math.round((correctCount / answered) * 100) : 0;

  el.innerHTML = `
    <div style="display:flex;gap:30px;flex-wrap:wrap;align-items:flex-end">
      <div>
        <div class="small muted">总进度</div>
        <div style="font-size:28px;font-weight:700">${answered}<span class="muted" style="font-size:16px"> / ${total} 题</span></div>
      </div>
      <div>
        <div class="small muted">正确率</div>
        <div style="font-size:28px;font-weight:700;color:${correctPct >= 60 ? 'var(--ok)' : 'var(--danger)'}">${correctPct}%</div>
      </div>
    </div>
    <div class="qb-progress-bar" style="margin-top:12px">
      <div class="qb-progress-fill" style="width:${pct}%"></div>
    </div>
    <div class="small muted" style="margin-top:6px">${pct}% 完成</div>
  `;
}

function showLoginPrompt() {
  document.getElementById('myProgress').innerHTML = `
    <div class="note">
      <a href="login.html?next=qbank.html" style="text-decoration:underline">登录</a> 后可查看个人进度、保存答题记录。
    </div>`;
}

async function loadSubjectStats(user, bank) {
  const el = document.getElementById('subjectStats');

  const { data: questions } = await supabase
    .from('qbank_questions')
    .select('id, subject')
    .eq('status', 'published')
    .eq('bank', bank);

  if (!questions || questions.length === 0) {
    el.innerHTML = '<div class="muted small">暂无题目</div>';
    return;
  }

  const subjectMap = {};
  for (const q of questions) {
    if (!subjectMap[q.subject]) subjectMap[q.subject] = { total: 0, ids: [] };
    subjectMap[q.subject].total++;
    subjectMap[q.subject].ids.push(q.id);
  }

  let userStats = {};
  if (user) {
    const { data: ans } = await supabase
      .from('qbank_user_answers')
      .select('question_id, is_correct')
      .eq('user_id', user.id);

    const latest = {};
    for (const a of (ans || [])) {
      latest[a.question_id] = a;
    }

    for (const [subj, info] of Object.entries(subjectMap)) {
      let done = 0, correct = 0;
      for (const qid of info.ids) {
        if (latest[qid]) {
          done++;
          if (latest[qid].is_correct) correct++;
        }
      }
      userStats[subj] = { done, correct };
    }
  }

  const subjects = Object.entries(subjectMap).sort((a, b) => b[1].total - a[1].total);

  el.innerHTML = `<div class="grid cols-2" style="gap:10px">
    ${subjects.map(([subj, info]) => {
      const us = userStats[subj] || { done: 0, correct: 0 };
      const pct = us.done > 0 ? Math.round((us.correct / us.done) * 100) : 0;
      const donePct = info.total > 0 ? Math.round((us.done / info.total) * 100) : 0;
      return `<div class="card soft" style="padding:14px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <b>${esc(subj)}</b>
          <span class="small muted">${info.total} 题</span>
        </div>
        ${user ? `<div class="qb-progress-bar" style="margin-top:8px;height:4px">
          <div class="qb-progress-fill" style="width:${donePct}%"></div>
        </div>
        <div class="small muted" style="margin-top:4px">已做 ${us.done}/${info.total} · 正确率 ${us.done > 0 ? pct + '%' : '--'}</div>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function bindEvents() {
  // Bank card click
  document.getElementById('bankCards').addEventListener('click', (e) => {
    const card = e.target.closest('.qb-bank-card');
    if (!card) return;
    selectBank(card.dataset.bank);
  });

  // Change bank button
  document.getElementById('btnChangeBank').addEventListener('click', () => {
    document.getElementById('practicePanel').hidden = true;
    document.querySelectorAll('.qb-bank-card').forEach(c => c.classList.remove('qb-bank-selected'));
    _currentBank = '';
    history.replaceState(null, '', 'qbank.html');
  });

  // Subject pill toggle
  document.getElementById('subjectPills').addEventListener('click', (e) => {
    const pill = e.target.closest('.qb-pill');
    if (!pill) return;
    const subj = pill.dataset.subject;
    if (_selectedSubjects.has(subj)) {
      _selectedSubjects.delete(subj);
      pill.classList.remove('qb-pill-active');
    } else {
      _selectedSubjects.add(subj);
      pill.classList.add('qb-pill-active');
    }
  });

  // Count buttons
  document.querySelectorAll('.qb-count-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.qb-count-btn').forEach(b => b.classList.remove('qb-count-active'));
      btn.classList.add('qb-count-active');
      _selectedCount = parseInt(btn.dataset.count, 10);
    });
  });

  // Start button
  document.getElementById('btnStart').addEventListener('click', () => {
    if (!_currentBank) { toast('请先选择题库', '', 'err'); return; }

    const params = new URLSearchParams();
    params.set('bank', _currentBank);
    if (_selectedSubjects.size > 0) {
      params.set('subjects', [..._selectedSubjects].join(','));
    }
    if (_selectedCount > 0) {
      params.set('count', String(_selectedCount));
    } else {
      params.set('count', '999');
    }
    const filter = document.querySelector('input[name="qfilter"]:checked')?.value || 'all';
    params.set('filter', filter);

    location.href = `qbank-test.html?${params.toString()}`;
  });
}

init();
