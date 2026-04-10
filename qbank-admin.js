/**
 * qbank-admin.js
 * Admin interface for batch question import.
 */

import { ensureSupabase, supabase, getCurrentUser, getUserProfile, isAdminRole, normalizeRole, toast } from './supabaseClient.js';
import { parseQuestions } from './qbank-parser.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

let _parsedQuestions = [];

async function init() {
  await ensureSupabase();

  // Auth gate
  const user = await getCurrentUser();
  if (!user) { location.replace('login.html?next=qbank-admin.html'); return; }
  const profile = await getUserProfile(user);
  if (!isAdminRole(normalizeRole(profile?.role))) {
    toast('权限不足', '仅管理员可访问题库管理。', 'err');
    location.replace('qbank.html');
    return;
  }

  loadStats();
  bindEvents();
}

async function loadStats() {
  const statsEl = document.getElementById('qbankStats');
  if (!supabase) { statsEl.innerHTML = '<div class="muted small">数据库未连接</div>'; return; }

  const { data, error } = await supabase
    .from('qbank_questions')
    .select('bank, subject, question_number')
    .eq('status', 'published')
    .order('question_number', { ascending: true });

  if (error) {
    statsEl.innerHTML = `<div class="muted small">加载失败：${esc(error.message)}</div>`;
    return;
  }

  const total = data?.length || 0;
  const byBank = {};
  const bySubject = {};
  let maxNum = 0;
  for (const q of (data || [])) {
    byBank[q.bank] = (byBank[q.bank] || 0) + 1;
    bySubject[q.subject] = (bySubject[q.subject] || 0) + 1;
    if (q.question_number > maxNum) maxNum = q.question_number;
  }

  const bankHtml = Object.entries(byBank)
    .sort((a, b) => b[1] - a[1])
    .map(([b, c]) => `<span class="badge" style="margin:3px;border-color:var(--brand)">${esc(b)} ${c}</span>`)
    .join('');

  const subjectHtml = Object.entries(bySubject)
    .sort((a, b) => b[1] - a[1])
    .map(([s, c]) => `<span class="badge" style="margin:3px">${esc(s)} ${c}</span>`)
    .join('');

  statsEl.innerHTML = `
    <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:center">
      <div><b style="font-size:24px">${total}</b> <span class="muted">道题目</span></div>
      <div class="muted">最大编号：第${maxNum}题</div>
    </div>
    <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px">${bankHtml}</div>
    <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">${subjectHtml || '<span class="muted small">暂无题目</span>'}</div>
  `;
}

async function loadQuestionList() {
  const listEl = document.getElementById('qbankList');
  if (!supabase) return;

  const { data, error } = await supabase
    .from('qbank_questions')
    .select('id, question_number, bank, subject, stem, question_text, choices, status')
    .order('question_number', { ascending: true });

  if (error) {
    listEl.innerHTML = `<div class="muted small">加载失败</div>`;
    return;
  }

  if (!data || data.length === 0) {
    listEl.innerHTML = `<div class="muted small">暂无题目</div>`;
    return;
  }

  listEl.innerHTML = data.map(q => {
    const correct = (q.choices || []).find(c => c.correct);
    const stemPreview = (q.stem || '').substring(0, 60);
    return `
      <div style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,.08);display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div style="flex:1;min-width:0">
          <div>
            <b>第${q.question_number}题</b>
            <span class="badge" style="margin-left:6px;font-size:11px;border-color:var(--brand)">${esc(q.bank || '肾内科')}</span>
            <span class="badge" style="margin-left:4px;font-size:11px">${esc(q.subject)}</span>
            ${q.status !== 'published' ? `<span class="badge" style="margin-left:4px;border-color:var(--danger);color:var(--danger);font-size:11px">${esc(q.status)}</span>` : ''}
          </div>
          <div class="small muted" style="margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(stemPreview)}…</div>
        </div>
        <div style="flex-shrink:0;display:flex;gap:6px;align-items:center">
          <span class="small" style="color:var(--ok)">${correct ? correct.label : '?'}</span>
          <button class="btn tiny danger" data-delete-q="${q.id}" data-qnum="${q.question_number}">删除</button>
        </div>
      </div>`;
  }).join('');
}

function bindEvents() {
  // Preview button
  document.getElementById('btnPreview').addEventListener('click', () => {
    const raw = document.getElementById('pasteArea').value;
    const { questions, errors } = parseQuestions(raw);
    _parsedQuestions = questions;

    const previewArea = document.getElementById('previewArea');
    previewArea.hidden = false;

    // Errors
    const errEl = document.getElementById('previewErrors');
    if (errors.length > 0) {
      errEl.innerHTML = errors.map(e => `<div style="color:var(--danger)" class="small">⚠ ${esc(e)}</div>`).join('');
    } else {
      errEl.innerHTML = '';
    }

    // Count badge
    document.getElementById('previewCount').textContent = `解析成功 ${questions.length} 道题`;

    // Render preview cards
    const listEl = document.getElementById('previewList');
    if (questions.length === 0) {
      listEl.innerHTML = '<div class="muted small">未解析到任何题目，请检查格式。</div>';
      document.getElementById('btnSave').hidden = true;
      return;
    }

    listEl.innerHTML = questions.map((q, i) => {
      const correctChoice = q.choices.find(c => c.correct);
      return `
        <div class="card soft" style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
            <div>
              <b>第${q.question_number}题</b>
              <span class="badge" style="margin-left:6px">${esc(q.subject)}</span>
            </div>
            <span style="color:var(--ok);font-weight:600">答案：${correctChoice?.label || '?'}</span>
          </div>
          <div class="small" style="margin-top:8px;color:var(--muted)">
            ${esc(q.stem).substring(0, 120)}…
          </div>
          <div class="small" style="margin-top:6px">
            ${q.choices.map(c => `<span style="margin-right:10px;${c.correct ? 'color:var(--ok);font-weight:600' : ''}">${c.label}. ${esc(c.text).substring(0, 30)}</span>`).join('')}
          </div>
          <div class="small muted" style="margin-top:6px">
            解析：${esc(q.explanation).substring(0, 80)}…
          </div>
        </div>`;
    }).join('');

    document.getElementById('btnSave').hidden = false;
  });

  // Clear button
  document.getElementById('btnClear').addEventListener('click', () => {
    document.getElementById('pasteArea').value = '';
    document.getElementById('previewArea').hidden = true;
    _parsedQuestions = [];
  });

  // Save button
  document.getElementById('btnSave').addEventListener('click', saveQuestions);

  // Toggle list
  let listVisible = false;
  document.getElementById('btnToggleList').addEventListener('click', () => {
    listVisible = !listVisible;
    const listEl = document.getElementById('qbankList');
    const btn = document.getElementById('btnToggleList');
    if (listVisible) {
      listEl.hidden = false;
      btn.textContent = '收起列表';
      loadQuestionList();
    } else {
      listEl.hidden = true;
      btn.textContent = '展开列表';
    }
  });

  // Delete question (event delegation)
  document.getElementById('qbankList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-delete-q]');
    if (!btn) return;
    const id = btn.dataset.deleteQ;
    const qnum = btn.dataset.qnum;
    if (!confirm(`确定删除第${qnum}题？此操作不可撤销。`)) return;

    // Delete related records first (foreign key constraints)
    await supabase.from('qbank_user_answers').delete().eq('question_id', id);
    await supabase.from('qbank_bookmarks').delete().eq('question_id', id);

    const { error } = await supabase.from('qbank_questions').delete().eq('id', id);
    if (error) {
      toast('删除失败', error.message, 'err');
    } else {
      toast('已删除', `第${qnum}题已删除。`);
      loadQuestionList();
      loadStats();
    }
  });
}

async function saveQuestions() {
  if (_parsedQuestions.length === 0) {
    toast('无题目', '请先预览解析题目。', 'err');
    return;
  }

  const btn = document.getElementById('btnSave');
  btn.disabled = true;
  btn.textContent = '入库中…';

  const user = await getCurrentUser();
  const selectedBank = document.querySelector('input[name="bank"]:checked')?.value || '肾内科';
  let successCount = 0;
  const errors = [];

  for (const q of _parsedQuestions) {
    const row = {
      question_number: q.question_number,
      bank: selectedBank,
      subject: q.subject,
      difficulty: q.difficulty,
      stem: q.stem,
      question_text: q.question_text,
      choices: q.choices,
      explanation: q.explanation,
      choice_explanations: q.choice_explanations,
      references: q.references,
      status: 'published',
      author_id: user?.id || null,
    };

    const { error } = await supabase.from('qbank_questions').upsert(row, { onConflict: 'bank,question_number' });
    if (error) {
      errors.push(`第${q.question_number}题：${error.message}`);
    } else {
      successCount++;
    }
  }

  btn.disabled = false;
  btn.textContent = '确认入库';

  if (errors.length > 0) {
    // Show real error (bypass toast sanitization)
    const errMsg = `成功 ${successCount} 道，失败 ${errors.length} 道。\n${errors.join('\n')}`;
    alert(errMsg);
    toast('部分失败', errors[0], 'err');
  } else {
    toast('入库成功', `${successCount} 道题目已入库！`);
    document.getElementById('pasteArea').value = '';
    document.getElementById('previewArea').hidden = true;
    _parsedQuestions = [];
    loadStats();
  }
}

init();
