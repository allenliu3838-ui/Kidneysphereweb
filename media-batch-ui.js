// DOM-only view for BatchQueue. Upload/auth/database work belongs to the
// supplied queue and settings adapter; this module makes no network request.
import { MEDIA_ACCEPT } from './media-upload.js?v=20260914_batch1';

let instanceNumber = 0;
const RETRYABLE = new Set(['upload_failed', 'save_failed']);
const STARTABLE = new Set(['pending', 'stopped', 'uploaded']);
const EDITABLE = new Set(['pending', 'stopped', 'upload_failed']);
const STATUS_TEXT = {
  pending: '待上传', uploading: '上传中', uploaded: '已上传，待保存课程',
  saving: '正在保存课程', saved: '课程已保存', upload_failed: '上传失败',
  save_failed: '课程保存失败', stopped: '已停止，可继续',
};
const ACCESS_TEXT = {
  registered_free: '注册后可播放（免费）', paid_single: '单课程付费',
  paid_specialty: '跟随专科课程', paid_membership: '付费会员可播放',
};

export function formatBatchBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function safeSettingsCopy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请先填写本批课程的公共信息。');
  return JSON.parse(JSON.stringify(value));
}

/**
 * queue: BatchQueue-compatible object (subscribe/getSnapshot/addFiles/start/
 * stop/retry/remove/updateTitle/updateChapter/sortByChapter).
 * getSettings: returns a serializable, validated common-settings object.
 * This view adds `publish` from its own explicit draft/publish choice.
 * Optional onBusy(boolean), onSaved(item), onError(error) are view callbacks.
 */
export function mountBatchUpload(root, { queue, getSettings, onBusy, onSaved, onError } = {}) {
  if (!root?.ownerDocument || !queue?.subscribe || typeof getSettings !== 'function') {
    throw new TypeError('批量上传需要挂载元素、队列实例和公共设置读取方法。');
  }
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const prefix = `media-batch-${++instanceNumber}`;
  const rows = new Map();
  const savedNotified = new Set();
  let snapshot = { busy: false, stopping: false, items: [] };
  let preparing = false;
  let settingsVersion = 0;
  let busyNotified;
  let destroyed = false;
  let unsubscribe = () => {};

  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, className = '') => {
    const node = el('button', `mb-btn ${className}`.trim(), text);
    node.type = 'button';
    return node;
  };
  const labelFor = (text, input) => {
    const label = el('label', 'mb-label', text);
    label.htmlFor = input.id;
    return label;
  };

  root.classList.add('media-batch');
  root.replaceChildren();
  const heading = el('div', 'mb-heading');
  const headingText = el('div');
  const title = el('h3', '', '批量上传视频 / 音频');
  title.id = `${prefix}-title`;
  root.setAttribute('aria-labelledby', title.id);
  headingText.append(el('p', 'mb-kicker', '课程管理'), title,
    el('p', 'mb-subtitle', '一次选择整套章节，每个文件生成一门独立课程。'));
  heading.append(headingText, el('span', 'mb-heading-chip', '按顺序上传'));

  const chooser = el('div', 'mb-chooser');
  const fileInput = el('input', 'mb-file-input');
  fileInput.type = 'file'; fileInput.multiple = true; fileInput.accept = MEDIA_ACCEPT;
  fileInput.id = `${prefix}-files`; fileInput.hidden = true;
  const choose = button('选择多个文件', 'mb-primary');
  choose.dataset.batchChoose = '';
  const sort = button('按章节排序');
  sort.dataset.batchSort = '';
  const chooserActions = el('div', 'mb-actions');
  chooserActions.append(choose, sort, fileInput);
  chooser.append(chooserActions, el('p', 'mb-help', '支持一次选择多章 MP3，也可继续选择文件合并到队列；同名、同大小且修改时间相同的文件会去重。单文件最大 2 GB。'));

  const notice = el('div', 'mb-notice');
  notice.hidden = true; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const rejectedList = el('ul', 'mb-rejected'); rejectedList.hidden = true;
  const queueHead = el('div', 'mb-queue-head');
  const count = el('strong', '', '尚未选择文件');
  const total = el('span', 'mb-help');
  queueHead.append(count, total);
  const empty = el('div', 'mb-empty', '选择文件后，可逐项修改课程标题和章节序号。');
  const list = el('ol', 'mb-list'); list.setAttribute('aria-label', '上传文件队列，可滚动查看所有章节'); list.tabIndex = 0;

  const footer = el('div', 'mb-footer');
  const modeFieldset = el('fieldset', 'mb-mode');
  modeFieldset.append(el('legend', '', '上传完成后'));
  function mode(value, text, checked) {
    const label = el('label', 'mb-mode-choice');
    const input = el('input'); input.type = 'radio'; input.name = `${prefix}-mode`; input.value = value; input.checked = checked;
    label.append(input, el('span', '', text)); modeFieldset.append(label);
    input.addEventListener('change', refreshSettings);
    return input;
  }
  const draftMode = mode('draft', '保存为草稿', true);
  const publishMode = mode('publish', '上传后上架', false);
  const summary = el('p', 'mb-summary', '上传时请保持此页面打开。');
  summary.setAttribute('role', 'status'); summary.setAttribute('aria-live', 'polite');
  const start = button('开始上传', 'mb-primary'); start.dataset.batchStart = '';
  const stop = button('停止上传', 'mb-stop'); stop.dataset.batchStop = ''; stop.hidden = true;
  const actions = el('div', 'mb-actions'); actions.append(start, stop);
  footer.append(modeFieldset, summary, actions, el('p', 'mb-help', '公共信息使用上方表单。已完成的课程会保留；已开始的文件继续或重试时，沿用首次开始时的设置。上传时请保持此页面打开。'));

  const review = el('section', 'mb-review');
  review.setAttribute('aria-labelledby', `${prefix}-review-title`);
  const reviewTitle = el('h4', '', '本批课程信息'); reviewTitle.id = `${prefix}-review-title`;
  const reviewLead = el('p', 'mb-review-lead');
  const reviewDetails = el('dl', 'mb-settings');
  review.append(reviewTitle, reviewLead, reviewDetails);
  root.append(heading, chooser, notice, rejectedList, queueHead, review, footer, empty, list);

  function message(text, error = false) {
    notice.textContent = text;
    notice.hidden = !text;
    notice.classList.toggle('mb-notice-error', error);
  }
  function reportError(error) {
    const text = String(error?.message || error || '操作失败，请重试。');
    message(text, true);
    if (onError) { try { onError(error); } catch (_) { /* Host reporting must not break the queue view. */ } }
  }
  function invoke(action) {
    try { return Promise.resolve(action()).catch(reportError); }
    catch (error) { reportError(error); return Promise.resolve(); }
  }
  function canEdit(item) { return !snapshot.busy && !preparing && !item.uploadResult && EDITABLE.has(item.status); }
  function actionableItems() { return snapshot.items.filter(item => STARTABLE.has(item.status)); }
  async function readSettings() { return { ...safeSettingsCopy(await getSettings()), publish: publishMode.checked }; }

  function addFiles(files) {
    return invoke(() => {
      const result = queue.addFiles(Array.from(files || []));
      const rejected = result.rejected || [], duplicates = result.duplicates || [];
      const added = result.items?.length || 0;
      message(`新增 ${added} 个文件${duplicates.length ? `，忽略 ${duplicates.length} 个重复文件` : ''}${rejected.length ? `，${rejected.length} 个文件未加入` : ''}。`, rejected.length > 0);
      rejectedList.replaceChildren(); rejectedList.hidden = !rejected.length;
      for (const entry of rejected) {
        const name = entry.file?.name || entry.name || '文件';
        rejectedList.append(el('li', '', `${name}：${entry.error || entry.reason || '格式或大小不符合要求'}`));
      }
      refreshSettings();
    });
  }
  choose.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  sort.addEventListener('click', () => { invoke(() => queue.sortByChapter()); });

  function createRow(item) {
    const row = el('li', 'mb-item'); row.dataset.batchItem = item.id;
    const top = el('div', 'mb-item-top');
    const file = el('div', 'mb-file');
    const fileName = el('strong', 'mb-filename');
    const meta = el('span', 'mb-file-meta');
    file.append(fileName, meta);
    const status = el('span', 'mb-state');
    top.append(file, status);
    const fields = el('div', 'mb-fields');
    const titleWrap = el('div', 'mb-title-field');
    const titleInput = el('input', 'mb-input'); titleInput.id = `${prefix}-${item.id}-title`; titleInput.type = 'text'; titleInput.maxLength = 200;
    titleInput.dataset.batchTitle = item.id;
    titleWrap.append(labelFor('课程标题', titleInput), titleInput);
    const chapterWrap = el('div', 'mb-chapter-field');
    const chapter = el('input', 'mb-input'); chapter.id = `${prefix}-${item.id}-chapter`; chapter.type = 'number'; chapter.min = '1'; chapter.step = '1'; chapter.inputMode = 'numeric'; chapter.placeholder = '未识别';
    chapter.dataset.batchChapter = item.id;
    chapterWrap.append(labelFor('章节序号', chapter), chapter);
    fields.append(titleWrap, chapterWrap);
    const bottom = el('div', 'mb-item-bottom');
    const progressWrap = el('div', 'mb-progress-wrap');
    const progress = el('progress', 'mb-progress'); progress.max = 100; progress.value = 0; progress.setAttribute('aria-label', `${item.file?.name || item.title} 上传进度`);
    const percent = el('span', 'mb-progress-text', '0%');
    progressWrap.append(progress, percent);
    const rowActions = el('div', 'mb-row-actions');
    const retry = button('重试', 'mb-retry'); retry.dataset.batchRetry = item.id;
    const remove = button('移除', 'mb-remove'); remove.dataset.batchRemove = item.id;
    rowActions.append(retry, remove); bottom.append(progressWrap, rowActions);
    const error = el('p', 'mb-item-error'); error.hidden = true;
    row.append(top, fields, bottom, error);
    const view = { row, fileName, meta, status, titleInput, chapter, progress, percent, retry, remove, error, item };
    titleInput.addEventListener('change', () => {
      invoke(() => queue.updateTitle(item.id, titleInput.value));
    });
    chapter.addEventListener('change', () => {
      const value = chapter.value.trim();
      if (value && (!Number.isSafeInteger(Number(value)) || Number(value) < 1)) {
        message('章节序号请填写正整数，或留空。', true);
        chapter.value = view.item.chapterNumber ?? '';
        return;
      }
      invoke(() => queue.updateChapter(item.id, value ? Number(value) : null));
    });
    remove.addEventListener('click', () => { invoke(() => queue.remove(item.id)); refreshSettings(); });
    retry.addEventListener('click', () => {
      message(view.item.status === 'save_failed' ? '正在重试保存这门课程，使用首次开始时的设置。' : '正在重试这个文件，使用首次开始时的设置。');
      invoke(() => queue.retry(item.id));
    });
    return view;
  }

  function render(next) {
    if (destroyed) return;
    snapshot = next;
    const busy = !!next.busy || preparing;
    const items = next.items || [];
    const ids = new Set(items.map(item => item.id));
    for (const [id, view] of rows) if (!ids.has(id)) { view.row.remove(); rows.delete(id); }
    items.forEach((item, index) => {
      let view = rows.get(item.id);
      if (!view) { view = createRow(item); rows.set(item.id, view); }
      view.item = item;
      if (list.children[index] !== view.row) list.insertBefore(view.row, list.children[index] || null);
      view.row.dataset.status = item.status;
      view.fileName.textContent = item.file?.name || item.title || '未命名文件';
      view.meta.textContent = `${item.mediaType === 'audio' ? '音频' : '视频'} · ${formatBatchBytes(item.file?.size)}${item.chapterNumber !== null && item.chapterNumber !== undefined ? ` · 第 ${item.chapterNumber} 章` : ''}`;
      view.status.textContent = item.status === 'saved' ? (item.settings?.publish ? '已上架' : '草稿已保存') : STATUS_TEXT[item.status] || item.status;
      if (doc.activeElement !== view.titleInput) view.titleInput.value = item.title || '';
      if (doc.activeElement !== view.chapter) view.chapter.value = item.chapterNumber ?? '';
      view.titleInput.disabled = !canEdit(item) || (!!item.settings && item.status !== 'upload_failed');
      view.chapter.disabled = !canEdit(item) || !!item.settings;
      const percent = Math.max(0, Math.min(100, Math.round((Number(item.progress) || 0) * 100)));
      view.progress.value = percent; view.percent.textContent = `${percent}%`;
      view.retry.hidden = !RETRYABLE.has(item.status); view.retry.disabled = busy;
      view.retry.textContent = item.status === 'save_failed' ? '重试保存' : '重试上传';
      view.remove.hidden = !!item.uploadResult || item.status === 'saved'; view.remove.disabled = !canEdit(item);
      view.error.hidden = !item.error; view.error.textContent = item.error ? String(item.error?.message || item.error) : '';
      if (item.status === 'saved' && !savedNotified.has(item.id)) {
        savedNotified.add(item.id);
        if (onSaved) { try { Promise.resolve(onSaved(item)).catch(reportError); } catch (error) { reportError(error); } }
      }
    });
    const saved = items.filter(item => item.status === 'saved').length;
    const failed = items.filter(item => RETRYABLE.has(item.status)).length;
    const pending = items.filter(item => STARTABLE.has(item.status)).length;
    count.textContent = items.length ? `${items.length} 个文件` : '尚未选择文件';
    total.textContent = items.length ? `总计 ${formatBatchBytes(items.reduce((sum, item) => sum + (Number(item.file?.size) || 0), 0))}` : '';
    empty.hidden = !!items.length;
    choose.disabled = busy; sort.disabled = busy || items.length < 2;
    draftMode.disabled = publishMode.disabled = busy;
    start.disabled = busy || !pending; start.textContent = preparing ? '正在读取公共信息…' : saved || items.some(item => item.status === 'stopped') ? '继续上传其余文件' : '开始上传';
    stop.hidden = !next.busy; stop.disabled = !!next.stopping; stop.textContent = next.stopping ? '正在停止…' : '停止上传';
    const phase = preparing ? '正在准备上传' : next.stopping ? '正在停止，当前保存结果确认后结束' : next.busy ? '正在按顺序处理' : '队列就绪';
    summary.textContent = items.length ? `${phase} · 已保存 ${saved}/${items.length}${failed ? ` · 失败 ${failed}，可逐项重试` : ''}${pending ? ` · 待处理 ${pending}` : ''}` : '上传时请保持此页面打开。';
    if (busyNotified !== busy) {
      busyNotified = busy;
      if (onBusy) { try { onBusy(busy); } catch (error) { reportError(error); } }
    }
  }

  function displaySettings(settings, frozen = false) {
    const items = actionableItems();
    const retained = items.filter(item => item.settings).length;
    reviewLead.textContent = `${frozen ? '已锁定本批信息。' : '开始时使用以下公共信息。'}每个文件生成一门课程。${settings.publish ? '保存成功后上架，播放以访问权限和媒体处理结果为准。' : '保存为草稿，可试听后再上架。'}${retained ? ` 其中 ${retained} 个已开始的文件沿用各自首次开始时的设置。` : ''}`;
    const fields = [
      ['频道', settings.categoryLabel || settings.category || '未选择'],
      ['主讲人', settings.speaker || '未填写'],
      ['所属专科', Array.isArray(settings.specialtyLabels) ? settings.specialtyLabels.join('、') || '未选择' : settings.specialtyLabel || '未选择'],
      ['内容来源', settings.sourceLabel || settings.source || '按上方表单'],
      ['访问权限', settings.accessLabel || ACCESS_TEXT[settings.accessType] || settings.accessType || '未选择'],
      ['单课程价格', settings.accessType === 'paid_single' ? `¥${Number(settings.price || 0).toFixed(2)}` : '按所选权限执行'],
      ['完成后', settings.publish ? '保存并上架' : '保存为草稿'],
    ];
    reviewDetails.replaceChildren();
    for (const [label, value] of fields) reviewDetails.append(el('dt', '', label), el('dd', '', String(value)));
  }
  async function refreshSettings() {
    if (snapshot.busy || preparing || destroyed) return;
    const version = ++settingsVersion;
    try {
      const settings = await readSettings();
      if (!destroyed && !snapshot.busy && !preparing && version === settingsVersion) displaySettings(settings);
    } catch (error) {
      if (!destroyed && !snapshot.busy && !preparing && version === settingsVersion) {
        reviewLead.textContent = String(error?.message || '填写上方公共信息后，此处显示本批课程设置。');
        reviewDetails.replaceChildren();
      }
    }
  }
  start.addEventListener('click', () => invoke(async () => {
    if (snapshot.busy || preparing) return;
    preparing = true; ++settingsVersion; render(snapshot);
    try {
      const settings = await readSettings();
      displaySettings(settings, true);
      preparing = false;
      message('已开始按队列顺序处理。');
      await queue.start(settings);
    } finally {
      preparing = false;
      render(queue.getSnapshot());
    }
  }));
  stop.addEventListener('click', () => invoke(() => { message('正在停止。已保存的课程会保留，剩余文件可稍后继续。'); return queue.stop(); }));
  const warnOnLeave = event => { if (snapshot.busy || preparing) { event.preventDefault(); event.returnValue = ''; } };
  win?.addEventListener('beforeunload', warnOnLeave);
  unsubscribe = queue.subscribe(render);
  refreshSettings();
  return {
    addFiles,
    refreshSettings,
    destroy() { destroyed = true; unsubscribe(); win?.removeEventListener('beforeunload', warnOnLeave); root.replaceChildren(); root.classList.remove('media-batch'); root.removeAttribute('aria-labelledby'); },
  };
}
