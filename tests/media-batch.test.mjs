import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const asModule = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const validationModule = asModule(read('media-upload.js'));
const source = read('media-batch.js').replace("'./media-upload.js?v=20260914_audio1'", JSON.stringify(validationModule)) + '\n//# sourceURL=media-batch.testing.mjs';
const { parseChapterNumber, titleFromFilename, prepareBatchFiles, BatchQueue } = await import(asModule(source));
const file = (name, size = 32, lastModified = 123) => ({ name, size, lastModified });
function ids() {
  let counter = 0;
  return () => '00000000-0000-4000-8000-' + String(++counter).padStart(12, '0');
}
function prepared(files) { return prepareBatchFiles(files, [], { idGenerator: ids() }).items; }
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function queue(options = {}) {
  return new BatchQueue({ idGenerator: ids(), minUploadIntervalMs: 0,
    upload: async item => ({ videoId: 'vod-' + item.id }), save: async item => ({ id: item.id }), ...options });
}

test('chapter parsing handles Chinese and zero-padded Arabic numeric order without guessing unrelated numbers', () => {
  for (const [name, expected] of [
    ['第1章.mp3', 1], ['第001章_概论.MP3', 1], ['第一章.mp3', 1], ['第十一章.mp3', 11],
    ['第二十七章.mp3', 27], ['肾脏病学_一百章.mp3', 100], ['第一百零一章.mp3', 101],
    ['第两百一十讲.mp3', 210], ['第一千零九十章.mp3', 1090], ['第二〇二课.mp3', 202],
    ['第０１２章.mp3', 12], ['第零章.mp3', null], ['肾脏2026专题.mp3', null], ['未编号.mp3', null]
  ]) assert.equal(parseChapterNumber(name), expected, name);
});

test('title cleanup preserves series and middle Chinese, removing only known suffixes at the end', () => {
  assert.equal(titleFromFilename('肾脏病学_第十一章_肾小球疾病_晓晓标准普通话版.mp3'), '肾脏病学 第十一章 肾小球疾病');
  assert.equal(titleFromFilename('系统肾脏病学_第二十七章_中文教学音频.MP3'), '系统肾脏病学 第二十七章');
  assert.equal(titleFromFilename('第一章（晓晓标准普通话版）_中文教学音频.mp3'), '第一章');
  assert.equal(titleFromFilename('中文教学音频_第一章_晓晓的临床课.mp3'), '中文教学音频 第一章 晓晓的临床课');
  assert.equal(titleFromFilename('中文教学音频.mp3'), '中文教学音频', 'no empty title from suffix-only names');
  assert.equal(titleFromFilename('临床2.0_第八章_英文版.wav'), '临床2.0 第八章 英文版');
  assert.equal(titleFromFilename('课'.repeat(205) + '.mp3').length, 200);
  assert.equal(titleFromFilename('课'.repeat(199) + '😀.mp3'), '课'.repeat(199), 'length cap never leaves an unmatched surrogate');
});

test('preparation reuses file validator, sorts chapters numerically and deduplicates this queue by file metadata only', () => {
  const chosen = [file('系列_第十章.mp3'), file('系列_第二章.mp3'), file('未编号乙.mp3'),
    file('系列_第一章.mp3'), file('未编号甲.mp3'), file('系列_第二章.mp3'), file('附件.exe'), file('空.mp3', 0)];
  const result = prepareBatchFiles(chosen, [], { idGenerator: ids() });
  assert.deepEqual(result.items.map(item => item.chapterNumber), [1, 2, 10, null, null]);
  assert.deepEqual(result.items.map(item => item.order), [1, 2, 3, 4, 5]);
  assert.equal(result.items[3].file.name, '未编号乙.mp3');
  assert.equal(result.duplicates.length, 1); assert.equal(result.rejected.length, 2);
  assert.equal(result.items[0].file, chosen[3], 'File reference is retained');
  for (const item of result.items) assert.match(item.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const next = prepareBatchFiles([file('系列_第二章.mp3'), file('系列_第二章.mp3', 33), file('系列_第二章.mp3', 32, 124)], result.items, { idGenerator: ids() });
  assert.equal(next.duplicates.length, 1); assert.equal(next.items.length, 2);
});

test('queue serializes upload then save and spaces upload starts even for very small files', async () => {
  const events = [], starts = [], waits = [];
  let clock = 0, active = 0;
  const q = queue({ items: prepared([file('第十章.mp3'), file('第二章.mp3'), file('第一章.mp3')]),
    minUploadIntervalMs: 2200, now: () => clock, wait: async ms => { waits.push(ms); clock += ms; },
    upload: async item => { assert.equal(active++, 0); starts.push(clock); events.push('upload:' + item.chapterNumber); active--; return { videoId: 'v' + item.chapterNumber }; },
    save: async item => { assert.equal(active++, 0); assert.equal(item.uploadResult.videoId, 'v' + item.chapterNumber); events.push('save:' + item.chapterNumber); active--; return { id: item.id }; }
  });
  const result = await q.start({ publish: false });
  assert.deepEqual(events, ['upload:1', 'save:1', 'upload:2', 'save:2', 'upload:10', 'save:10']);
  assert.deepEqual(starts, [0, 2200, 4400]); assert.deepEqual(waits, [2200, 2200]);
  assert.ok(result.items.every(item => item.status === 'saved'));
  assert.equal(result.busy, false);
});

test('save retry retains uploaded VOD, stable DB id and original deep settings, while new pending items use new settings', async () => {
  const uploads = [], saves = [];
  let fail = true;
  const q = queue({ upload: async item => { uploads.push(item.id); return { videoId: 'vod-fixed' }; },
    save: async (item, settings) => { saves.push({ id: item.id, settings, vod: item.uploadResult.videoId });
      settings.specialtyIds.push('mutated-by-callback'); if (fail) throw new Error('database offline'); return { id: item.id }; }
  });
  q.addFiles([file('第一章.mp3')]);
  const settings = { accessType: 'paid_membership', specialtyIds: ['glom'], publish: false };
  await q.start(settings);
  settings.accessType = 'free'; settings.specialtyIds.push('external');
  const first = q.items[0];
  assert.equal(first.status, 'save_failed'); assert.equal(first.uploadResult.videoId, 'vod-fixed');
  await q.start({ publish: true });
  assert.equal(uploads.length, 1); assert.equal(saves.length, 1, 'new start leaves save failure for explicit retry');
  fail = false;
  await q.retry(first.id, { accessType: 'free', publish: true });
  assert.equal(uploads.length, 1); assert.equal(saves.length, 2); assert.equal(saves[1].id, first.id);
  assert.equal(saves[1].settings.accessType, 'paid_membership'); assert.equal(saves[1].settings.publish, false);
  assert.deepEqual(q.items[0].settings.specialtyIds, ['glom']);
  q.addFiles([file('第二章.mp3')]);
  await q.start({ accessType: 'free', specialtyIds: [], publish: true });
  assert.equal(saves[2].settings.accessType, 'free'); assert.equal(saves[2].settings.publish, true);
});

test('one failed upload does not stop other items; retry processes only the failed stage of the chosen item', async () => {
  const attempts = new Map(), saves = [];
  const q = queue({ items: prepared([file('第一章.mp3'), file('第二章.mp3')]),
    upload: async item => { const count = (attempts.get(item.id) || 0) + 1; attempts.set(item.id, count);
      if (item.chapterNumber === 1 && count === 1) throw new Error('interrupted'); return { videoId: 'v' + item.chapterNumber }; },
    save: async item => { saves.push(item.chapterNumber); return {}; }
  });
  await q.start({ publish: false });
  assert.deepEqual(q.items.map(item => item.status), ['upload_failed', 'saved']);
  await q.retry(q.items[0].id, { publish: true });
  assert.deepEqual(saves, [2, 1]); assert.equal(attempts.get(q.items[1].id), 1);
  assert.equal(q.items[0].settings.publish, false);
});

test('busy lock blocks overlapping start/retry and edits until an active upload resolves', async () => {
  const held = deferred();
  const q = queue({ items: prepared([file('第一章.mp3')]), upload: async () => held.promise });
  const running = q.start({});
  assert.equal(q.busy, true);
  await assert.rejects(q.start({}), error => error.code === 'BATCH_BUSY');
  await assert.rejects(q.retry(q.items[0].id), error => error.code === 'BATCH_BUSY');
  assert.throws(() => q.addFiles([file('第二章.mp3')]), error => error.code === 'BATCH_BUSY');
  assert.throws(() => q.updateTitle(q.items[0].id, '另一个标题'), error => error.code === 'BATCH_BUSY');
  held.resolve({ videoId: 'v1' }); await running;
  assert.equal(q.busy, false);
});

test('stop preserves original batch settings even for chapters not yet started; later additions receive new settings', async () => {
  const held = deferred(); let attempted = 0, aborted = false;
  const q = queue({
    upload: async (item, progress, signal) => {
      attempted++;
      if (item.chapterNumber !== 2 || attempted > 2) return { videoId: 'v' + item.chapterNumber };
      signal.addEventListener('abort', () => { aborted = true; const error = new Error('cancelled'); error.name = 'AbortError'; held.reject(error); }, { once: true });
      return held.promise;
    }
  });
  q.addFiles([file('第一章.mp3'), file('第二章.mp3'), file('第三章.mp3')]);
  const reachedSecond = deferred();
  q.subscribe(state => { if (state.items[1]?.status === 'uploading') reachedSecond.resolve(); });
  const running = q.start({ publish: false });
  assert.ok(q.items.every(item => item.settings.publish === false), 'settings freeze for the entire selection before any await');
  await reachedSecond.promise;
  assert.equal(q.stop(), true); await running;
  assert.equal(aborted, true);
  assert.deepEqual(q.items.map(item => item.status), ['saved', 'stopped', 'pending']);
  assert.ok(q.items.every(item => item.settings.publish === false), 'all selected chapters froze settings before the first upload');
  q.addFiles([file('第四章.mp3')]);
  await q.start({ publish: true });
  assert.deepEqual(q.items.map(item => item.status), ['saved', 'saved', 'saved', 'saved']);
  assert.equal(q.items[1].settings.publish, false); assert.equal(q.items[2].settings.publish, false);
  assert.equal(q.items[3].settings.publish, true);
  assert.equal(attempted, 5);
});

test('stop while saving waits for its real outcome and never starts a later upload', async () => {
  const saving = deferred(), saved = deferred(); const uploads = [];
  const q = queue({ items: prepared([file('第一章.mp3'), file('第二章.mp3')]),
    upload: async item => { uploads.push(item.id); return { videoId: 'v' }; },
    save: async () => { saving.resolve(); return saved.promise; }
  });
  const running = q.start({ publish: false });
  await saving.promise; q.stop();
  assert.equal(q.getSnapshot().busy, true); assert.equal(q.getSnapshot().stopping, true);
  saved.resolve({ id: q.items[0].id }); await running;
  assert.equal(uploads.length, 1); assert.deepEqual(q.items.map(item => item.status), ['saved', 'pending']);
});

test('upload success arriving after stop is retained and resumed as save-only, with no second VOD upload', async () => {
  const held = deferred(); let uploads = 0, saves = 0;
  const q = queue({ items: prepared([file('第一章.mp3')]),
    upload: async () => { uploads++; return held.promise; }, save: async () => { saves++; return {}; }
  });
  const running = q.start({ publish: false }); q.stop();
  held.resolve({ videoId: 'completed-despite-cancel' }); await running;
  assert.equal(q.items[0].status, 'uploaded'); assert.equal(saves, 0);
  await q.start({ publish: true });
  assert.equal(uploads, 1); assert.equal(saves, 1); assert.equal(q.items[0].settings.publish, false);
});

test('stop during pacing cancels the wait and does not start the next transport', async () => {
  let uploads = 0; const waiting = deferred();
  const q = queue({ items: prepared([file('第一章.mp3'), file('第二章.mp3')]),
    minUploadIntervalMs: 2200, now: () => 0,
    wait: async (ms, signal) => { assert.equal(ms, 2200); waiting.resolve(); return new Promise((_, reject) => {
      signal.addEventListener('abort', () => { const error = new Error('cancelled wait'); error.name = 'AbortError'; reject(error); }, { once: true });
    }); }, upload: async () => { uploads++; return { videoId: 'v' }; }
  });
  const running = q.start({}); await waiting.promise; q.stop(); await running;
  assert.equal(uploads, 1); assert.deepEqual(q.items.map(item => item.status), ['saved', 'stopped']);
});

test('snapshot and observers cannot mutate queue settings or break successful work; stale progress is ignored', async () => {
  let progressCallback; const held = deferred();
  const q = queue({ items: prepared([file('第一章.mp3')]), upload: async (_, progress) => { progressCallback = progress; return held.promise; } });
  const observed = [];
  const unsubscribe = q.subscribe(state => { observed.push(state); if (state.items[0]) state.items[0].title = 'external mutation'; throw new Error('rendering failure'); });
  const running = q.start({ specialtyIds: ['glom'] });
  progressCallback(0.6); progressCallback(0.2); progressCallback(NaN);
  assert.equal(q.items[0].progress, 0.6);
  const snapshot = q.getSnapshot(); snapshot.items[0].settings.specialtyIds.push('bad');
  assert.deepEqual(q.items[0].settings.specialtyIds, ['glom']); assert.equal(q.items[0].title, '第一章');
  held.resolve({ videoId: 'v' }); await running; progressCallback(0.1);
  assert.equal(q.items[0].progress, 1); assert.equal(q.items[0].status, 'saved');
  const count = observed.length; unsubscribe(); q.sortByChapter(); assert.equal(observed.length, count);
});

test('manual title/chapter edits sort predictably, dedupe uses original file identity and completed assets cannot be removed', async () => {
  const q = queue(); q.addFiles([file('未编号.mp3'), file('第十章.mp3')]);
  const unnumbered = q.items.find(item => item.chapterNumber === null);
  q.updateTitle(unnumbered.id, '手工章节名'); q.updateChapter(unnumbered.id, 2); q.sortByChapter();
  assert.deepEqual(q.items.map(item => item.chapterNumber), [2, 10]);
  assert.equal(q.addFiles([file('未编号.mp3')]).duplicates.length, 1);
  assert.throws(() => q.updateChapter(unnumbered.id, -1), error => error.code === 'INVALID_CHAPTER');
  assert.throws(() => q.updateChapter(unnumbered.id, 0), error => error.code === 'INVALID_CHAPTER');
  assert.throws(() => q.updateTitle(unnumbered.id, '  '), error => error.code === 'TITLE_REQUIRED');
  assert.throws(() => q.updateTitle(unnumbered.id, '课'.repeat(201)), error => error.code === 'TITLE_TOO_LONG');
  await q.start({});
  assert.throws(() => q.remove(unnumbered.id), error => error.code === 'ITEM_ALREADY_UPLOADED');
  assert.throws(() => q.updateTitle(unnumbered.id, '改名'), error => error.code === 'ITEM_ALREADY_UPLOADED');
});

test('adding chapters after an unconfirmed save never changes its retry order or title', async () => {
  const rows = [], original = file('未编号课程.mp3'); let fail = true;
  const q = queue({ save: async item => {
    rows.push({ id: item.id, title: item.title, order: item.order, chapterNumber: item.chapterNumber });
    if (item.file === original && fail) throw new Error('insert reply lost'); return { id: item.id };
  } });
  q.addFiles([original]); await q.start({ sortStart: 100, publish: false });
  const first = q.items[0]; assert.equal(first.status, 'save_failed'); assert.equal(first.order, 1);
  q.addFiles([file('第一章.mp3'), file('另一未编号课.mp3')]); q.sortByChapter();
  assert.equal(q.items.find(item => item.id === first.id).order, 1);
  assert.equal(new Set(q.items.map(item => item.order)).size, 3, 'new fallback orders avoid reserved orders');
  assert.throws(() => q.updateTitle(first.id, '重试改名'), error => error.code === 'ITEM_ALREADY_UPLOADED');
  assert.throws(() => q.updateChapter(first.id, 3), error => error.code === 'ITEM_ALREADY_UPLOADED');
  fail = false; await q.retry(first.id, { sortStart: 200, publish: true });
  assert.deepEqual(rows[1], rows[0], 'same UUID retry receives the exact original row inputs');
  assert.equal(q.items.find(item => item.id === first.id).settings.sortStart, 100);
});

test('first processing freezes chapters, while a failed upload may fix its title without changing settings or order', async () => {
  const q = queue({ upload: async () => { throw new Error('upload interrupted'); } });
  q.addFiles([file('未编号课程.mp3')]);
  await q.start({ publish: false }); const first = q.items[0];
  q.updateTitle(first.id, '修正标题');
  assert.throws(() => q.updateChapter(first.id, 2), error => error.code === 'ITEM_SETTINGS_LOCKED');
  q.addFiles([file('第一章.mp3')]);
  const retried = q.items.find(item => item.id === first.id);
  assert.equal(retried.title, '修正标题'); assert.equal(retried.order, 1); assert.equal(retried.settings.publish, false);
});

test('batch module performs no network, DOM, storage or credential operations', () => {
  assert.doesNotMatch(read('media-batch.js'), /\b(?:fetch|XMLHttpRequest|document|localStorage|sessionStorage|supabase)\b/);
});
