import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const load = name => import(`data:text/javascript;base64,${Buffer.from(read(name)).toString('base64')}`);
const helpers = await load('qbank-data.js');
const { readAllQbankRows, latestQbankAnswers, qbankQuestionProblem, scoreQbankAnswer } = helpers;
const { parseQuestions } = await load('qbank-parser.js');

const validText = `第1题（测试）
合成病例背景，保留题干。
请选择一个选项？
A. 选项一
B. 选项二 *
C. 选项三
正确答案：B。
解析：仅用于软件测试，不包含医学建议。`;
const question = (id, extra = {}) => ({ id, bank: '肾内科', subject: '测试', status: 'published',
  stem: '合成病例', question_text: '请选择？', choices: [
    { label: 'A', text: '一', correct: true }, { label: 'B', text: '二', correct: false },
    { label: 'C', text: '三', correct: false },
  ], ...extra });

test('parser preserves vignette and question, and accepts matching declared/asterisk answer', () => {
  const { questions, errors } = parseQuestions(validText);
  assert.deepEqual(errors, []);
  assert.equal(questions[0].stem, '合成病例背景，保留题干。');
  assert.equal(questions[0].question_text, '请选择一个选项？');
  assert.deepEqual(questions[0].choices.filter(c => c.correct).map(c => c.label), ['B']);
});

test('parser preserves nested biochemical parentheses in subjects instead of leaking the suffix into the stem', () => {
  const subject = '电解质-低PTH高钙：1,25(OH)2D升高';
  const result = parseQuestions(validText.replace('（测试）', `（${subject}）`));
  assert.deepEqual(result.errors, []);
  assert.equal(result.questions[0].subject, subject);
  assert.equal(result.questions[0].stem, '合成病例背景，保留题干。');
});

test('parser rejects contradictory, absent, duplicated, empty and multiple single-choice keys', () => {
  for (const text of [
    validText.replace('A. 选项一', 'A. 选项一 *'),
    validText.replace('正确答案：B。', '正确答案：E。').replace('二 *', '二'),
    validText.replace('C. 选项三', 'B. 重复标签'),
    validText.replace('C. 选项三', 'C. '),
    validText.replace('正确答案：B。', '正确答案：A、B。'),
    validText + '\n正确答案：A。',
  ]) {
    const result = parseQuestions(text);
    assert.equal(result.questions.length, 0, text);
    assert.equal(result.errors.length, 1, text);
  }
});

test('pagination reads past 1,000 and a server cap smaller than the requested page', async () => {
  const rows = Array.from({ length: 1207 }, (_, id) => ({ id }));
  const result = await readAllQbankRows(() => ({ range: async (from, to) => ({
    data: rows.slice(from, Math.min(to + 1, from + 137)), error: null,
  }) }));
  assert.deepEqual(result, rows);
});

test('a later page error rejects instead of returning a partial practice pool', async () => {
  let calls = 0;
  await assert.rejects(readAllQbankRows(() => ({ range: async () => ++calls === 1
    ? { data: [{ id: 1 }], error: null }
    : { data: null, error: new Error('network failed') } })), /network failed/);
});

test('latest answers use timestamps and a stable ID tie-break regardless of input order', () => {
  const older = { id: 'a', question_id: 'q', is_correct: false, created_at: '2026-09-01T00:00:00Z' };
  const newer = { ...older, id: 'b', is_correct: true, created_at: '2026-09-02T00:00:00Z' };
  const tied = { ...newer, id: 'c', is_correct: false };
  assert.equal(latestQbankAnswers([newer, older]).get('q').is_correct, true);
  assert.equal(latestQbankAnswers([tied, newer, older]).get('q').id, 'c');
  assert.throws(() => latestQbankAnswers([{ question_id: 'q' }]), /时间/);
});

test('explicit multi-select requires the exact set, while malformed single-choice keys cannot be scored', () => {
  const q = question('multi', { question_text: '哪些正确（多选题）？' });
  q.choices[1].correct = true;
  assert.equal(qbankQuestionProblem(q), '');
  assert.equal(scoreQbankAnswer(q, ['B', 'A']), true);
  for (const chosen of [['A'], ['B'], ['A', 'B', 'C']]) assert.equal(scoreQbankAnswer(q, chosen), false);
  const single = { ...q, question_text: '哪个正确？' };
  assert.match(qbankQuestionProblem(single), /只能有一个/);
  assert.throws(() => scoreQbankAnswer(single, ['A']), /只能有一个/);
  assert.match(qbankQuestionProblem(question('bad', { choices: [
    { label: 'A', text: '一', correct: 'false' }, { label: 'B', text: '二', correct: true },
  ] })), /true 或 false/);
});

function fakeSupabase(tables, insertError = null) {
  const writes = [];
  return { writes, from(table) {
    let selected = '*';
    let filters = [];
    let orders = [];
    const query = {
      select(fields) { selected = fields; return this; },
      eq(key, value) { filters.push(row => row[key] === value); return this; },
      in(key, values) { filters.push(row => values.includes(row[key])); return this; },
      order(key, { ascending = true } = {}) { orders.push([key, ascending]); return this; },
      async range(from, to) {
        let rows = (tables[table] || []).filter(row => filters.every(fn => fn(row)));
        rows.sort((a, b) => { for (const [key, asc] of orders) {
          if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (asc ? 1 : -1);
        } return 0; });
        rows = rows.slice(from, Math.min(to + 1, from + 137));
        // Projection is intentional: tests fail if callers forget created_at again.
        if (selected !== '*') rows = rows.map(row => Object.fromEntries(selected.split(',').map(s => {
          const key = s.trim(); return [key, row[key]];
        })));
        return { data: rows, error: null };
      },
      async insert(row) { writes.push(row); return { error: insertError }; },
    };
    return query;
  } };
}

function practiceContext(supabase) {
  const nodes = new Map();
  const notices = [];
  const document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', events: {}, addEventListener(type, fn) {
      (this.events[type] ||= []).push(fn);
    } });
    return nodes.get(id);
  }, querySelectorAll() { return []; }, addEventListener() {} };
  const ctx = vm.createContext({ ...helpers, supabase, document, toast: (...args) => notices.push(args) });
  const source = read('qbank-test.js').replace(/^import .+;\n/gm, '').replace(/\ninit\(\)\.catch\([\s\S]*$/, '');
  vm.runInContext(source + '\n_user = {id: "u"};', ctx);
  return { ctx, nodes, notices, document };
}

test('practice filters include questions/bookmarks beyond row 1,000 and use the most recent answer', async () => {
  const questions = Array.from({ length: 1207 }, (_, i) => question(`q${String(i).padStart(4, '0')}`));
  const answers = Array.from({ length: 1100 }, (_, i) => ({ id: `old${i}`, user_id: 'u', question_id: 'q0000',
    is_correct: false, created_at: '2026-01-01T00:00:00Z' }));
  answers.push({ id: 'latest', user_id: 'u', question_id: 'q0000', is_correct: true, created_at: '2026-09-01T00:00:00Z' },
    { id: 'wrong', user_id: 'u', question_id: 'q1206', is_correct: false, created_at: '2026-09-01T00:00:00Z' });
  const bookmarks = questions.map(q => ({ id: q.id, question_id: q.id, user_id: 'u' }));
  const { ctx } = practiceContext(fakeSupabase({ qbank_questions: questions, qbank_user_answers: answers, qbank_bookmarks: bookmarks }));
  await vm.runInContext('loadBookmarks()', ctx);
  assert.equal(vm.runInContext('_bookmarks.size', ctx), 1207);
  await vm.runInContext('loadQuestions("肾内科", [], 20, "incorrect")', ctx);
  assert.deepEqual(Array.from(vm.runInContext('_questions.map(q => q.id)', ctx)), ['q1206']);
  await vm.runInContext('loadQuestions("肾内科", [], 2000, "unused")', ctx);
  assert.equal(vm.runInContext('_questions.length', ctx), 1205);
  assert.equal(vm.runInContext('_questions.some(q => q.id === "q1205")', ctx), true);
});

test('multi-select UI persists a sorted answer set and does not mark failed saves as submitted', async () => {
  for (const error of [null, new Error('save failed')]) {
    const db = fakeSupabase({}, error);
    const { ctx, document, notices } = practiceContext(db);
    const q = question('multi', { question_text: '哪些正确（多选题）？' });
    q.choices[1].correct = true;
    ctx.fixtureQuestion = q;
    vm.runInContext('_questions = [fixtureQuestion]; bindEvents();', ctx);
    const card = document.getElementById('questionCard');
    for (const label of ['B', 'A']) card.events.click[0]({ target: { closest: () => ({ dataset: { label } }) } });
    assert.match(card.innerHTML, /多选题/);
    await card.events.click[1]({ target: { closest: () => ({}) } });
    assert.equal(db.writes[0].chosen_label, 'A,B');
    assert.equal(db.writes[0].is_correct, true);
    assert.equal(vm.runInContext('!!_answers.multi.submitted', ctx), !error);
    assert.equal(notices.length, error ? 1 : 0);
  }
});
