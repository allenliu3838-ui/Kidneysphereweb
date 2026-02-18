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
  // Backward/forward compatible ids (some versions used videoSave/videoAdminHint)
  videoSave: document.getElementById('videoSave') || document.getElementById('videoSubmit'),
  videoAdminHint: document.getElementById('videoAdminHint') || document.getElementById('videoHint'),
  videoAdminList: document.getElementById('videoAdminList'),
};

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
    els.hotArticlesList.innerHTML = '<div class="muted small">暂无文章。管理员可在「写文章」中发布。</div>';
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

function renderVideoAdminList(rows){
  if(!els.videoAdminList) return;
  const list = Array.isArray(rows) ? rows : [];
  if(!list.length){
    els.videoAdminList.innerHTML = '<div class="muted small">暂无新增视频。</div>';
    return;
  }

  const catMap = new Map((Array.isArray(VIDEO_CATEGORIES) ? VIDEO_CATEGORIES : []).map(c=>[String(c.key), c]));

  els.videoAdminList.innerHTML = list.map(v=>{
    const cat = catMap.get(String(v.category || ''));
    const tag = cat ? (String(cat.zh || '').trim() ? `${String(cat.zh).trim()}${cat.en ? ' / ' + String(cat.en).trim() : ''}` : (cat.en || cat.key)) : (v.category || '未分类');
    const kindLabel = v.kind === 'mp4' ? 'MP4' : (v.kind === 'bilibili' ? 'B站' : '链接');
    const openUrl = v.kind === 'mp4' ? (v.mp4_url || v.source_url || '') : (v.source_url || '');
    return `
      <div class="card" style="padding:12px">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
          <div style="min-width:0">
            <b style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:520px">${esc(v.title || '（无标题）')}</b>
            <div class="small muted" style="margin-top:6px">${esc(tag)} · ${esc(kindLabel)} · ${esc(fmtDate(v.created_at))}</div>
            <div class="small" style="margin-top:6px;word-break:break-all">${openUrl ? `<a class="auto-link" href="${esc(openUrl)}" target="_blank" rel="noopener">${esc(openUrl)}</a>` : ''}</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <a class="btn tiny" href="watch.html?id=${encodeURIComponent(v.id)}">预览</a>
            <button class="btn tiny danger" type="button" data-video-del="${esc(v.id)}">删除</button>
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
    const { data, error } = await supabase
      .from('learning_videos')
      .select('id,title,category,kind,source_url,mp4_url,bvid,created_at,enabled,deleted_at')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(12);
    if(error) throw error;
    renderVideoAdminList(data || []);
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
  const url = String(els.videoUrl?.value || '').trim();
  const file = els.videoMp4?.files?.[0] || null;

  if(!title){ toast('请输入名称', '请填写视频名称。', 'err'); return; }
  if(!category){ toast('请选择分类', '请先选择一个视频分类。', 'err'); return; }
  if(!url && !file){ toast('缺少内容', '请填写链接或选择 MP4 文件。', 'err'); return; }

  await ensureSupabase();
  if(!supabase){ toast('初始化失败', 'Supabase 未就绪。', 'err'); return; }

  els.videoSave.disabled = true;
  if(els.videoAdminHint) els.videoAdminHint.textContent = '保存中…';

  try{
    let kind = 'external';
    let source_url = url || null;
    let bvid = null;
    let mp4_url = null;

    if(file){
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

    const { error } = await supabase
      .from('learning_videos')
      .insert({
        title,
        category,
        kind,
        source_url,
        mp4_url,
        bvid,
        enabled: true,
        deleted_at: null,
        created_by: currentUser.id,
      });
    if(error) throw error;

    toast('已保存', '视频已添加到视频库。', 'ok');
    if(els.videoTitle) els.videoTitle.value = '';
    if(els.videoUrl) els.videoUrl.value = '';
    if(els.videoMp4) els.videoMp4.value = '';

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
    toast('删除失败', String(e?.message || e || ''), 'err');
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

  els.videoSave?.addEventListener('click', async (e)=>{
    e.preventDefault();
    await saveVideo(user);
  });

  els.videoAdminList?.addEventListener('click', async (e)=>{
    const btn = e.target?.closest?.('[data-video-del]');
    if(!btn) return;
    e.preventDefault();
    const id = String(btn.getAttribute('data-video-del') || '').trim();
    if(id) await deleteVideo(id);
  });
}

init();
