export const DAILY_SPECIALTIES = Object.freeze(['glom', 'icu', 'tx', 'path', 'da', 'peds']);

export const DAILY_SPECIALTY_LABELS = Object.freeze({
  glom: '肾小球病',
  icu: '重症肾内',
  tx: '肾移植',
  path: '肾脏病理',
  da: '血管通路',
  peds: '儿童肾脏',
  other: '综合肾脏病',
});

export const DAILY_ACCESS_LABELS = Object.freeze({
  free: '免费',
  member: '会员回放 · ¥299/年',
  training: '培训项目 · 另行付费',
});

export function normalizeDailySpecialties(values) {
  const source = Array.isArray(values) ? values : [];
  return [...new Set(source.map(value => String(value || '').trim().toLowerCase()))]
    .filter(value => DAILY_SPECIALTIES.includes(value));
}

export function parseDailyPreferences(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return normalizeDailySpecialties(parsed?.specialties);
  } catch (_) {
    return [];
  }
}

export function dailyReviewInterval(stage, correct) {
  if (!correct) return { stage: 0, days: 1 };
  const nextStage = Math.min(4, Math.max(0, Number(stage) || 0) + 1);
  return { stage: nextStage, days: [1, 1, 3, 7, 30][nextStage] };
}

export function recordDailyLocalAnswer(previous, selectedOption, correctOption, now = Date.now()) {
  const correct = Number(selectedOption) === Number(correctOption);
  const schedule = dailyReviewInterval(previous?.reviewStage, correct);
  return {
    selectedOption: Number(selectedOption),
    correct,
    answerCount: Math.max(0, Number(previous?.answerCount) || 0) + 1,
    reviewStage: schedule.stage,
    completedAt: new Date(now).toISOString(),
    nextReviewAt: new Date(now + schedule.days * 86400000).toISOString(),
  };
}

export function isDailyReviewDue(progress, now = Date.now()) {
  const due = Date.parse(progress?.nextReviewAt || '');
  return Number.isFinite(due) && due <= now;
}
