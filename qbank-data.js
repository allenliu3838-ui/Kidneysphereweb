/** Read every visible row; callers must supply a fresh, deterministically ordered query. */
export async function readAllQbankRows(makeQuery, pageSize = 500) {
  const rows = [];
  while (true) {
    const { data, error } = await makeQuery().range(rows.length, rows.length + pageSize - 1);
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('题库返回数据格式异常');
    if (data.length === 0) return rows;
    rows.push(...data);
    // Continue even after a short page: the server's row cap may be below pageSize.
  }
}

/** Timestamp, then ID, define a stable latest attempt even across pagination boundaries. */
export function latestQbankAnswers(answers) {
  const latest = new Map();
  for (const answer of answers) {
    const previous = latest.get(answer.question_id);
    const time = Date.parse(answer.created_at);
    const previousTime = previous ? Date.parse(previous.created_at) : -Infinity;
    if (!Number.isFinite(time)) throw new Error('答题记录缺少有效时间');
    if (!previous || time > previousTime ||
        (time === previousTime && String(answer.id) > String(previous.id))) {
      latest.set(answer.question_id, answer);
    }
  }
  return latest;
}

export function isMultipleChoice(question) {
  return /多选|多项/.test(question?.question_text || '') || /多选题|多项选择题/.test(question?.stem || '');
}

/** Never guess an answer key or silently treat a malformed single-choice item as multi-select. */
export function qbankQuestionProblem(question) {
  const choices = question?.choices;
  if (!String(question?.stem || question?.question_text || '').trim()) return '缺少题干';
  if (!Array.isArray(choices) || choices.length < 2) return '至少需要两个选项';
  const labels = new Set();
  for (const choice of choices) {
    if (!choice || typeof choice.label !== 'string' || !choice.label.trim() ||
        typeof choice.text !== 'string' || !choice.text.trim()) return '选项标签或内容为空';
    if (labels.has(choice.label)) return '选项标签重复';
    labels.add(choice.label);
    if (typeof choice.correct !== 'boolean') return '选项正确性必须明确标为 true 或 false';
  }
  const correctCount = choices.filter(choice => choice.correct === true).length;
  if (correctCount === 0) return '缺少正确答案';
  if (!isMultipleChoice(question) && correctCount !== 1) return '单选题必须且只能有一个正确答案';
  return '';
}

export function scoreQbankAnswer(question, chosenLabels) {
  const problem = qbankQuestionProblem(question);
  if (problem) throw new Error(problem);
  const expected = question.choices.filter(choice => choice.correct === true).map(choice => choice.label);
  const selected = new Set(chosenLabels);
  return selected.size === expected.length && expected.every(label => selected.has(label));
}
