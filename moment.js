import { supabase, ensureAuthed, isConfigured, toast, getCurrentUser, getUserProfile, isAdminRole, normalizeRole, getPublicProfiles, levelBadgeHtml } from './supabaseClient.js';

const detailHint = document.getElementById('detailHint');
const postBox = document.getElementById('postBox');

const commentHint = document.getElementById('commentHint');
const commentList = document.getElementById('commentList');
const commentForm = document.getElementById('commentForm');
const commentBody = document.getElementById('commentBody');
const commentSubmit = document.getElementById('commentSubmit');
const commentSubmitHint = document.getElementById('commentSubmitHint');

const shareHelp = document.getElementById('shareHelp');
const shareHelpClose = document.getElementById('shareHelpClose');
const shareHelpCopy = document.getElementById('shareHelpCopy');

let currentUser = null;
let currentProfile = null;
let isAdmin = false;
let authorPublic = null;
let currentPost = null;

function esc(str){
  return String(str ?? '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

function isWeChat(){
  return /MicroMessenger/i.test(navigator.userAgent || '');
}

function fmtTime(ts){
  if(!ts) return '';
  try{
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  }catch(_e){
    return String(ts);
  }
}

function typeLabel(t){
  const k = String(t || '').toLowerCase();
  if(k === 'literature') return '文献';
  if(k === 'pathology') return '病理';
  return '总结';
}

function countFromRel(rel){
  if(Array.isArray(rel)) return Number(rel[0]?.count || 0);
  if(rel && typeof rel === 'object') return Number(rel.count || 0);
  return 0;
}

async function copyText(text){
  try{
    await navigator.clipboard.writeText(text);
    return true;
  }catch(_e){
    try{
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }catch(_e2){
      return false;
    }
  }
}

function showShareHelp(url){
  if(!shareHelp) return;
  shareHelp.dataset.url = url;
  shareHelp.classList.add('show');
  shareHelp.setAttribute('aria-hidden', 'false');
}

function hideShareHelp(){
  if(!shareHelp) return;
  shareHelp.classList.remove('show');
  shareHelp.setAttribute('aria-hidden', 'true');
}

async function sharePost(){
  if(!currentPost) return;
  const origin = location.origin;
  const shareUrl = `${origin}/s/${currentPost.id}`;
  const title = currentPost.title || `肾域 社区动态（${typeLabel(currentPost.type)}）`;
  const text = (currentPost.body || '').slice(0, 80);

  if(navigator.share){
    try{
      await navigator.share({ title, text, url: shareUrl });
      return;
    }catch(_e){}
  }

  const ok = await copyText(shareUrl);
  if(ok) toast('已复制链接', '可粘贴到微信/群聊，再分享至朋友圈', 'ok');
  else toast('复制失败', '请手动复制浏览器地址栏链接', 'err');

  if(isWeChat()){
    showShareHelp(shareUrl);
  }
}

function renderImages(urls){
  const list = (urls || []).filter(Boolean);
  if(list.length === 0) return '';
  const items = list.slice(0, 9).map(u => `
    <a href="${esc(u)}" target="_blank" rel="noopener">
      <img alt="image" src="${esc(u)}" loading="lazy" />
    </a>
  `).join('');
  return `<div class="image-grid">${items}</div>`;
}

function renderTags(tags){
  const list = (tags || []).filter(Boolean).slice(0, 12);
  if(list.length === 0) return '';
  return `<div class="moment-tags">${list.map(t => `<span class="badge" style="border-color:rgba(255,255,255,.18);background:rgba(255,255,255,.06)">#${esc(t)}</span>`).join('')}</div>`;
}

function renderPost(p, liked=false){
  const canDelete = (currentUser && currentUser.id === p.author_id) || isAdmin;
  const likeCount = countFromRel(p.frontier_likes);
  const commentCount = countFromRel(p.frontier_comments);

  const authorName = (p.author_name || authorPublic?.full_name || 'Member');
  const authorInitial = String(authorName).trim().slice(0,1).toUpperCase();
  const avatarUrl = authorPublic?.avatar_url || '';
  const levelHtml = levelBadgeHtml(authorPublic?.post_count || 0);
  const orgLine = [authorPublic?.organization, authorPublic?.title].filter(Boolean).join(' · ');

  postBox.innerHTML = `
    <div class="moment-card" data-post-id="${esc(p.id)}">
      <div class="moment-head">
        <div class="moment-author">
          <div class="avatar">${avatarUrl ? `<img alt="avatar" src="${esc(avatarUrl)}" style="width:36px;height:36px;border-radius:999px;object-fit:cover">` : authorInitial}</div>
          <div class="who">
            <div class="who-top"><b>${esc(authorName)}</b>${levelHtml}</div>
            <span>${orgLine ? esc(orgLine) + " · " : ""}${esc(typeLabel(p.type))} · ${esc(fmtTime(p.created_at))}</span>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          ${p.is_public_share ? `<span class="badge" title="可公开分享">可分享</span>` : ``}
          ${canDelete ? `<button class="btn tiny danger" type="button" id="deletePostBtn">删除</button>` : ``}
        </div>
      </div>

      ${p.title ? `<div style="margin-top:10px;font-weight:800">${esc(p.title)}</div>` : ``}
      <div class="moment-body" style="margin-top:10px">${esc(p.body)}</div>

      ${p.link_url ? `<div class="small" style="margin-top:8px"><a href="${esc(p.link_url)}" target="_blank" rel="noopener">引用/链接 ↗</a></div>` : ``}

      ${renderImages(p.image_urls)}
      ${renderTags(p.tags)}

      <div class="moment-actions">
        <button class="btn tiny" type="button" id="likeBtn" aria-pressed="${liked ? 'true':'false'}">${liked ? '👍 已赞' : '👍 赞'}</button>
        <span class="count" id="likeCount">${likeCount}</span>

        <span class="btn tiny disabled" aria-disabled="true">💬 评论</span>
        <span class="count">${commentCount}</span>

        <button class="btn tiny" type="button" id="shareBtn">↗ 分享</button>
      </div>
    </div>
  `;

  document.getElementById('shareBtn')?.addEventListener('click', sharePost);
  document.getElementById('likeBtn')?.addEventListener('click', toggleLike);
  document.getElementById('deletePostBtn')?.addEventListener('click', deletePost);
}

async function loadPost(id){
  if(!isConfigured() || !supabase) throw new Error('Supabase 未配置');
  const { data, error } = await supabase
    .from('frontier_posts')
    .select('id, created_at, type, title, body, link_url, tags, image_urls, is_public_share, author_id, author_name, frontier_likes(count), frontier_comments(count)')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if(error) throw error;
  return data || null;
}

async function loadLiked(id){
  const { data, error } = await supabase
    .from('frontier_likes')
    .select('id')
    .eq('post_id', id)
    .eq('user_id', currentUser.id)
    .limit(1);
  if(error) return false;
  return (data || []).length > 0;
}

async function toggleLike(){
  if(!currentPost) return;
  const btn = document.getElementById('likeBtn');
  const countEl = document.getElementById('likeCount');
  const pressed = btn.getAttribute('aria-pressed') === 'true';
  const curCount = Number(countEl.textContent || '0') || 0;

  try{
    if(pressed){
      const { error } = await supabase
        .from('frontier_likes')
        .delete()
        .eq('post_id', currentPost.id)
        .eq('user_id', currentUser.id);
      if(error) throw error;
      btn.setAttribute('aria-pressed','false');
      btn.textContent = '👍 赞';
      countEl.textContent = String(Math.max(0, curCount - 1));
    }else{
      const { error } = await supabase
        .from('frontier_likes')
        .insert({ post_id: currentPost.id, user_id: currentUser.id });
      if(error) throw error;
      btn.setAttribute('aria-pressed','true');
      btn.textContent = '👍 已赞';
      countEl.textContent = String(curCount + 1);
    }
  }catch(e){
    toast('操作失败', e.message || String(e), 'err');
  }
}

async function deletePost(){
  if(!currentPost) return;
  if(!confirm('确定删除这条动态吗？删除后普通用户不可见。')) return;
  try{
    const { error } = await supabase
      .from('frontier_posts')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', currentPost.id);
    if(error) throw error;
    toast('已删除', '动态已删除', 'ok');
    setTimeout(()=> location.href = 'moments.html', 700);
  }catch(e){
    toast('删除失败', e.message || String(e), 'err');
  }
}

function renderComment(c){
  const canDel = (currentUser && currentUser.id === c.author_id) || isAdmin;
  return `
    <div class="card soft" data-comment-id="${esc(c.id)}" style="padding:10px 12px">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
        <div>
          <b>${esc(c.author_name || 'Member')}</b>
          <div class="small muted" style="margin-top:4px">${esc(fmtTime(c.created_at))}</div>
        </div>
        ${canDel ? `<button class="btn tiny danger" type="button" data-del-comment>删除</button>` : ``}
      </div>
      <div style="margin-top:8px;white-space:pre-wrap;line-height:1.55">${esc(c.body)}</div>
    </div>
  `;
}

async function loadComments(){
  if(!currentPost) return;
  commentHint.textContent = '加载中...';
  try{
    const { data, error } = await supabase
      .from('frontier_comments')
      .select('id, created_at, post_id, author_id, author_name, body, deleted_at')
      .eq('post_id', currentPost.id)
      .order('created_at', { ascending: true });
    if(error) throw error;
    const rows = (data || []).filter(x => !x.deleted_at);
    commentHint.textContent = rows.length ? '' : '暂无评论，来抢沙发。';
    commentList.innerHTML = rows.map(renderComment).join('');
  }catch(e){
    console.error(e);
    commentHint.textContent = '评论加载失败';
  }
}

async function deleteComment(commentId, el){
  if(!confirm('删除这条评论？')) return;
  try{
    const { error } = await supabase
      .from('frontier_comments')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', commentId);
    if(error) throw error;
    toast('已删除', '评论已删除', 'ok');
    el?.remove();
  }catch(e){
    toast('删除失败', e.message || String(e), 'err');
  }
}

function initCommentEvents(){
  commentList?.addEventListener('click', async (e)=>{
    const btn = e.target.closest('[data-del-comment]');
    if(!btn) return;
    const item = e.target.closest('[data-comment-id]');
    const id = item?.getAttribute('data-comment-id');
    if(id) await deleteComment(id, item);
  });

  commentForm?.addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    if(!currentPost) return;
    const body = String(commentBody.value || '').trim();
    if(!body){
      toast('内容为空', '请输入评论内容', 'err');
      return;
    }
    commentSubmit.disabled = true;
    commentSubmit.textContent = '发布中...';
    commentSubmitHint.textContent = '';

    try{
      const payload = {
        post_id: currentPost.id,
        author_id: currentUser.id,
        author_name: currentProfile?.full_name || currentUser.email || 'Member',
        body,
      };
      const { error } = await supabase
        .from('frontier_comments')
        .insert(payload);
      if(error) throw error;

      toast('已发布', '评论已发布', 'ok');
      commentBody.value = '';
      await loadComments();
    }catch(e){
      toast('发布失败', e.message || String(e), 'err');
    }finally{
      commentSubmit.disabled = false;
      commentSubmit.textContent = '发布评论';
    }
  });
}

function initShareOverlay(){
  shareHelpClose?.addEventListener('click', hideShareHelp);
  shareHelp?.addEventListener('click', (e)=>{
    if(e.target === shareHelp) hideShareHelp();
  });
  shareHelpCopy?.addEventListener('click', async ()=>{
    const url = shareHelp?.dataset?.url || '';
    if(!url) return;
    const ok = await copyText(url);
    if(ok) toast('已复制', '分享链接已复制', 'ok');
  });
}

(async function init(){
  await ensureAuthed('login.html');

  currentUser = await getCurrentUser();
  if(!currentUser){
    toast('未登录', '请先登录', 'err');
    location.href = 'login.html';
    return;
  }
  currentProfile = await getUserProfile(currentUser).catch(()=>null);
  const role = normalizeRole(currentProfile?.role);
  isAdmin = isAdminRole(role);

  const id = new URLSearchParams(location.search).get('id');
  if(!id){
    detailHint.textContent = '缺少动态 ID';
    return;
  }

  if(!isConfigured() || !supabase){
    detailHint.textContent = '（Supabase 未配置）';
    return;
  }

  try{
    detailHint.textContent = '加载中...';
    const p = await loadPost(id);
    if(!p){
      detailHint.textContent = '动态不存在或已删除';
      return;
    }
    currentPost = p;

    // Load author public profile (for avatar + level badge)
    try{
      const map = await getPublicProfiles([p.author_id]);
      authorPublic = map && map[p.author_id] ? map[p.author_id] : null;
    }catch(_e){
      authorPublic = null;
    }

    const liked = await loadLiked(p.id);
    detailHint.textContent = '';
    renderPost(p, liked);
    initShareOverlay();
    initCommentEvents();
    await loadComments();
  }catch(e){
    console.error(e);
    detailHint.textContent = '加载失败';
    toast('加载失败', e.message || String(e), 'err');
  }
})();