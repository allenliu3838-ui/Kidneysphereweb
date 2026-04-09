/**
 * qbank-parser.js
 *
 * Parses pasted question text into structured question objects.
 *
 * Expected format per question:
 *
 *   第X题（科目）
 *
 *   <stem text>
 *
 *   A. choice text
 *   B. choice text *        ← asterisk marks correct answer
 *   C. choice text
 *   D. choice text
 *   E. choice text
 *
 *   正确答案：X。
 *
 *   解析：
 *   <explanation text>
 *
 *   A. per-choice explanation...
 *   B. per-choice explanation...
 *   ...
 *
 *   参考文献：
 *   <references>
 */

/**
 * Parse a block of pasted text into an array of question objects.
 * @param {string} raw - The full pasted text
 * @returns {{ questions: Array, errors: string[] }}
 */
export function parseQuestions(raw) {
  if (!raw || !raw.trim()) return { questions: [], errors: ['输入为空'] };

  const errors = [];

  // Split by "第X题" pattern
  // Match: 第1题（心血管）  or  第12题（呼吸/重症）  etc.
  const splitRe = /(?=第\s*\d+\s*题\s*[（(])/;
  const blocks = raw.split(splitRe).filter(b => b.trim());

  const questions = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim();
    if (!block) continue;

    try {
      const q = parseSingleQuestion(block);
      questions.push(q);
    } catch (e) {
      errors.push(`第${i + 1}块解析失败: ${e.message}`);
    }
  }

  return { questions, errors };
}

/**
 * Parse a single question block.
 */
function parseSingleQuestion(block) {
  // 1. Extract question number and subject from header
  const headerRe = /^第\s*(\d+)\s*题\s*[（(]\s*(.+?)\s*[）)]/;
  const headerMatch = block.match(headerRe);
  if (!headerMatch) {
    throw new Error('未找到题目标题（格式：第X题（科目））');
  }

  const questionNumber = parseInt(headerMatch[1], 10);
  const subject = headerMatch[2].trim();

  // Remove header line
  let rest = block.replace(headerRe, '').trim();

  // 2. Split at "正确答案：" to separate stem+choices from answer+explanation
  const answerSplitRe = /正确答案[：:]\s*([A-Ea-e])\s*[。.]/;
  const answerMatch = rest.match(answerSplitRe);
  if (!answerMatch) {
    throw new Error(`第${questionNumber}题：未找到"正确答案：X。"`);
  }

  const correctLabel = answerMatch[1].toUpperCase();
  const answerIdx = rest.indexOf(answerMatch[0]);
  const stemAndChoices = rest.substring(0, answerIdx).trim();
  const afterAnswer = rest.substring(answerIdx + answerMatch[0].length).trim();

  // 3. Extract choices from stemAndChoices
  // Choices start with A. B. C. D. E. at the beginning of a line
  const choiceRe = /^([A-E])\.\s+/m;
  const choiceLineRe = /^([A-E])\.\s+(.+)/gm;

  // Find where choices start
  const firstChoiceMatch = stemAndChoices.match(/^([A-E])\.\s+/m);
  if (!firstChoiceMatch) {
    throw new Error(`第${questionNumber}题：未找到选项（A. B. C. ...）`);
  }

  const firstChoiceIdx = stemAndChoices.indexOf(firstChoiceMatch[0]);
  const stemRaw = stemAndChoices.substring(0, firstChoiceIdx).trim();
  const choicesRaw = stemAndChoices.substring(firstChoiceIdx).trim();

  // 4. Separate stem into vignette and question sentence
  // The question sentence is usually the last line/sentence ending with ？
  const stemLines = stemRaw.split('\n').map(l => l.trim()).filter(Boolean);
  let stem = '';
  let questionText = '';

  // Look for the last line ending with ？
  const lastQuestionIdx = stemLines.findLastIndex(l => l.endsWith('？') || l.endsWith('?'));
  if (lastQuestionIdx >= 0) {
    stem = stemLines.slice(0, lastQuestionIdx).join('\n');
    questionText = stemLines.slice(lastQuestionIdx).join('\n');
  } else {
    stem = stemLines.join('\n');
    questionText = '';
  }

  // 5. Parse individual choices
  const choices = [];
  const choiceBlocks = choicesRaw.split(/(?=^[A-E]\.\s+)/m).filter(Boolean);

  for (const cb of choiceBlocks) {
    const m = cb.match(/^([A-E])\.\s+(.+)/s);
    if (!m) continue;
    const label = m[1];
    let text = m[2].trim();
    // Check for asterisk marking correct answer (alternative to 正确答案 line)
    const hasAsterisk = text.endsWith('*');
    if (hasAsterisk) text = text.slice(0, -1).trim();

    choices.push({
      label,
      text,
      correct: label === correctLabel || hasAsterisk,
    });
  }

  // Ensure exactly one correct answer
  const correctCount = choices.filter(c => c.correct).length;
  if (correctCount === 0 && choices.length > 0) {
    // Fall back: mark the one from 正确答案
    const found = choices.find(c => c.label === correctLabel);
    if (found) found.correct = true;
  }

  // 6. Parse explanation and per-choice explanations
  let explanation = '';
  let choiceExplanations = [];
  let references = '';

  // Split afterAnswer at 参考文献
  const refRe = /参考文献[：:]/;
  const refMatch = afterAnswer.match(refRe);
  let explanationBlock = afterAnswer;
  if (refMatch) {
    const refIdx = afterAnswer.indexOf(refMatch[0]);
    explanationBlock = afterAnswer.substring(0, refIdx).trim();
    references = afterAnswer.substring(refIdx + refMatch[0].length).trim();
  }

  // Remove leading 解析：
  explanationBlock = explanationBlock.replace(/^解析[：:]\s*/, '').trim();

  // Try to split explanation into general explanation + per-choice explanations
  // Per-choice explanations start with "A." or "A " at the beginning of a line after some general text
  const choiceExplRe = /^([A-E])[.\s、]\s*/m;
  const firstExplChoice = explanationBlock.match(new RegExp(`^([A-E])[.、．]\\s*`, 'm'));

  if (firstExplChoice) {
    const explIdx = explanationBlock.indexOf(firstExplChoice[0]);
    // Only split if there's some general explanation before the first choice explanation
    if (explIdx > 20) {
      explanation = explanationBlock.substring(0, explIdx).trim();
      const choiceExplBlock = explanationBlock.substring(explIdx);

      // Parse each choice explanation
      const ceBlocks = choiceExplBlock.split(/(?=^[A-E][.、．]\s*)/m).filter(Boolean);
      for (const ce of ceBlocks) {
        const cm = ce.match(/^([A-E])[.、．]\s*(.*)/s);
        if (cm) {
          choiceExplanations.push({
            label: cm[1],
            text: cm[2].trim(),
          });
        }
      }
    } else {
      explanation = explanationBlock;
    }
  } else {
    explanation = explanationBlock;
  }

  return {
    question_number: questionNumber,
    subject,
    difficulty: 2,
    stem,
    question_text: questionText,
    choices,
    explanation,
    choice_explanations: choiceExplanations,
    references,
  };
}
