// Learning Center enhancements (v7.2)
// - Hot articles list (public)
// - Admin video link / mp4 uploader (writes to learning_videos table)

import {
  supabase,
  ensureSupabase,
  isConfigured,
  toast,
  getCurrentUser,
  getUserProfile,
  normalizeRole,
  isAdminRole,
  formatBeijingDate,
} from './supabaseClient.js?v=20260401_fix';

import { VIDEO_CATEGORIES } from './assets/videos.js?v=20260917_permissions1';
import { MEDIA_ACCEPT, validateMediaFile } from './media-upload.js?v=20260914_audio1';
import { createVodUploader } from './vod-upload.js?v=20260914_batch1';
import { BatchQueue } from './media-batch.js?v=20260914_batch1';
import { mountBatchUpload } from './media-batch-ui.js?v=20260917_permissions1';
import { saveBatchCourse } from './media-batch-save.js?v=20260917_permissions1';
import { createCourseSeriesId, courseUploadMetadata, courseMetadataSchemaError, readLocalMediaDuration } from './course-upload-metadata.js?v=20260915_learning2';
import { classifyTrainingProduct, isRetiredTrainingReplay } from './training-commerce.js?v=20260914_pricing1';
import { courseMediaType, courseMediaIcon, courseAccessLevel, formatCourseDuration } from './course-catalog.js?v=20260916_learn2';
import { coursePermissionForVideo, buildCoursePermissions, trainingProjectOptions } from './course-permissions.js?v=20260917_permissions1';

const videoAddForm = document.getElementById('videoAddForm');
const videoAdminPanelEl = document.getElementById('videoAdminPanel')
  || (videoAddForm ? videoAddForm.closest('[data-admin-only]') : null);

const els = {
  hotArticlesList: document.getElementById('hotArticlesList'),
  hotArticlesHint: document.getElementById('hotArticlesHint'),

  // Admin video uploader panel (super_admin / admin)
  videoAdminPanel: videoAdminPanelEl,
  videoTitle: document.getElementById('videoTitle'),
  videoCategory: document.getElementById('videoCategory'),
  videoUrl: document.getElementById('videoUrl'),
  videoMp4: document.getElementById('videoMp4'),
  videoAliyunUrl: document.getElementById('videoAliyunUrl'),
  videoAliyunVid: document.getElementById('videoAliyunVid'),
  videoSpeaker: document.getElementById('videoSpeaker'),
  videoSpecialtyChecks: document.getElementById('videoSpecialtyChecks'),
  videoIsPaid: document.getElementById('videoIsPaid'),
  videoMembershipAccessible: document.getElementById('videoMembershipAccessible'),
  // New fields for paid video MVP
  videoSourceType: document.getElementById('videoSourceType'),
  videoAudience: document.getElementById('videoAudience'),
  videoPrice: document.getElementById('videoPrice'),
  videoDescription: document.getElementById('videoDescription'),
  videoCoverImage: document.getElementById('videoCoverImage'),
  videoContentSource: document.getElementById('videoContentSource'),
  videoSortOrder: document.getElementById('videoSortOrder'),
  videoSaveDraft: document.getElementById('videoSaveDraft'),
  videoPriceRow: document.getElementById('videoPriceRow'),
  videoAliyunVidWrap: document.getElementById('videoAliyunVidWrap'),
  videoUrlWrap: document.getElementById('videoUrlWrap'),
  videoMp4Wrap: document.getElementById('videoMp4Wrap'),
  videoAliyunUrlWrap: document.getElementById('videoAliyunUrlWrap'),
  // Backward/forward compatible ids (some versions used videoSave/videoAdminHint)
  videoSave: document.getElementById('videoSave') || document.getElementById('videoSubmit'),
  videoAdminHint: document.getElementById('videoAdminHint') || document.getElementById('videoHint'),
  videoAdminList: document.getElementById('videoAdminList'),
  showDeletedVideos: document.getElementById('showDeletedVideos'),
};

// Specialties cache for dropdown + display
let _specialtiesMap = new Map(); // id → { id, title, code }

// Cache all admin videos (including soft-deleted) for toggle filtering
let _allAdminVideos = [];

const MAX_MP4_BYTES = 50 * 1024 * 1024; // 50MB
const MEMBERSHIP_SCOPES = {
  unclassified: '未分类', weekly_replay: '周日 / 周三学术视频回放',
  training: '培训项目', other_paid: '其他付费内容',
};

function membershipScopeOptions(selected = 'unclassified') {
  return Object.entries(MEMBERSHIP_SCOPES).map(([value, label]) =>
    `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
}

function validateMembershipScope(scope, mediaType, membershipAccessible, isPaid = true, { checkMedia = true } = {}) {
  if (!Object.hasOwn(MEMBERSHIP_SCOPES, scope)) throw new Error('请选择有效的课程权益分类。');
  if (!isPaid && (scope !== 'unclassified' || membershipAccessible)) throw new Error('免费课程应选择“未分类”且关闭年度会员权限；付费分类不能同时标为免费。');
  if (scope === 'weekly_replay' && checkMedia && mediaType !== 'video') throw new Error('年度会员回放仅限周日、周三学术活动视频，请确认媒体类型；音频需选择其他分类。');
  if (scope === 'weekly_replay' && !membershipAccessible) throw new Error('学术视频回放请同时选择年度会员访问权限。');
  if (membershipAccessible && scope !== 'weekly_replay') throw new Error('仅“周日 / 周三学术视频回放”可设置年度会员权限；培训与其他内容需单独设置权限。');
  return scope;
}

function esc(str){
  return String(str ?? '').replace(/[&<>"']/g, s => ({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[s]));
}

function safeFilename(name){
  // Supabase Storage object keys should be URL-safe (ASCII). Keep a conservative
  // ASCII-only filename to avoid supabase-js "Invalid key".
  const raw = String(name || 'file').trim();
  const dot = raw.lastIndexOf('.');
  const stemRaw = dot > 0 ? raw.slice(0, dot) : raw;
  const extRaw = dot > 0 && dot < raw.length - 1 ? raw.slice(dot + 1) : '';

  let stem = stemRaw
    .normalize('NFKD')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if(!stem) stem = 'file';

  const ext = extRaw.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
  return ext ? `${stem}.${ext}` : stem;
}

function fmtDate(iso){
  try{
    if(!iso) return '';
    return formatBeijingDate(iso);
  }catch{ return '' }
}
// Extract Alibaba Cloud vid from embed HTML or raw vid string
function extractAliyunVid(input){
  const s = String(input || '').trim();
  if(!s) return null;
  // Direct vid (hex string, 32 chars)
  if(/^[0-9a-f]{20,}$/i.test(s)) return s;
  // vid:"..." or vid:'...' in embed code
  const m = s.match(/vid\s*[:=]\s*["']([0-9a-f]{20,})["']/i);
  if(m) return m[1];
  return null;
}

// Check if input looks like pasted HTML embed code
function looksLikeHtml(input){
  const s = String(input || '').trim();
  return /^\s*</.test(s) || /<\/?(?:script|html|head|body|link|div|meta)\b/i.test(s);
}

function extractBvid(input){
  const s = String(input || '').trim();
  if(!s) return null;
  // direct BV id
  const direct = s.match(/^(BV[0-9A-Za-z]{10,})$/);
  if(direct) return direct[1];
  // /video/BV...
  const m = s.match(/\/video\/(BV[0-9A-Za-z]{10,})/);
  if(m) return m[1];
  // ?bvid=BV...
  try{
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    const b = u.searchParams.get('bvid') || u.searchParams.get('BVID') || u.searchParams.get('bv');
    if(b && /^BV[0-9A-Za-z]{10,}$/.test(b)) return b;
  }catch{}
  return null;
}

function renderHotArticles(items){
  if(!els.hotArticlesList) return;
  const list = Array.isArray(items) ? items : [];
  if(!list.length){
    els.hotArticlesList.innerHTML = '<div class="muted small">暂无文章，敬请关注。</div>';
    return;
  }
  // Match the "training project" card layout: no nested mini-cards inside the card,
  // use clean rows with consistent left/right padding and predictable wrapping.
  els.hotArticlesList.innerHTML = '<div class="hot-article-list">' + list.map(a=>{
    // Mobile Safari can overflow flex rows if the text container isn't allowed to shrink.
    // Force the cover to be fixed-width and the text column to flex/shrink.
    // IMPORTANT: Keep class names aligned with styles.css to avoid mobile overflow.
    // We intentionally render a small thumbnail here (not a full-width cover) so titles remain visible.
    const cover = a.cover_url
      ? `<img class="hot-article-thumb" src="${esc(a.cover_url)}" alt="cover"/>`
      : `<div class="hot-article-thumb placeholder" aria-hidden="true"></div>`;

    const views = (typeof a.view_count === 'number' && isFinite(a.view_count)) ? a.view_count : null;
    const dls = (typeof a.download_count === 'number' && isFinite(a.download_count)) ? a.download_count : null;
    const viewsBadge = (views !== null) ? `<span class="badge badge-ghost">阅读 ${esc(String(views))}</span>` : '';
    const dlBadge = (dls !== null) ? `<span class="badge badge-ghost">下载 ${esc(String(dls))}</span>` : '';

    const summary = (a.summary || '').trim();
    const summaryHtml = summary ? `<div class="hot-article-summary small muted">${esc(summary)}</div>` : '';

    return `
      <a class="hot-article-row" href="article.html?id=${encodeURIComponent(a.id)}">
        ${cover}
        <div class="hot-article-content">
          <div class="hot-article-head">
            <b class="hot-article-title">${esc(a.title || '（未命名）')}</b>
            <span class="badge badge-ghost">${esc(fmtDate(a.published_at || a.created_at))}</span>
            ${viewsBadge}
            ${dlBadge}
          </div>
          ${summaryHtml}
        </div>
      </a>
    `;
  }).join('') + '</div>';
}

async function loadHotArticles(){
  if(!els.hotArticlesList) return;
  if(!isConfigured()){
    els.hotArticlesList.innerHTML = '<div class="muted small">（演示模式）配置 Supabase 后自动显示最新文章。</div>';
    return;
  }
  await ensureSupabase();
  if(!supabase){
    els.hotArticlesList.innerHTML = '<div class="muted small">Supabase 未初始化。</div>';
    return;
  }

  try{
    const baseQuery = () => supabase
      .from('articles')
      .select('id,title,summary,cover_url,published_at,created_at,status,pinned,deleted_at,view_count,download_count')
      .eq('status', 'published')
      .is('deleted_at', null)
      .order('pinned', { ascending: false })
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(6);

    let { data, error } = await baseQuery();
    if(error){
      // Backward compatibility if DB hasn't added view_count yet.
      const msg = String(error?.message || error || '');
      if(/column .*download_count/i.test(msg)){
        const { data: d2, error: e2 } = await supabase
          .from('articles')
          .select('id,title,summary,cover_url,published_at,created_at,status,pinned,deleted_at,view_count')
          .eq('status', 'published')
          .is('deleted_at', null)
          .order('pinned', { ascending: false })
          .order('published_at', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .limit(6);
        if(e2) throw e2;
        data = d2;
        error = null;
      }
      if(error && /column .*view_count/i.test(String(error?.message || error || ''))){
        const { data: d2, error: e2 } = await supabase
          .from('articles')
          .select('id,title,summary,cover_url,published_at,created_at,status,pinned,deleted_at')
          .eq('status', 'published')
          .is('deleted_at', null)
          .order('pinned', { ascending: false })
          .order('published_at', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .limit(6);
        if(e2) throw e2;
        data = d2;
        error = null;
      }
    }

    if(error) throw error;
    renderHotArticles(data || []);
  }catch(e){
    const msg = String(e?.message || e || '');
    if(/relation .*articles.* does not exist/i.test(msg)){
      els.hotArticlesList.innerHTML = '<div class="muted small">文章表未初始化：请先在 Supabase SQL Editor 运行 MIGRATION_20260107_NEXT.sql。</div>';
      return;
    }
    els.hotArticlesList.innerHTML = `<div class="muted small">加载文章失败：${esc(msg)}</div>`;
  }
}

function fillVideoCategories(){
  if(!els.videoCategory) return;
  const cats = Array.isArray(VIDEO_CATEGORIES) ? VIDEO_CATEGORIES : [];
  const options = cats.map(c=>{
    const key = String(c?.key || '').trim();
    if(!key) return '';
    const zh = String(c?.zh || '').trim();
    const en = String(c?.en || '').trim();
    const label = zh ? (en ? `${zh} / ${en}` : zh) : (en || key);
    return `<option value="${esc(key)}">${esc(label)}<\/option>`;
  }).filter(Boolean).join('');
  els.videoCategory.innerHTML = options;
}

async function loadSpecialties(){
  if(!isConfigured() || !supabase) return;
  try{
    const { data, error } = await supabase
      .from('specialties')
      .select('id, name, code, is_active')
      .eq('is_active', true)
      .order('sort_order');
    if(error) throw error;
    _specialtiesMap.clear();
    for(const s of (data || [])){
      _specialtiesMap.set(s.id, { ...s, title: s.name });
    }
    fillSpecialtyDropdown();
  }catch(e){
    // Silently skip if table not yet migrated
    const msg = String(e?.message || '');
    if(/specialties.*does not exist/i.test(msg)) return;
    console.warn('loadSpecialties error:', e);
  }
}

function buildSpecialtyChecksHTML(selectedIds, idPrefix){
  const selected = new Set((selectedIds || []).map(String));
  const options = trainingProjectOptions(_specialtiesMap);
  if (!options.length) return '<span class="small muted">培训项目未加载，请刷新后重试。</span>';
  return options.map(project => `<label style="display:flex;align-items:center;gap:8px;min-height:44px;padding:8px 12px;border:1px solid #bdd4ee;border-radius:10px;cursor:pointer;background:#f5faff;color:#173957">
    <input type="checkbox" class="${idPrefix}-spec-check" style="width:18px;height:18px;min-height:18px;flex:0 0 18px;padding:0" value="${esc(project.id)}" ${selected.has(String(project.id)) ? 'checked' : ''} />
    <span>${esc(project.label)}</span></label>`).join('');
}

function permissionOptionsHTML(selected = '', allowLegacy = false) {
  const options = [
    ['', '请选择课程权限'],
    ['free', '免费课程 · 注册后可收听 / 观看'],
    ['member', '299 元 / 年会员 · 周日 / 周三视频回放'],
    ['training', '独立付费培训 · 仅已购对应项目的学员'],
  ];
  if (allowLegacy) options.push(['legacy', '保留当前历史权限（本次不变更）']);
  return options.map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''} ${!value ? 'disabled' : ''}>${label}</option>`).join('');
}

function updatePermissionUI(prefix) {
  const audience = document.getElementById(`${prefix}Audience`)?.value || '';
  const projectWrap = document.getElementById(`${prefix}ProjectWrap`);
  const summary = document.getElementById(`${prefix}PermissionSummary`);
  if (projectWrap) projectWrap.hidden = audience !== 'training';
  if (!summary) return;
  const names = trainingProjectOptions(_specialtiesMap)
    .filter(project => getCheckedSpecialtyIds(prefix).includes(String(project.id)))
    .map(project => project.label);
  const mediaType = document.getElementById(`${prefix}MediaType`)?.value;
  summary.textContent = audience === 'free' ? '免费课程：注册用户可收听或观看，无需购买会员或培训项目。'
    : audience === 'member' ? (mediaType === 'audio' ? '当前是音频，不能归入年度会员视频回放。请选择培训项目或免费课程。' : '年度会员专享：299 元 / 年，仅包含周日、周三学术活动的视频回放，不包含培训项目。')
    : audience === 'training' ? (names.length ? `本课程属于：${names.join('、')}。购买其中任一对应项目后可学习；仅有 299 元年度会员不能学习。` : '请至少选择一个所属培训项目。299 元年度会员不包含这些项目。')
    : audience === 'legacy' ? '保留此课程原有权限。要调整观看范围，请明确选择免费课程、年度会员回放或培训项目。'
    : '先选择课程权限，再上传和保存。单条及批量上传共用此设置。';
}

function readCoursePermissions(prefix, mediaType) {
  return buildCoursePermissions({
    audience: document.getElementById(`${prefix}Audience`)?.value || '',
    specialtyIds: getCheckedSpecialtyIds(prefix), mediaType,
    specialties: Array.from(_specialtiesMap.values()),
  });
}

function getCheckedSpecialtyIds(idPrefix){
  return Array.from(document.querySelectorAll(`.${idPrefix}-spec-check:checked`))
    .map(el => String(el.value))
    .filter(Boolean);
}

function fillSpecialtyDropdown(){
  const wrap = document.getElementById('videoSpecialtyChecks');
  if(!wrap) return;
  wrap.innerHTML = buildSpecialtyChecksHTML([], 'video');
  const filter = document.getElementById('videoAdminProjectFilter');
  if (filter) filter.innerHTML = '<option value="">全部项目</option>' + trainingProjectOptions(_specialtiesMap).map(project => `<option value="${esc(project.id)}">${esc(project.label)}</option>`).join('');
}

function checkAliyunUrlExpiry(url){
  if(!url) return { expired: false };
  try{
    const u = new URL(url);
    const exp = u.searchParams.get('Expires');
    if(!exp) return { expired: false };
    const expiresAt = new Date(Number(exp) * 1000);
    if(isNaN(expiresAt.getTime())) return { expired: false };
    return { expired: expiresAt.getTime() < Date.now(), expiresAt };
  }catch{ return { expired: false }; }
}

// ── Playback health (admin) ──
// Asks the server what Aliyun knows about each course's media id, so a course
// whose video is missing or still processing shows up in the list instead of
// being discovered by members weeks later.
const _mediaHealth = new Map();   // lower-case VOD id -> { status, title, duration }
let _mediaHealthBusy = false;
const HEALTH_LABEL = {
  Normal: ['ok', '播放源正常'],
  Uploading: ['wait', '阿里云处理中'], UploadSucc: ['wait', '阿里云处理中'],
  Transcoding: ['wait', '阿里云处理中'], Checking: ['wait', '阿里云审核中'],
  NotFound: ['bad', '阿里云找不到'], TranscodeFail: ['bad', '阿里云处理失败'],
  UploadFail: ['bad', '阿里云上传失败'], ProduceFail: ['bad', '阿里云处理失败'],
  Blocked: ['bad', '阿里云已屏蔽'], Unknown: ['unknown', '状态未知'],
};
const HEALTH_STYLE = {
  ok: 'border-color:rgba(34,197,94,.45);background:rgba(34,197,94,.08);color:#4ade80',
  wait: 'border-color:rgba(234,179,8,.5);background:rgba(234,179,8,.1);color:#fbbf24',
  bad: 'border-color:rgba(239,68,68,.6);background:rgba(239,68,68,.12);color:#f87171',
  unknown: 'border-color:rgba(160,160,160,.5);background:rgba(160,160,160,.1);color:#aaa',
};
function mediaHealthOf(v){
  if (!v || v.deleted_at || v.kind !== 'aliyun') return null;
  if (!v.aliyun_vid) return ['bad', '缺少媒体 ID'];
  const h = _mediaHealth.get(String(v.aliyun_vid).toLowerCase());
  return h ? (HEALTH_LABEL[h.status] || HEALTH_LABEL.Unknown) : null;
}
function mediaHealthBadge(v){
  const h = mediaHealthOf(v);
  return h ? `<span class="badge" style="${HEALTH_STYLE[h[0]]}" title="阿里云点播里的状态">${esc(h[1])}</span>` : '';
}
async function checkMediaHealth({ quiet = false } = {}){
  const summary = document.getElementById('videoHealthSummary');
  const btn = document.getElementById('videoHealthBtn');
  if (_mediaHealthBusy || !supabase) return;
  const ids = [...new Set(_allAdminVideos
    .filter(v => !v.deleted_at && v.kind === 'aliyun' && v.aliyun_vid)
    .map(v => String(v.aliyun_vid).toLowerCase()))];
  if (!ids.length) { if (summary) summary.textContent = ''; return; }
  _mediaHealthBusy = true;
  if (btn) btn.disabled = true;
  if (summary) summary.textContent = `正在检查 ${ids.length} 个阿里云媒体…`;
  try {
    const token = (await supabase.auth.getSession())?.data?.session?.access_token;
    if (!token) throw new Error('登录已失效，请重新登录。');
    for (let i = 0; i < ids.length; i += 200) {
      const res = await fetch('/api/videos/upload-credentials/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ videoIds: ids.slice(i, i + 200) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || data.code || data.error || `HTTP ${res.status}`);
      for (const [id, info] of Object.entries(data.results || {})) _mediaHealth.set(id, info);
    }
    renderVideoAdminList(_allAdminVideos);
    const counts = { ok: 0, wait: 0, bad: 0, unknown: 0 };
    for (const v of _allAdminVideos) { const h = mediaHealthOf(v); if (h) counts[h[0]]++; }
    if (summary) {
      const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      summary.innerHTML = `播放源：正常 ${counts.ok} · 处理中 ${counts.wait}` +
        (counts.bad ? ` · <b style="color:#f87171">异常 ${counts.bad}</b>` : ' · 异常 0') +
        (counts.unknown ? ` · 未知 ${counts.unknown}` : '') + `（${time} 检查）`;
    }
    if (!quiet && counts.bad) toast('有课程播放源异常', `共 ${counts.bad} 门，已在列表中标红。可勾选「只看播放源异常」查看。`, 'err');
  } catch (e) {
    if (summary) summary.textContent = `播放源检查暂不可用：${String(e?.message || e)}`;
  } finally {
    _mediaHealthBusy = false;
    if (btn) btn.disabled = false;
  }
}

function isDraftCourse(v){
  return !v.deleted_at && (v.enabled === false || v.is_published === false);
}

async function setCoursePublished(id, publish){
  if (!id || !supabase) return;
  const v = _allAdminVideos.find(row => row.id === id);
  if (!v) return;
  if (publish && v.kind === 'aliyun' && mediaHealthOf(v)?.[0] !== 'ok') {
    toast('暂不能上架', '播放源还不是「播放源正常」。请等阿里云处理完，点「检查播放源」后再上架。', 'err');
    return;
  }
  const question = publish
    ? `确定上架《${v.title || '未命名课程'}》吗？上架后学员即可在视频库看到。`
    : `确定下架《${v.title || '未命名课程'}》吗？学员将暂时看不到它，课程记录和观看记录都会保留。`;
  if (!confirm(question)) return;
  try {
    const { error } = await supabase.from('learning_videos')
      .update({ enabled: publish, is_published: publish, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
    toast(publish ? '已上架' : '已下架', publish ? '学员现在可以看到这门课了。' : '课程已转为草稿。', 'ok');
    await loadAdminVideos();
  } catch (e) {
    alert(`${publish ? '上架' : '下架'}失败：\n\n${String(e?.message || e?.code || e || '')}`);
  }
}

function setMediaIdLocked(locked){
  // After an upload fills the id there is nothing to type; locking the field
  // removes the chance to paste a title over it, which is how ten paid courses broke.
  const input = document.getElementById('videoAliyunVid');
  const note = document.getElementById('videoAliyunVidLockNote');
  if (input) input.readOnly = !!locked;
  if (note) note.style.display = locked ? 'flex' : 'none';
}

function renderVideoAdminList(rows){
  if(!els.videoAdminList) return;
  const showDeleted = els.showDeletedVideos?.checked || false;
  const search = String(document.getElementById('videoAdminSearch')?.value || '').trim().toLocaleLowerCase();
  const audienceFilter = document.getElementById('videoAdminAudienceFilter')?.value || '';
  const mediaFilter = document.getElementById('videoAdminMediaFilter')?.value || '';
  const projectFilter = document.getElementById('videoAdminProjectFilter')?.value || '';
  const onlyBadHealth = !!document.getElementById('videoHealthOnlyBad')?.checked;
  const onlyDrafts = !!document.getElementById('videoOnlyDrafts')?.checked;
  const list = (Array.isArray(rows) ? rows : []).filter(v => {
    if(v.deleted_at && !showDeleted) return false;
    if (search && ![v.title, v.speaker, v.series_title].some(value => String(value || '').toLocaleLowerCase().includes(search))) return false;
    const permission = coursePermissionForVideo(v);
    if (audienceFilter && permission.audience !== audienceFilter) return false;
    if (mediaFilter && courseMediaType(v) !== mediaFilter) return false;
    if (projectFilter && !permission.specialtyIds.includes(projectFilter)) return false;
    if (onlyBadHealth && mediaHealthOf(v)?.[0] !== 'bad') return false;
    if (onlyDrafts && !isDraftCourse(v)) return false;
    return true;
  });
  const count = document.getElementById('videoAdminCount');
  if (count) count.textContent = `找到 ${list.length} 条课程 · 已加载 ${Array.isArray(rows) ? rows.length : 0} 条`;
  if (!list.length && (search || audienceFilter || mediaFilter || projectFilter || onlyBadHealth || onlyDrafts)) {
    els.videoAdminList.innerHTML = '<div class="muted small">没有符合筛选条件的课程，请清空搜索或调整筛选。</div>';
    return;
  }
  if(!list.length){
    const hasDeleted = (Array.isArray(rows) ? rows : []).some(v => !!v.deleted_at);
    els.videoAdminList.innerHTML = hasDeleted
      ? '<div class="muted small">暂无活跃课程。勾选"显示已删除"可查看已删除项。</div>'
      : '<div class="muted small">暂无新增课程。</div>';
    return;
  }

  const catMap = new Map((Array.isArray(VIDEO_CATEGORIES) ? VIDEO_CATEGORIES : []).map(c=>[String(c.key), c]));

  els.videoAdminList.innerHTML = list.map(v=>{
    const isDeleted = !!v.deleted_at;
    const cat = catMap.get(String(v.category || ''));
    const tag = cat ? (String(cat.zh || '').trim() ? `${String(cat.zh).trim()}${cat.en ? ' / ' + String(cat.en).trim() : ''}` : (cat.en || cat.key)) : (v.category || '未分类');
    const kindLabel = v.kind === 'mp4' ? 'MP4' : (v.kind === 'bilibili' ? 'B站' : (v.kind === 'aliyun' ? '阿里云' : '链接'));
    const openUrl = (v.kind === 'mp4' || v.kind === 'aliyun') ? (v.mp4_url || v.source_url || '') : (v.source_url || '');

    // Check URL expiry for aliyun/mp4 URLs
    const expiry = checkAliyunUrlExpiry(v.mp4_url || v.source_url || '');
    const expiredBadge = expiry.expired
      ? `<span class="badge" style="border-color:rgba(255,100,100,.6);background:rgba(255,100,100,.1);color:#f66">链接已过期</span>`
      : '';
    const deletedBadge = isDeleted
      ? `<span class="badge" style="border-color:rgba(160,160,160,.5);background:rgba(160,160,160,.12);color:#aaa">已删除</span>`
      : '';
    const accessLevel = courseAccessLevel(v);
    const paidBadge = ['paid', 'member', 'training'].includes(accessLevel)
      ? `<span class="badge" style="border-color:rgba(234,179,8,.5);background:rgba(234,179,8,.1);color:#fbbf24">付费</span>`
      : accessLevel === 'free' ? `<span class="badge" style="border-color:rgba(34,197,94,.4);background:rgba(34,197,94,.08);color:#4ade80">免费</span>`
      : '<span class="badge badge-unknown">权限待确认</span>';
    const legacyBadge = coursePermissionForVideo(v).audience === 'legacy'
      ? '<span class="badge badge-unknown">历史权限待确认</span>' : '';
    const memberBadge = courseAccessLevel(v) === 'member'
      ? `<span class="badge" style="border-color:rgba(168,85,247,.5);background:rgba(168,85,247,.1);color:#c084fc">会员学术回放</span>`
      : '';
    const specIds = (Array.isArray(v.specialty_ids) && v.specialty_ids.length > 0)
      ? v.specialty_ids
      : (v.specialty_id ? [v.specialty_id] : []);
    const specBadge = specIds
      .map(id => _specialtiesMap.get(id)?.title)
      .filter(Boolean)
      .map(name => `<span class="badge" style="border-color:rgba(99,102,241,.4);background:rgba(99,102,241,.08);color:#818cf8">${esc(name)}</span>`)
      .join(' ');
    const speakerText = v.speaker ? `主讲：${esc(v.speaker)} · ` : '';
    const media = courseMediaType(v), duration = formatCourseDuration(v);
    const mediaBadge = `<span class="badge badge-media ${media === 'audio' ? 'badge-audio' : ''}">${courseMediaIcon(v)}${media === 'audio' ? '音频' : media === 'video' ? '视频' : '形式待确认'}</span>`;

    const cardStyle = isDeleted
      ? 'padding:12px;opacity:0.5;border-left:3px solid rgba(160,160,160,.4)'
      : 'padding:12px';

    const actionBtn = isDeleted
      ? `<button class="btn tiny" type="button" data-video-restore="${esc(v.id)}">恢复</button>
         <button class="btn tiny danger" type="button" data-video-purge="${esc(v.id)}" data-aliyun-vid="${esc(v.aliyun_vid || '')}" title="从数据库和阿里云一起删除, 不可恢复">永久删除</button>`
      : `<button class="btn tiny danger" type="button" data-video-del="${esc(v.id)}">删除</button>`;

    return `
      <div class="card" style="${cardStyle}">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
          <div style="min-width:0;flex:1">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
              <b style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px${isDeleted ? ';text-decoration:line-through' : ''}">${esc(v.title || '（无标题）')}</b>
              ${isDraftCourse(v) ? '<span class="badge" style="border-color:rgba(251,146,60,.6);background:rgba(251,146,60,.12);color:#fb923c">草稿 · 未上架</span>' : ''}${mediaHealthBadge(v)}${paidBadge}${memberBadge}${specBadge}${legacyBadge}${deletedBadge}${expiredBadge}
            </div>
            <div class="small muted" style="margin-top:6px">
              ${speakerText}${esc(tag)} · ${esc(kindLabel)} · ${esc(fmtDate(v.created_at))}
            </div>
            <div class="small muted" style="margin-top:6px">${mediaBadge}${duration ? ` <span class="badge badge-duration">${esc(duration)}</span>` : ''}${v.series_title ? ` · ${esc(v.series_title)}` : ' · 独立课程'}${v.chapter_number ? ` · 第 ${esc(v.chapter_number)} 章` : ''}</div>
            <div class="small" style="margin-top:6px;word-break:break-all">${openUrl ? `<a class="auto-link" href="${esc(openUrl)}" target="_blank" rel="noopener">${esc(openUrl.length > 80 ? openUrl.slice(0,80) + '…' : openUrl)}</a>` : ''}</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex-shrink:0">
            ${isDeleted ? '' : (isDraftCourse(v)
              ? (v.kind === 'aliyun' && mediaHealthOf(v)?.[0] !== 'ok'
                  ? `<button class="btn tiny" type="button" disabled title="播放源正常后才能上架">上架</button>`
                  : `<button class="btn tiny primary" type="button" data-video-publish="${esc(v.id)}">上架</button>`)
              : `<button class="btn tiny" type="button" data-video-unpublish="${esc(v.id)}">下架</button>`)}
            ${isDeleted ? '' : `<button class="btn tiny" type="button" data-video-edit="${esc(v.id)}">编辑权限 / 信息</button>`}
            ${isDeleted ? '' : `<a class="btn tiny" href="watch.html?id=${encodeURIComponent(v.id)}">${media === 'audio' ? '试听' : media === 'video' ? '试看' : '预览'}</a>`}
            ${actionBtn}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function loadAdminVideos(){
  if(!els.videoAdminList) return;
  // Only a complete administrative read may populate editable records.
  _allAdminVideos = [];
  els.videoAdminList.innerHTML = '<div class="muted small">正在加载课程管理信息…</div>';
  if(!isConfigured()){
    els.videoAdminList.innerHTML = '<div class="muted small">（演示模式）配置 Supabase 后可管理视频。</div>';
    return;
  }

  try{
    await ensureSupabase();
    if(!supabase) throw new Error('课程服务暂不可用，请稍后重试。');
    const completeRows = new Map();
    const pageSize = 200;
    let offset = 0;
    for (let page = 0; page < 100; page++) {
      const { data, error, count } = await supabase.rpc('list_learning_videos_admin', {}, { count: 'exact' })
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (error) throw courseMetadataSchemaError(error) || error;
      if (!Array.isArray(data)) throw new Error('课程列表返回格式异常，请重试。');
      for (const row of data) {
        if (completeRows.has(row.id)) throw new Error('课程列表在加载期间发生变动，请重试以获取完整列表。');
        completeRows.set(row.id, row);
      }
      offset += data.length;
      if (Number.isInteger(count) && offset >= count) break;
      if (!data.length) {
        if (Number.isInteger(count) && offset < count) throw new Error('课程列表尚未完整返回，请重试。');
        break;
      }
      if (page === 99) throw new Error('课程数量超过当前管理列表上限，请联系技术支持扩展分页。');
    }
    _allAdminVideos = [...completeRows.values()];
    renderVideoAdminList(_allAdminVideos);
    void checkMediaHealth({ quiet: true });
  }catch(e){
    _allAdminVideos = [];
    const schemaMissing = ['42703', '42883', 'PGRST202', 'PGRST204', 'course_metadata_schema_required'].includes(String(e?.code));
    const msg = schemaMissing ? '课程管理所需的权限或系列字段尚未完成数据库更新，暂不能编辑。请管理员完成更新后点击重试。已上传媒体和当前队列会保留。' : String(e?.message || e || '');
    if(/relation .*learning_videos.* does not exist/i.test(msg)){
      els.videoAdminList.innerHTML = '<div class="muted small">视频表未初始化：请先运行本次迁移（learning_videos）。</div>';
      return;
    }
    els.videoAdminList.innerHTML = `<div class="muted small">加载失败：${esc(msg)}</div>`;
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn tiny'; retry.textContent = '重试课程管理列表';
    retry.addEventListener('click', () => { void loadAdminVideos(); }); els.videoAdminList.append(retry);
  }
}

async function saveVideo(currentUser, publish = true){
  if(!els.videoSave) return;
  if(_mediaSaveInProgress) return;
  if(_batchBusy){ toast('批量上传正在处理', '请等待完成或停止后再保存单条课程。', 'err'); return; }
  if(_currentUpload){ toast('文件正在上传', '请等待上传完成后保存课程。', 'err'); return; }
  if(!els.videoTitle || !els.videoCategory) return;
  if(!isConfigured()){
    toast('未配置', 'Supabase 未配置。', 'err');
    return;
  }

  const title = String(els.videoTitle.value || '').trim();
  const category = String(els.videoCategory.value || '').trim();
  const sourceType = String(els.videoSourceType?.value || 'aliyun_vod').trim();
  let url = String(els.videoUrl?.value || '').trim();
  const file = els.videoMp4?.files?.[0] || null;
  let aliyunUrl = String(els.videoAliyunUrl?.value || '').trim();
  let aliyunVid = String(els.videoAliyunVid?.value || '').trim();
  const description = String(els.videoDescription?.value || '').trim() || null;
  const coverImage = String(els.videoCoverImage?.value || '').trim() || null;
  const sortOrder = parseInt(els.videoSortOrder?.value || '0', 10) || 0;
  const localMetadata = els.videoAliyunVid?.ksMediaMetadata;
  const uploadedMetadata = sourceType === 'aliyun_vod' && localMetadata?.videoId === aliyunVid ? localMetadata : null;
  const intendedMediaType = uploadedMetadata?.mediaType || (['upload_mp4', 'bilibili'].includes(sourceType) ? 'video' : els.videoMediaType?.value || null);

  if(!title){ toast('请输入名称', '请填写课程名称。', 'err'); return; }
  if(!category){ toast('请选择分类', '请先选择一个课程分类。', 'err'); return; }

  // Validate based on source type
  if(sourceType === 'aliyun_vod' && !aliyunVid){
    toast('请填写阿里云媒体 ID', '请先上传视频或音频，也可以填写已有的媒体 ID。', 'err');
    return;
  }
  // 只接受阿里云媒体 ID 的格式（32 位 0-9a-f）。以前这里什么都收，课程名称或阿里云里
  // 显示的"名称"被当成 ID 存进去，播放时阿里云找不到视频，会员只能看到"没有可用的播放源"。
  if(sourceType === 'aliyun_vod'){
    const normalizedVid = aliyunVid.toLowerCase();
    if(!/^[0-9a-f]{32}$/.test(normalizedVid)){
      toast('阿里云媒体 ID 不正确',
        '这里只能填 32 位字母和数字（阿里云点播控制台视频标题下方"ID:"后面那一串），不能填视频名称或课程名称。最稳妥的做法是点「上传视频 / 音频」，由系统自动填写。',
        'err');
      els.videoAliyunVid?.focus?.();
      return;
    }
    aliyunVid = normalizedVid;
  }
  if((sourceType === 'external_url' || sourceType === 'bilibili') && !url){
    toast('请填写视频链接', '', 'err');
    return;
  }
  if(sourceType === 'upload_mp4' && !file){
    toast('请选择 MP4 文件', '', 'err');
    return;
  }

  // Detect HTML embed code pasted by mistake
  const allInput = url || aliyunUrl || '';
  if(looksLikeHtml(allInput)){
    const extractedVid = extractAliyunVid(allInput);
    if(extractedVid){
      toast('请粘贴播放地址',
        '检测到你粘贴了阿里云的 HTML 嵌入代码（已自动提取视频 ID：' + extractedVid + '）。',
        'err');
      if(els.videoAliyunVid) els.videoAliyunVid.value = extractedVid;
      if(looksLikeHtml(url) && els.videoUrl) els.videoUrl.value = '';
      if(looksLikeHtml(aliyunUrl) && els.videoAliyunUrl) els.videoAliyunUrl.value = '';
    }else{
      toast('格式错误', '检测到粘贴了 HTML 代码。请粘贴视频的播放地址。', 'err');
    }
    return;
  }

  try {
    if (!intendedMediaType) throw new Error('请选择媒体类型（音频或视频）；本地上传会自动识别。');
    readCoursePermissions('video', intendedMediaType);
  } catch (error) { toast('请确认课程权限', String(error?.message || error), 'err'); return; }

  _mediaSaveInProgress = true;
  const batchPanel = document.getElementById('mediaBatchPanel');
  if(batchPanel) batchPanel.disabled = true;
  const uploadButton = document.getElementById('videoAliyunFileBtn');
  const uploadWasDisabled = uploadButton?.disabled || false;
  if(uploadButton) uploadButton.disabled = true;
  els.videoSave.disabled = true;
  if(els.videoSaveDraft) els.videoSaveDraft.disabled = true;
  if(els.videoAdminHint) els.videoAdminHint.textContent = '保存中…';

  try{
    await ensureSupabase();
    if(!supabase) throw new Error('Supabase 未就绪，请稍后重试。');
    let kind = 'external';
    let source_url = url || null;
    let bvid = null;
    let mp4_url = null;
    let aliyun_vid = aliyunVid || null;
    let metadata = courseUploadMetadata({ mediaType: intendedMediaType,
      duration: uploadedMetadata?.durationSeconds });

    if(sourceType === 'aliyun_vod'){
      kind = 'aliyun';
      // VOD playback uses this media ID and the existing authorization API.
      // The debug URL must never become a stale fallback for a new audio file.
      source_url = null;
      mp4_url = null;
    }else if(sourceType === 'upload_mp4' && file){
      const validation = validateMediaFile(file);
      if (validation.error || validation.mediaType !== 'video') throw new Error(validation.error || '请选择有效的视频文件。');
      metadata = courseUploadMetadata({ mediaType: validation.mediaType,
        duration: await readLocalMediaDuration(file, validation.mediaType) });
      if((file.size || 0) > MAX_MP4_BYTES){
        const mb = Math.round((file.size || 0) / 1024 / 1024);
        toast('文件过大', `当前 ${mb}MB，超过上限 50MB。`, 'err');
        return;
      }
      kind = 'mp4';
      const key = `${currentUser.id}/mp4/${Date.now()}_${Math.random().toString(16).slice(2)}_${safeFilename(file.name)}`;
      const up = await supabase.storage.from('learning_videos').upload(key, file, {
        upsert: false,
        contentType: file.type || 'video/mp4',
        cacheControl: '3600',
      });
      if(up?.error) throw up.error;
      const { data: pu } = supabase.storage.from('learning_videos').getPublicUrl(key);
      mp4_url = pu?.publicUrl || null;
      source_url = mp4_url;
    }else if(sourceType === 'bilibili'){
      const bv = extractBvid(url);
      if(bv){
        kind = 'bilibili';
        bvid = bv;
      }else{
        kind = 'external';
      }
    }else{
      kind = 'external';
    }

    const permissions = readCoursePermissions('video', metadata.media_type);
    const speaker = String(els.videoSpeaker?.value || '').trim() || null;
    const contentSource = String(els.videoContentSource?.value || 'external').trim();

    const row = {
      title, category, kind, source_url, mp4_url, bvid,
      source: contentSource,
      enabled: publish, deleted_at: null, created_by: currentUser.id,
      ...permissions,
      is_published: publish,
      sort_order: sortOrder,
      ...metadata,
    };
    if(speaker) row.speaker = speaker;
    if(aliyun_vid) row.aliyun_vid = aliyun_vid;
    if(description) row.description = description;
    if(coverImage) row.cover_image = coverImage;

    const { error } = await supabase.from('learning_videos').insert(row);
    // Every source keeps its original access and media metadata on schema failure.
    if(error) throw courseMetadataSchemaError(error) || error;

    toast('已保存', publish ? '课程已添加并上架。' : '课程已保存为草稿。', 'ok');
    // Reset form
    if(els.videoTitle) els.videoTitle.value = '';
    if(els.videoUrl) els.videoUrl.value = '';
    if(els.videoMp4) els.videoMp4.value = '';
    if(els.videoAliyunUrl) els.videoAliyunUrl.value = '';
    if(els.videoAliyunVid) { els.videoAliyunVid.value = ''; delete els.videoAliyunVid.ksMediaMetadata; }
    setMediaIdLocked(false);
    if(els.videoMediaType) els.videoMediaType.value = '';
    if(els.videoSpeaker) els.videoSpeaker.value = '';
    document.querySelectorAll('.video-spec-check:checked').forEach(el => { el.checked = false; });
    if(els.videoDescription) els.videoDescription.value = '';
    if(els.videoCoverImage) els.videoCoverImage.value = '';
    if(els.videoSortOrder) els.videoSortOrder.value = '0';
    if(els.videoAudience) els.videoAudience.value = '';
    updatePermissionUI('video');

    await loadAdminVideos();
  }catch(e){
    const msg = String(e?.message || e || '');
    if(/bucket .*learning_videos.* does not exist/i.test(msg) || /The resource was not found/i.test(msg)){
      toast('未初始化 Bucket', '请先创建 Storage bucket: learning_videos，并配置读写策略。', 'err');
      return;
    }
    toast('保存失败', msg, 'err');
  }finally{
    _mediaSaveInProgress = false;
    if(batchPanel) batchPanel.disabled = false;
    if(uploadButton) uploadButton.disabled = uploadWasDisabled;
    els.videoSave.disabled = false;
    if(els.videoSaveDraft) els.videoSaveDraft.disabled = false;
    if(els.videoAdminHint) els.videoAdminHint.textContent = '';
  }
}

async function deleteVideo(id){
  if(!id) return;
  if(!isConfigured() || !supabase) return;
  if(!confirm('确定删除这个视频吗？（会从前台列表隐藏）')) return;
  try{
    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from('learning_videos')
      .update({ deleted_at: nowIso })
      .eq('id', id);
    if(error) throw error;
    toast('已删除', '已从视频库移除。', 'ok');
    await loadAdminVideos();
  }catch(e){
    const rawMsg = String(e?.message || e?.code || e || '');
    console.error('[deleteVideo] raw error:', e);
    alert('删除失败（管理员可见原始错误）:\n\n' + rawMsg);
  }
}

async function purgeVideo(id, aliyunVid){
  if(!id) return;
  if(!isConfigured() || !supabase) return;
  if(!confirm('⚠️ 永久删除这个视频？\n\n会同时清理:\n· 数据库记录 (不可恢复)\n· 阿里云 VOD 文件 (省存储费)\n\n确定继续吗？')) return;
  try{
    // 1. 先删阿里云视频文件 (best effort, 失败也继续删 DB)
    if(aliyunVid){
      try {
        const sess = (await supabase.auth.getSession())?.data?.session;
        const token = sess?.access_token;
        if(token){
          const r = await fetch('/api/videos/upload-credentials/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ videoId: aliyunVid }),
          });
          if(!r.ok){
            const rd = await r.json().catch(() => ({}));
            console.warn('[purgeVideo] aliyun delete failed:', rd);
          }
        }
      } catch(e){ console.warn('[purgeVideo] aliyun delete exception:', e); }
    }
    // 2. 硬删 DB 行
    const { error } = await supabase
      .from('learning_videos')
      .delete()
      .eq('id', id);
    if(error) throw error;
    toast('已永久删除', aliyunVid ? '数据库 + 阿里云 VOD 都已清理。' : '数据库已清理。', 'ok');
    await loadAdminVideos();
  }catch(e){
    const rawMsg = String(e?.message || e?.code || e || '');
    console.error('[purgeVideo] raw error:', e);
    alert('永久删除失败（管理员可见原始错误）:\n\n' + rawMsg);
  }
}

async function restoreVideo(id){
  if(!id) return;
  if(!isConfigured() || !supabase) return;
  if(!confirm('确定恢复这个视频吗？（会重新出现在前台列表）')) return;
  try{
    const { error } = await supabase
      .from('learning_videos')
      .update({ deleted_at: null })
      .eq('id', id);
    if(error) throw error;
    toast('已恢复', '视频已恢复到前台列表。', 'ok');
    await loadAdminVideos();
  }catch(e){
    const rawMsg = String(e?.message || e?.code || e || '');
    console.error('[restoreVideo] raw error:', e);
    alert('恢复失败（管理员可见原始错误）:\n\n' + rawMsg);
  }
}

// ── Edit video (inline modal) ──
let _editingVideoId = null;
let _editNewSeriesId = null;

function openEditModal(videoId){
  const v = _allAdminVideos.find(r => r.id === videoId);
  if(!v) return;
  _editingVideoId = videoId;
  _editNewSeriesId = null;

  // Remove existing modal if any
  document.getElementById('videoEditModal')?.remove();

  const cats = Array.isArray(VIDEO_CATEGORIES) ? VIDEO_CATEGORIES : [];
  const catOptions = cats.map(c => {
    const key = String(c?.key || '');
    const label = `${c.zh || ''} / ${c.en || ''}`;
    return `<option value="${esc(key)}" ${key === (v.category || '') ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');

  const currentPermission = coursePermissionForVideo(v);
  const specChecksHTML = buildSpecialtyChecksHTML(currentPermission.specialtyIds, 'edit');
  const detectedMediaType = v.media_type || ''; // Never rewrite historical metadata from display-only inference.

  const curSource = v.source || 'external';
  const sourceOptions = [
    { value: 'glomcon',     label: 'GlomCon 中国' },
    { value: 'kidneysphere',label: '肾域原创' },
    { value: 'external',    label: '外部资源' },
  ].map(o => `<option value="${o.value}" ${o.value === curSource ? 'selected' : ''}>${o.label}</option>`).join('');
  const seriesChoices = new Map();
  for (const row of _allAdminVideos) if (row.series_id && row.series_title && !row.deleted_at) seriesChoices.set(row.series_id, row.series_title);
  if (v.series_id) seriesChoices.set(v.series_id, v.series_title || '未命名系列');
  const seriesOptions = [...seriesChoices].map(([id, name]) =>
    `<option value="${esc(id)}" ${id === v.series_id ? 'selected' : ''}>${esc(name)} · ${esc(id.slice(-8))}</option>`).join('');

  const modal = document.createElement('div');
  modal.id = 'videoEditModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);padding:16px';
  modal.innerHTML = `
    <div class="card" style="max-width:640px;width:100%;max-height:90vh;overflow-y:auto;padding:20px">
      <h3 style="margin:0 0 12px">编辑课程</h3>
      <div class="form" style="display:flex;flex-direction:column;gap:12px">
        <div>
          <label>课程名称</label>
          <input class="input" id="editTitle" value="${esc(v.title || '')}" />
        </div>
        <div class="form-row">
          <div style="flex:1;min-width:180px">
            <label>主讲人</label>
            <input class="input" id="editSpeaker" value="${esc(v.speaker || '')}" />
          </div>
          <div style="min-width:200px">
            <label>频道</label>
            <select class="input" id="editCategory">${catOptions}</select>
          </div>
        </div>
        <div>
          <label>媒体链接 / 阿里云地址</label>
          <input class="input" id="editUrl" value="${esc(v.mp4_url || v.source_url || '')}" />
        </div>
        <div>
          <label for="editSeriesId">所属课程系列</label>
          <select class="input" id="editSeriesId"><option value="">独立课程</option>${seriesOptions}<option value="__new__">创建新系列</option></select>
          <p class="small muted">将旧章节归入同一系列时，请选择同一个已有系列。仅修改当前课程，不合并或删除重复章节。</p>
        </div>
        <div id="editSeriesTitleWrap" ${v.series_id ? '' : 'hidden'}>
          <label for="editSeriesTitle">课程系列名称</label>
          <input class="input" id="editSeriesTitle" maxlength="200" value="${esc(v.series_title || '')}" />
          <p class="small muted">名称随当前章节保存，系列归属以所选系列为准。</p>
        </div>
        <div class="form-row">
          <div style="min-width:140px;flex:1"><label for="editChapterNumber">章节序号（可选）</label><input class="input" id="editChapterNumber" type="number" min="1" step="1" value="${esc(v.chapter_number ?? '')}" /></div>
          <div style="min-width:180px;flex:1"><label for="editMediaType">媒体类型</label><select class="input" id="editMediaType"><option value="">未知 / 暂不指定</option><option value="audio" ${detectedMediaType === 'audio' ? 'selected' : ''}>音频</option><option value="video" ${detectedMediaType === 'video' ? 'selected' : ''}>视频</option></select></div>
        </div>
        <div class="form-row">
          <div style="min-width:180px">
            <label>内容来源</label>
            <select class="input" id="editContentSource">${sourceOptions}</select>
          </div>
        </div>
        <div>
          <label for="editAudience">课程权限 *</label>
          <select class="input" id="editAudience">${permissionOptionsHTML(currentPermission.audience, currentPermission.audience === 'legacy')}</select>
        </div>
        <div id="editProjectWrap" ${currentPermission.audience === 'training' ? '' : 'hidden'}>
          <label>所属付费培训项目（可多选）</label>
          <div id="editSpecialtyChecks" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:8px">${specChecksHTML}</div>
        </div>
        <p class="small" id="editPermissionSummary" role="status" aria-live="polite" style="margin:0;padding:12px;background:#edf5ff;border:1px solid #bdd4ee;border-radius:10px;color:#244f75"></p>
        <div>
          <label for="editPreviewVid">独立试看 / 试听媒资 ID（可选）</label>
          <input class="input" id="editPreviewVid" maxlength="128" autocomplete="off" placeholder="填入已单独上传的阿里云短片 ID" />
          <p class="small muted">请先单独上传本课程开头的短片，最长 180 秒，且必须短于正片、使用不同媒资 ID。留空保留当前设置，保存后由服务端核验可否试听或试看。</p>
          <button class="btn tiny" type="button" id="editSavePreviewBtn">设置独立试看 / 试听</button>
          <button class="btn tiny" type="button" id="editClearPreviewBtn">清除当前试看 / 试听</button>
          <p class="small muted" id="editPreviewStatus" role="status" aria-live="polite"></p>
        </div>
        <div style="display:flex;gap:10px;margin-top:4px">
          <button class="btn primary" type="button" id="editSaveBtn">保存修改</button>
          <button class="btn" type="button" id="editCancelBtn">取消</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  ['editAudience', 'editSpecialtyChecks', 'editMediaType'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => updatePermissionUI('edit'));
  });
  updatePermissionUI('edit');

  // Close on backdrop click
  modal.addEventListener('click', (e) => { if(e.target === modal) closeEditModal(); });
  document.getElementById('editCancelBtn').addEventListener('click', closeEditModal);
  document.getElementById('editSaveBtn').addEventListener('click', saveEdit);
  document.getElementById('editSavePreviewBtn').addEventListener('click', () => saveCoursePreview(v, false));
  document.getElementById('editClearPreviewBtn').addEventListener('click', () => saveCoursePreview(v, true));
  document.getElementById('editSeriesId').addEventListener('change', event => {
    const choice = event.target.value;
    document.getElementById('editSeriesTitleWrap').hidden = !choice;
    document.getElementById('editSeriesTitle').value = seriesChoices.get(choice) || '';
  });

}

async function saveCoursePreview(course, clear) {
  const input = document.getElementById('editPreviewVid');
  const status = document.getElementById('editPreviewStatus');
  const buttons = [document.getElementById('editSavePreviewBtn'), document.getElementById('editClearPreviewBtn')];
  const previewId = clear ? null : String(input?.value || '').trim();
  if (!clear && !/^[A-Za-z0-9_-]{16,128}$/.test(previewId)) { status.textContent = '请填写有效的独立试看 / 试听媒资 ID。'; return; }
  if (!clear && previewId === course.aliyun_vid) { status.textContent = '试看 / 试听必须使用独立短媒资，不能填写正片 ID。'; return; }
  buttons.forEach(button => { if (button) button.disabled = true; });
  status.textContent = '正在保存试看 / 试听设置…';
  try {
    const { error } = await supabase.rpc('set_learning_video_preview', { p_video_id: course.id, p_preview_aliyun_vid: previewId });
    if (error) throw error;
    input.value = '';
    status.textContent = clear ? '已清除本课程试看 / 试听设置。' : '独立媒资已保存，服务端核验时长与格式后提供试看 / 试听。';
  } catch (error) {
    status.textContent = ['42883', 'PGRST202'].includes(String(error?.code))
      ? '请先安装数据库更新，再保存试看 / 试听设置。'
      : '试看 / 试听设置未保存，请检查管理员权限和媒资 ID 后重试。';
  } finally { buttons.forEach(button => { if (button) button.disabled = false; }); }
}

function closeEditModal(){
  _editingVideoId = null;
  _editNewSeriesId = null;
  document.getElementById('videoEditModal')?.remove();
}

async function saveEdit(){
  if(!_editingVideoId || !supabase) return;
  const btn = document.getElementById('editSaveBtn');
  if(btn) btn.disabled = true;

  const title = String(document.getElementById('editTitle')?.value || '').trim();
  const speaker = String(document.getElementById('editSpeaker')?.value || '').trim() || null;
  const category = String(document.getElementById('editCategory')?.value || '').trim();
  const urlVal = String(document.getElementById('editUrl')?.value || '').trim();
  const contentSource = String(document.getElementById('editContentSource')?.value || 'external').trim();
  const audience = document.getElementById('editAudience')?.value || '';
  const existing = _allAdminVideos.find(row => String(row.id) === String(_editingVideoId));

  if(!title){ toast('请输入名称', '', 'err'); if(btn) btn.disabled = false; return; }

  try{
    const seriesChoice = document.getElementById('editSeriesId')?.value || '';
    const seriesTitle = seriesChoice ? String(document.getElementById('editSeriesTitle')?.value || '').trim() : '';
    if (seriesChoice && !seriesTitle) throw new Error('请填写课程系列名称。');
    if (seriesChoice === '__new__' && !_editNewSeriesId) _editNewSeriesId = createCourseSeriesId();
    const metadata = courseUploadMetadata({ seriesId: seriesChoice === '__new__' ? _editNewSeriesId : seriesChoice,
      seriesTitle, chapterNumber: document.getElementById('editChapterNumber')?.value,
      mediaType: document.getElementById('editMediaType')?.value || null });
    if (!existing) throw new Error('课程资料已失效，请重新打开编辑窗口。');
    const originalPermission = coursePermissionForVideo(existing);
    if (audience === 'legacy' && originalPermission.audience !== 'legacy') throw new Error('请选择有效的课程权限。');
    const mediaTypeChanged = (metadata.media_type || null) !== (existing.media_type || null);
    if (audience === 'legacy' && mediaTypeChanged) throw new Error('修改媒体类型时，请同时明确选择课程权限。');
    const chosenPermission = audience === 'legacy' ? null : readCoursePermissions('edit', metadata.media_type);
    const permissionChanged = audience !== originalPermission.audience || mediaTypeChanged || (audience === 'training'
      && JSON.stringify([...chosenPermission.specialty_ids].sort()) !== JSON.stringify([...originalPermission.specialtyIds].sort()));
    if (permissionChanged && !metadata.media_type) throw new Error('调整权限前，请明确选择本课程是音频还是视频。');
    const permissions = chosenPermission && permissionChanged ? chosenPermission : {};
    const updates = {
      title,
      speaker,
      category,
      source: contentSource,
      ...permissions,
      updated_at: new Date().toISOString(),
      ...metadata,
    };

    // Detect URL type and update accordingly
    if(urlVal && urlVal !== String(existing.mp4_url || existing.source_url || '').trim()){
      if(/aliyuncs\.com|alicdn\.com|aliyun\.com/i.test(urlVal)){
        updates.kind = 'aliyun';
        updates.mp4_url = urlVal;
        updates.source_url = urlVal;
      } else if(extractBvid(urlVal)){
        updates.kind = 'bilibili';
        updates.bvid = extractBvid(urlVal);
        updates.source_url = urlVal;
      } else {
        updates.kind = 'external';
        updates.source_url = urlVal;
      }
    }

    const { data: saved, error } = await supabase
      .from('learning_videos')
      .update(updates)
      .eq('id', _editingVideoId)
      .select('id')
      .maybeSingle();
    if(error) throw courseMetadataSchemaError(error) || error;
    if (!saved?.id) throw new Error('未确认课程更新，请检查当前账号的编辑权限后重试。');

    toast('已更新', '课程信息已保存。', 'ok');
    closeEditModal();
    await loadAdminVideos();
  }catch(e){
    toast('更新失败', String(e?.message || e || ''), 'err');
  }finally{
    if(btn) btn.disabled = false;
  }
}

async function init(){
  console.log('[LC] init() start');
  // Hot articles are public
  loadHotArticles();

  // Admin video panel
  if(!els.videoAdminPanel){ console.log('[LC] no videoAdminPanel element'); return; }
  fillVideoCategories();

  if(!isConfigured()){ console.log('[LC] not configured'); return; }
  await ensureSupabase();
  console.log('[LC] supabase ready');

  // Wait for Supabase auth session to be restored from localStorage
  let user = await getCurrentUser();
  console.log('[LC] getCurrentUser:', user?.email || 'null');
  if(!user){
    console.log('[LC] waiting for auth state change...');
    // Session may not be restored yet; wait for auth state change
    user = await new Promise((resolve)=>{
      const { data:{ subscription } } = supabase.auth.onAuthStateChange((_event, session)=>{
        console.log('[LC] auth event:', _event, session?.user?.email || 'no user');
        subscription.unsubscribe();
        resolve(session?.user || null);
      });
      // Timeout after 3 seconds if no auth event
      setTimeout(()=>{ console.log('[LC] auth timeout'); subscription.unsubscribe(); resolve(null); }, 3000);
    });
  }
  if(!user){ console.log('[LC] no user, abort'); return; }
  const profile = await getUserProfile(user);
  const role = normalizeRole(profile?.role);
  const isAdmin = isAdminRole(role);
  console.log('[LC] role:', role, 'isAdmin:', isAdmin);
  if(!isAdmin){ console.log('[LC] not admin, abort'); return; }

  // Dynamically inject admin video panel HTML only when admin is authenticated
  if(els.videoAdminPanel && !document.getElementById('videoAddForm')){
    els.videoAdminPanel.innerHTML = `
        <div class="card soft" style="margin-top:12px">
          <h3 style="margin:0">新增视频 / 音频</h3>
          <div class="hr"></div>
          <form id="videoAddForm" class="form" style="max-width:860px">
            <div class="form-row">
              <div style="flex:1;min-width:240px">
                <label for="videoTitle">课程名称 *</label>
                <input class="input" id="videoTitle" required />
              </div>
              <div style="min-width:220px">
                <label>频道 *</label>
                <select class="input" id="videoCategory" required></select>
              </div>
            </div>

            <fieldset style="margin:0;padding:16px;border:1px solid #bdd4ee;border-radius:14px;background:#f5faff;min-width:0">
              <legend style="font-weight:700;color:#173957">本次上传的课程权限</legend>
              <label for="videoAudience">谁可以收听 / 观看？ *</label>
              <select class="input" id="videoAudience" required>${permissionOptionsHTML()}</select>
              <div id="videoProjectWrap" hidden style="margin-top:14px">
                <label>所属付费培训项目（可多选） *</label>
                <div id="videoSpecialtyChecks" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:8px"></div>
              </div>
              <p class="small" id="videoPermissionSummary" role="status" aria-live="polite" style="margin:12px 0 0;color:#244f75"></p>
              <p class="small muted" style="margin:8px 0 0">这些设置同时用于下方批量上传。保存后可在课程列表中随时点击“编辑权限 / 信息”。</p>
            </fieldset>

            <div class="form-row">
              <div style="min-width:220px">
                <label for="videoSourceType">媒体来源 *</label>
                <select class="input" id="videoSourceType">
                  <option value="aliyun_vod">阿里云点播（视频 / 音频）</option>
                  <option value="bilibili">B站视频</option>
                  <option value="external_url">外部视频链接</option>
                  <option value="upload_mp4">上传 MP4</option>
                </select>
              </div>
              <div style="flex:1;min-width:240px" id="videoAliyunVidWrap">
                <label for="videoAliyunVid">阿里云媒体 ID *</label>
                <input class="input" id="videoAliyunVid" placeholder="点下方「上传视频 / 音频」后自动填写" />
                <div id="videoAliyunVidLockNote" class="small muted" style="margin-top:4px;display:none;align-items:center;gap:8px;flex-wrap:wrap">
                  <span>✅ 已由上传自动填写并锁定，无需改动。</span>
                  <button type="button" class="btn tiny" id="videoAliyunVidUnlock">改为手动填写</button>
                </div>
                <div id="videoAliyunUploadBox" style="margin-top:8px;padding:10px;border:1px dashed rgba(168,85,247,.4);border-radius:8px;background:rgba(168,85,247,.04);">
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <input type="file" id="videoAliyunFile" accept="${MEDIA_ACCEPT}" style="display:none;" />
                    <button type="button" class="btn tiny primary" id="videoAliyunFileBtn" style="min-height:44px">📤 上传视频 / 音频</button>
                    <button type="button" class="btn tiny danger" id="videoAliyunCancelBtn" style="display:none;">⏹ 停止上传</button>
                    <span class="small muted" id="videoAliyunFileStatus" role="status" style="overflow-wrap:anywhere">视频 MP4 / MOV / MKV 等；音频 MP3 / M4A / WAV / AAC / FLAC / WMA / APE。单文件 ≤ 2 GB</span>
                  </div>
                  <p class="small muted" style="margin:8px 0 0">音频建议使用 MP3；其他音频格式需在阿里云完成音频转码后收听。可先保存草稿，在阿里云试听确认后再上架。</p>
                  <div id="videoAliyunUploadProgress" style="margin-top:10px;display:none;">
                    <div style="background:rgba(255,255,255,.08);border-radius:4px;height:8px;overflow:hidden;">
                      <div id="videoAliyunUploadBar" style="background:#4a90e2;height:100%;width:0%;transition:width .2s;"></div>
                    </div>
                    <div class="small muted" id="videoAliyunUploadText" role="status" style="margin-top:4px;">准备中…</div>
                  </div>
                </div>
              </div>
              <div style="flex:1;min-width:240px" id="videoUrlWrap" hidden>
                <label>外部视频链接</label>
                <input class="input" id="videoUrl" placeholder="https://..." />
              </div>
              <div style="min-width:240px" id="videoMp4Wrap" hidden>
                <label>上传 MP4 (≤50MB)</label>
                <input class="input" id="videoMp4" type="file" accept="video/mp4" />
              </div>
            </div>

            <div class="form-row" id="videoAliyunUrlWrap" style="display:none">
              <div style="flex:1;min-width:240px">
                <label>阿里云播放地址（调试用，不作为正式播放）</label>
                <input class="input" id="videoAliyunUrl" placeholder="仅调试用途" style="opacity:.6" />
              </div>
            </div>

            <div class="form-row">
              <div style="min-width:200px">
                <label>主讲人</label>
                <input class="input" id="videoSpeaker" />
              </div>
              <div style="min-width:180px">
                <label>内容来源</label>
                <select class="input" id="videoContentSource">
                  <option value="glomcon">GlomCon 中国</option>
                  <option value="kidneysphere">肾域原创</option>
                  <option value="external">外部资源</option>
                </select>
              </div>
            </div>

            <div class="form-row">
              <div style="flex:1;min-width:240px">
                <label for="videoDescription">课程简介</label>
                <textarea class="input" id="videoDescription" rows="2" style="resize:vertical"></textarea>
              </div>
            </div>

            <div class="form-row">
              <div style="min-width:200px">
                <label>封面图 URL</label>
                <input class="input" id="videoCoverImage" placeholder="https://..." />
              </div>
              <div style="min-width:120px">
                <label>排序</label>
                <input class="input" id="videoSortOrder" type="number" value="0" />
              </div>
              <div style="min-width:180px">
                <label for="videoMediaType">媒体类型 *</label>
                <select class="input" id="videoMediaType"><option value="">请选择音频或视频</option><option value="audio">音频</option><option value="video">视频</option></select>
                <p class="small muted">本地文件自动识别；手动填写媒体 ID 时请按实际内容选择。</p>
              </div>
            </div>

            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;align-items:center">
              <button class="btn" type="button" id="videoSaveDraft">保存草稿</button>
              <button class="btn primary" type="submit" id="videoSubmit">保存并上架</button>
              <span class="small muted" id="videoHint"></span>
            </div>
          </form>
          <fieldset id="mediaBatchPanel" style="min-width:0;margin:22px 0 0"></fieldset>
          <div class="hr"></div>
          <div>
            <div class="section-title" style="margin:0">
              <div><h3 style="margin:0">全部课程管理</h3><p class="small muted" id="videoAdminCount"></p></div>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:14px">
                <input type="checkbox" id="showDeletedVideos" /> 显示已删除
              </label>
            </div>
            <div class="form-row" style="margin-top:14px;gap:10px">
              <div style="flex:2;min-width:200px"><label for="videoAdminSearch">搜索课程 / 系列 / 主讲人</label><input class="input" id="videoAdminSearch" type="search" placeholder="如：电解质" /></div>
              <div style="flex:1;min-width:160px"><label for="videoAdminAudienceFilter">课程权限</label><select class="input" id="videoAdminAudienceFilter"><option value="">全部权限</option><option value="training">付费培训</option><option value="member">299 元会员回放</option><option value="free">免费课程</option><option value="legacy">历史权限待确认</option></select></div>
              <div style="flex:1;min-width:130px"><label for="videoAdminMediaFilter">媒体类型</label><select class="input" id="videoAdminMediaFilter"><option value="">全部类型</option><option value="video">视频</option><option value="audio">音频</option><option value="unknown">类型待确认</option></select></div>
              <div style="flex:1;min-width:200px"><label for="videoAdminProjectFilter">培训项目</label><select class="input" id="videoAdminProjectFilter"><option value="">全部项目</option></select></div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px">
              <button class="btn tiny" type="button" id="videoHealthBtn">检查播放源</button>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:14px"><input type="checkbox" id="videoHealthOnlyBad" /> 只看播放源异常</label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:14px"><input type="checkbox" id="videoOnlyDrafts" /> 只看草稿</label>
              <span class="small muted" id="videoHealthSummary"></span>
            </div>
            <div id="videoAdminList" style="margin-top:10px"></div>
          </div>
        </div>
    `;
    // Re-query dynamically injected elements
    els.videoTitle = document.getElementById('videoTitle');
    els.videoCategory = document.getElementById('videoCategory');
    els.videoUrl = document.getElementById('videoUrl');
    els.videoMp4 = document.getElementById('videoMp4');
    els.videoAliyunUrl = document.getElementById('videoAliyunUrl');
    els.videoAliyunVid = document.getElementById('videoAliyunVid');
    els.videoSpeaker = document.getElementById('videoSpeaker');
    els.videoSpecialtyChecks = document.getElementById('videoSpecialtyChecks');
    els.videoIsPaid = document.getElementById('videoIsPaid');
    els.videoMembershipAccessible = document.getElementById('videoMembershipAccessible');
    els.videoSourceType = document.getElementById('videoSourceType');
    els.videoAudience = document.getElementById('videoAudience');
    els.videoPrice = document.getElementById('videoPrice');
    els.videoDescription = document.getElementById('videoDescription');
    els.videoCoverImage = document.getElementById('videoCoverImage');
    els.videoContentSource = document.getElementById('videoContentSource');
    els.videoSortOrder = document.getElementById('videoSortOrder');
    els.videoMediaType = document.getElementById('videoMediaType');
    els.videoSaveDraft = document.getElementById('videoSaveDraft');
    els.videoPriceRow = document.getElementById('videoPriceRow');
    els.videoAliyunVidWrap = document.getElementById('videoAliyunVidWrap');
    els.videoUrlWrap = document.getElementById('videoUrlWrap');
    els.videoMp4Wrap = document.getElementById('videoMp4Wrap');
    els.videoAliyunUrlWrap = document.getElementById('videoAliyunUrlWrap');
    els.videoSave = document.getElementById('videoSave') || document.getElementById('videoSubmit');
    els.videoAdminHint = document.getElementById('videoAdminHint') || document.getElementById('videoHint');
    els.videoAdminList = document.getElementById('videoAdminList');
    els.showDeletedVideos = document.getElementById('showDeletedVideos');
  }

  // Re-fill categories after dynamic injection
  fillVideoCategories();

  // Load specialties + admin videos in parallel
  await Promise.all([loadSpecialties(), loadAdminVideos()]);

  document.getElementById('videoAdminSearch')?.addEventListener('input', () => renderVideoAdminList(_allAdminVideos));
  document.getElementById('videoHealthOnlyBad')?.addEventListener('change', () => renderVideoAdminList(_allAdminVideos));
  document.getElementById('videoOnlyDrafts')?.addEventListener('change', () => renderVideoAdminList(_allAdminVideos));
  document.getElementById('videoHealthBtn')?.addEventListener('click', () => { void checkMediaHealth(); });
  ['videoAdminAudienceFilter', 'videoAdminMediaFilter', 'videoAdminProjectFilter'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => renderVideoAdminList(_allAdminVideos));
  });

  // Toggle show/hide deleted videos
  els.showDeletedVideos?.addEventListener('change', ()=>{
    renderVideoAdminList(_allAdminVideos);
  });

  // ── Source type toggle: show/hide relevant fields ──
  function updateSourceTypeUI(){
    const st = els.videoSourceType?.value || 'aliyun_vod';
    if(els.videoAliyunVidWrap) els.videoAliyunVidWrap.hidden = (st !== 'aliyun_vod');
    if(els.videoUrlWrap) els.videoUrlWrap.hidden = (st !== 'external_url' && st !== 'bilibili');
    if(els.videoMp4Wrap) els.videoMp4Wrap.hidden = (st !== 'upload_mp4');
    if(els.videoAliyunUrlWrap) els.videoAliyunUrlWrap.style.display = (st === 'aliyun_vod') ? 'flex' : 'none';
  }
  els.videoSourceType?.addEventListener('change', updateSourceTypeUI);
  updateSourceTypeUI();

  // One explicit audience setting controls all saved permission fields.
  ['videoAudience', 'videoSpecialtyChecks', 'videoMediaType'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', () => {
      if (id === 'videoSpecialtyChecks') {
        const selected = getCheckedSpecialtyIds('video');
        if (selected.length === 1 && els.videoCategory) {
          const code = _specialtiesMap.get(selected[0])?.code;
          const category = code === 'patho' ? 'path' : code;
          if (VIDEO_CATEGORIES.some(item => item.key === category)) els.videoCategory.value = category;
        }
      }
      updatePermissionUI('video');
    });
  });
  updatePermissionUI('video');

  // ── Aliyun VOD direct upload (admin only) ──
  _adminUploadOwner = user.id;
  setupAliyunDirectUpload();
  setupBatchUpload(user);

  // Save draft button
  els.videoSaveDraft?.addEventListener('click', async ()=>{
    await saveVideo(user, false); // false = draft (not published)
  });

  els.videoSave?.addEventListener('click', async (e)=>{
    e.preventDefault();
    await saveVideo(user, true); // true = publish
  });

  els.videoAdminList?.addEventListener('click', async (e)=>{
    const editBtn = e.target?.closest?.('[data-video-edit]');
    if(editBtn){
      e.preventDefault();
      const id = String(editBtn.getAttribute('data-video-edit') || '').trim();
      if(id) openEditModal(id);
      return;
    }
    const pubBtn = e.target?.closest?.('[data-video-publish],[data-video-unpublish]');
    if(pubBtn){
      e.preventDefault();
      const publish = pubBtn.hasAttribute('data-video-publish');
      const id = String(pubBtn.getAttribute(publish ? 'data-video-publish' : 'data-video-unpublish') || '').trim();
      if(id) await setCoursePublished(id, publish);
      return;
    }
    const delBtn = e.target?.closest?.('[data-video-del]');
    if(delBtn){
      e.preventDefault();
      const id = String(delBtn.getAttribute('data-video-del') || '').trim();
      if(id) await deleteVideo(id);
      return;
    }
    const restoreBtn = e.target?.closest?.('[data-video-restore]');
    if(restoreBtn){
      e.preventDefault();
      const id = String(restoreBtn.getAttribute('data-video-restore') || '').trim();
      if(id) await restoreVideo(id);
      return;
    }
    const purgeBtn = e.target?.closest?.('[data-video-purge]');
    if(purgeBtn){
      e.preventDefault();
      const id = String(purgeBtn.getAttribute('data-video-purge') || '').trim();
      const aliyunVid = String(purgeBtn.getAttribute('data-aliyun-vid') || '').trim();
      if(id) await purgeVideo(id, aliyunVid);
    }
  });
}

init();

// ============================================================
// Training Projects — dynamic section on learning.html
// ============================================================

const PROJECT_STATUS_LABELS = {
  draft:       { label: '筹备中',     color: 'rgba(156,163,175,.7)' },
  recruiting:  { label: '招生中',     color: '#4ade80' },
  in_progress: { label: '进行中',     color: '#3fa9f5' },
  closed:      { label: '报名已截止', color: '#fbbf24' },
  ended:       { label: '已结束',     color: 'rgba(156,163,175,.5)' },
};

async function loadTrainingProjects(){
  const gridEl = document.getElementById('trainingProgramsGrid');
  const hintEl = document.getElementById('trainingProgramsHint');
  if(!gridEl) return;

  if(!isConfigured()){
    gridEl.innerHTML = '<div class="note small">服务未配置，项目信息暂不可用。</div>';
    return;
  }

  await ensureSupabase();
  if(!supabase){
    gridEl.innerHTML = '<div class="note small">初始化失败，请刷新重试。</div>';
    return;
  }

  try{
    // Fetch active projects with their associated products
    const { data: projects, error } = await supabase
      .from('learning_projects')
      .select(`
        id, project_code, title, intro, cover_url, status, sort_order,
        registration_fee_cny, refund_policy_text, is_active
      `)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .limit(20);

    if(error) throw error;

    if(!projects || projects.length === 0){
      gridEl.innerHTML = `
        <div class="card soft">
          <h3 style="margin:0">培训项目即将开放</h3>
          <p class="small muted" style="margin-top:8px">重症肾内科 · 肾移植内科规范化培训项目正在筹备中，敬请关注。</p>
          <div style="margin-top:12px">
            <a class="btn" href="my-learning.html">我的学习</a>
          </div>
        </div>`;
      return;
    }

    // Fetch active registration products. Retired replay editions are never sold.
    const { data: allProducts } = await supabase
      .from('products')
      .select('id, product_code, title, subtitle, price_cny, list_price_cny, product_type, project_id')
      .eq('is_active', true)
      .in('product_type', ['project_registration','specialty_bundle'])
      .order('sort_order');

    const productsByProject = {};
    for(const p of (allProducts || [])){
      if (isRetiredTrainingReplay(p)) continue;
      if(p.project_id){
        if(!productsByProject[p.project_id]) productsByProject[p.project_id] = [];
        productsByProject[p.project_id].push(p);
      }
    }

    // Fetch current user + their entitlements
    let currentUser = null;
    let userEnts = new Set(); // project_id values user has access to
    try{
      currentUser = await getCurrentUser();
      if(currentUser){
        const { data: ents } = await supabase
          .from('user_entitlements')
          .select('project_id, status, end_at')
          .eq('user_id', currentUser.id)
          .eq('status', 'active')
          .eq('entitlement_type', 'project_access')
          .or(`end_at.is.null,end_at.gt.${new Date().toISOString()}`);
        for(const e of (ents || [])){ if(e.project_id) userEnts.add(e.project_id); }
      }
    }catch(_e){}

    gridEl.innerHTML = `<div class="grid cols-2" style="gap:16px">${
      projects.map(proj => {
        const sl = PROJECT_STATUS_LABELS[proj.status] || { label: proj.status, color: 'gray' };
        const hasAccess = userEnts.has(proj.id);
        const prods = productsByProject[proj.id] || [];
        const fullProd = prods.find(p => classifyTrainingProduct(p) === 'registration');

        function priceTag(p){
          if(!p) return '';
          return `<b>¥${esc(String(p.price_cny))}</b>`;
        }

        let ctaHtml = '';
        if(hasAccess){
          ctaHtml = `
            <div class="note" style="border-color:rgba(34,197,94,.3);background:rgba(34,197,94,.06);padding:10px;border-radius:8px;margin-top:10px">
              ✅ 已报名。<a href="my-learning.html">进入我的学习</a>查看班期与学习群。
            </div>`;
        } else if(proj.status === 'recruiting' || proj.status === 'in_progress'){
          const fullBtn = fullProd ? `<a class="btn primary" href="checkout.html?product_id=${encodeURIComponent(fullProd.id)}">${priceTag(fullProd)} 报名版</a>` : '';
          if(fullBtn){
            ctaHtml = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${fullBtn}</div>`;
          } else {
            ctaHtml = `<div style="margin-top:10px"><a class="btn" href="mailto:china@kidneysphere.com?subject=${encodeURIComponent('报名咨询：' + (proj.title || ''))}">联系招募</a></div>`;
          }
          if(!currentUser){
            ctaHtml = `<div style="margin-top:10px"><a class="btn" href="login.html?next=${encodeURIComponent('learning.html')}">登录后报名</a></div>`;
          }
        } else if(proj.status === 'draft'){
          ctaHtml = `<p class="small muted" style="margin-top:10px">报名即将开放，敬请关注。</p>`;
        }

        return `
          <div class="card soft">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap">
              <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
                  <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${esc(sl.color)};flex-shrink:0"></span>
                  <span class="small" style="color:${esc(sl.color)};font-weight:600">${esc(sl.label)}</span>
                </div>
                <h3 style="margin:0;font-size:16px">${esc(proj.title)}</h3>
                ${proj.intro ? `<p class="small muted" style="margin-top:6px;line-height:1.6">${esc(proj.intro.slice(0,100))}${proj.intro.length > 100 ? '…' : ''}</p>` : ''}
              </div>
            </div>
            ${fullProd ? `
              <div class="hr" style="margin:10px 0"></div>
              <div style="display:flex;gap:16px;flex-wrap:wrap">
                <div class="small"><span class="muted">报名版：</span>${priceTag(fullProd)}</div>
              </div>` : ''}
            ${proj.refund_policy_text ? `<p class="small muted" style="margin-top:6px">退款：${esc(proj.refund_policy_text)}</p>` : ''}
            ${ctaHtml}
          </div>`;
      }).join('')
    }</div>`;

  }catch(e){
    const msg = String(e?.message || e || '');
    // Silently skip if table not yet migrated
    if(/learning_projects.*does not exist/i.test(msg)) return;
    gridEl.innerHTML = `<div class="note small muted">项目加载失败：${esc(msg)}</div>`;
  }
}

// ──────────────────────────────────────────────────────────
// 阿里云 VOD 直传 (admin 直接在浏览器选文件 -> 服务器签发凭证 ->
// OSS SDK 直传到阿里云 -> 自动填写视频 ID)
// 流程参考: https://help.aliyun.com/zh/vod/developer-reference/upload-media-files-by-using-the-vod-upload-sdk-for-javascript
// 但我们直接用 OSS SDK + CreateUploadVideo, 不依赖 aliyun-upload-sdk.
// ──────────────────────────────────────────────────────────
let _currentUpload = null;
let _mediaSaveInProgress = false;
let _batchBusy = false;
let _adminUploadOwner = null;
let _vodUploader;

function vodUploader() {
  if (!_vodUploader) _vodUploader = createVodUploader({
    getToken: async () => {
      const session = (await supabase.auth.getSession())?.data?.session;
      if (!session?.access_token) throw new Error('登录已失效，请重新登录后重试。');
      if (session.user?.id !== _adminUploadOwner) throw new Error('当前登录账号已变化，请重新打开课程管理页面。');
      return session.access_token;
    },
  });
  return _vodUploader;
}

function setupAliyunDirectUpload() {
  const fileInput = document.getElementById('videoAliyunFile');
  const fileBtn = document.getElementById('videoAliyunFileBtn');
  const cancelBtn = document.getElementById('videoAliyunCancelBtn');
  const statusEl = document.getElementById('videoAliyunFileStatus');
  const progressEl = document.getElementById('videoAliyunUploadProgress');
  const barEl = document.getElementById('videoAliyunUploadBar');
  const textEl = document.getElementById('videoAliyunUploadText');
  const vidInput = document.getElementById('videoAliyunVid');
  const titleInput = document.getElementById('videoTitle');
  const batchPanel = document.getElementById('mediaBatchPanel');
  if (!fileInput || !fileBtn || !vidInput || fileBtn.dataset.wired === '1') return;
  fileBtn.dataset.wired = '1';
  vidInput.addEventListener('input', () => {
    delete vidInput.ksMediaMetadata;
    if (els.videoMediaType) els.videoMediaType.value = '';
  });
  fileBtn.addEventListener('click', () => fileInput.click());
  document.getElementById('videoAliyunVidUnlock')?.addEventListener('click', () => {
    if (!confirm('只有在关联阿里云里【已经存在】的视频时，才需要手动填写媒体 ID。\n\n确定改为手动填写吗？')) return;
    setMediaIdLocked(false);
    vidInput.focus();
  });
  cancelBtn?.addEventListener('click', () => {
    if (!_currentUpload) return;
    _currentUpload.abort();
    textEl.textContent = '正在停止…';
    cancelBtn.disabled = true;
  });
  fileInput.addEventListener('change', async () => {
    if (_currentUpload) return;
    if (_mediaSaveInProgress || _batchBusy) {
      alert('课程正在保存或批量上传，请完成后再上传单个文件。');
      fileInput.value = '';
      return;
    }
    const file = fileInput.files?.[0];
    if (!file) return;
    const validation = validateMediaFile(file);
    if (validation.error) { alert(validation.error); fileInput.value = ''; return; }
    try { readCoursePermissions('video', validation.mediaType); }
    catch (error) { alert(String(error?.message || error)); fileInput.value = ''; return; }
    const mediaLabel = validation.mediaType === 'audio' ? '音频' : '视频';
    const previousVid = vidInput.value;
    const controls = [vidInput, els.videoSave, els.videoSaveDraft, els.videoSourceType, els.videoMediaType, batchPanel, fileBtn]
      .filter(Boolean).map(control => [control, control.disabled]);
    controls.forEach(([control]) => { control.disabled = true; });
    const title = String(titleInput?.value || '').trim() || file.name.replace(/\.[^.]+$/, '');
    statusEl.textContent = `已选${mediaLabel}：${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
    progressEl.style.display = 'block'; barEl.style.width = '0%'; barEl.style.background = '#4a90e2';
    cancelBtn.style.display = ''; cancelBtn.disabled = false;
    _currentUpload = new AbortController();
    try {
      const durationTask = readLocalMediaDuration(file, validation.mediaType);
      const result = await vodUploader()(file, {
        title, signal: _currentUpload.signal,
        onStatus: message => { textEl.textContent = message; },
        onProgress: value => {
          const pct = Math.round(value * 100);
          barEl.style.width = pct + '%';
          textEl.textContent = `上传中 ${pct}%`;
        },
      });
      vidInput.value = result.videoId;
      setMediaIdLocked(true);
      vidInput.ksMediaMetadata = { videoId: result.videoId, mediaType: validation.mediaType,
        durationSeconds: await durationTask };
      if (els.videoMediaType) els.videoMediaType.value = validation.mediaType;
      updatePermissionUI('video');
      if (els.videoAliyunUrl) els.videoAliyunUrl.value = '';
      if (titleInput && !titleInput.value.trim()) titleInput.value = title;
      barEl.style.width = '100%'; barEl.style.background = '#22c55e';
      textEl.textContent = `✅ ${mediaLabel}上传成功 · 媒体 ID 已自动填写`;
      statusEl.textContent = '下一步：点「保存草稿」。在下方课程列表看到「播放源正常」后，点「上架」。';
    } catch (error) {
      const stopped = _currentUpload.signal.aborted || error?.name === 'AbortError';
      barEl.style.background = stopped ? '#888' : '#e74c3c';
      textEl.textContent = stopped ? '已停止上传，可重新选择文件。' : `上传失败：${error?.message || error}`;
      vidInput.value = previousVid;
    } finally {
      controls.forEach(([control, disabled]) => { control.disabled = disabled; });
      fileInput.value = ''; cancelBtn.style.display = 'none'; cancelBtn.disabled = false;
      _currentUpload = null;
    }
  });
}

function setupBatchUpload(user) {
  const root = document.getElementById('mediaBatchPanel');
  const form = document.getElementById('videoAddForm');
  if (!root || !form || root.dataset.wired === '1') return;
  root.dataset.wired = '1';
  let lockedControls = [], listDirty = false;
  const label = element => element?.selectedOptions?.[0]?.textContent?.trim() || '';
  function getSettings() {
    if (_currentUpload || _mediaSaveInProgress) throw new Error('请先完成当前单个文件的上传或保存。');
    const category = String(els.videoCategory?.value || '').trim();
    const source = String(els.videoContentSource?.value || 'external');
    const audience = String(els.videoAudience?.value || '');
    const specialtyIds = getCheckedSpecialtyIds('video');
    const specialties = Array.from(_specialtiesMap.values());
    // Actual file types are checked for the complete queue before uploading.
    const permissions = buildCoursePermissions({ audience, specialtyIds, specialties, mediaType: 'video' });
    const sortStart = Number(els.videoSortOrder?.value || 0);
    if (!category) throw new Error('请先在上方选择频道。');
    if (!Number.isInteger(sortStart) || sortStart < 0 || sortStart > 2147383647) throw new Error('起始排序须为非负整数，且预留章节排序空间。');
    return {
      category, categoryLabel: label(els.videoCategory), source, sourceLabel: label(els.videoContentSource),
      speaker: String(els.videoSpeaker?.value || '').trim(), audience, specialties,
      specialtyIds: permissions.specialty_ids,
      specialtyLabels: trainingProjectOptions(specialties).filter(project => permissions.specialty_ids.includes(project.id)).map(project => project.label),
      accessType: permissions.access_type, accessLabel: label(els.videoAudience),
      membershipScope: permissions.membership_scope, membershipScopeLabel: MEMBERSHIP_SCOPES[permissions.membership_scope],
      price: permissions.price, sortStart, createdBy: user.id,
      description: String(els.videoDescription?.value || '').trim(), coverImage: String(els.videoCoverImage?.value || '').trim(),
    };
  }
  const queue = new BatchQueue({
    upload: async (item, onProgress, signal) => {
      const durationTask = readLocalMediaDuration(item.file, item.mediaType);
      const result = await vodUploader()(item.file, { title: item.title, onProgress, signal });
      return { ...result, durationSeconds: await durationTask };
    },
    save: (item, settings) => saveBatchCourse(supabase, item, settings),
  });
  const view = mountBatchUpload(root, {
    queue, getSettings,
    onSaved: () => { listDirty = true; },
    onBusy: busy => {
      _batchBusy = busy;
      if (busy && !lockedControls.length) {
        lockedControls = [...form.querySelectorAll('input,select,textarea,button')].filter(control => !root.contains(control)).map(control => [control, control.disabled]);
        lockedControls.forEach(([control]) => { control.disabled = true; });
      } else if (!busy) {
        lockedControls.forEach(([control, disabled]) => { control.disabled = disabled; });
        lockedControls = [];
        if (listDirty) { listDirty = false; loadAdminVideos(); }
      }
    },
  });
  form.addEventListener('change', () => { view.refreshSettings(); });
  form.addEventListener('input', () => { view.refreshSettings(); });
  window.addEventListener('beforeunload', event => {
    if (_batchBusy || _currentUpload || _mediaSaveInProgress) { event.preventDefault(); event.returnValue = ''; }
  });
}

// Run after DOM is ready
loadTrainingProjects();
