import { validateMediaFile } from './media-upload.js?v=20260914_audio1';

const DIGITS = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });
const UNITS = Object.freeze({ 十: 10, 百: 100, 千: 1000, 万: 10000 });

function chineseNumber(text) {
  if (![...text].some(char => Object.hasOwn(UNITS, char))) {
    return Number([...text].map(char => DIGITS[char]).join(''));
  }
  let result = 0, section = 0, digit = 0;
  for (const char of text) {
    if (Object.hasOwn(DIGITS, char)) digit = DIGITS[char];
    else if (UNITS[char] === 10000) {
      result += (section + digit || 1) * 10000;
      section = 0; digit = 0;
    } else {
      section += (digit || 1) * UNITS[char];
      digit = 0;
    }
  }
  return result + section + digit;
}

export function parseChapterNumber(filename) {
  const name = String(filename || '').replace(/[０-９]/g, digit => String(digit.charCodeAt(0) - 0xff10));
  const match = name.match(/(?:第\s*)?([0-9]+|[零〇一二两三四五六七八九十百千万]+)\s*[章节讲回课]/u);
  if (!match) return null;
  const number = /^\d+$/.test(match[1]) ? Number(match[1]) : chineseNumber(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function titleFromFilename(filename) {
  let title = String(filename || '').replace(/\.[a-z0-9]{1,8}$/i, '').replace(/_/g, ' ').trim();
  const original = title;
  // Remove only these known production suffixes, only at the end. Series names
  // and matching words in the middle of a chapter remain untouched.
  let previous;
  do {
    previous = title;
    title = title.replace(/(?:[\s\-—–·|]*[（(【\[]?\s*(?:晓晓\s*标准\s*普通话版|中文\s*教学\s*音频)\s*[）)】\]]?)$/u, '').trim();
  } while (title !== previous);
  const cleaned = title.replace(/\s+/g, ' ').replace(/[\s\-—–·|]+$/u, '').trim() || original;
  return cleaned.slice(0, 200).replace(/[\uD800-\uDBFF]$/, '').trimEnd();
}

function fileKey(file) {
  return JSON.stringify([String(file?.name || ''), file?.size, Number.isFinite(file?.lastModified) ? file.lastModified : 0]);
}

function newId() {
  if (!globalThis.crypto?.randomUUID) throw new Error('浏览器不支持安全的上传编号，请更新浏览器后重试。');
  return globalThis.crypto.randomUUID();
}

function sortItems(items) {
  items.sort((a, b) => {
    if (a.chapterNumber == null) return b.chapterNumber == null ? 0 : 1;
    if (b.chapterNumber == null) return -1;
    return a.chapterNumber - b.chapterNumber;
  });
  // A save may have committed before its response was lost. Keep its exact
  // fallback order for every later retry, even after adding another chapter.
  const reserved = new Set(items.filter(item => item.settings !== null &&
    Number.isSafeInteger(item.order) && item.order > 0).map(item => item.order));
  let order = 1;
  for (const item of items) {
    if (item.settings !== null) continue;
    while (reserved.has(order)) order++;
    item.order = order++;
  }
  return items;
}

export function prepareBatchFiles(files, existing = [], { idGenerator = newId } = {}) {
  const seen = new Set(Array.from(existing, item => item.fileKey || fileKey(item.file || item)));
  const items = [], rejected = [], duplicates = [];
  for (const file of Array.from(files || [])) {
    const validation = validateMediaFile(file);
    if (validation.error) {
      rejected.push({ file, error: validation.error });
      continue;
    }
    const key = fileKey(file);
    if (seen.has(key)) {
      duplicates.push({ file, reason: '本队列已包含同名、同大小、同修改时间的文件。' });
      continue;
    }
    seen.add(key);
    items.push({ id: idGenerator(), file, fileKey: key, title: titleFromFilename(file.name),
      chapterNumber: parseChapterNumber(file.name), ...validation,
      status: 'pending', progress: 0, uploadResult: null, savedResult: null,
      error: null, failedStage: null, settings: null });
  }
  return { items: sortItems(items), rejected, duplicates };
}

function copy(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function snapshotItem(item) {
  return { ...item, file: item.file, uploadResult: copy(item.uploadResult),
    savedResult: copy(item.savedResult), settings: copy(item.settings) };
}

function abortError() {
  const error = new Error('已停止当前上传。');
  error.name = 'AbortError';
  return error;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function problem(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class BatchQueue {
  constructor({ items = [], upload, save, onChange, idGenerator = newId,
    minUploadIntervalMs = 2200, now = () => Date.now(), wait = delay } = {}) {
    if (typeof upload !== 'function' || typeof save !== 'function') throw new TypeError('需要提供上传和保存方法。');
    if (!Number.isFinite(minUploadIntervalMs) || minUploadIntervalMs < 0) throw new TypeError('上传间隔无效。');
    this._items = [];
    this._upload = upload; this._save = save;
    this._idGenerator = idGenerator; this._interval = minUploadIntervalMs;
    this._now = now; this._wait = wait;
    this._lastUpload = -Infinity;
    this._busy = false; this._stopping = false; this._controller = null;
    this._listeners = new Set();
    this.add(items);
    if (onChange) this.subscribe(onChange);
  }

  get items() { return this.getSnapshot().items; }
  get busy() { return this._busy; }

  getSnapshot() {
    return { busy: this._busy, stopping: this._stopping, items: this._items.map(snapshotItem) };
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('监听方法无效。');
    this._listeners.add(listener);
    this._notify(listener);
    return () => this._listeners.delete(listener);
  }

  _notify(only) {
    for (const listener of only ? [only] : this._listeners) {
      // A rendering failure must not turn a successful VOD upload into a retry.
      try { listener(this.getSnapshot()); } catch (_) { /* observer only */ }
    }
  }

  _idle() {
    if (this._busy) throw problem('当前批次正在处理，请先停止或等待完成。', 'BATCH_BUSY');
  }

  _item(id) {
    const item = this._items.find(candidate => candidate.id === id);
    if (!item) throw problem('未找到该上传项目。', 'ITEM_NOT_FOUND');
    return item;
  }

  add(items) {
    this._idle();
    const keys = new Set(this._items.map(item => item.fileKey));
    const ids = new Set(this._items.map(item => item.id));
    for (const item of items || []) {
      if (keys.has(item.fileKey)) continue;
      if (!item.id || ids.has(item.id)) throw problem('上传项目编号重复或缺失。', 'DUPLICATE_ITEM_ID');
      const validation = validateMediaFile(item.file);
      if (validation.error) throw problem(validation.error, 'INVALID_MEDIA_FILE');
      if (item.status !== 'pending' || item.uploadResult || item.settings) throw problem('只能加入新选择的待上传文件。', 'INVALID_NEW_ITEM');
      this._items.push(snapshotItem(item));
      keys.add(item.fileKey); ids.add(item.id);
    }
    sortItems(this._items);
    this._notify();
    return this.getSnapshot();
  }

  addFiles(files) {
    this._idle();
    const prepared = prepareBatchFiles(files, this._items, { idGenerator: this._idGenerator });
    this.add(prepared.items);
    return prepared;
  }

  _editable(id) {
    this._idle();
    const item = this._item(id);
    if (item.uploadResult || !['pending', 'stopped', 'upload_failed'].includes(item.status)) {
      throw problem('已经上传的项目不能在队列中改名或移除。', 'ITEM_ALREADY_UPLOADED');
    }
    return item;
  }

  updateTitle(id, title) {
    const item = this._editable(id);
    if (item.settings !== null && item.status !== 'upload_failed') {
      throw problem('该项目已经开始处理，标题已固定。', 'ITEM_SETTINGS_LOCKED');
    }
    const value = String(title || '').trim();
    if (!value) throw problem('请填写章节标题。', 'TITLE_REQUIRED');
    if (value.length > 200) throw problem('章节标题不能超过 200 个字符。', 'TITLE_TOO_LONG');
    item.title = value;
    this._notify();
  }

  updateChapter(id, number) {
    const item = this._editable(id);
    if (item.settings !== null) throw problem('该项目已经开始处理，章节序号已固定。', 'ITEM_SETTINGS_LOCKED');
    if (number !== null && (!Number.isSafeInteger(number) || number <= 0)) throw problem('章节序号应为正整数。', 'INVALID_CHAPTER');
    item.chapterNumber = number;
    this._notify();
  }

  sortByChapter() {
    this._idle();
    sortItems(this._items);
    this._notify();
  }

  remove(id) {
    this._editable(id);
    this._items = this._items.filter(item => item.id !== id);
    sortItems(this._items);
    this._notify();
  }

  async start(settings = {}) {
    this._idle();
    const pending = this._items.filter(item => ['pending', 'stopped', 'uploaded'].includes(item.status));
    return this._run(pending, settings);
  }

  async retry(id, settings = {}) {
    this._idle();
    const item = this._item(id);
    if (!['upload_failed', 'save_failed', 'stopped'].includes(item.status)) {
      throw problem('该项目当前不需要重试。', 'ITEM_NOT_RETRYABLE');
    }
    return this._run([item], settings);
  }

  stop() {
    if (!this._busy) return false;
    this._stopping = true;
    // Save has no cancellation signal: its outcome must be learned before retry.
    this._controller?.abort();
    this._notify();
    return true;
  }

  async _run(items, settings) {
    const runSettings = copy(settings);
    if (!runSettings || typeof runSettings !== 'object' || Array.isArray(runSettings)) throw new TypeError('批量设置应为 JSON 对象。');
    this._busy = true; this._stopping = false;
    // One selection is one batch: stopping before a later chapter starts must
    // not give that chapter different access settings when the batch resumes.
    for (const item of items) {
      if (item.settings === null) item.settings = copy(runSettings);
    }
    this._notify();
    try {
      for (const item of items) {
        if (this._stopping) break;
        await this._process(item);
      }
    } finally {
      this._controller = null;
      this._busy = false; this._stopping = false;
      this._notify();
    }
    return this.getSnapshot();
  }

  async _process(item) {
    item.error = null; item.failedStage = null;
    if (!item.uploadResult) {
      const controller = new AbortController();
      this._controller = controller;
      let receivingProgress = false;
      try {
        const remaining = this._interval - (this._now() - this._lastUpload);
        if (remaining > 0) await this._wait(remaining, controller.signal);
        if (controller.signal.aborted) throw abortError();
        item.status = 'uploading'; item.progress = 0;
        this._notify();
        if (controller.signal.aborted) throw abortError();
        this._lastUpload = this._now();
        receivingProgress = true;
        const result = await this._upload(snapshotItem(item), fraction => {
          if (!receivingProgress || controller.signal.aborted || !Number.isFinite(fraction)) return;
          item.progress = Math.max(item.progress, Math.max(0, Math.min(1, fraction)));
          this._notify();
        }, controller.signal);
        if (!result || typeof result !== 'object') throw new Error('上传未返回媒体信息，请重试。');
        item.uploadResult = copy(result);
        item.status = 'uploaded'; item.progress = 1;
      } catch (error) {
        item.status = controller.signal.aborted || error?.name === 'AbortError' ? 'stopped' : 'upload_failed';
        item.failedStage = 'upload';
        item.error = item.status === 'stopped' ? '已停止，可继续上传。' : String(error?.message || '上传失败，请重试。');
        this._notify();
        return;
      } finally {
        receivingProgress = false;
        if (this._controller === controller) this._controller = null;
      }
      this._notify();
    }
    if (this._stopping) return;
    item.status = 'saving';
    this._notify();
    try {
      item.savedResult = copy(await this._save(snapshotItem(item), copy(item.settings)));
      item.status = 'saved'; item.error = null; item.failedStage = null;
    } catch (error) {
      item.status = 'save_failed'; item.failedStage = 'save';
      item.error = String(error?.message || '媒体已上传，课程保存失败。重试将只保存课程。');
    }
    this._notify();
  }
}
