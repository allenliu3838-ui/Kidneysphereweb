import {
  supabase,
  ensureSupabase,
  isConfigured,
  ensureAuthed,
  toast,
  getCurrentUser,
  getUserProfile,
  isAdminRole,
} from './supabaseClient.js?v=20260128_030';

import { applyShareMeta, copyToClipboard, buildStableUrl } from './share.js?v=20260118_001';

import { renderSafeHtml } from './ks_richtext.js?v=20260213_001';

const root = document.getElementById('articleRoot');
const editBtn = document.getElementById('editArticleBtn');
const favBtn = document.getElementById('articleFavBtn');
const shareBtn = document.getElementById('articleShareBtn');
const likeBtn = document.getElementById('articleLikeBtn');

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function fmtBeijing(ts){
  try{
    const d = new Date(ts);
    const opts = { timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' };
    const parts = new Intl.DateTimeFormat('zh-CN', opts).formatToParts(d);
    const m = Object.fromEntries(parts.map(p=>[p.type,p.value]));
    return `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}`;
  }catch(_e){
    return String(ts || '');
  }
}


function safeUrl(url){
  const raw = String(url || '').trim();
  if(!raw) return '';
  if(/^https?:\/\//i.test(raw)) return raw;
  return 'https://' + raw;
}

function linkify(htmlEscapedText){
  // htmlEscapedText should already be escaped; we only wrap URLs.
  const urlRe = /\bhttps?:\/\/[^\s<>\"']+|(?<!@)\bwww\.[^\s<>\"']+/gi;
  return String(htmlEscapedText).replace(urlRe, (m)=>{
    const href = safeUrl(m);
    return `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(m)}</a>`;
  });
}

function mdToHtml(md){
  // Minimal safe renderer:
  // - Escape everything first to avoid XSS
  // - Then apply lightweight Markdown features
  // - Media tokens are forced into standalone blocks for stable layout
  const raw = String(md || '').replace(/\r\n/g, '\n');
  let s = esc(raw);

  // Media embeds (force standalone blocks)
  // - Image: ![alt](url)
  // - Video: {{video:url}}
  // - PDF: {{pdf:url}}
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url)=>{
    const u = safeUrl(String(url || '').trim());
    if(!u) return '';
    return `\n\n__IMG__${esc(alt)}__${esc(u)}__\n\n`;
  });
  s = s.replace(/\{\{video:([^}]+)\}\}/g, (_m, url)=>{
    const u = safeUrl(String(url || '').trim());
    if(!u) return '';
    return `\n\n__VID__${esc(u)}__\n\n`;
  });
  s = s.replace(/\{\{pdf:([^}]+)\}\}/g, (_m, url)=>{
    const u = safeUrl(String(url || '').trim());
    if(!u) return '';
    return `\n\n__PDF__${esc(u)}__\n\n`;
  });

  // Code fences ```...```
  s = s.replace(/```([\s\S]*?)```/g, (_m, code)=>`<pre class="codeblock"><code>${code}</code></pre>`);

  // Horizontal rule
  s = s.replace(/^\s*---\s*$/gm, '<hr/>');

  // Headings
  s = s.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Bold/italic/inline code
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*(.+?)\*/g, '<i>$1</i>');
  s = s.replace(/`(.+?)`/g, '<code>$1</code>');

  // Lists: unordered (- item) and ordered (1. item)
  s = s.replace(/(?:^|\n)(- .+(?:\n- .+)*)/g, (m)=>{
    const lines = m.trim().split('\n').map(l=>l.replace(/^- /,''));
    return '\n<ul>' + lines.map(li=>`<li>${li}</li>`).join('') + '</ul>';
  });
  s = s.replace(/(?:^|\n)((?:\d+\. .+)(?:\n\d+\. .+)*)/g, (m)=>{
    const lines = m.trim().split('\n').map(l=>l.replace(/^\d+\.\s+/,''));
    return '\n<ol>' + lines.map(li=>`<li>${li}</li>`).join('') + '</ol>';
  });

  const blocks = s.split(/\n{2,}/).map(b=>b.trim()).filter(Boolean);

  const isImgBlock = (b)=>/^__IMG__/.test(b);
  const isVidBlock = (b)=>/^__VID__/.test(b);
  const isPdfBlock = (b)=>/^__PDF__/.test(b);

  const shouldCaption = (alt)=>{
    const a = String(alt || '').trim();
    if(!a) return false;
    const low = a.toLowerCase();
    if(low === 'image' || low === 'img' || low === '图片') return false;
    // Avoid captions that look like file names only
    if(/^[a-z0-9_-]+\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(a)) return false;
    return true;
  };

  const renderImgs = (imgs)=>{
    if(!imgs.length) return '';
    if(imgs.length === 1){
      const { alt, url } = imgs[0];
      const cap = shouldCaption(alt) ? `<figcaption>${alt}</figcaption>` : '';
      // Click-to-open in a new tab (useful on mobile too)
      return `
        <figure class="ks-figure">
          <a class="ks-media-item" href="${url}" target="_blank" rel="noopener">
            <img class="article-media" alt="${alt}" src="${url}" />
          </a>
          ${cap}
        </figure>
      `;
    }
    return `
      <div class="ks-media-grid" data-count="${imgs.length}">
        ${imgs.map(({ alt, url }) => `
          <a class="ks-media-item" href="${url}" target="_blank" rel="noopener">
            <img alt="${alt || 'image'}" src="${url}" />
          </a>
        `).join('')}
      </div>
    `;
  };

  const renderVids = (vids)=>{
    if(!vids.length) return '';
    return vids.map(({ url })=>`
      <div class="article-video">
        <video controls playsinline preload="metadata" style="width:100%;max-width:980px;border-radius:16px;background:#000;border:1px solid rgba(255,255,255,.12)">
          <source src="${url}" type="video/mp4" />
          你的浏览器不支持 MP4 播放。
        </video>
      </div>
    `).join('\n');
  };

  const renderPdfs = (pdfs)=>{
    if(!pdfs.length) return '';
    return `
      <div class="attach-list">
        ${pdfs.map(({ url }) => `
          <a class="file-chip" data-act="article-download" data-kind="pdf" href="${url}" target="_blank" rel="noopener">📄 打开 PDF</a>
        `).join('')}
      </div>
    `;
  };

  const out = [];
  for(let i=0;i<blocks.length;i++){
    const b = blocks[i];

    // Structural blocks (already HTML)
    if(/^<h[1-3]>/.test(b) || /^<ul>/.test(b) || /^<ol>/.test(b) || /^<pre /.test(b) || /^<hr\/?>/.test(b)){
      out.push(b);
      continue;
    }

    // Group consecutive images into a grid
    if(isImgBlock(b)){
      const imgs = [];
      let j = i;
      while(j < blocks.length && isImgBlock(blocks[j])){
        const m = blocks[j].match(/^__IMG__(.*?)__(.*?)__$/);
        if(m) imgs.push({ alt: m[1], url: m[2] });
        j++;
      }
      out.push(renderImgs(imgs));
      i = j - 1;
      continue;
    }

    // Group consecutive PDFs into one attachment row
    if(isPdfBlock(b)){
      const pdfs = [];
      let j = i;
      while(j < blocks.length && isPdfBlock(blocks[j])){
        const m = blocks[j].match(/^__PDF__(.*?)__$/);
        if(m) pdfs.push({ url: m[1] });
        j++;
      }
      out.push(renderPdfs(pdfs));
      i = j - 1;
      continue;
    }

    // Videos (usually 1 per block; still supports multiple if needed)
    if(isVidBlock(b)){
      const vids = [];
      let j = i;
      while(j < blocks.length && isVidBlock(blocks[j])){
        const m = blocks[j].match(/^__VID__(.*?)__$/);
        if(m) vids.push({ url: m[1] });
        j++;
      }
      out.push(renderVids(vids));
      i = j - 1;
      continue;
    }

    // Normal paragraph: keep single newlines as <br/>
    out.push(`<p>${b.replace(/\n/g,'<br/>')}</p>`);
  }

  let html = out.join('\n');

  // Auto links (text blocks only; avoid touching HTML attributes)
  html = html.replace(/<p>([\s\S]*?)<\/p>/g, (_m, inner)=>`<p>${linkify(inner)}</p>`);

  return html;
}

function getId(){
  const u = new URL(location.href);
  return u.searchParams.get('id') || '';
}

// Prevent refresh spam from inflating the counter.
// Count at most once per device per article within 6 hours.
function shouldCountArticleView(articleId){
  try{
    const key = `ks_article_view_${String(articleId || '')}`;
    const now = Date.now();
    const last = Number(localStorage.getItem(key) || '0');
    const windowMs = 6 * 60 * 60 * 1000;
    if(last && (now - last) < windowMs) return false;
    localStorage.setItem(key, String(now));
    return true;
  }catch(_e){
    // If storage is blocked, fall back to always counting.
    return true;
  }
}

function isMissingTableError(e, table){
  const m = String(e?.message || e || '').toLowerCase();
  return m.includes(table.toLowerCase()) && (
    m.includes('does not exist') ||
    m.includes('relation') ||
    m.includes('schema cache') ||
    m.includes('not find')
  );
}

function setFavButtonState({ enabled=true, faved=false }={}){
  if(!favBtn) return;
  favBtn.disabled = !enabled;
  favBtn.dataset.faved = faved ? '1' : '0';
  favBtn.textContent = faved ? '⭐ 已收藏' : '⭐ 收藏';
  favBtn.classList.toggle('primary', Boolean(faved));
}

function setLikeButtonState({ enabled=true, liked=false, count=null }={}){
  if(!likeBtn) return;
  likeBtn.disabled = !enabled;
  likeBtn.dataset.liked = liked ? '1' : '0';
  if(typeof count === 'number' && isFinite(count)){
    likeBtn.dataset.count = String(Math.max(0, Math.floor(count)));
  }
  const labelEl = likeBtn.querySelector('.like-label');
  const countEl = likeBtn.querySelector('.like-count');
  const cur = Number(likeBtn.dataset.count || 0) || 0;

  if(labelEl) labelEl.textContent = liked ? '💙 已赞' : '👍 点赞';
  if(countEl) countEl.textContent = String(cur);
  likeBtn.classList.toggle('primary', Boolean(liked));
}

function updateLikeMeta(count){
  const el = document.getElementById('articleLikeCountMeta');
  if(!el) return;
  const n = Math.max(0, Number(count || 0));
  el.textContent = `点赞：${n}`;
}

async function loadLikeState(user, articleId){
  if(!likeBtn) return;

  // Not logged in: allow click to trigger login.
  if(!user){
    setLikeButtonState({ enabled:true, liked:false });
    return;
  }

  try{
    const { data, error } = await supabase
      .from('article_likes')
      .select('article_id')
      .eq('article_id', articleId)
      .eq('user_id', user.id)
      .maybeSingle();
    if(error) throw error;
    const curCount = Number(likeBtn.dataset.count || 0) || 0;
    setLikeButtonState({ enabled:true, liked: Boolean(data), count: curCount });
  }catch(e){
    if(isMissingTableError(e, 'article_likes')){
      setLikeButtonState({ enabled:false, liked:false });
      toast('点赞暂不可用', '文章点赞功能尚未启用或正在维护中，请稍后再试。', 'err');
      return;
    }
    // Don't block reading; just show warning.
    setLikeButtonState({ enabled:false, liked:false });
    console.warn('loadLikeState failed:', e);
  }
}

async function toggleLike(articleId){
  if(!likeBtn) return;

  if(!isConfigured()){
    toast('服务暂不可用', '系统尚未完成初始化或配置，请联系管理员。', 'err');
    return;
  }

  await ensureSupabase();
  if(!supabase){
    toast('服务不可用', 'Supabase SDK 初始化失败，请刷新后重试。', 'err');
    return;
  }

  let user = await getCurrentUser();
  if(!user){
    const ok = await ensureAuthed('login.html');
    if(!ok) return;
    user = await getCurrentUser();
  }
  if(!user){
    toast('需要登录', '请先登录后再点赞。', 'err');
    return;
  }

  const liked = likeBtn.dataset.liked === '1';
  const curCount = Number(likeBtn.dataset.count || 0) || 0;

  // optimistic UI
  const nextLiked = !liked;
  const nextCount = Math.max(curCount + (nextLiked ? 1 : -1), 0);
  setLikeButtonState({ enabled:true, liked: nextLiked, count: nextCount });
  updateLikeMeta(nextCount);

  likeBtn.disabled = true;
  try{
    if(nextLiked){
      const row = { article_id: articleId, user_id: user.id };
      // Prefer upsert to avoid duplicate errors on fast taps
      let res = await supabase
        .from('article_likes')
        .upsert(row, { onConflict: 'article_id,user_id', ignoreDuplicates: true });
      if(res?.error){
        // Fallback to insert for older client versions
        res = await supabase.from('article_likes').insert(row);
        if(res?.error){
          const msg = String(res.error.message || res.error);
          if(/duplicate key/i.test(msg) || String(res.error.code || '') === '23505'){
            // ignore
          }else{
            throw res.error;
          }
        }
      }
    }else{
      const { error } = await supabase
        .from('article_likes')
        .delete()
        .eq('article_id', articleId)
        .eq('user_id', user.id);
      if(error) throw error;
    }

    // Sync with DB like_count (trigger-updated)
    try{
      const { data } = await supabase
        .from('articles')
        .select('like_count')
        .eq('id', articleId)
        .maybeSingle();
      if(data && typeof data.like_count !== 'undefined'){
        const n = Math.max(0, Number(data.like_count || 0));
        setLikeButtonState({ enabled:true, liked: nextLiked, count: n });
        updateLikeMeta(n);
      }
    }catch(_e){ /* ignore */ }
  }catch(e){
    // rollback UI
    setLikeButtonState({ enabled:true, liked, count: curCount });
    updateLikeMeta(curCount);

    const msg = e?.message || String(e);
    if(isMissingTableError(e, 'article_likes')){
      toast('点赞暂不可用', '文章点赞功能尚未启用或正在维护中，请稍后再试。', 'err');
    }else{
      toast('操作失败', msg, 'err');
    }
  }finally{
    likeBtn.disabled = false;
  }
}

async function loadFavState(user, articleId){
  if(!favBtn) return;

  // Not logged in: allow click to trigger login.
  if(!user){
    setFavButtonState({ enabled:true, faved:false });
    return;
  }

  try{
    const { data, error } = await supabase
      .from('article_favorites')
      .select('article_id')
      .eq('article_id', articleId)
      .eq('user_id', user.id)
      .maybeSingle();
    if(error) throw error;
    setFavButtonState({ enabled:true, faved: Boolean(data) });
  }catch(e){
    if(isMissingTableError(e, 'article_favorites')){
      setFavButtonState({ enabled:false, faved:false });
      toast('文章收藏未初始化', '请在 Supabase SQL Editor 运行 MIGRATION_20260114_ARTICLE_FAVORITES.sql，然后 Settings → API 点击 “Reload schema”。', 'err');
      return;
    }
    // Don't block reading; just show warning.
    setFavButtonState({ enabled:false, faved:false });
    toast('收藏状态读取失败', e?.message || String(e), 'err');
  }
}

async function toggleFav(articleId){
  if(!favBtn) return;

  if(!isConfigured()){
    toast('服务暂不可用', '请先在 assets/config.js 配置 SUPABASE_URL 与 SUPABASE_ANON_KEY。', 'err');
    return;
  }

  await ensureSupabase();
  if(!supabase){
    toast('服务不可用', 'Supabase SDK 初始化失败，请刷新后重试。', 'err');
    return;
  }

  let user = await getCurrentUser();
  if(!user){
    const ok = await ensureAuthed('login.html');
    if(!ok) return;
    user = await getCurrentUser();
  }
  if(!user){
    toast('需要登录', '请先登录后再收藏。', 'err');
    return;
  }

  const isFaved = favBtn.dataset.faved === '1';
  favBtn.disabled = true;

  try{
    if(isFaved){
      const { error } = await supabase
        .from('article_favorites')
        .delete()
        .eq('article_id', articleId)
        .eq('user_id', user.id);
      if(error) throw error;
      setFavButtonState({ enabled:true, faved:false });
      toast('已取消收藏', '', 'ok');
    }else{
      const { error } = await supabase
        .from('article_favorites')
        .upsert({ article_id: articleId, user_id: user.id }, { onConflict: 'article_id,user_id' });
      if(error) throw error;
      setFavButtonState({ enabled:true, faved:true });
      toast('已收藏', '可在「我的收藏」中查看。', 'ok');
    }
  }catch(e){
    favBtn.disabled = false;
    if(isMissingTableError(e, 'article_favorites')){
      toast('文章收藏未初始化', '请在 Supabase SQL Editor 运行 MIGRATION_20260114_ARTICLE_FAVORITES.sql，然后 Settings → API 点击 “Reload schema”。', 'err');
      return;
    }
    toast('操作失败', e?.message || String(e), 'err');
  }
}

async function main(){
  if(!root) return;
  const id = getId();
  if(!id){
    root.innerHTML = `<div class="muted small">缺少文章 ID。</div>`;
    if(favBtn) favBtn.hidden = true;
    return;
  }

  if(!isConfigured()){
    root.innerHTML = `<div class="note"><b>服务暂不可用：</b>系统尚未完成初始化或配置，请联系管理员。</div>`;
    if(favBtn) favBtn.hidden = true;
    return;
  }

  await ensureSupabase();
  if(!supabase){
    root.innerHTML = `<div class="muted small">Supabase SDK 初始化失败，请刷新或切换网络后重试。</div>`;
    if(favBtn) favBtn.hidden = true;
    return;
  }

  const user = await getCurrentUser();
  const profile = user ? await getUserProfile(user.id) : null;
  const isAdmin = Boolean(user && isAdminRole(profile?.role));

  if(editBtn){
    editBtn.href = `article-editor.html?id=${encodeURIComponent(id)}`;
  }

  // Favorite button
  if(favBtn){
    favBtn.hidden = false;
    setFavButtonState({ enabled:true, faved:false });
    favBtn.addEventListener('click', ()=> toggleFav(id));
  }

  await loadFavState(user, id);

  // Like button
  if(likeBtn){
    likeBtn.hidden = false;
    setLikeButtonState({ enabled:true, liked:false, count:0 });
    likeBtn.addEventListener('click', ()=> toggleLike(id));
  }
  await loadLikeState(user, id);

  try{
    // If not admin, only allow published
    let q = supabase.from('articles').select('*').eq('id', id).maybeSingle();
    if(!isAdmin) q = q.eq('status', 'published').is('deleted_at', null);

    const { data, error } = await q;
    if(error) throw error;
    if(!data){
      root.innerHTML = `<div class="muted small">文章不存在，或你没有权限查看。</div>`;
      return;
    }

    const title = data.title || '未命名';
    const summary = String(data.summary || '').trim();
    const cover = String(data.cover_url || '').trim();
    const author = data.author_name || '';
    const status = String(data.status || 'draft');
    const publishedAt = data.published_at;
    const createdAt = data.created_at;

    // Views (optional): only available after MIGRATION_20260109_ARTICLE_VIEWCOUNT.sql
    const hasViewCount = Object.prototype.hasOwnProperty.call(data, 'view_count');
    let viewCount = hasViewCount ? Number(data.view_count || 0) : null;
    if(hasViewCount && status === 'published' && shouldCountArticleView(id)){
      try{
        const { data: newCount, error: incErr } = await supabase.rpc('increment_article_view', { p_article_id: id });
        if(!incErr && typeof newCount === 'number' && isFinite(newCount)){
          viewCount = newCount;
        }
      }catch(_e){
        // Ignore if RPC isn't installed yet.
      }
    }

    // Downloads (optional): only available after MIGRATION_20260130_DOWNLOADCOUNT_ARTICLE_PPT.sql
    const hasDownloadCount = Object.prototype.hasOwnProperty.call(data, 'download_count');
    let downloadCount = hasDownloadCount ? Number(data.download_count || 0) : null;

    // Likes (optional): available after MIGRATION_20260203_ARTICLE_LIKES.sql
    const hasLikeCount = Object.prototype.hasOwnProperty.call(data, 'like_count');
    let likeCount = hasLikeCount ? Number(data.like_count || 0) : null;

    const meta = [
      author ? `作者：${esc(author)}` : '',
      status === 'published' && publishedAt ? `发布时间：${esc(fmtBeijing(publishedAt))}` : '',
      viewCount !== null ? `阅读：${esc(String(viewCount))}` : '',
      downloadCount !== null ? `<span id="articleDownloadCount">下载：${esc(String(downloadCount))}</span>` : '',
      likeCount !== null ? `<span id="articleLikeCountMeta">点赞：${esc(String(likeCount))}</span>` : '',
      status !== 'published' ? `<span class="chip todo">未发布（${esc(status)}）</span>` : '',
    ].filter(Boolean).join(' · ');

    root.innerHTML = `
      <div class="article">
        <h1 style="margin:0 0 10px 0">${esc(title)}</h1>
        <div class="small muted">${meta}</div>

        ${cover ? `<div style="margin-top:14px"><img class="article-cover" src="${esc(cover)}" alt="cover"/></div>` : ''}

        ${summary ? `<div class="note" style="margin-top:14px"><b>摘要</b><div class="small muted" style="margin-top:6px">${esc(summary)}</div></div>` : ''}

        <div class="hr"></div>

        <div class="article-content ks-prose ks-reading">
          ${(() => {
            const html = String(data.content_html || '').trim();
            if(html) return renderSafeHtml(html, { mode:'article', linkify:true });
            return mdToHtml(data.content_md || '');
          })()}
        </div>
      </div>
    `;


    // Update like button count (and disable if likes not initialized)
    if(likeBtn){
      if(likeCount !== null){
        const liked = likeBtn.dataset.liked === '1';
        setLikeButtonState({ enabled:true, liked, count: likeCount });
      }else{
        // Schema not updated yet; keep button but disable.
        setLikeButtonState({ enabled:false, liked:false, count: 0 });
        likeBtn.title = '点赞功能暂不可用';
      }
    }

    // Count article downloads when users click PDF/file chips in the content.
    const bumpDownload = async () => {
      if (!hasDownloadCount) return;
      try {
        const { data: newCount, error: incErr } = await supabase.rpc('increment_article_download', { p_article_id: id });
        if (!incErr && typeof newCount === 'number' && isFinite(newCount)) {
          downloadCount = newCount;
          const cEl = document.getElementById('articleDownloadCount');
          if (cEl) cEl.textContent = `下载：${newCount}`;
        }
      } catch (_e) {
        // Ignore if RPC isn't installed yet.
      }
    };

    if (root && root.dataset.dlBound !== '1') {
      root.dataset.dlBound = '1';
      root.addEventListener('click', (e) => {
        const a = e.target?.closest?.('a[data-act="article-download"]');
        if (!a) return;
        bumpDownload();
      });
    }

    // --- Sharing (WeChat Moments / Timeline) ---
    // Build a stable URL without cache-busting params.
    const shareUrl = buildStableUrl();
    const shareTitle = `${title} · 肾域AI`;
    const shareDesc = summary || excerptFromMd(data.content_md || '', 120) || 'KidneySphere 学术文章';
    // WeChat/朋友圈链接预览对 JS 执行不稳定；
    // 为保证所有文章分享都有统一封面，这里固定使用站点封面图。
    const shareImg = 'assets/wechat_share_logo.png';
    applyShareMeta({
      title: shareTitle,
      description: shareDesc,
      image: shareImg,
      url: shareUrl,
      type: 'article'
    });

    // Share button: prefer native share if available, otherwise copy link.
    if(shareBtn){
      shareBtn.onclick = async ()=>{
        const payload = { title: shareTitle, text: shareDesc, url: shareUrl };
        try{
          if(navigator.share){
            await navigator.share(payload);
            return;
          }
        }catch(_e){}

        const ok = await copyToClipboard(shareUrl);
        if(ok) toast('链接已复制', '可在微信中粘贴并分享到朋友圈；或在微信内打开页面后点右上角分享。', 'ok');
        else toast('复制失败', '请手动复制地址栏链接进行分享。', 'err');
      };
    }


  }catch(e){
    const msg = esc(e?.message || String(e));
    const hint = isMissingTableError(e, 'articles')
      ? `<div class="small muted" style="margin-top:8px">提示：文章功能暂不可用（系统初始化或升级中）。请稍后重试；如持续失败，请联系管理员。</div>`
      : `<div class="small muted" style="margin-top:8px">提示：请刷新页面后重试；如仍失败，请稍后再试或联系管理员。</div>`;
    const showDev = Boolean(typeof window !== 'undefined' && window.__SHOW_DEV_HINTS__);
    const detail = showDev ? `<div class="small muted" style="margin-top:8px">错误详情：${msg}</div>` : '';
    root.innerHTML = `
      <div class="muted small">读取文章失败，请稍后重试。</div>
      ${hint}
      ${detail}
    `;
  }
}

main();