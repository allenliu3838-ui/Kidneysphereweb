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
} from './supabaseClient.js?v=20260128_030';

import { VIDEO_CATEGORIES } from './assets/videos.js?v=20260118_001';

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
  // Backward/forward compatible ids (some versions used videoSave/videoAdminHint)
  videoSave: document.getElementById('videoSave') || document.getElementById('videoSubmit'),
  videoAdminHint: document.getElementById('videoAdminHint') || document.getElementById('videoHint'),
  videoAdminList: document.getElementById('videoAdminList'),
  showDeletedVideos: document.getElementById('showDeletedVideos'),
};

// Cache all admin videos (including soft-deleted) for toggle filtering
let _allAdminVideos = [];

const MAX_MP4_BYTES = 50 * 1024 * 1024; // 50MB

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

function renderVideoAdminList(rows){
  if(!els.videoAdminList) return;
  const showDeleted = els.showDeletedVideos?.checked || false;
  const list = (Array.isArray(rows) ? rows : []).filter(v => {
    if(v.deleted_at && !showDeleted) return false;
    return true;
  });
  if(!list.length){
    const hasDeleted = (Array.isArray(rows) ? rows : []).some(v => !!v.deleted_at);
    els.videoAdminList.innerHTML = hasDeleted
      ? '<div class="muted small">暂无活跃视频。勾选"显示已删除"可查看已删除项。</div>'
      : '<div class="muted small">暂无新增视频。</div>';
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

    const cardStyle = isDeleted
      ? 'padding:12px;opacity:0.5;border-left:3px solid rgba(160,160,160,.4)'
      : 'padding:12px';

    const actionBtn = isDeleted
      ? `<button class="btn tiny" type="button" data-video-restore="${esc(v.id)}">恢复</button>`
      : `<button class="btn tiny danger" type="button" data-video-del="${esc(v.id)}">删除</button>`;

    return `
      <div class="card" style="${cardStyle}">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
          <div style="min-width:0">
            <b style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:520px${isDeleted ? ';text-decoration:line-through' : ''}">${esc(v.title || '（无标题）')}</b>
            <div class="small muted" style="margin-top:6px">
              ${esc(tag)} · ${esc(kindLabel)} · ${esc(fmtDate(v.created_at))}
              ${deletedBadge}${expiredBadge}
            </div>
            <div class="small" style="margin-top:6px;word-break:break-all">${openUrl ? `<a class="auto-link" href="${esc(openUrl)}" target="_blank" rel="noopener">${esc(openUrl)}</a>` : ''}</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            ${isDeleted ? '' : `<a class="btn tiny" href="watch.html?id=${encodeURIComponent(v.id)}">预览</a>`}
            ${actionBtn}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function loadAdminVideos(){
  if(!els.videoAdminList) return;
  if(!isConfigured()){
    els.videoAdminList.innerHTML = '<div class="muted small">（演示模式）配置 Supabase 后可管理视频。</div>';
    return;
  }

  await ensureSupabase();
  if(!supabase) return;

  try{
    let { data, error } = await supabase
      .from('learning_videos')
      .select('id,title,category,kind,source_url,mp4_url,bvid,aliyun_vid,created_at,enabled,deleted_at')
      .order('created_at', { ascending: false })
      .limit(30);
    // Backward compat: retry without aliyun_vid if column doesn't exist yet
    if(error && /aliyun_vid/i.test(String(error.message || ''))){
      const r2 = await supabase
        .from('learning_videos')
        .select('id,title,category,kind,source_url,mp4_url,bvid,created_at,enabled,deleted_at')
        .order('created_at', { ascending: false })
        .limit(30);
      data = r2.data;
      error = r2.error;
    }
    if(error) throw error;
    _allAdminVideos = data || [];
    renderVideoAdminList(_allAdminVideos);
  }catch(e){
    const msg = String(e?.message || e || '');
    if(/relation .*learning_videos.* does not exist/i.test(msg)){
      els.videoAdminList.innerHTML = '<div class="muted small">视频表未初始化：请先运行本次迁移（learning_videos）。</div>';
      return;
    }
    els.videoAdminList.innerHTML = `<div class="muted small">加载失败：${esc(msg)}</div>`;
  }
}

async function saveVideo(currentUser){
  if(!els.videoSave) return;
  if(!els.videoTitle || !els.videoCategory) return;
  if(!isConfigured()){
    toast('未配置', 'Supabase 未配置。', 'err');
    return;
  }

  const title = String(els.videoTitle.value || '').trim();
  const category = String(els.videoCategory.value || '').trim();
  let url = String(els.videoUrl?.value || '').trim();
  const file = els.videoMp4?.files?.[0] || null;
  let aliyunUrl = String(els.videoAliyunUrl?.value || '').trim();
  let aliyunVid = String(els.videoAliyunVid?.value || '').trim();

  if(!title){ toast('请输入名称', '请填写视频名称。', 'err'); return; }
  if(!category){ toast('请选择分类', '请先选择一个视频分类。', 'err'); return; }

  // Detect if user pasted Alibaba Cloud HTML embed code in any field
  const allInput = url || aliyunUrl || '';
  if(looksLikeHtml(allInput)){
    const extractedVid = extractAliyunVid(allInput);
    if(extractedVid){
      toast('请粘贴播放地址',
        '检测到你粘贴了阿里云的 HTML 嵌入代码（已自动提取视频 ID：' + extractedVid + '）。\n\n' +
        '请改为粘贴视频的播放地址：\n' +
        '阿里云控制台 → 点击视频 → 「视频地址」标签页 → 复制 MP4 播放地址（以 https:// 开头）。',
        'err');
      // Auto-fill the vid field for convenience
      if(els.videoAliyunVid) els.videoAliyunVid.value = extractedVid;
      // Clear the bad input
      if(looksLikeHtml(url) && els.videoUrl) els.videoUrl.value = '';
      if(looksLikeHtml(aliyunUrl) && els.videoAliyunUrl) els.videoAliyunUrl.value = '';
    }else{
      toast('格式错误', '检测到粘贴了 HTML 代码。请粘贴视频的播放地址（以 https:// 开头），而不是嵌入代码。', 'err');
    }
    return;
  }

  // Also detect vid pasted into URL field (not a URL)
  if(url && !file && !aliyunUrl && !/^https?:\/\//i.test(url) && !extractBvid(url)){
    const vid = extractAliyunVid(url);
    if(vid){
      toast('请粘贴播放地址',
        '检测到你粘贴的是阿里云视频 ID（' + vid + '），请改为粘贴播放地址。\n\n' +
        '获取方式：阿里云控制台 → 点击视频 → 「视频地址」标签页 → 复制 MP4 地址。',
        'err');
      if(els.videoAliyunVid) els.videoAliyunVid.value = vid;
      if(els.videoUrl) els.videoUrl.value = '';
      return;
    }
  }

  if(!url && !file && !aliyunUrl){ toast('缺少内容', '请填写链接、选择 MP4 文件或填写阿里云视频地址。', 'err'); return; }

  await ensureSupabase();
  if(!supabase){ toast('初始化失败', 'Supabase 未就绪。', 'err'); return; }

  els.videoSave.disabled = true;
  if(els.videoAdminHint) els.videoAdminHint.textContent = '保存中…';

  try{
    let kind = 'external';
    let source_url = url || null;
    let bvid = null;
    let mp4_url = null;
    let aliyun_vid = null;

    if(aliyunUrl){
      // Try 'aliyun' kind first; fallback to 'mp4' if migration not run
      kind = 'aliyun';
      source_url = aliyunUrl;
      mp4_url = aliyunUrl;
      aliyun_vid = aliyunVid || null;
    }else if(file){
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
    }else{
      const bv = extractBvid(url);
      if(bv){
        kind = 'bilibili';
        bvid = bv;
      }else{
        kind = 'external';
      }
    }

    const row = { title, category, kind, source_url, mp4_url, bvid, enabled: true, deleted_at: null, created_by: currentUser.id };
    if(aliyun_vid) row.aliyun_vid = aliyun_vid;

    let { error } = await supabase.from('learning_videos').insert(row);

    // Fallback: if 'aliyun' kind or aliyun_vid column not supported yet, retry as 'mp4'
    if(error && kind === 'aliyun'){
      delete row.aliyun_vid;
      row.kind = 'mp4';
      const r2 = await supabase.from('learning_videos').insert(row);
      error = r2.error;
    }
    if(error) throw error;

    toast('已保存', '视频已添加到视频库。', 'ok');
    if(els.videoTitle) els.videoTitle.value = '';
    if(els.videoUrl) els.videoUrl.value = '';
    if(els.videoMp4) els.videoMp4.value = '';
    if(els.videoAliyunUrl) els.videoAliyunUrl.value = '';
    if(els.videoAliyunVid) els.videoAliyunVid.value = '';

    await loadAdminVideos();
  }catch(e){
    const msg = String(e?.message || e || '');
    if(/bucket .*learning_videos.* does not exist/i.test(msg) || /The resource was not found/i.test(msg)){
      toast('未初始化 Bucket', '请先创建 Storage bucket: learning_videos，并配置读写策略。', 'err');
      return;
    }
    toast('保存失败', msg, 'err');
  }finally{
    els.videoSave.disabled = false;
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

async function init(){
  // Hot articles are public
  loadHotArticles();

  // Admin video panel
  if(!els.videoAdminPanel) return;
  fillVideoCategories();

  if(!isConfigured()) return;
  await ensureSupabase();
  const user = await getCurrentUser();
  if(!user) return;
  const profile = await getUserProfile(user);
  const role = normalizeRole(profile?.role);
  const isAdmin = isAdminRole(role);
  if(!isAdmin) return;

  // Admin list
  loadAdminVideos();

  // Toggle show/hide deleted videos
  els.showDeletedVideos?.addEventListener('change', ()=>{
    renderVideoAdminList(_allAdminVideos);
  });

  els.videoSave?.addEventListener('click', async (e)=>{
    e.preventDefault();
    await saveVideo(user);
  });

  els.videoAdminList?.addEventListener('click', async (e)=>{
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
    }
  });
}

init();

// ============================================================
// Training Projects — dynamic section on learning.html
// ============================================================

const PROJECT_STATUS_LABELS = {
  draft:      { label: '筹备中', color: 'rgba(156,163,175,.7)' },
  recruiting: { label: '招募中', color: '#4ade80' },
  closed:     { label: '报名已截止', color: '#fbbf24' },
  ended:      { label: '已结束', color: 'rgba(156,163,175,.5)' },
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

    // Fetch related products for buy buttons (full+video editions)
    const { data: allProducts } = await supabase
      .from('products')
      .select('id, product_code, title, subtitle, price_cny, list_price_cny, product_type, project_id')
      .eq('is_active', true)
      .in('product_type', ['project_registration','specialty_bundle'])
      .order('sort_order');

    const productsByProject = {};
    for(const p of (allProducts || [])){
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
        const fullProd  = prods.find(p => /full|完整|报名/.test(p.product_code + p.title));
        const videoProd = prods.find(p => /video|视频|回放/.test(p.product_code + p.title));

        function priceTag(p){
          if(!p) return '';
          const early = p.list_price_cny ? `<s class="muted" style="font-weight:400">¥${esc(String(p.list_price_cny))}</s> ` : '';
          return `${early}<b>¥${esc(String(p.price_cny))}</b>`;
        }

        let ctaHtml = '';
        if(hasAccess){
          ctaHtml = `
            <div class="note" style="border-color:rgba(34,197,94,.3);background:rgba(34,197,94,.06);padding:10px;border-radius:8px;margin-top:10px">
              ✅ 已报名。<a href="my-learning.html">进入我的学习</a>查看班期与学习群。
            </div>`;
        } else if(proj.status === 'recruiting'){
          const fullBtn  = fullProd  ? `<a class="btn primary" href="checkout.html?product_id=${encodeURIComponent(fullProd.id)}">${priceTag(fullProd)} 报名版</a>` : '';
          const videoBtn = videoProd ? `<a class="btn" href="checkout.html?product_id=${encodeURIComponent(videoProd.id)}">${priceTag(videoProd)} 视频版</a>` : '';
          if(fullBtn || videoBtn){
            ctaHtml = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${fullBtn}${videoBtn}</div>`;
          } else {
            ctaHtml = `<div style="margin-top:10px"><a class="btn" href="my-learning.html">联系招募</a></div>`;
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
            ${fullProd || videoProd ? `
              <div class="hr" style="margin:10px 0"></div>
              <div style="display:flex;gap:16px;flex-wrap:wrap">
                ${fullProd ? `<div class="small"><span class="muted">报名版：</span>${priceTag(fullProd)}</div>` : ''}
                ${videoProd ? `<div class="small"><span class="muted">视频版：</span>${priceTag(videoProd)}</div>` : ''}
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

// Run after DOM is ready
loadTrainingProjects();
