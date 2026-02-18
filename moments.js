import {
  supabase,
  ensureSupabase,
  isConfigured,
  toast,
  ensureAuthed,
  getCurrentUser,
  getUserProfile,
  isAdminRole,
  normalizeRole,
  formatBeijingDateTime,
} from './supabaseClient.js?v=20260128_030';

import { pickDoctor, formatMention, insertAtCursor } from './mentionPicker.js?v=20260130_001';

import { applyShareMeta, copyToClipboard, buildStableUrl } from './share.js?v=20260118_001';

// ------------------------------
// Moments (Phase 1):
// - Text + images (paste / drag & drop / file picker)
// - Fast publish
// - Likes (optional, if table exists)
// ------------------------------

const els = {
  composerHint: document.getElementById('composerHint'),
  editBar: document.getElementById('editBar'),
  editMeta: document.getElementById('editMeta'),
  cancelEditBtn: document.getElementById('cancelEditBtn'),
  bumpTime: document.getElementById('bumpTime'),
  text: document.getElementById('momentText'),
  uploader: document.getElementById('uploader'),
  fileInput: document.getElementById('fileInput'),
  pickBtn: document.getElementById('pickBtn'),
  clearBtn: document.getElementById('clearBtn'),
  thumbGrid: document.getElementById('thumbGrid'),
  // PDF/Word attachments for moments
  docUploader: document.getElementById('docUploader'),
  docInput: document.getElementById('docInput'),
  pickDocBtn: document.getElementById('pickDocBtn'),
  clearDocBtn: document.getElementById('clearDocBtn'),
  docList: document.getElementById('docList'),
  videoUploader: document.getElementById('videoUploader'),
  videoInput: document.getElementById('videoInput'),
  pickVideoBtn: document.getElementById('pickVideoBtn'),
  clearVideoBtn: document.getElementById('clearVideoBtn'),
  videoPreview: document.getElementById('videoPreview'),
  videoLinkRow: document.getElementById('videoLinkRow'),
  videoLink: document.getElementById('videoLink'),
  applyVideoLinkBtn: document.getElementById('applyVideoLinkBtn'),
  clearVideoLinkBtn: document.getElementById('clearVideoLinkBtn'),
  videoLinkPreview: document.getElementById('videoLinkPreview'),
  publishBtn: document.getElementById('publishBtn'),
  publishState: document.getElementById('publishState'),
  feed: document.getElementById('momentsFeed'),
  feedHint: document.getElementById('feedHint'),
  loadMoreBtn: document.getElementById('loadMoreBtn'),
  refreshFeedBtn: document.getElementById('refreshFeedBtn'),
};

function esc(str){
  return String(str ?? '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

// Shorten long URLs for display (keep full href for click / copy).
// iOS Safari renders very long URLs poorly; this keeps layout clean.
function prettyUrlText(href, raw){
  const MAX = 46; // fits most mobile widths inside cards
  try{
    const u = new URL(href);
    const host = String(u.host || '').replace(/^www\./i, '');
    let path = String(u.pathname || '');
    try{ path = decodeURIComponent(path); }catch{}
    if(path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

    let display = host + (path && path !== '/' ? path : '');
    if(!display) display = raw;

    // Hint that there are extra query params without showing the whole thing
    if(u.search && display.length <= MAX - 2) display += '…';

    if(display.length > MAX){
      const headLen = Math.max(18, Math.min(30, MAX - 14));
      const tailLen = 12;
      display = `${display.slice(0, headLen)}…${display.slice(-tailLen)}`;
    }
    return display;
  }catch{
    let s = String(raw || '').replace(/^https?:\/\//i,'').replace(/^www\./i,'');
    if(s.length > MAX) s = `${s.slice(0, 30)}…${s.slice(-12)}`;
    return s || String(raw || '');
  }
}

// ------------------------------
// Video link helpers (B站 / 腾讯会议等)
//
// We store everything in moments.video_url. For rendering:
// - If url looks like a direct video file (mp4/mov/webm...), use <video>
// - If url is a Bilibili page link, embed via player.bilibili.com
// - Otherwise, show a clickable "视频链接" card.
// ------------------------------
function isLikelyVideoFileUrl(url){
  const u = String(url || '').toLowerCase();
  return /(\.mp4|\.mov|\.webm|\.m4v)(\?|#|$)/i.test(u);
}

function safeUrl(url){
  const raw = String(url || '').trim();
  if(!raw) return '';
  if(/^https?:\/\//i.test(raw)) return raw;
  // Allow users to paste without scheme
  return 'https://' + raw;
}

function parseBili(url){
  // returns { type: 'bvid'|'aid', id: string } or null
  try{
    const u = new URL(safeUrl(url));
    const host = String(u.host || '').toLowerCase();
    const path = String(u.pathname || '');
    if(!host.includes('bilibili.com') && !host.includes('b23.tv')) return null;

    // Examples:
    // - https://www.bilibili.com/video/BV1xx411c7mD
    // - https://www.bilibili.com/video/av123456
    // - https://player.bilibili.com/player.html?bvid=BV...  (we can accept)
    const bvidFromQuery = u.searchParams.get('bvid');
    if(bvidFromQuery && /^BV/i.test(bvidFromQuery)) return { type: 'bvid', id: bvidFromQuery };

    const aidFromQuery = u.searchParams.get('aid') || u.searchParams.get('avid');
    if(aidFromQuery && /^\d+$/.test(aidFromQuery)) return { type: 'aid', id: aidFromQuery };

    const m1 = path.match(/\/video\/(BV[0-9A-Za-z]+)/i);
    if(m1) return { type: 'bvid', id: m1[1] };

    const m2 = path.match(/\/video\/av(\d+)/i);
    if(m2) return { type: 'aid', id: m2[1] };

    // b23.tv short links sometimes carry BV in path (best-effort)
    const m3 = path.match(/\/(BV[0-9A-Za-z]+)/i);
    if(m3) return { type: 'bvid', id: m3[1] };

    return null;
  }catch(_e){
    return null;
  }
}

function biliEmbedHtml(url){
  const info = parseBili(url);
  if(!info) return '';
  const src = info.type === 'bvid'
    ? `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(info.id)}&page=1&high_quality=1&danmaku=0`
    : `https://player.bilibili.com/player.html?aid=${encodeURIComponent(info.id)}&page=1&high_quality=1&danmaku=0`;

  return `
    <div class="video-embed-wrap">
      <iframe class="video-embed" src="${esc(src)}"
        scrolling="no" frameborder="0" allowfullscreen="true"></iframe>
    </div>
  `;
}

function externalVideoCardHtml(url){
  const href = safeUrl(url);
  const display = prettyUrlText(href, url);
  return `
    <a class="list-item" href="${esc(href)}" target="_blank" rel="noopener">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
        <div style="min-width:0">
          <b>视频链接</b>
          <div class="small muted" style="margin-top:6px;word-break:break-all">${esc(display)}</div>
        </div>
        <span class="chip">打开</span>
      </div>
    </a>
  `;
}

function renderVideoUrl(url){
  const u = String(url || '').trim();
  if(!u) return '';
  if(isLikelyVideoFileUrl(u)){
    return `
      <div class="video-wrap" style="margin-top:12px">
        <video controls playsinline preload="metadata" style="width:100%;border-radius:14px;background:rgba(0,0,0,0.35)">
          <source src="${esc(u)}" />
        </video>
      </div>
    `;
  }
  const bili = biliEmbedHtml(u);
  if(bili) return bili;
  return externalVideoCardHtml(u);
}



// Safely render user-generated text:
// - escape HTML
// - auto-linkify URLs
// - preserve newlines
function nl2br(str){
  // Safely render user-generated text:
  // - supports @mentions:
  //     - legacy: @[Name](uuid)
  //     - new: @Name (no uuid)
  // - auto-linkify URLs
  // - preserves single newlines
  // - converts blank lines into paragraphs (tidier on mobile + desktop)
  const raw = String(str ?? '').replace(/\r\n/g, '\n');

  // Tokenize in one pass: legacy mention / plain mention / URL
  // Plain mention matches common Chinese/English names and avoids emails by requiring a boundary.
  const tokenRe = /@\[([^\]]+?)\]\(([0-9a-fA-F-]{36})\)|(^|[\s(（【\[{\u3000>《“‘'"、，。！？;:])@([A-Za-z0-9_\-\u4e00-\u9fa5·]{1,24})|(?:https?:\/\/|www\.)[^\s<]+/gm;

  function renderInline(s){
    const text = String(s ?? '');
    let out = '';
    let last = 0;

    for(const m of text.matchAll(tokenRe)){
      const start = m.index ?? 0;
      const full = String(m[0] ?? '');
      out += esc(text.slice(last, start));

      // Mention token (legacy)
      if(full.startsWith('@[')){
        const name = String(m[1] ?? '').trim() || '医生';
        const id = String(m[2] ?? '').trim();
        out += `<span class="mention" data-uid="${esc(id)}">@${esc(name)}</span>`;
        last = start + full.length;
        continue;
      }

      // Mention token (plain): matched with a boundary prefix captured in group 3
      if(typeof m[4] === 'string' && m[4]){
        const prefix = String(m[3] ?? '');
        const name = String(m[4] ?? '').trim();
        if(prefix) out += esc(prefix);
        out += `<span class="mention">@${esc(name)}</span>`;
        last = start + full.length;
        continue;
      }

      // URL token
      let rawUrl = full;
      let url = rawUrl;
      let trailing = '';
      while(url.length){
        const ch = url[url.length - 1];
        if(/[\)\]\}\.,!?;:，。！？；：》」』”’"']/.test(ch)){
          trailing = ch + trailing;
          url = url.slice(0, -1);
          continue;
        }
        break;
      }
      const href = url.startsWith('www.') ? `https://${url}` : url;
      if(url){
        const label = prettyUrlText(href, url);
        out += `<a class="auto-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(href)}">${esc(label)}</a>`;
      }else{
        out += esc(rawUrl);
      }
      if(trailing) out += esc(trailing);

      last = start + rawUrl.length;
    }

    out += esc(text.slice(last));
    return out;
  }

  const paras = raw
    .split(/\n{2,}/)
    .map(p => p.replace(/\s+$/g, '')) // keep leading spaces, trim only line-end whitespace
    .filter(p => p.trim().length > 0);

  if(!paras.length) return '';

  return paras.map(p=>{
    const inner = renderInline(p).replace(/\n/g, '<br/>');
    return `<p>${inner}</p>`;
  }).join('');
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// ------------------------------
// Comment attachment helpers
// ------------------------------
function fmtSize(n){
  const b = Number(n || 0);
  if(!Number.isFinite(b) || b <= 0) return '';
  const kb = b / 1024;
  if(kb < 1024) return `${Math.round(kb)}KB`;
  const mb = kb / 1024;
  if(mb < 1024) return `${mb.toFixed(1)}MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)}GB`;
}

function guessKindFromMime(mime, name){
  const t = String(mime || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if(t.startsWith('image/')) return 'image';
  if(t.includes('pdf') || n.endsWith('.pdf')) return 'pdf';
  if(t.includes('msword') || t.includes('wordprocessingml') || n.endsWith('.doc') || n.endsWith('.docx')) return 'doc';
  return 'file';
}

function safeFilename(name){
  // Supabase Storage object keys should be URL-safe (ASCII). Non-ASCII characters
  // (e.g. Chinese) can trigger "Invalid key" errors in supabase-js.
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

function draftKey(scope, id){
  return `${scope}:${id}`;
}

function getDraftItems(scope, id){
  const k = draftKey(scope, id);
  const v = attachDraft.get(k);
  return Array.isArray(v?.items) ? v.items : [];
}

function setDraftItems(scope, id, items){
  const k = draftKey(scope, id);
  attachDraft.set(k, { items: Array.isArray(items) ? items : [] });
}

function clearDraft(scope, id){
  const k = draftKey(scope, id);
  attachDraft.delete(k);
  const input = els.feed?.querySelector(`[data-attach-input="${id}"][data-attach-scope="${scope}"]`);
  if(input) input.value = '';
  renderDraft(scope, id);
}

function isAllowedAttachment(file){
  const t = String(file?.type || '').toLowerCase();
  const n = String(file?.name || '').toLowerCase();
  if(t.startsWith('image/')) return true;
  if(t.includes('pdf') || n.endsWith('.pdf')) return true;
  if(t.includes('msword') || t.includes('wordprocessingml') || n.endsWith('.doc') || n.endsWith('.docx')) return true;
  // allow empty-type doc via extension
  return false;
}

function addDraftFiles(scope, id, files){
  const list = Array.from(files || []);
  if(!list.length) return;

  const cur = getDraftItems(scope, id);
  const next = [...cur];

  for(const f of list){
    if(next.length >= MAX_COMMENT_ATTACH_COUNT) break;
    if(!isAllowedAttachment(f)){
      toast('不支持的附件格式', `${f.name || '附件'}：仅支持 图片 / PDF / Word（.doc/.docx）。`, 'err');
      continue;
    }
    if((f.size || 0) > MAX_COMMENT_ATTACH_BYTES){
      const mb = Math.round((f.size || 0) / 1024 / 1024);
      toast('附件过大', `${f.name}（${mb}MB）超出限制（单个≤${Math.round(MAX_COMMENT_ATTACH_BYTES/1024/1024)}MB）。`, 'err');
      continue;
    }
    next.push({ file: f, id: `${Date.now()}_${Math.random().toString(16).slice(2)}` });
  }

  setDraftItems(scope, id, next);
  renderDraft(scope, id);
}

function renderDraft(scope, id){
  const listEl = els.feed?.querySelector(`[data-attach-list="${id}"][data-attach-scope="${scope}"]`);
  if(!listEl) return;
  const items = getDraftItems(scope, id);
  if(!items.length){
    listEl.innerHTML = '';
    return;
  }
  listEl.innerHTML = items.map(it=>{
    const f = it.file;
    const kind = guessKindFromMime(f?.type, f?.name);
    const icon = kind === 'image' ? '🖼️' : (kind === 'pdf' ? '📄' : (kind === 'doc' ? '📝' : '📎'));
    const meta = `${esc(String(f?.type || ''))}${f?.size ? ' · ' + fmtSize(f.size) : ''}`;
    return `
      <div class="attach-item">
        <div class="left">
          <div class="name">${icon} ${esc(f?.name || '附件')}</div>
          <div class="meta">${esc(meta)}</div>
        </div>
        <button class="btn tiny" type="button" data-attach-remove="${it.id}" data-attach-scope="${scope}" data-attach-owner="${id}">移除</button>
      </div>
    `;
  }).join('');
}

function renderAttachmentsBlock(attaches){
  const raw = Array.isArray(attaches) ? attaches : [];
  if(!raw.length) return '';

  // Only render links we can actually open. For private buckets, URLs are resolved
  // via signed URLs at load time; anonymous users may not have access.
  const a = raw.filter(x => x && String(x.public_url || '').trim().length > 0);
  if(!a.length){
    // We know there are attachments but we cannot render accessible links.
    return '<div class="small muted">（附件仅登录后可查看）</div>';
  }

  const imgs = a.filter(x => String(x.kind || '') === 'image');
  const files = a.filter(x => String(x.kind || '') !== 'image');
  const imgHtml = imgs.length ? `
    <div class="attach-grid">
      ${imgs.map(x=>`<a class="attach-img" href="${esc(x.public_url || '')}" target="_blank" rel="noopener"><img alt="img" src="${esc(x.public_url || '')}"/></a>`).join('')}
    </div>
  ` : '';
  const fileHtml = files.length ? `
    <div class="attach-list">
      ${files.map(x=>{
        const icon = String(x.kind || '') === 'pdf' ? '📄' : (String(x.kind || '') === 'doc' ? '📝' : '📎');
        const nm = x.original_name || x.path || '附件';
        return `<a class="file-chip" href="${esc(x.public_url || '')}" target="_blank" rel="noopener">${icon} ${esc(nm)}</a>`;
      }).join('')}
    </div>
  ` : '';
  return imgHtml + fileHtml;
}


const ATTACH_SIGN_TTL_SECONDS = 60 * 60; // 1 hour

async function hydrateSignedUrlsForAttachments(attRows){
  const rows = Array.isArray(attRows) ? attRows : [];
  if(!rows.length) return;

  // Only sign for the private discussion bucket.
  const need = rows.filter(a => a && String(a.bucket || 'attachments') === 'attachments' && a.path);
  if(!need.length) return;

  // Ensure we know whether the user is authenticated.
  try{ await initAuth(); }catch(_e){}

  if(!currentUser){
    // Anonymous users cannot sign private URLs; clear them to avoid broken links.
    for(const a of need){
      a.public_url = '';
    }
    return;
  }

  const bucket = 'attachments';
  const uniq = Array.from(new Set(need.map(a => String(a.path))));
  try{
    const api = supabase?.storage?.from(bucket);
    if(!api) return;

    if(typeof api.createSignedUrls === 'function'){
      const { data, error } = await api.createSignedUrls(uniq, ATTACH_SIGN_TTL_SECONDS);
      if(error) throw error;
      const map = new Map((data || []).map(x => [String(x.path), String(x.signedUrl || '')]));
      for(const a of need){
        const u = map.get(String(a.path));
        if(u) a.public_url = u;
      }
      return;
    }

    // Fallback (older SDKs): sign one-by-one
    if(typeof api.createSignedUrl === 'function'){
      for(const a of need){
        try{
          const { data, error } = await api.createSignedUrl(String(a.path), ATTACH_SIGN_TTL_SECONDS);
          if(!error && data?.signedUrl) a.public_url = data.signedUrl;
        }catch(_e){ /* ignore */ }
      }
    }
  }catch(_e){
    // If signing fails, clear legacy public URLs (they won't work once bucket is private).
    for(const a of need){
      const u = String(a.public_url || '');
      if(!u || u.includes('/storage/v1/object/public/attachments/')) a.public_url = '';
    }
  }
}



// ------------------------------
// Common error helpers
// ------------------------------
function _isMissingRpc(err, fnName){
  const msg = String((err && (err.message || err.error_description)) ? (err.message || err.error_description) : (err || ''));
  return msg.includes('PGRST202') || msg.includes('Could not find the function') || (msg.includes('function') && msg.includes(fnName));
}

function _humanizeRlsError(err){
  const msg = String((err && (err.message || err.error_description)) ? (err.message || err.error_description) : (err || ''));
  if(/row-level security|rls|permission denied|403/i.test(msg)){
    return msg + '\n\n提示：这通常是 Supabase 的 RLS 权限/策略未配置好导致。请在 Supabase → SQL Editor 重新运行最新版 SUPABASE_SETUP.sql，然后到 Settings → API 执行 Reload schema 再重试。';
  }
  return msg;
}


// Selected images (local preview)
/** @type {{ file: File, url: string, id: string }[]} */
let picks = [];

// Selected short video (mutually exclusive with images in this version)
/** @type {{ file: File, url: string, id: string } | null} */
let videoPick = null;
let videoLinkUrl = '';
let videoLinkTouched = false;

// Edit mode state
let editingMomentId = null;
let editingOriginal = null;
// Existing media (when editing): keep URLs unless user clears/replaces
let existingImages = [];
let existingVideoUrl = null;

// Feed cache (for edit)
let feedRows = [];
let feedById = new Map();

// Feed paging (Load more)
const FEED_PAGE_SIZE = 30;
let feedCursor = null; // created_at of the oldest loaded row
let feedReachedEnd = false;
let feedLoadingMore = false;


// Comments cache (Moment comments & replies)
let commentCache = new Map(); // momentId -> { rows, loadedAt }

// Attachments draft for comments/replies
// key: `moment:${momentId}` | `reply:${commentId}`
let attachDraft = new Map(); // key -> { items: {file: File, id: string}[] }
const MAX_COMMENT_ATTACH_BYTES = 20 * 1024 * 1024; // 20MB
const MAX_COMMENT_ATTACH_COUNT = 9;
let feedDelegationBound = false;

// Moment-level attachments (PDF/Word)
/** @type {{ file: File, id: string }[]} */
let momentFilePicks = [];
/** @type {any[]} */
let existingMomentFiles = [];
/** @type {Set<string>} */
let pendingMomentFileDeletes = new Set();
const MAX_MOMENT_FILE_BYTES = 20 * 1024 * 1024; // 20MB
const MAX_MOMENT_FILE_COUNT = 5;


const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12MB / image

let currentUser = null;
let currentProfile = null;
let isAdmin = false;
let isModerator = false;

// If a deployment had an incorrect DEFAULT on deleted_at,
// explicitly writing null during insert ensures the moment is visible.
// (We also keep a local copy to display even if feed read is blocked.)
let lastPublished = null;

// When linking from notifications/favorites: moments.html?id=<momentId>


function momentShareUrl(momentId){
  try{
    const u = new URL(location.href);
    u.searchParams.set('id', String(momentId));
    u.searchParams.delete('v');
    u.hash = '';
    return u.href;
  }catch(_e){
    return buildStableUrl();
  }
}

function momentShareDesc(m){
  const raw = String(m?.content || '').replace(/\s+/g, ' ').trim();
  if(!raw) return '来自 KidneySphere 的一条社区动态';
  const MAX = 110;
  return raw.length <= MAX ? raw : (raw.slice(0, MAX).trim() + '…');
}

function applyShareForMoment(m){
  if(!m || !m.id) return null;
  // 分享标题：优先用内容摘要（更像朋友圈/收藏里常见的“文章标题”），
  // 没有内容再退回到“社区动态 · 作者”。
  const author = String(m.author_name || '成员');
  const raw = String(m?.content || '').replace(/\s+/g, ' ').trim();
  const titleCore = raw ? (raw.length <= 42 ? raw : (raw.slice(0, 42).trim() + '…')) : '';
  const title = titleCore ? `${titleCore} · ${author}` : `社区动态 · ${author}`;
  const description = momentShareDesc(m);
  // WeChat/朋友圈链接预览对 JS 执行不稳定；
  // 为避免“有时无图/图不一致”，这里默认固定使用统一的分享封面。
  // （如未来希望“每条动态用自己的首图做封面”，需要做服务端渲染/分享中转页。）
  const image = 'assets/wechat_share_logo.png';
  const url = momentShareUrl(m.id);
  applyShareMeta({ title, description, image, url, type: 'website' });
  return { title, description, image, url };
}


function momentFirstImageUrl(m){
  const imgs = Array.isArray(m?.images) ? m.images : [];
  const first = imgs.find(Boolean);
  if(first) return String(first);
  const legacy = m?.image_url || m?.cover_url || '';
  return legacy ? String(legacy) : '';
}

function ensureMomentShareModal(){
  let modal = document.getElementById('momentShareModal');
  if(modal) return modal;

  modal = document.createElement('div');
  modal.id = 'momentShareModal';
  modal.className = 'modal hidden';
  modal.innerHTML = `
    <div class="modal-backdrop" data-close="1"></div>
    <div class="modal-card">
      <div class="modal-head">
        <div class="modal-title">分享动态</div>
        <button class="icon-btn" data-close="1" aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="small muted" id="momentShareIntro">
          你可以复制链接，或在手机上使用系统分享（可选择“发送给朋友 / 分享到朋友圈”等）。
          如需朋友圈展示图片，建议使用“分享图片/保存图片”。
        </div>

        <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn" id="momentShareCopyBtn" type="button">复制链接</button>
          <button class="btn primary" id="momentShareNativeBtn" type="button">系统分享链接</button>
          <button class="btn" id="momentShareImageBtn" type="button">分享图片</button>
          <button class="btn" id="momentShareSaveBtn" type="button">保存图片</button>
        </div>

        <div class="small muted" style="margin-top:10px; line-height:1.6;">
          提示：网页无法直接“自动发朋友圈”，但系统分享会弹出分享面板，你可在微信中选择好友/朋友圈。
          若系统分享不可用，请使用“复制链接”或“保存图片”。
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Close handlers
  modal.addEventListener('click', (e)=>{
    const t = e.target;
    if(!(t instanceof Element)) return;
    if(t.getAttribute('data-close') === '1') hideMomentShareModal();
    if(t.classList.contains('modal-backdrop')) hideMomentShareModal();
  });

  return modal;
}

function hideMomentShareModal(){
  const modal = document.getElementById('momentShareModal');
  if(modal) modal.classList.add('hidden');
}

async function downloadImage(url, filename){
  try{
    const r = await fetch(url, { cache: 'no-store' });
    if(!r.ok) throw new Error('fetch failed');
    const blob = await r.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename || 'image';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=> URL.revokeObjectURL(objectUrl), 1500);
  }catch(e){
    // If CORS blocks, fallback to opening the image
    window.open(url, '_blank');
  }
}

async function shareImage(url, filename, title, text, shareUrl){
  try{
    const r = await fetch(url, { cache: 'no-store' });
    if(!r.ok) throw new Error('fetch failed');
    const blob = await r.blob();
    const ext = (blob.type && blob.type.split('/')[1]) ? blob.type.split('/')[1] : 'jpg';
    const file = new File([blob], `${filename || 'moment'}.${ext}`, { type: blob.type || 'image/jpeg' });

    if(navigator.canShare && !navigator.canShare({ files:[file] })){
      throw new Error('canShare(files) not supported');
    }
    if(!navigator.share) throw new Error('navigator.share not supported');

    // 部分平台对同时分享 files+url 支持不一致：把链接写进 text 里更稳
    const txt = (text ? String(text) : '').trim();
    const urlText = shareUrl ? `

链接：${shareUrl}` : '';
    await navigator.share({
      title: title || '肾域AI · 社区动态',
      text: (txt || '来自肾域AI 的一条动态') + urlText,
      files: [file],
    });
    return true;
  }catch(e){
    return false;
  }
}

async function openMomentShareDialog(m){
  const modal = ensureMomentShareModal();

  const meta = applyShareForMoment(m);
  const shareUrl = meta?.url || momentShareUrl(m?.id);
  const title = meta?.title || '肾域AI · 社区动态';
  const text = (meta?.description || '').trim() || ((m?.content || '').slice(0, 80) || '来自肾域AI 的一条动态');

  const imgUrl = momentFirstImageUrl(m);
  const nativeBtn = modal.querySelector('#momentShareNativeBtn');
  const imgBtn = modal.querySelector('#momentShareImageBtn');
  const saveBtn = modal.querySelector('#momentShareSaveBtn');
  const copyBtn = modal.querySelector('#momentShareCopyBtn');

  if(nativeBtn){
    nativeBtn.style.display = navigator.share ? '' : 'none';
    nativeBtn.onclick = async ()=>{
      try{
        await navigator.share({ title, text, url: shareUrl });
      }catch(_e){}
      hideMomentShareModal();
    };
  }
  if(copyBtn){
    copyBtn.onclick = async ()=>{
      await copyToClipboard(shareUrl);
      toast('已复制链接，可粘贴到微信/朋友圈');
      hideMomentShareModal();
    };
  }

  const hasImg = !!imgUrl;
  if(imgBtn){
    imgBtn.style.display = (hasImg && navigator.share) ? '' : 'none';
    imgBtn.onclick = async ()=>{
      const ok = await shareImage(imgUrl, `moment_${m?.id || ''}`, title, text, shareUrl);
      if(!ok){
        toast('系统不支持直接分享图片，已为你打开“保存图片”');
        await downloadImage(imgUrl, `moment_${m?.id || ''}.jpg`);
      }
      hideMomentShareModal();
    };
  }
  if(saveBtn){
    saveBtn.style.display = hasImg ? '' : 'none';
    saveBtn.onclick = async ()=>{
      await downloadImage(imgUrl, `moment_${m?.id || ''}.jpg`);
      toast('已触发下载/打开图片，可在微信中选择分享');
      hideMomentShareModal();
    };
  }

  modal.classList.remove('hidden');
}


let urlHighlightId = null;
try{ urlHighlightId = new URLSearchParams(location.search).get('id'); }catch(_e){ urlHighlightId = null; }


async function initAuth(){
  if(!isConfigured()) return;
  if(!supabase) await ensureSupabase();
  if(!supabase) return;
  if(currentUser && currentProfile) return;
  try{
    currentUser = await getCurrentUser();
    if(currentUser){
      currentProfile = await getUserProfile(currentUser);
      const role = normalizeRole(currentProfile?.role || currentUser.user_metadata?.role);
      isAdmin = isAdminRole(role);
      isModerator = (String(role || '').toLowerCase() === 'moderator');
    }
  }catch(_e){
    // ignore
  }
}

function setHint(msg, type='info'){
  if(!els.composerHint) return;
  if(!msg){
    els.composerHint.style.display = 'none';
    els.composerHint.textContent = '';
    return;
  }
  els.composerHint.style.display = 'block';
  els.composerHint.className = type === 'err' ? 'note' : 'note';
  els.composerHint.innerHTML = msg;
}

function setPublishState(msg){
  if(els.publishState) els.publishState.textContent = msg || '';
}

function isEditing(){
  return Boolean(editingMomentId);
}

function updateComposerMode(){
  const editing = Boolean(editingMomentId);

  if(els.editBar){
    els.editBar.style.display = editing ? 'flex' : 'none';
  }
  if(els.publishBtn){
    els.publishBtn.textContent = editing ? '保存修改' : '发布';
  }
  if(els.bumpTime){
    els.bumpTime.disabled = !editing;
    if(!editing) els.bumpTime.checked = false;
  }
  if(els.editMeta){
    if(editing){
      const when = editingOriginal?.created_at ? formatBeijingDateTime(editingOriginal.created_at) : '';
      els.editMeta.textContent = `ID #${editingMomentId}${when ? ' · 发布于 ' + when : ''}`;
    }else{
      els.editMeta.textContent = '';
    }
  }
}

function resetEditState(){
  editingMomentId = null;
  editingOriginal = null;
  existingImages = [];
  existingVideoUrl = null;
  existingMomentFiles = [];
  pendingMomentFileDeletes = new Set();
  momentFilePicks = [];
  renderMomentFiles();
  videoLinkTouched = false;
  videoLinkUrl = '';
  if(els.videoLink) els.videoLink.value = '';
  renderVideoLinkPreview();
  if(els.bumpTime) els.bumpTime.checked = false;
  updateComposerMode();
}

function cancelEdit(){
  resetEditState();
  setHint('');
  setPublishState('');
  if(els.text) els.text.value = '';
  clearAll();
  clearMomentFiles();
  clearVideo();
  clearVideoLink();
}

function updateClearBtn(){
  const has = (picks.length > 0) || (existingImages && existingImages.length > 0);
  if(!els.clearBtn) return;
  els.clearBtn.setAttribute('aria-disabled', has ? 'false' : 'true');
  els.clearBtn.disabled = !has;
}

function updateVideoClearBtn(){
  const has = Boolean(videoPick || existingVideoUrl);
  if(!els.clearVideoBtn) return;
  els.clearVideoBtn.setAttribute('aria-disabled', has ? 'false' : 'true');
  els.clearVideoBtn.disabled = !has;
}

// ------------------------------
// Moment-level PDF/Word attachments
// ------------------------------
function _visibleExistingMomentFiles(){
  const all = Array.isArray(existingMomentFiles) ? existingMomentFiles : [];
  if(!all.length) return [];
  return all.filter(a => a && a.id && !pendingMomentFileDeletes.has(String(a.id)));
}

function updateDocClearBtn(){
  const has = (momentFilePicks.length > 0) || (_visibleExistingMomentFiles().length > 0);
  if(!els.clearDocBtn) return;
  els.clearDocBtn.setAttribute('aria-disabled', has ? 'false' : 'true');
  els.clearDocBtn.disabled = !has;
}

function removeMomentFilePick(id){
  const idx = momentFilePicks.findIndex(x => x.id === id);
  if(idx >= 0){
    momentFilePicks.splice(idx, 1);
    renderMomentFiles();
  }
}

function markExistingMomentFileDeleted(attId){
  if(attId == null) return;
  pendingMomentFileDeletes.add(String(attId));
  renderMomentFiles();
}

function clearMomentFiles(){
  // Clear newly selected files
  momentFilePicks = [];
  // In edit mode, also mark all existing files as deleted (will be applied on save)
  for(const a of Array.isArray(existingMomentFiles) ? existingMomentFiles : []){
    if(a && a.id) pendingMomentFileDeletes.add(String(a.id));
  }
  renderMomentFiles();
}

function addMomentFiles(files){
  const list = Array.from(files || []);
  if(!list.length) return;

  const hasFileVideo = Boolean(
    videoPick ||
    (existingVideoUrl && isLikelyVideoFileUrl(existingVideoUrl)) ||
    (videoLinkUrl && isLikelyVideoFileUrl(videoLinkUrl))
  );
  if(hasFileVideo){
    toast('已选择短视频', '短视频（上传/直链）与 PDF/Word 附件暂不支持混发。请先“清空视频”再添加附件。', 'err');
    return;
  }

  const existingCount = _visibleExistingMomentFiles().length;
  const cur = existingCount + momentFilePicks.length;
  const remain = Math.max(0, MAX_MOMENT_FILE_COUNT - cur);
  if(remain <= 0){
    toast(`最多 ${MAX_MOMENT_FILE_COUNT} 个附件`, '已达到最大附件数量。如需替换，请先移除/清空附件。', 'err');
    return;
  }

  let added = 0;
  for(const f of list){
    if(existingCount + momentFilePicks.length >= MAX_MOMENT_FILE_COUNT) break;
    if(!f) continue;

    const kind = guessKindFromMime(f.type, f.name);
    if(!(kind === 'pdf' || kind === 'doc')){
      toast('不支持的格式', `${f.name || '文件'}：仅支持 PDF / Word（.doc/.docx）。`, 'err');
      continue;
    }
    if((f.size || 0) > MAX_MOMENT_FILE_BYTES){
      const mb = Math.round((f.size || 0) / 1024 / 1024);
      toast('文件过大', `${f.name}（${mb}MB）超出限制（单个≤${Math.round(MAX_MOMENT_FILE_BYTES/1024/1024)}MB）。`, 'err');
      continue;
    }

    momentFilePicks.push({ file: f, id: `${Date.now()}_${Math.random().toString(16).slice(2)}` });
    added++;
  }

  if(added) renderMomentFiles();
}

function renderMomentFiles(){
  if(!els.docList) return;
  const existing = _visibleExistingMomentFiles();
  const picks = Array.isArray(momentFilePicks) ? momentFilePicks : [];

  if(existing.length === 0 && picks.length === 0){
    els.docList.innerHTML = '';
    updateDocClearBtn();
    return;
  }

  const existingHtml = existing.map(a=>{
    const kind = String(a.kind || guessKindFromMime(a.mime_type, a.original_name));
    const icon = kind === 'pdf' ? '📄' : (kind === 'doc' ? '📝' : '📎');
    const nm = a.original_name || a.path || '附件';
    const meta = `${String(a.mime_type || '')}${a.size_bytes ? ' · ' + fmtSize(a.size_bytes) : ''}`;
    const open = a.public_url ? `<a class="btn tiny" href="${esc(a.public_url)}" target="_blank" rel="noopener">打开</a>` : '';
    return `
      <div class="attach-item">
        <div class="left">
          <div class="name">${icon} ${esc(nm)}</div>
          <div class="meta">${esc(meta)}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
          ${open}
          <button class="btn tiny" type="button" data-moment-file-remove-existing="${esc(a.id)}">移除</button>
        </div>
      </div>
    `;
  }).join('');

  const picksHtml = picks.map(it=>{
    const f = it.file;
    const kind = guessKindFromMime(f?.type, f?.name);
    const icon = kind === 'pdf' ? '📄' : (kind === 'doc' ? '📝' : '📎');
    const meta = `${String(f?.type || '')}${f?.size ? ' · ' + fmtSize(f.size) : ''}`;
    return `
      <div class="attach-item" data-moment-file-pick="${esc(it.id)}">
        <div class="left">
          <div class="name">${icon} ${esc(f?.name || '附件')}</div>
          <div class="meta">${esc(meta)}</div>
        </div>
        <button class="btn tiny" type="button" data-moment-file-remove="${esc(it.id)}">移除</button>
      </div>
    `;
  }).join('');

  els.docList.innerHTML = existingHtml + picksHtml;

  els.docList.querySelectorAll('[data-moment-file-remove]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-moment-file-remove');
      removeMomentFilePick(id);
    });
  });
  els.docList.querySelectorAll('[data-moment-file-remove-existing]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-moment-file-remove-existing');
      markExistingMomentFileDeleted(id);
    });
  });

  updateDocClearBtn();
}

function removeExistingImage(idx){
  const i = Number(idx);
  if(Number.isNaN(i)) return;
  if(i >= 0 && i < (existingImages?.length || 0)){
    existingImages.splice(i, 1);
    renderThumbs();
  }
}

function renderThumbs(){
  if(!els.thumbGrid) return;

  const existing = Array.isArray(existingImages) ? existingImages : [];
  if(existing.length === 0 && picks.length === 0){
    els.thumbGrid.innerHTML = '';
    updateClearBtn();
    return;
  }

  const existingHtml = existing.map((u, i) => `
    <div class="thumb" data-existing="${i}">
      <img alt="image" src="${esc(u)}" />
      <button class="thumb-x" type="button" title="移除原图" data-remove-existing="${i}">✕</button>
    </div>
  `).join('');

  const newHtml = picks.map(p => `
    <div class="thumb" data-thumb="${esc(p.id)}">
      <img alt="image" src="${esc(p.url)}" />
      <button class="thumb-x" type="button" title="移除" data-remove="${esc(p.id)}">✕</button>
    </div>
  `).join('');

  els.thumbGrid.innerHTML = existingHtml + newHtml;

  els.thumbGrid.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-remove');
      removePick(id);
    });
  });
  els.thumbGrid.querySelectorAll('[data-remove-existing]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const idx = btn.getAttribute('data-remove-existing');
      removeExistingImage(idx);
    });
  });

  updateClearBtn();
}

function renderVideo(){
  if(!els.videoPreview) return;

  // videoPreview is for uploaded video file (or file-like URL) only.
  const shouldShowExisting = existingVideoUrl && isLikelyVideoFileUrl(existingVideoUrl);

  if(!videoPick && !shouldShowExisting){
    els.videoPreview.innerHTML = '';
    updateVideoClearBtn();
    return;
  }

  if(videoPick){
    const mb = Math.round((videoPick.file?.size || 0) / 1024 / 1024);
    els.videoPreview.innerHTML = `
      <div class="moment-video">
        <video controls playsinline preload="metadata" src="${esc(videoPick.url)}"></video>
      </div>
      <div class="small muted" style="margin-top:8px">已选择：${esc(videoPick.file?.name || 'video')} · ${mb}MB</div>
    `;
    updateVideoClearBtn();
    return;
  }

  // existing video file (edit mode)
  els.videoPreview.innerHTML = `
    ${renderVideoUrl(existingVideoUrl)}
    <div class="small muted" style="margin-top:8px">当前视频（编辑中）。如需替换，先点击“清空视频”，再选择新视频。</div>
  `;
  updateVideoClearBtn();
}

function renderVideoLinkPreview(){
  if(!els.videoLinkPreview) return;
  const u = String(videoLinkUrl || '').trim();
  if(!u){
    els.videoLinkPreview.innerHTML = '';
    return;
  }
  els.videoLinkPreview.innerHTML = renderVideoUrl(u);
}

function clearVideoLink(){
  videoLinkTouched = true;
  videoLinkUrl = '';
  if(els.videoLink) els.videoLink.value = '';
  renderVideoLinkPreview();
}

function removePick(id){
  const idx = picks.findIndex(x => x.id === id);
  if(idx >= 0){
    try{ URL.revokeObjectURL(picks[idx].url); }catch(_e){}
    picks.splice(idx, 1);
    renderThumbs();
  }
}

function clearAll(){
  picks.forEach(p=>{ try{ URL.revokeObjectURL(p.url); }catch(_e){} });
  picks = [];
  existingImages = [];
  renderThumbs();
}

function clearVideo(){
  if(videoPick){
    try{ URL.revokeObjectURL(videoPick.url); }catch(_e){}
    videoPick = null;
  }
  existingVideoUrl = null;
  renderVideo();
}

function fileId(file){
  return `${Date.now()}_${Math.random().toString(16).slice(2)}_${file.size}`;
}

function addFiles(files){
  const hasFileVideo = Boolean(
    videoPick ||
    (existingVideoUrl && isLikelyVideoFileUrl(existingVideoUrl)) ||
    (videoLinkUrl && isLikelyVideoFileUrl(videoLinkUrl))
  );
  if(hasFileVideo){
    toast('已选择短视频', '短视频（上传/直链）与图片暂不支持混发。请先“清空视频”再添加图片。', 'err');
    return;
  }
  const arr = Array.from(files || []).filter(f => f && String(f.type || '').startsWith('image/'));
  if(arr.length === 0) return;

  const max = 9;
  const cur = (existingImages?.length || 0) + picks.length;
  const remain = Math.max(0, max - cur);
  if(remain <= 0){
    toast('最多 9 张', '已达到最大图片数量（9 张）。如需替换，请先点击“清空”。', 'err');
    return;
  }
  const take = arr.slice(0, remain);
  if(take.length < arr.length){
    toast('最多 9 张', `本次仅添加前 ${remain} 张图片。`, 'err');
  }

  take.forEach(f=>{
    const url = URL.createObjectURL(f);
    picks.push({ file: f, url, id: fileId(f) });
  });
  renderThumbs();
}

function addVideoFile(file){
  if(!file || !String(file.type || '').startsWith('video/')){
    toast('请选择视频文件', '支持 mp4 / mov / webm 等常见格式。', 'err');
    return;
  }
  // If user already pasted an external video link, clear it (video_url can only hold one).
  if(videoLinkUrl){
    clearVideoLink();
  }

  if(_visibleExistingMomentFiles().length > 0 || momentFilePicks.length > 0){
    toast('已选择附件', '短视频（上传）与 PDF/Word 附件暂不支持混发。请先“清空附件”再选择视频。', 'err');
    return;
  }

  if(picks.length > 0 || (existingImages?.length || 0) > 0){
    toast('已选择图片', '当前版本短视频与图片暂不支持混发。请先“清空图片”再选择视频。', 'err');
    return;
  }
  if((file.size || 0) > MAX_VIDEO_BYTES){
    toast('视频过大', `建议 ≤ 50MB。当前：${Math.round((file.size||0)/1024/1024)}MB`, 'err');
    return;
  }
  // Replace existing video
  clearVideo();
  const url = URL.createObjectURL(file);
  videoPick = { file, url, id: fileId(file) };
  renderVideo();
}

// ------------------------------
// Uploader: drag & drop + paste
// ------------------------------
function initUploader(){
  if(!els.uploader && !els.videoUploader) return;

  els.pickBtn?.addEventListener('click', ()=> els.fileInput?.click());
  els.fileInput?.addEventListener('change', ()=>{
    addFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  els.clearBtn?.addEventListener('click', clearAll);

  // PDF/Word attachments
  els.pickDocBtn?.addEventListener('click', ()=> els.docInput?.click());
  els.docInput?.addEventListener('change', ()=>{
    addMomentFiles(els.docInput.files);
    els.docInput.value = '';
  });
  els.clearDocBtn?.addEventListener('click', clearMomentFiles);

  // video pick / clear
  els.pickVideoBtn?.addEventListener('click', ()=> els.videoInput?.click());
  els.videoInput?.addEventListener('change', ()=>{
    const f = els.videoInput.files && els.videoInput.files[0];
    if(f) addVideoFile(f);
    els.videoInput.value = '';
  });
  els.clearVideoBtn?.addEventListener('click', clearVideo);
  els.cancelEditBtn?.addEventListener('click', cancelEdit);

  // video link
  els.applyVideoLinkBtn?.addEventListener('click', ()=>{
    videoLinkTouched = true;
    videoLinkUrl = String(els.videoLink?.value || '').trim();
    // If a link is set, clear any uploaded video (they share the same DB column video_url)
    if(videoLinkUrl){
      clearVideo();
    }
    renderVideoLinkPreview();
  });
  els.clearVideoLinkBtn?.addEventListener('click', clearVideoLink);
  els.videoLink?.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){
      e.preventDefault();
      els.applyVideoLinkBtn?.click();
    }
  });
  els.videoLink?.addEventListener('change', ()=>{
    // keep it non-destructive; user can still hit "发布" directly
    videoLinkTouched = true;
    videoLinkUrl = String(els.videoLink?.value || '').trim();
    renderVideoLinkPreview();
  });


  // drag & drop
  ;['dragenter','dragover'].forEach(evt=>{
    els.uploader.addEventListener(evt, (e)=>{
      e.preventDefault();
      e.stopPropagation();
      els.uploader.classList.add('dragover');
    });
  });
  ;['dragleave','drop'].forEach(evt=>{
    els.uploader.addEventListener(evt, (e)=>{
      e.preventDefault();
      e.stopPropagation();
      els.uploader.classList.remove('dragover');
    });
  });
  els.uploader.addEventListener('drop', (e)=>{
    const dt = e.dataTransfer;
    if(dt?.files?.length) addFiles(dt.files);
  });

  // doc drag & drop
  if(els.docUploader){
    ;['dragenter','dragover'].forEach(evt=>{
      els.docUploader.addEventListener(evt, (e)=>{
        e.preventDefault();
        e.stopPropagation();
        els.docUploader.classList.add('dragover');
      });
    });
    ;['dragleave','drop'].forEach(evt=>{
      els.docUploader.addEventListener(evt, (e)=>{
        e.preventDefault();
        e.stopPropagation();
        els.docUploader.classList.remove('dragover');
      });
    });
    els.docUploader.addEventListener('drop', (e)=>{
      const dt = e.dataTransfer;
      if(dt?.files?.length) addMomentFiles(dt.files);
    });
  }

  // video drag & drop
  if(els.videoUploader){
    ;['dragenter','dragover'].forEach(evt=>{
      els.videoUploader.addEventListener(evt, (e)=>{
        e.preventDefault();
        e.stopPropagation();
        els.videoUploader.classList.add('dragover');
      });
    });
    ;['dragleave','drop'].forEach(evt=>{
      els.videoUploader.addEventListener(evt, (e)=>{
        e.preventDefault();
        e.stopPropagation();
        els.videoUploader.classList.remove('dragover');
      });
    });
    els.videoUploader.addEventListener('drop', (e)=>{
      const dt = e.dataTransfer;
      const files = Array.from(dt?.files || []);
      const f = files.find(x => x && String(x.type || '').startsWith('video/'));
      if(f) addVideoFile(f);
    });
  }

  // paste images: listen on textarea and uploader
  const onPaste = (e)=>{
    const cd = e.clipboardData;
    if(!cd?.items) return;
    const files = [];
    for(const it of Array.from(cd.items)){
      if(it.kind === 'file'){
        const f = it.getAsFile();
        if(f && String(f.type||'').startsWith('image/')) files.push(f);
      }
    }
    if(files.length){
      addFiles(files);
      // do not preventDefault so text can still paste
    }
  };

  els.text?.addEventListener('paste', onPaste);
  els.uploader.addEventListener('paste', onPaste);

  // initial states
  updateClearBtn();
  updateDocClearBtn();
  updateVideoClearBtn();
  renderVideo();
  renderVideoLinkPreview();
  renderMomentFiles();
  updateComposerMode();
}

// ------------------------------
// Storage upload
// ------------------------------
function extFromFile(file){
  const t = String(file.type || '').toLowerCase();
  if(t.includes('png')) return 'png';
  if(t.includes('webp')) return 'webp';
  if(t.includes('gif')) return 'gif';
  if(t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  return 'bin';
}

function extFromVideoFile(file){
  const t = String(file.type || '').toLowerCase();
  if(t.includes('mp4')) return 'mp4';
  if(t.includes('webm')) return 'webm';
  if(t.includes('quicktime') || t.includes('mov')) return 'mov';
  // fallback to filename extension
  const name = String(file?.name || '');
  const ext = name.includes('.') ? name.split('.').pop() : '';
  const safe = String(ext || '').toLowerCase();
  return safe && safe.length <= 6 ? safe : 'mp4';
}

async function uploadOne(file){
  if(!file) throw new Error('未选择图片文件。');
  if((file.size || 0) > MAX_IMAGE_BYTES){
    const mb = Math.round((file.size || 0) / 1024 / 1024);
    throw new Error(`图片过大（${mb}MB）。建议每张不超过 ${Math.round(MAX_IMAGE_BYTES/1024/1024)}MB，或先压缩/截图后再上传。`);
  }

  const bucket = 'moments';
  const ext = extFromFile(file);
  const key = `${currentUser.id}/${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`;

  const { error } = await supabase
    .storage
    .from(bucket)
    .upload(key, file, { upsert: false, contentType: file.type || undefined, cacheControl: '3600' });

  if(error){
    const msg = String(error.message || error);
    if(/row-level security|rls|permission|unauthorized|403/i.test(msg)){
      throw new Error(
        '图片上传被拒绝（Storage 权限/RLS）。\n\n请在 Supabase → SQL Editor 重新运行最新版 SUPABASE_SETUP.sql（或 MIGRATION_ONLY_MOMENTS.sql），确保：\n- 已创建 moments bucket\n- 已创建 storage.objects 策略：moments_public_read / moments_insert_own\n然后在 Settings → API 点击 Reload schema。'
      );
    }
    if(/bucket/i.test(msg) && /not found|does not exist/i.test(msg)){
      throw new Error('未找到 Storage bucket「moments」。请在 Supabase Storage 创建 bucket（id=moments），或运行最新版 SUPABASE_SETUP.sql 自动创建。');
    }
    throw error;
  }

  // Public URL (bucket public=true). If bucket is private, this URL will 403.
  const { data } = supabase.storage.from(bucket).getPublicUrl(key);
  const url = data?.publicUrl;
  if(!url) throw new Error('无法获取图片 URL。');
  return url;
}


async function uploadVideo(file){
  if(!file) throw new Error('未选择视频文件。');
  if((file.size || 0) > MAX_VIDEO_BYTES){
    const mb = Math.round((file.size || 0) / 1024 / 1024);
    throw new Error(`视频过大（${mb}MB）。建议不超过 ${Math.round(MAX_VIDEO_BYTES/1024/1024)}MB（可先剪辑/压缩后再上传）。`);
  }

  const bucket = 'moments';
  const ext = extFromVideoFile(file);
  const key = `${currentUser.id}/${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`;

  const { error } = await supabase
    .storage
    .from(bucket)
    .upload(key, file, { upsert: false, contentType: file.type || undefined, cacheControl: '3600' });

  if(error){
    const msg = String(error.message || error);
    if(/row-level security|rls|permission|unauthorized|403/i.test(msg)){
      throw new Error(
        '视频上传被拒绝（Storage 权限/RLS）。\n\n请在 Supabase → SQL Editor 重新运行最新版 SUPABASE_SETUP.sql（或 MIGRATION_ONLY_MOMENTS.sql），确保：\n- 已创建 moments bucket\n- 已创建 storage.objects 策略：moments_public_read / moments_insert_own\n然后在 Settings → API 点击 Reload schema。'
      );
    }
    if(/bucket/i.test(msg) && /not found|does not exist/i.test(msg)){
      throw new Error('未找到 Storage bucket「moments」。请在 Supabase Storage 创建 bucket（id=moments），或运行最新版 SUPABASE_SETUP.sql 自动创建。');
    }
    throw error;
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(key);
  const url = data?.publicUrl;
  if(!url) throw new Error('无法获取视频 URL。');
  return url;
}


async function uploadAll(){
  if(picks.length === 0) return [];
  // Upload sequentially to reduce mobile failure rate
  const urls = [];
  for(let i=0;i<picks.length;i++){
    setPublishState(`上传图片 ${i+1}/${picks.length}…`);
    const url = await uploadOne(picks[i].file);
    urls.push(url);
    await sleep(80);
  }
  return urls;
}

async function uploadSelectedVideo(){
  if(!videoPick) return null;
  setPublishState('上传视频…');
  const url = await uploadVideo(videoPick.file);
  await sleep(120);
  return url;
}

// ------------------------------
// Moment file attachments (PDF/Word) — stored in public bucket "moments"
// and tracked via public.attachments (target_type='moment').
// ------------------------------
async function fetchMomentAttachments(momentId){
  const mid = Number(momentId || 0);
  if(!mid || !supabase) return [];
  try{
    const { data, error } = await supabase
      .from('attachments')
      .select('id, created_at, target_id, author_id, author_name, bucket, path, public_url, mime_type, original_name, size_bytes, kind, deleted_at')
      .eq('target_type', 'moment')
      .eq('target_id', mid)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
    if(error) throw error;
    const rows = Array.isArray(data) ? data : [];

    // Ensure public_url for the public bucket
    for(const a of rows){
      if(!a) continue;
      const b = String(a.bucket || '');
      if(!a.public_url && b === 'moments' && a.path){
        try{
          const { data: pu } = supabase.storage.from('moments').getPublicUrl(String(a.path));
          if(pu?.publicUrl) a.public_url = pu.publicUrl;
        }catch(_e){ /* ignore */ }
      }
    }

    // If any rows are stored in the private attachments bucket, resolve signed URLs.
    await hydrateSignedUrlsForAttachments(rows);
    return rows;
  }catch(_e){
    return [];
  }
}

async function applyPendingMomentFileDeletes(){
  const ids = Array.from(pendingMomentFileDeletes || []).map(x=>String(x)).filter(Boolean);
  if(!ids.length || !supabase) return;

  // Best-effort: mark deleted_at in DB and delete Storage objects.
  try{
    // Read the rows so we can delete their storage objects too.
    const { data: rows } = await supabase
      .from('attachments')
      .select('id, bucket, path')
      .in('id', ids)
      .is('deleted_at', null);

    await supabase
      .from('attachments')
      .update({ deleted_at: new Date().toISOString() })
      .in('id', ids);

    const toRemoveByBucket = new Map();
    (rows || []).forEach(r=>{
      if(!r?.path || !r?.bucket) return;
      const b = String(r.bucket);
      if(!toRemoveByBucket.has(b)) toRemoveByBucket.set(b, []);
      toRemoveByBucket.get(b).push(String(r.path));
    });

    for(const [bucket, paths] of toRemoveByBucket.entries()){
      try{
        if(paths?.length) await supabase.storage.from(bucket).remove(paths);
      }catch(_e){ /* ignore */ }
    }
  }catch(_e){ /* ignore */ }
}

async function uploadMomentFiles(momentId){
  const mid = Number(momentId || 0);
  if(!mid || !supabase || !currentUser) return;
  const picks = Array.isArray(momentFilePicks) ? momentFilePicks : [];
  if(!picks.length) return;

  const author_name = currentProfile?.full_name || currentUser.user_metadata?.full_name || currentUser.email || '成员';

  for(let i=0;i<picks.length;i++){
    const f = picks[i]?.file;
    if(!f) continue;
    const kind = guessKindFromMime(f.type, f.name);
    if(!(kind === 'pdf' || kind === 'doc')) continue;

    setPublishState(`上传附件 ${i+1}/${picks.length}…`);

    const rid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const key = `${currentUser.id}/moment/${mid}/${rid}_${safeFilename(f.name)}`;
    const up = await supabase.storage.from('moments').upload(key, f, {
      cacheControl: '3600',
      upsert: false,
      contentType: f.type || undefined,
    });
    if(up?.error) throw up.error;

    const { data: pu } = supabase.storage.from('moments').getPublicUrl(key);
    const url = pu?.publicUrl || null;

    const row = {
      target_type: 'moment',
      target_id: mid,
      author_id: currentUser.id,
      author_name,
      bucket: 'moments',
      path: key,
      public_url: url,
      mime_type: f.type || null,
      original_name: f.name || null,
      size_bytes: Number(f.size || 0) || null,
      kind,
      deleted_at: null,
    };
    const ins = await supabase.from('attachments').insert(row);
    if(ins?.error) throw ins.error;

    await sleep(80);
  }
}

async function syncMomentFiles(momentId){
  // 1) Apply deletions
  if(pendingMomentFileDeletes && pendingMomentFileDeletes.size){
    try{ await applyPendingMomentFileDeletes(); }catch(_e){ /* ignore */ }
  }

  // 2) Upload new files
  if(momentFilePicks && momentFilePicks.length){
    try{
      await uploadMomentFiles(momentId);
    }catch(attErr){
      const msg = String(attErr?.message || attErr);
      if(/relation .*attachments.*does not exist|does not exist/i.test(msg)){
        toast('附件功能未初始化', '请在 Supabase SQL Editor 运行最新版 SUPABASE_SETUP.sql，然后到 Settings → API 执行 “Reload schema”。', 'err');
      }else if(/bucket/i.test(msg) && /not found|does not exist/i.test(msg)){
        toast('存储未初始化', '请在 Supabase Storage 确认 moments bucket 已创建（或运行最新版 SUPABASE_SETUP.sql 会自动创建）。', 'err');
      }else{
        toast('附件上传失败', _humanizeRlsError(attErr), 'err');
      }
    }
  }

  // 3) Clear local state (we will re-fetch when rendering the feed)
  momentFilePicks = [];
  pendingMomentFileDeletes = new Set();
  existingMomentFiles = [];
  renderMomentFiles();
}

// ------------------------------
// Publish
// ------------------------------
async function publish(){
  if(!isConfigured()){
    toast('Supabase 未配置', '请先在 assets/config.js 填入 SUPABASE_URL 与 SUPABASE_ANON_KEY。', 'err');
    return;
  }

  // Ensure client is ready (some mobile networks load CDN slower)
  if(!supabase) await ensureSupabase();
  if(!supabase){
    toast('认证服务不可用', 'Supabase SDK 加载失败（可能网络拦截/不稳定）。请刷新重试，或考虑放置本地 vendor。', 'err');
    return;
  }

  // Require login only when publishing/updating
  const ok = await ensureAuthed('login.html?next=moments.html');
  if(!ok) return;

  await initAuth();
  if(!currentUser){
    toast('请先登录', '登录后可发布/编辑动态。', 'err');
    return;
  }

  const editing = isEditing();
  const content = String(els.text?.value || '').trim();
  const hasExistingFiles = _visibleExistingMomentFiles().length > 0;
  const hasExistingMedia = (existingImages?.length || 0) > 0 || Boolean(existingVideoUrl) || Boolean(String(videoLinkUrl || '').trim()) || hasExistingFiles;

  if(!content && picks.length === 0 && !videoPick && momentFilePicks.length === 0 && !hasExistingMedia){
    toast('内容为空', '请填写文字或添加图片/视频/附件。', 'err');
    return;
  }

  // Basic permission guard (UI already hides edit button, but keep it safe)
  if(editing){
    const owner = editingOriginal?.author_id;
    const can = Boolean(isAdmin || (owner && currentUser.id === owner));
    if(!can){
      toast('无权限', '只能编辑自己发布的动态。', 'err');
      return;
    }
  }

  els.publishBtn.disabled = true;
  setPublishState(editing ? '准备保存…' : '准备发布…');

  try{
    // Upload only the newly selected media (existing URLs are kept)
    const newImages = (picks.length > 0) ? await uploadAll() : [];
    const newVideoUrl = (videoPick) ? await uploadSelectedVideo() : null;
    setPublishState('写入数据库…');

    // --------------------------
    // Edit existing moment
    // --------------------------
    if(editing){
      const momentId = Number(editingMomentId);
      if(!momentId) throw new Error('编辑状态异常：未找到动态 ID。');

      // Determine desired video URL:
      // - upload video (videoPick) has highest priority
      // - otherwise use pasted video link (videoLinkUrl)
      // - if user never touched the link field, fall back to existingVideoUrl
      let video_url = null;
      if(videoPick){
        video_url = newVideoUrl || null;
      }else if(String(videoLinkUrl || '').trim()){
        video_url = safeUrl(videoLinkUrl);
      }else if(!videoLinkTouched && existingVideoUrl){
        video_url = existingVideoUrl || null;
      }else{
        video_url = null;
      }

      const hasFileVideo = Boolean(video_url && isLikelyVideoFileUrl(video_url));

      // Images:
      // - If video is an uploaded/file-like video, keep exclusive (no mix)
      // - If video is an external link, allow mixing with images
      let images = [...(existingImages || []), ...(newImages || [])].slice(0, 9);
      if(videoPick || hasFileVideo){
        images = [];
      }

      const payload = {
        content: content || null,
        images: Array.isArray(images) ? images : [],
        video_url: video_url || null,
      };

      // Optional: bump created_at to top (re-publish)
      if(els.bumpTime?.checked){
        payload.created_at = new Date().toISOString();
      }

      const { data, error } = await supabase
        .from('moments')
        .update(payload)
        .eq('id', momentId)
        .select('id, created_at, author_id, author_name, content, images, video_url, like_count, comment_count, deleted_at')
        .single();
      if(error) throw error;

      lastPublished = data || null;

      // Sync PDF/Word attachments (best-effort; does not block the main update)
      try{ await syncMomentFiles(momentId); }catch(_e){ /* ignore */ }

      toast('已更新', '动态已更新。', 'ok');

      // Exit edit mode + reset composer
      resetEditState();
      if(els.text) els.text.value = '';
      clearAll();
      clearVideo();
      clearVideoLink();
      setPublishState('');

      await loadFeed({ reset:true, highlightId: lastPublished?.id || null });
      try{ document.getElementById('composer')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }catch(_e){}
      return;
    }

    // --------------------------
    // Publish new moment
    // --------------------------
    const author_name = currentProfile?.full_name || currentUser.user_metadata?.full_name || currentUser.email || 'Member';
    const payload = {
      author_id: currentUser.id,
      author_name,
      content: content || null,
      images: (()=>{
        const link = String(videoLinkUrl || '').trim() ? safeUrl(videoLinkUrl) : null;
        const finalVideo = newVideoUrl || link;
        const hasFile = Boolean(finalVideo && isLikelyVideoFileUrl(finalVideo));
        if(newVideoUrl || hasFile) return [];
        return newImages || [];
      })(),
      video_url: (newVideoUrl || (String(videoLinkUrl || '').trim() ? safeUrl(videoLinkUrl) : null)) || null,
      // force visibility
      deleted_at: null,
      like_count: 0,
    };

    const { data, error } = await supabase
      .from('moments')
      .insert(payload)
      .select('id, created_at, author_id, author_name, content, images, video_url, like_count, comment_count, deleted_at')
      .single();
    if(error) throw error;

    // Keep a local copy so the user ALWAYS sees what they just posted,
    // even if the subsequent feed query is blocked by RLS/misconfig.
    lastPublished = data || null;

    // Upload PDF/Word attachments (best-effort)
    try{ await syncMomentFiles(lastPublished?.id); }catch(_e){ /* ignore */ }

    toast('已发布', '动态已发布。', 'ok');
    if(els.text) els.text.value = '';
    clearAll();
    clearMomentFiles();
    clearVideo();
    clearVideoLink();
    setPublishState('');

    // Optimistic render (prepend), then refresh feed.
    if(lastPublished && els.feed){
      try{
        await initAuth();
        const html = momentCard(lastPublished, false, false);
        // If feed was empty / demo, replace; otherwise prepend.
        if(!els.feed.innerHTML || /演示模式/.test(els.feed.innerHTML)){
          els.feed.innerHTML = html;
        }else{
          els.feed.insertAdjacentHTML('afterbegin', html);
        }
      }catch(_e){ /* ignore */ }
    }

    await loadFeed({ reset:true, highlightId: lastPublished?.id || null });
    // scroll to top of feed
    try{ window.scrollTo({ top: 0, behavior: 'smooth' }); }catch(_e){}
  }catch(e){
    const msg = (e && (e.message || e.error_description)) ? String(e.message || e.error_description) : String(e);
    const title = editing ? '保存失败' : '发布失败';

    if(/could not find the table/i.test(msg) && msg.includes('moments')){
      toast(
        title,
        '未找到 public.moments 表（或 PostgREST schema 未刷新）。请到 Supabase → SQL Editor 运行最新版 SUPABASE_SETUP.sql（或 MIGRATION_ONLY_MOMENTS.sql），然后在 Supabase → Settings → API 点击 “Reload schema”（或等待 1–2 分钟再试）。',
        'err'
      );
    }else if(/column/i.test(msg) && /video_url/i.test(msg) && /does not exist/i.test(msg)){
      toast(
        title + '（需要升级数据库）',
        '当前数据库 moments 表还没有 video_url 字段。请运行最新版 SUPABASE_SETUP.sql（或 MIGRATION_ONLY_MOMENTS.sql），并在 Supabase → Settings → API 点击 “Reload schema”。',
        'err'
      );
    }else{
      toast(title, _humanizeRlsError(e), 'err');
    }
    setPublishState('');
  }finally{
    els.publishBtn.disabled = false;
  }
}

els.publishBtn?.addEventListener('click', publish);

// Ctrl+Enter to publish
els.text?.addEventListener('keydown', (e)=>{
  if((e.ctrlKey || e.metaKey) && e.key === 'Enter') publish();
});

// ------------------------------
// Feed
// ------------------------------
function momentCard(m, liked = false, faved = false, opts = {}){
  const highlightId = opts?.highlightId || null;
  const attachmentsById = opts?.attachmentsById;
  const when = m.created_at ? formatBeijingDateTime(m.created_at) : '';
  const imgs = Array.isArray(m.images) ? m.images : [];
  const videoUrl = m.video_url ? String(m.video_url) : '';
  const gridClass = imgs.length <= 1 ? 'img-grid one' : (imgs.length === 2 ? 'img-grid two' : 'img-grid');
  const imgHtml = imgs.length ? `
    <div class="${gridClass}" style="margin-top:10px">
      ${imgs.map(u => `<a class="img" href="${esc(u)}" target="_blank" rel="noopener"><img alt="img" src="${esc(u)}"/></a>`).join('')}
    </div>
  ` : '';

  const videoHtml = videoUrl ? `<div style="margin-top:10px">${renderVideoUrl(videoUrl)}</div>` : '';

  const attaches = (attachmentsById && typeof attachmentsById.get === 'function') ? (attachmentsById.get(String(m.id)) || []) : [];
  const attHtml = attaches.length ? `<div style="margin-top:10px">${renderAttachmentsBlock(attaches)}</div>` : '';

  const canEdit = Boolean(currentUser && (isAdmin || currentUser.id === m.author_id));
  const editBtn = canEdit ? `<button class="btn tiny" data-edit="${m.id}">编辑</button>` : '';
  // Moderators can delete posts but cannot edit others' content.
  const canDelete = Boolean(currentUser && (isAdmin || isModerator || currentUser.id === m.author_id));
  const delBtn = canDelete ? `<button class="btn tiny danger" data-del="${m.id}">删除</button>` : '';

  const likeCount = Number(m.like_count || 0);
  const likeLabel = liked ? '💙 已赞' : '👍 点赞';
  const likeBtn = `
    <button class="btn tiny ${liked ? 'primary' : ''}" data-like="${m.id}" data-liked="${liked ? '1':'0'}" data-count="${likeCount}">
      <span class="like-label">${likeLabel}</span> · <span class="like-count">${likeCount}</span>
    </button>
  `;

  const commentCount = Number(m.comment_count || 0);
  const commentBtn = `
    <button class="btn tiny" data-comment-toggle="${m.id}" data-comment-open="0" data-comment-count="${commentCount}">
      <span class="comment-label">💬 留言</span> · <span class="comment-count">${commentCount}</span>
    </button>
  `;

  const favBtn = `
    <button class="btn tiny ${faved ? 'primary' : ''}" data-fav="${m.id}" data-faved="${faved ? '1' : '0'}">
      ⭐ <span data-fav-label>${faved ? '已收藏' : '收藏'}</span>
    </button>
  `;


  const shareBtn = `
    <button class="btn tiny" data-share="${m.id}" title="复制链接分享">🔗 分享</button>
  `;

  const highlight = highlightId && String(m.id) === String(highlightId);
  const badge = highlight ? `<span class="badge" style="margin-left:8px">刚发布</span>` : '';

  const commentsHtml = `
    <div class="moment-comments" data-comments-wrap="${m.id}" hidden>
      <div class="comment-list" data-comments-list="${m.id}">
        <div class="small muted">加载中…</div>
      </div>

      ${currentUser ? `
        <div class="comment-compose">
          <textarea class="input prose-input" rows="2" placeholder="写留言…" data-comment-input="${m.id}"></textarea>
          <input type="file" multiple hidden data-attach-input="${m.id}" data-attach-scope="moment" accept="image/*,application/pdf,.pdf,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
          <div class="attach-tools">
            <button class="btn tiny" type="button" data-attach-pick="${m.id}" data-attach-scope="moment">📎 附件</button>
            <button class="btn tiny" type="button" data-attach-clear="${m.id}" data-attach-scope="moment">清空</button>
            <span class="attach-hint">支持图片 / PDF / Word（单个≤20MB）</span>
          </div>
          <div class="attach-list" data-attach-list="${m.id}" data-attach-scope="moment"></div>
          <div class="comment-actions">
            <button class="btn tiny" type="button" data-mention-author data-moment="${m.id}" data-mention-target="comment" title="@该动态作者">@作者</button>
            <button class="btn tiny" type="button" data-mention-doctor data-moment="${m.id}" data-mention-target="comment" title="@其他医生">@医生</button>
            <button class="btn tiny primary" data-comment-send="${m.id}">发送</button>
            <button class="btn tiny" data-comments-refresh="${m.id}">刷新</button>
          </div>
        </div>
      ` : `
        <div class="small muted" style="margin-top:10px">登录后可留言与回复。 <a href="login.html?next=moments.html">去登录</a></div>
      `}
    </div>
  `;

  return `
    <div class="card soft" ${highlight ? 'style="border-color: rgba(59,130,246,.55)"' : ''} id="moment-${m.id}" data-moment="${m.id}">
      <div class="row" style="align-items:flex-start;justify-content:space-between">
        <div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <b>${esc(m.author_name || '成员')}</b>
            <span class="small muted">${esc(when)}</span>
            ${badge}
          </div>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          ${likeBtn}
          ${favBtn}
          ${shareBtn}
          ${commentBtn}
          ${editBtn}
          ${delBtn}
        </div>
      </div>

      ${m.content ? `<div class="moment-body ks-prose">${nl2br(String(m.content))}</div>` : ''}
      ${attHtml}
      ${videoHtml}
      ${imgHtml}

      ${commentsHtml}
    </div>
  `;
}


function _setFeedHint(t){
  if(els.feedHint) els.feedHint.textContent = t || '';
}

function updateLoadMoreUI(){
  const btn = els.loadMoreBtn;
  if(!btn) return;
  btn.disabled = Boolean(feedLoadingMore);
  btn.textContent = feedLoadingMore ? '加载中…' : '加载更多';
  btn.style.display = feedReachedEnd ? 'none' : '';
}

async function queryMomentsPage({ before=null, limit=FEED_PAGE_SIZE } = {}){
  // Robust querying for older deployments:
  // - video_url column may not exist
  // - deleted_at column may not exist / may have a bad default
  const candidates = [
    { fields: 'id, created_at, author_id, author_name, content, images, video_url, like_count, comment_count, deleted_at', filterDeleted: true },
    { fields: 'id, created_at, author_id, author_name, content, images, like_count, comment_count, deleted_at', filterDeleted: true },
    { fields: 'id, created_at, author_id, author_name, content, images, video_url, like_count, comment_count', filterDeleted: false },
    { fields: 'id, created_at, author_id, author_name, content, images, like_count, comment_count', filterDeleted: false },
  ];

  let res = null;
  for(const c of candidates){
    let q = supabase
      .from('moments')
      .select(c.fields);

    if(c.filterDeleted) q = q.is('deleted_at', null);
    if(before) q = q.lt('created_at', before);

    q = q
      .order('created_at', { ascending: false })
      .limit(limit);

    res = await q;

    if(!res?.error) break;

    const msg = String(res.error.message || res.error).toLowerCase();
    // Only retry on missing-column issues; otherwise break early.
    if(!(msg.includes('column') && (msg.includes('video_url') || msg.includes('deleted_at') || msg.includes('comment_count')))){
      break;
    }
  }

  const { data, error } = res || {};
  if(error) throw error;
  return data || [];
}

async function queryMomentById(momentId){
  const id = Number(momentId || 0);
  if(!id) return null;

  // Similar to queryMomentsPage: be robust to older schemas
  const candidates = [
    { fields: 'id, created_at, author_id, author_name, content, images, video_url, like_count, comment_count, deleted_at', filterDeleted: true },
    { fields: 'id, created_at, author_id, author_name, content, images, like_count, comment_count, deleted_at', filterDeleted: true },
    { fields: 'id, created_at, author_id, author_name, content, images, video_url, like_count, comment_count', filterDeleted: false },
    { fields: 'id, created_at, author_id, author_name, content, images, like_count, comment_count', filterDeleted: false },
  ];

  let res = null;
  for(const c of candidates){
    let q = supabase
      .from('moments')
      .select(c.fields)
      .eq('id', id);
    if(c.filterDeleted) q = q.is('deleted_at', null);
    q = q.limit(1).maybeSingle();

    res = await q;

    if(!res?.error) break;

    const msg = String(res.error.message || res.error).toLowerCase();
    if(!(msg.includes('column') && (msg.includes('video_url') || msg.includes('deleted_at') || msg.includes('comment_count')))){
      break;
    }
  }

  const { data, error } = res || {};
  if(error) throw error;
  return data || null;
}

async function getLikedSet(rows){
  const likedSet = new Set();
  if(!currentUser || !rows?.length) return likedSet;
  try{
    const ids = rows.map(r=>r.id);
    const { data } = await supabase
      .from('moment_likes')
      .select('moment_id')
      .eq('user_id', currentUser.id)
      .in('moment_id', ids);
    (data || []).forEach(x => likedSet.add(x.moment_id));
  }catch(_e){
    // table may not exist, ignore
  }
  return likedSet;
}

async function getFavedSet(rows){
  const favedSet = new Set();
  if(!currentUser || !rows?.length) return favedSet;
  try{
    const ids = rows.map(r=>r.id);
    const { data: favRows, error: favErr } = await supabase
      .from('moment_favorites')
      .select('moment_id')
      .eq('user_id', currentUser.id)
      .in('moment_id', ids);
    if(!favErr && favRows){
      favRows.forEach(r => favedSet.add(r.moment_id));
    }
  }catch(_e){
    // table may not exist, ignore
  }
  return favedSet;
}

async function getMomentAttachmentsMap(rows){
  const map = new Map();
  if(!rows || !rows.length || !supabase) return map;
  const ids = rows.map(r=>Number(r?.id)).filter(Boolean);
  if(!ids.length) return map;

  try{
    const { data: at, error: atErr } = await supabase
      .from('attachments')
      .select('id, created_at, target_id, author_id, author_name, bucket, path, public_url, mime_type, original_name, size_bytes, kind, deleted_at')
      .eq('target_type', 'moment')
      .in('target_id', ids)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
    if(atErr || !Array.isArray(at)) return map;

    // Ensure public URLs for the public bucket
    for(const a of at){
      if(!a) continue;
      const b = String(a.bucket || '');
      if(!a.public_url && b === 'moments' && a.path){
        try{
          const { data: pu } = supabase.storage.from('moments').getPublicUrl(String(a.path));
          if(pu?.publicUrl) a.public_url = pu.publicUrl;
        }catch(_e){ /* ignore */ }
      }
    }

    // Resolve signed URLs for any private attachments rows
    await hydrateSignedUrlsForAttachments(at);

    at.forEach(a=>{
      const k = String(a.target_id);
      if(!map.has(k)) map.set(k, []);
      map.get(k).push(a);
    });
  }catch(_e){ /* ignore */ }

  return map;
}

async function loadFeed(opts={}){
  if(!els.feed) return;

  const reset = opts?.reset !== false; // default true
  const highlightId = opts?.highlightId ?? urlHighlightId ?? (lastPublished?.id ?? null);

  // Ensure SDK is ready first (prevents false "演示模式" on slow networks)
  if(isConfigured() && !supabase){
    await ensureSupabase();
  }

  // Demo mode (not configured or SDK blocked)
  if(!isConfigured() || !supabase){
    els.feed.innerHTML = `
      <div class="note"><b>演示模式：</b>请在 assets/config.js 配置 Supabase 后启用真实 Moments。</div>
      <div class="card soft"><b>KidneySphere</b><div class="small muted" style="margin-top:4px">演示数据</div><div style="margin-top:10px">欢迎使用 Moments：支持拖拽图片与 Ctrl+V 粘贴截图。</div></div>
    `;
    _setFeedHint('');
    feedReachedEnd = true;
    updateLoadMoreUI();
    return;
  }

  await initAuth();

  if(reset){
    feedCursor = null;
    feedReachedEnd = false;
  }

  updateLoadMoreUI();

  if(reset){
    els.feed.innerHTML = `<div class="muted small">加载中…</div>`;
  }

  let baseRows = [];
  try{
    baseRows = await queryMomentsPage({ before: null, limit: FEED_PAGE_SIZE });
  }catch(e){
    const msg = (e && (e.message || e.error_description)) ? String(e.message || e.error_description) : String(e);
    const extra = (/could not find the table/i.test(msg) && msg.includes('moments'))
      ? `<br/><span class="small">未找到 public.moments 表：请运行最新版 SUPABASE_SETUP.sql（或 MIGRATION_ONLY_MOMENTS.sql），并在 Supabase → Settings → API 点击 “Reload schema”。</span>`
      : `<br/><span class="small">请检查 Supabase 配置与 RLS 权限。</span>`;
    els.feed.innerHTML = `<div class="note"><b>读取失败：</b>${esc(msg)}${extra}</div>`;
    _setFeedHint('');
    feedReachedEnd = true;
    updateLoadMoreUI();
    return;
  }

  // paging state (based on DB rows only)
  feedCursor = baseRows.length ? baseRows[baseRows.length - 1].created_at : feedCursor;
  feedReachedEnd = baseRows.length < FEED_PAGE_SIZE;

  // If we have a locally published row but it is missing from the feed result,
  // keep it visible at the top (helps diagnose RLS / schema mismatch).
  let rows = baseRows.slice();
  if(lastPublished && !rows.some(r => String(r.id) === String(lastPublished.id))){
    rows = [lastPublished, ...rows];
  }

  // Ensure the highlighted moment is visible even if it is old.
  // This matters for shared links (moments.html?id=...) and notifications/favorites.
  if(urlHighlightId){
    const hid = Number(urlHighlightId);
    if(hid && !rows.some(r => String(r.id) === String(hid))){
      try{
        const one = await queryMomentById(hid);
        if(one) rows = [one, ...rows];
      }catch(_e){}
    }
  }

  if(rows.length === 0){
    els.feed.innerHTML = `<div class="muted small">暂无动态。你可以发布第一条。</div>`;
    _setFeedHint('');
    feedReachedEnd = true;
    updateLoadMoreUI();
    return;
  }

  // cache for edit / comments
  feedRows = rows;
  feedById = new Map(rows.map(r => [String(r.id), r]));

  // Share meta: when opening a specific moment via URL (moments.html?id=...),
  // update the page meta so WeChat Moments can generate a proper card.
  if(urlHighlightId){
    try{
      const m = feedById.get(String(urlHighlightId));
      if(m) applyShareForMoment(m);
    }catch(_e){}
  }else{
    // Default moments share meta
    try{
      applyShareMeta({
        title: '社区动态 · KidneySphere',
        description: 'KidneySphere · Moments',
        image: 'assets/logo.png',
        url: buildStableUrl(),
        type: 'website'
      });
    }catch(_e){}
  }

  // like/fav sets (optional)
  const likedSet = await getLikedSet(rows);
  const favedSet = await getFavedSet(rows);

  // Moment attachments (PDF/Word) — optional
  const attachmentsById = await getMomentAttachmentsMap(rows);

  els.feed.innerHTML = rows.map(m => momentCard(m, likedSet.has(m.id), favedSet.has(m.id), { highlightId, attachmentsById })).join('');

  const loadedCount = feedRows.length;
  _setFeedHint(feedReachedEnd
    ? `已加载 ${loadedCount} 条（已到底）`
    : `已加载最近 ${Math.min(loadedCount, FEED_PAGE_SIZE)} 条，点击下方“加载更多”查看更早内容。`
  );

  updateLoadMoreUI();

  // bind comments + like/fav/edit/del (delegation)
  if(!feedDelegationBound){
    els.feed.addEventListener('click', handleFeedClick);
    els.feed.addEventListener('change', handleFeedChange);
    feedDelegationBound = true;
  }

  // Scroll to a highlighted moment when coming from notifications/favorites
  if(highlightId){
    const target = document.getElementById(`moment-${highlightId}`) || els.feed.querySelector(`[data-moment="${highlightId}"]`);
    if(target){
      try{ target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }catch(_e){}
    }
  }
}

async function loadMoreFeed(){
  if(!els.feed || !isConfigured()) return;
  if(feedReachedEnd) return;
  if(feedLoadingMore) return;

  // Ensure SDK
  if(isConfigured() && !supabase){
    await ensureSupabase();
  }
  if(!isConfigured() || !supabase) return;

  await initAuth();

  if(!feedCursor){
    feedReachedEnd = true;
    updateLoadMoreUI();
    return;
  }

  feedLoadingMore = true;
  updateLoadMoreUI();

  try{
    const baseRows = await queryMomentsPage({ before: feedCursor, limit: FEED_PAGE_SIZE });
    if(!baseRows.length){
      feedReachedEnd = true;
      _setFeedHint(`已加载 ${feedRows.length} 条（已到底）`);
      return;
    }

    // Update paging state
    feedCursor = baseRows[baseRows.length - 1].created_at || feedCursor;
    if(baseRows.length < FEED_PAGE_SIZE) feedReachedEnd = true;

    const likedSet = await getLikedSet(baseRows);
    const favedSet = await getFavedSet(baseRows);

    const attachmentsById = await getMomentAttachmentsMap(baseRows);

    // Update cache + append to DOM
    for(const r of baseRows){
      const key = String(r.id);
      if(feedById.has(key)) continue;
      feedRows.push(r);
      feedById.set(key, r);
    }

    els.feed.insertAdjacentHTML('beforeend', baseRows.map(m => momentCard(m, likedSet.has(m.id), favedSet.has(m.id), { attachmentsById })).join(''));

    _setFeedHint(feedReachedEnd
      ? `已加载 ${feedRows.length} 条（已到底）`
      : `已加载 ${feedRows.length} 条`
    );
  }catch(e){
    toast('加载更多失败', _humanizeRlsError(e), 'err');
  }finally{
    feedLoadingMore = false;
    updateLoadMoreUI();
  }
}

async function beginEdit(btn){
  if(!isConfigured()) return;
  if(!supabase) await ensureSupabase();
  if(!supabase) return;

  const ok = await ensureAuthed('login.html?next=moments.html');
  if(!ok) return;

  await initAuth();
  if(!currentUser) return;

  const id = Number(btn.getAttribute('data-edit'));
  if(!id) return;

  // confirm switching edits
  if(editingMomentId && Number(editingMomentId) !== id){
    if(!confirm('你正在编辑另一条动态。切换将丢失未保存内容，确定继续吗？')) return;
  }

  let m = feedById.get(String(id)) || null;

  // Fallback: fetch from DB if not in cache
  if(!m){
    try{
      const { data, error } = await supabase
        .from('moments')
        .select('id, created_at, author_id, author_name, content, images, video_url, like_count, comment_count, deleted_at')
        .eq('id', id)
        .maybeSingle();
      if(error) throw error;
      m = data || null;
    }catch(e){
      toast('无法进入编辑', _humanizeRlsError(e), 'err');
      return;
    }
  }

  if(!m){
    toast('无法编辑', '未找到该动态，可能已被删除/下线。', 'err');
    return;
  }

  const can = Boolean(isAdmin || currentUser.id === m.author_id);
  if(!can){
    toast('无权限', '只能编辑自己发布的动态。', 'err');
    return;
  }

  // Enter edit mode
  editingMomentId = id;
  editingOriginal = m;
  existingImages = Array.isArray(m.images) ? [...m.images] : [];
  existingVideoUrl = m.video_url ? String(m.video_url) : null;

  // Existing PDF/Word attachments (best-effort)
  momentFilePicks = [];
  pendingMomentFileDeletes = new Set();
  existingMomentFiles = [];
  try{
    existingMomentFiles = await fetchMomentAttachments(id);
  }catch(_e){
    existingMomentFiles = [];
  }
  renderMomentFiles();

  // v7: also bind to the "视频链接" field (for external platforms like B站 / 腾讯会议回放)
  videoLinkTouched = false;
  videoLinkUrl = existingVideoUrl ? String(existingVideoUrl) : '';
  if(els.videoLink) els.videoLink.value = videoLinkUrl || '';
  renderVideoLinkPreview();

  // Clear only newly selected media
  picks.forEach(p=>{ try{ URL.revokeObjectURL(p.url); }catch(_e){} });
  picks = [];
  if(videoPick){
    try{ URL.revokeObjectURL(videoPick.url); }catch(_e){}
    videoPick = null;
  }

  if(els.text) els.text.value = m.content || '';

  setHint('正在编辑该动态：修改完成后点击“保存修改”。如需替换图片/视频，可先“清空”再重新上传。', 'info');
  setPublishState('');

  renderThumbs();
  renderVideo();
  renderVideoLinkPreview();
  renderMomentFiles();
  updateComposerMode();

  try{ document.getElementById('composer')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }catch(_e){}
}


// ------------------------------
// Moment comments (留言/回复)
// ------------------------------
function _findMomentAuthorId(momentId){
  const m = feedById?.get(String(momentId));
  return m ? String(m.author_id || '') : '';
}

function _updateCommentCountUI(momentId, count){
  const btn = els.feed?.querySelector(`[data-comment-toggle="${momentId}"]`);
  if(!btn) return;

  btn.setAttribute('data-comment-count', String(count));
  const countEl = btn.querySelector('.comment-count');
  if(countEl) countEl.textContent = String(count);
}

function _setCommentBtnOpen(btn, open){
  if(!btn) return;
  btn.setAttribute('data-comment-open', open ? '1' : '0');
  const label = btn.querySelector('.comment-label');
  if(label) label.textContent = open ? '💬 收起' : '💬 留言';
}

async function toggleComments(btn){
  const momentId = Number(btn?.getAttribute('data-comment-toggle') || 0);
  if(!momentId || !els.feed) return;
  const wrap = els.feed.querySelector(`[data-comments-wrap="${momentId}"]`);
  if(!wrap) return;

  const isOpen = btn.getAttribute('data-comment-open') === '1';
  if(isOpen){
    wrap.hidden = true;
    _setCommentBtnOpen(btn, false);
    return;
  }

  wrap.hidden = false;
  _setCommentBtnOpen(btn, true);
  await loadAndRenderComments(momentId, { force: false });
}

async function loadAndRenderComments(momentId, opts={}){
  const force = Boolean(opts?.force);
  const listEl = els.feed?.querySelector(`[data-comments-list="${momentId}"]`);
  if(listEl) listEl.innerHTML = '<div class="small muted">加载中…</div>';

  // Ensure SDK
  if(isConfigured() && !supabase){
    await ensureSupabase();
  }
  if(!isConfigured() || !supabase){
    if(listEl) listEl.innerHTML = '<div class="small muted">演示模式：未配置 Supabase。</div>';
    return;
  }

  // Ensure user/session info (for likes + private attachment signed URLs)
  await initAuth();

  const cached = commentCache.get(String(momentId));
  if(cached && !force){
    renderCommentsToDom(momentId, cached.rows || [], cached.attachmentsById || new Map(), cached.likedSet || new Set());
    return;
  }

  try{
    const { data, error } = await supabase
      .from('moment_comments')
      .select('id, created_at, moment_id, parent_id, author_id, author_name, body, like_count, deleted_at')
      .eq('moment_id', momentId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true });

    if(error) throw error;
    const rows = data || [];

    // Load attachments (optional: table may not exist yet)
    let attachmentsById = new Map();
    const ids = rows.map(r=>Number(r.id)).filter(Boolean);
    if(ids.length){
      try{
        const { data: at, error: atErr } = await supabase
          .from('attachments')
          .select('id, created_at, target_id, author_id, author_name, bucket, path, public_url, mime_type, original_name, size_bytes, kind, deleted_at')
          .eq('target_type', 'moment_comment')
          .in('target_id', ids)
          .is('deleted_at', null)
          .order('created_at', { ascending: true });
        if(!atErr && Array.isArray(at)){
          // Resolve private attachment URLs via short-lived signed URLs
          await hydrateSignedUrlsForAttachments(at);
          at.forEach(a=>{
            const k = String(a.target_id);
            if(!attachmentsById.has(k)) attachmentsById.set(k, []);
            attachmentsById.get(k).push(a);
          });
        }
      }catch(_e){ /* ignore */ }
    }

    // Load which comments the current user has liked (optional)
    let likedSet = new Set();
    if(currentUser && ids.length){
      try{
        const { data: likes, error: lErr } = await supabase
          .from('moment_comment_likes')
          .select('comment_id')
          .eq('user_id', currentUser.id)
          .in('comment_id', ids);
        if(!lErr && Array.isArray(likes)){
          likedSet = new Set(likes.map(x => String(x.comment_id)));
        }
      }catch(_e){ /* ignore */ }
    }

    commentCache.set(String(momentId), { rows, attachmentsById, likedSet, loadedAt: Date.now() });
    renderCommentsToDom(momentId, rows, attachmentsById, likedSet);
  }catch(e){
    const msg = _humanizeRlsError(e);
    if(listEl) listEl.innerHTML = `<div class="small muted">加载失败：${esc(msg)}</div>`;
  }
}

function renderCommentsToDom(momentId, rows, attachmentsById=new Map(), likedSet=new Set()){
  const listEl = els.feed?.querySelector(`[data-comments-list="${momentId}"]`);
  if(!listEl) return;

  const momentAuthorId = _findMomentAuthorId(momentId);
  const all = Array.isArray(rows) ? rows : [];
  _updateCommentCountUI(momentId, all.length);

  if(all.length === 0){
    listEl.innerHTML = '<div class="small muted">暂无留言。你可以写下第一条。</div>';
    return;
  }

  const children = new Map(); // parent_id -> []
  const top = [];
  all.forEach(c=>{
    const pid = c.parent_id ? String(c.parent_id) : '';
    if(!pid){
      top.push(c);
    }else{
      if(!children.has(pid)) children.set(pid, []);
      children.get(pid).push(c);
    }
  });

  function itemHtml(c, isReply=false){
    const when = c.created_at ? formatBeijingDateTime(c.created_at) : '';
    const name = esc(c.author_name || '成员');
    const isAuthor = momentAuthorId && String(c.author_id || '') === String(momentAuthorId);
    const badge = isAuthor ? '<span class="badge mini">作者</span>' : '';
    const canReply = Boolean(currentUser);
    const canDel = Boolean(
      currentUser
      && (
        isAdmin
        || isModerator
        || String(currentUser.id) === String(c.author_id)
        || String(currentUser.id) === String(momentAuthorId)
      )
    );

    const attaches = (attachmentsById && typeof attachmentsById.get === 'function') ? (attachmentsById.get(String(c.id)) || []) : [];
    const attHtml = attaches.length ? `<div style="margin-top:8px">${renderAttachmentsBlock(attaches)}</div>` : '';

    const likeCount = Number(c.like_count || 0);
    const liked = (likedSet && typeof likedSet.has === 'function') ? likedSet.has(String(c.id)) : false;
    const likeLabel = liked ? '💙 已赞' : '👍 点赞';
    const likeBtn = `
      <button class="btn tiny ${liked ? 'primary' : ''}" data-comment-like="${c.id}" data-moment="${momentId}" data-liked="${liked ? '1' : '0'}" data-count="${likeCount}">
        <span class="comment-like-label">${likeLabel}</span> · <span class="comment-like-count">${likeCount}</span>
      </button>
    `;

    return `
      <div class="${isReply ? 'reply' : 'comment'}" data-comment="${c.id}">
        <div class="comment-meta">
          <b>${name}</b> ${badge}
          <span class="small muted">${esc(when)}</span>
        </div>
        <div class="comment-body ks-prose">${nl2br(String(c.body || ''))}${attHtml}</div>
        <div class="comment-actions">
          ${likeBtn}
          ${canReply && !isReply ? `<button class="btn tiny" data-reply="${c.id}" data-moment="${momentId}">回复</button>` : ''}
          ${canDel ? `<button class="btn tiny danger" data-comment-del="${c.id}" data-moment="${momentId}">删除</button>` : ''}
        </div>
        ${!isReply ? `<div class="reply-box" data-reply-box="${c.id}"></div>` : ''}
      </div>
    `;
  }

  const html = top.map(c=>{
    const reps = children.get(String(c.id)) || [];
    const repHtml = reps.length ? `<div class="reply-list">${reps.map(r=>itemHtml(r, true)).join('')}</div>` : '';
    return `<div class="comment-group">${itemHtml(c, false)}${repHtml}</div>`;
  }).join('');

  listEl.innerHTML = html;
}

async function postComment(momentId, parentId=null){
  if(!isConfigured()) return;
  if(!supabase) await ensureSupabase();
  if(!supabase) return;

  const ok = await ensureAuthed('login.html?next=moments.html');
  if(!ok) return;
  await initAuth();
  if(!currentUser) return;

  const selector = parentId ? `[data-reply-input="${parentId}"]` : `[data-comment-input="${momentId}"]`;
  const inputEl = els.feed?.querySelector(selector);
  const body = String(inputEl?.value || '').trim();
  if(!body){
    toast('内容为空', '请填写留言内容。', 'err');
    return;
  }

  const scope = parentId ? 'reply' : 'moment';
  const owner = parentId ? String(parentId) : String(momentId);
  const draftItems = getDraftItems(scope, owner);

  const sendBtnSel = parentId
    ? `[data-reply-send="${parentId}"][data-moment="${momentId}"]`
    : `[data-comment-send="${momentId}"]`;
  const sendBtn = els.feed?.querySelector(sendBtnSel);
  if(sendBtn) sendBtn.disabled = true;

  try{
    let newCommentId = null;

    // Preferred: RPC (more robust)
    let res = await supabase.rpc('add_moment_comment', {
      _moment_id: momentId,
      _body: body,
      _parent_id: parentId ? Number(parentId) : null,
    });
    if(!res?.error && res?.data) newCommentId = res.data;

    // Fallback: direct insert if RPC not deployed
    if(res?.error && /function .*add_moment_comment/i.test(String(res.error.message || res.error))){
      const payload = {
        moment_id: momentId,
        parent_id: parentId ? Number(parentId) : null,
        author_id: currentUser.id,
        author_name: currentProfile?.full_name || currentUser.user_metadata?.full_name || currentUser.email || '成员',
        body,
        deleted_at: null,
      };
      const ins = await supabase
        .from('moment_comments')
        .insert(payload)
        .select('id')
        .single();
      if(ins?.error) throw ins.error;
      newCommentId = ins?.data?.id || newCommentId;
      res = { error: null };
    }

    if(res?.error) throw res.error;

    // Upload attachments (optional)
    if(draftItems.length && newCommentId){
      try{
        for(let i=0;i<draftItems.length;i++){
          const f = draftItems[i]?.file;
          if(!f) continue;
          const kind = guessKindFromMime(f.type, f.name);
          const rid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
          const key = `${currentUser.id}/moment_comment/${newCommentId}/${rid}_${safeFilename(f.name)}`;
          const up = await supabase.storage.from('attachments').upload(key, f, {
            cacheControl: '3600',
            upsert: false,
            contentType: f.type || undefined,
          });
          if(up?.error) throw up.error;
          const url = null; // attachments bucket is private; resolve via signed URLs when rendering
          const arow = {
            target_type: 'moment_comment',
            target_id: Number(newCommentId),
            author_id: currentUser.id,
            author_name: currentProfile?.full_name || currentUser.user_metadata?.full_name || currentUser.email || '成员',
            bucket: 'attachments',
            path: key,
            public_url: url,
            mime_type: f.type || null,
            original_name: f.name || null,
            size_bytes: Number(f.size || 0) || null,
            kind,
            deleted_at: null,
          };
          const ins2 = await supabase.from('attachments').insert(arow);
          if(ins2?.error) throw ins2.error;
        }
      }catch(attErr){
        const msg = String(attErr?.message || attErr);
        if(/relation .*attachments.*does not exist|does not exist/i.test(msg)){
          toast('附件功能未初始化', '请在 Supabase SQL Editor 运行最新版 SUPABASE_SETUP.sql，然后到 Settings → API 执行 “Reload schema”。', 'err');
        }else if(/bucket/i.test(msg) && /not found|does not exist/i.test(msg)){
          toast('附件存储未初始化', '请在 Supabase Storage 创建 attachments bucket（或运行最新版 SUPABASE_SETUP.sql 会自动创建）。', 'err');
        }else{
          toast('附件上传失败', _humanizeRlsError(attErr), 'err');
        }
      }
    }

    // clear draft on success
    if(draftItems.length) clearDraft(scope, owner);

    if(inputEl) inputEl.value = '';
    toast('已发送', parentId ? '回复已发布。' : '留言已发布。', 'ok');
    await loadAndRenderComments(momentId, { force: true });
  }catch(e){
    toast('发送失败', _humanizeRlsError(e), 'err');
  }finally{
    if(sendBtn) sendBtn.disabled = false;
  }
}

function showReplyBox(momentId, commentId){
  if(!els.feed) return;
  const box = els.feed.querySelector(`[data-reply-box="${commentId}"]`);
  if(!box) return;

  // If already open, toggle off
  if(box.dataset.open === '1'){
    box.innerHTML = '';
    box.dataset.open = '0';
    clearDraft('reply', String(commentId));
    return;
  }

  box.dataset.open = '1';
  box.innerHTML = `
    <div class="reply-compose">
      <textarea class="input prose-input" rows="2" placeholder="写回复…" data-reply-input="${commentId}"></textarea>
      <input type="file" multiple hidden data-attach-input="${commentId}" data-attach-scope="reply" accept="image/*,application/pdf,.pdf,.doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
      <div class="attach-tools">
        <button class="btn tiny" type="button" data-attach-pick="${commentId}" data-attach-scope="reply">📎 附件</button>
        <button class="btn tiny" type="button" data-attach-clear="${commentId}" data-attach-scope="reply">清空</button>
        <span class="attach-hint">支持图片 / PDF / Word</span>
      </div>
      <div class="attach-list" data-attach-list="${commentId}" data-attach-scope="reply"></div>
      <div class="comment-actions" style="margin-top:8px">
        <button class="btn tiny" type="button" data-mention-author data-moment="${momentId}" data-mention-target="reply" data-reply-target="${commentId}" title="@该动态作者">@作者</button>
        <button class="btn tiny" type="button" data-mention-doctor data-moment="${momentId}" data-mention-target="reply" data-reply-target="${commentId}" title="@其他医生">@医生</button>
        <button class="btn tiny primary" data-reply-send="${commentId}" data-moment="${momentId}">发送回复</button>
        <button class="btn tiny" data-reply-cancel="${commentId}">取消</button>
      </div>
    </div>
  `;
}

async function deleteComment(momentId, commentId){
  if(!isConfigured()) return;
  if(!supabase) await ensureSupabase();
  if(!supabase) return;

  const ok = await ensureAuthed('login.html?next=moments.html');
  if(!ok) return;
  await initAuth();
  if(!currentUser) return;

  if(!confirm('确定要删除这条留言/回复吗？')) return;

  try{
    let res = await supabase.rpc('delete_moment_comment', { _comment_id: Number(commentId) });

    // Fallback: soft delete via update
    if(res?.error && /function .*delete_moment_comment/i.test(String(res.error.message || res.error))){
      res = await supabase
        .from('moment_comments')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', Number(commentId));
    }

    if(res?.error) throw res.error;
    toast('已删除', '留言已删除。', 'ok');
    await loadAndRenderComments(momentId, { force: true });
  }catch(e){
    toast('删除失败', _humanizeRlsError(e), 'err');
  }
}

async function toggleMomentCommentLike(momentId, commentId, btn){
  if(!isConfigured()) return;
  if(!supabase) await ensureSupabase();
  if(!supabase) return;
  if(!currentUser) return;

  const el = btn;
  const liked = (el.getAttribute('data-liked') || '0') === '1';
  const curCount = Number(el.getAttribute('data-count') || 0);

  el.disabled = true;
  try{
    if(!liked){
      const { error } = await supabase
        .from('moment_comment_likes')
        .insert({ comment_id: commentId, user_id: currentUser.id });
      if(error) throw error;

      const n = curCount + 1;
      el.setAttribute('data-liked', '1');
      el.setAttribute('data-count', String(n));
      el.classList.add('primary');
      el.querySelector('.comment-like-label')?.replaceChildren(document.createTextNode('💙 已赞'));
      const cnt = el.querySelector('.comment-like-count');
      if(cnt) cnt.textContent = String(n);

      const cached = commentCache.get(String(momentId));
      if(cached){
        try{
          cached.likedSet = cached.likedSet || new Set();
          cached.likedSet.add(String(commentId));
          const row = (cached.rows || []).find(r => String(r.id) === String(commentId));
          if(row) row.like_count = n;
        }catch(_e){ /* ignore */ }
      }
    }else{
      const { error } = await supabase
        .from('moment_comment_likes')
        .delete()
        .eq('comment_id', commentId)
        .eq('user_id', currentUser.id);
      if(error) throw error;

      const n = Math.max(0, curCount - 1);
      el.setAttribute('data-liked', '0');
      el.setAttribute('data-count', String(n));
      el.classList.remove('primary');
      el.querySelector('.comment-like-label')?.replaceChildren(document.createTextNode('👍 点赞'));
      const cnt = el.querySelector('.comment-like-count');
      if(cnt) cnt.textContent = String(n);

      const cached = commentCache.get(String(momentId));
      if(cached){
        try{
          cached.likedSet = cached.likedSet || new Set();
          cached.likedSet.delete(String(commentId));
          const row = (cached.rows || []).find(r => String(r.id) === String(commentId));
          if(row) row.like_count = n;
        }catch(_e){ /* ignore */ }
      }
    }
  }catch(e){
    toast('操作失败', _humanizeRlsError(e), 'err');
  }finally{
    el.disabled = false;
  }
}

async function handleFeedClick(e){
  const t = e.target;
  const btn = t?.closest?.('[data-like],[data-share],[data-fav],[data-edit],[data-del],[data-comment-toggle],[data-comment-send],[data-comments-refresh],[data-reply],[data-reply-send],[data-reply-cancel],[data-comment-del],[data-comment-like],[data-mention-author],[data-mention-doctor],[data-attach-pick],[data-attach-clear],[data-attach-remove]');
  if(!btn) return;

  // Attachments (comment/reply)
  if(btn.hasAttribute('data-attach-pick')){
    e.preventDefault();
    const scope = String(btn.getAttribute('data-attach-scope') || 'moment');
    const owner = String(btn.getAttribute('data-attach-pick') || '');
    if(!owner) return;
    const inp = els.feed?.querySelector(`[data-attach-input="${owner}"][data-attach-scope="${scope}"]`);
    inp?.click?.();
    return;
  }
  if(btn.hasAttribute('data-attach-clear')){
    e.preventDefault();
    const scope = String(btn.getAttribute('data-attach-scope') || 'moment');
    const owner = String(btn.getAttribute('data-attach-clear') || '');
    if(!owner) return;
    clearDraft(scope, owner);
    return;
  }
  if(btn.hasAttribute('data-attach-remove')){
    e.preventDefault();
    const fileId = String(btn.getAttribute('data-attach-remove') || '');
    const scope = String(btn.getAttribute('data-attach-scope') || 'moment');
    const owner = String(btn.getAttribute('data-attach-owner') || '');
    if(!fileId || !owner) return;
    const cur = getDraftItems(scope, owner);
    setDraftItems(scope, owner, cur.filter(x => x.id !== fileId));
    renderDraft(scope, owner);
    return;
  }




  // Share
  if(btn.hasAttribute('data-share')){
    e.preventDefault();
    const momentId = Number(btn.getAttribute('data-share') || 0);
    if(!momentId) return;
    const m = feedById?.get(String(momentId));
    if(!m){ toast('找不到这条动态'); return; }
    await openMomentShareDialog(m);
    return;
  }

  // Like / Favorite / Edit / Delete
  if(btn.hasAttribute('data-like')){
    e.preventDefault();
    await toggleLike(btn);
    return;
  }
  if(btn.hasAttribute('data-fav')){
    e.preventDefault();
    await toggleFavorite(btn);
    return;
  }
  if(btn.hasAttribute('data-edit')){
    e.preventDefault();
    await beginEdit(btn);
    return;
  }
  if(btn.hasAttribute('data-del')){
    e.preventDefault();
    await deleteMoment(btn);
    return;
  }

  if(btn.hasAttribute('data-comment-toggle')){
    e.preventDefault();
    toggleComments(btn);
    return;
  }

  // Mentions
  if(btn.hasAttribute('data-mention-author')){
    e.preventDefault();
    const momentId = Number(btn.getAttribute('data-moment') || 0);
    const target = String(btn.getAttribute('data-mention-target') || 'comment');
    const replyTarget = String(btn.getAttribute('data-reply-target') || '');
    if(!momentId) return;
    const m = feedById?.get(String(momentId));
    const authorId = String(m?.author_id || '').trim();
    const authorName = String(m?.author_name || '作者').trim();

    const ta = target === 'reply'
      ? els.feed?.querySelector(`[data-reply-input="${replyTarget}"]`)
      : els.feed?.querySelector(`[data-comment-input="${momentId}"]`);
    if(!ta) return;
    insertAtCursor(ta, formatMention({ id: authorId, full_name: authorName }) + ' ');
    return;
  }
  if(btn.hasAttribute('data-mention-doctor')){
    e.preventDefault();
    if(!currentUser){
      toast('需要登录', '登录后才能 @ 其他医生。', 'err');
      return;
    }
    const target = String(btn.getAttribute('data-mention-target') || 'comment');
    const momentId = Number(btn.getAttribute('data-moment') || 0);
    const replyTarget = String(btn.getAttribute('data-reply-target') || '');
    const ta = target === 'reply'
      ? els.feed?.querySelector(`[data-reply-input="${replyTarget}"]`)
      : els.feed?.querySelector(`[data-comment-input="${momentId}"]`);
    if(!ta) return;

    const p = await pickDoctor({ title: '@医生', placeholder: '搜索医生姓名…' });
    if(!p) return;
    insertAtCursor(ta, formatMention(p) + ' ');
    return;
  }

  // Comment like
  if(btn.hasAttribute('data-comment-like')){
    e.preventDefault();
    if(!currentUser){
      toast('需要登录', '登录后才能点赞留言。', 'err');
      return;
    }
    const momentId = Number(btn.getAttribute('data-moment') || 0);
    const commentId = Number(btn.getAttribute('data-comment-like') || 0);
    if(momentId && commentId) await toggleMomentCommentLike(momentId, commentId, btn);
    return;
  }
  if(btn.hasAttribute('data-comments-refresh')){
    e.preventDefault();
    const momentId = Number(btn.getAttribute('data-comments-refresh') || 0);
    if(momentId) loadAndRenderComments(momentId, { force:true });
    return;
  }
  if(btn.hasAttribute('data-comment-send')){
    e.preventDefault();
    const momentId = Number(btn.getAttribute('data-comment-send') || 0);
    if(momentId) postComment(momentId, null);
    return;
  }
  if(btn.hasAttribute('data-reply')){
    e.preventDefault();
    const momentId = Number(btn.getAttribute('data-moment') || 0);
    const commentId = Number(btn.getAttribute('data-reply') || 0);
    if(momentId && commentId) showReplyBox(momentId, commentId);
    return;
  }
  if(btn.hasAttribute('data-reply-send')){
    e.preventDefault();
    const momentId = Number(btn.getAttribute('data-moment') || 0);
    const commentId = Number(btn.getAttribute('data-reply-send') || 0);
    if(momentId && commentId) postComment(momentId, commentId);
    return;
  }
  if(btn.hasAttribute('data-reply-cancel')){
    e.preventDefault();
    const commentId = String(btn.getAttribute('data-reply-cancel') || '');
    const box = els.feed?.querySelector(`[data-reply-box="${commentId}"]`);
    if(box){ box.innerHTML=''; box.dataset.open='0'; }
    if(commentId) clearDraft('reply', commentId);
    return;
  }
  if(btn.hasAttribute('data-comment-del')){
    e.preventDefault();
    const momentId = Number(btn.getAttribute('data-moment') || 0);
    const commentId = Number(btn.getAttribute('data-comment-del') || 0);
    if(momentId && commentId) deleteComment(momentId, commentId);
    return;
  }
}

function handleFeedChange(e){
  const t = e.target;
  const inp = t?.closest?.('input[type="file"][data-attach-input]');
  if(!inp) return;
  const owner = String(inp.getAttribute('data-attach-input') || '');
  const scope = String(inp.getAttribute('data-attach-scope') || 'moment');
  if(!owner) return;
  addDraftFiles(scope, owner, inp.files);
  // reset so picking same file again triggers change
  inp.value = '';
}

async function toggleLike(btn){
  if(!isConfigured()) return;
  if(!supabase) await ensureSupabase();
  if(!supabase) return;
  const ok = await ensureAuthed('login.html?next=moments.html');
  if(!ok) return;
  await initAuth();
  if(!currentUser) return;

  const id = Number(btn.getAttribute('data-like'));
  if(!id) return;
  const liked = btn.getAttribute('data-liked') === '1';

  const labelEl = btn.querySelector('.like-label');
  const countEl = btn.querySelector('.like-count');
  const curCount = Number(btn.getAttribute('data-count') || (countEl ? countEl.textContent : '0') || 0) || 0;

  // optimistic UI
  const nextLiked = !liked;
  const nextCount = Math.max(curCount + (nextLiked ? 1 : -1), 0);
  btn.setAttribute('data-liked', nextLiked ? '1' : '0');
  btn.setAttribute('data-count', String(nextCount));
  btn.classList.toggle('primary', nextLiked);
  if(labelEl) labelEl.textContent = nextLiked ? '💙 已赞' : '👍 点赞';
  if(countEl) countEl.textContent = String(nextCount);

  btn.disabled = true;
  try{
    if(nextLiked){
      const row = { moment_id: id, user_id: currentUser.id };
      // Prefer upsert to avoid duplicate errors on fast taps
      let res = await supabase
        .from('moment_likes')
        .upsert(row, { onConflict: 'moment_id,user_id', ignoreDuplicates: true });
      if(res?.error){
        // Fallback to insert for older client versions
        res = await supabase.from('moment_likes').insert(row);
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
        .from('moment_likes')
        .delete()
        .eq('moment_id', id)
        .eq('user_id', currentUser.id);
      if(error) throw error;
    }

    // Sync with DB like_count (trigger-updated)
    try{
      const { data } = await supabase
        .from('moments')
        .select('like_count')
        .eq('id', id)
        .maybeSingle();
      if(data && typeof data.like_count !== 'undefined'){
        const n = Math.max(0, Number(data.like_count || 0));
        btn.setAttribute('data-count', String(n));
        if(countEl) countEl.textContent = String(n);
      }
    }catch(_e){ /* ignore */ }
  }catch(e){
    // rollback UI
    btn.setAttribute('data-liked', liked ? '1' : '0');
    btn.setAttribute('data-count', String(curCount));
    btn.classList.toggle('primary', liked);
    if(labelEl) labelEl.textContent = liked ? '💙 已赞' : '👍 点赞';
    if(countEl) countEl.textContent = String(curCount);

    const msg = e?.message || String(e);
    if(/moment_likes/i.test(msg) && /does not exist|relation/i.test(msg)){
      toast('点赞功能未初始化', '请在 Supabase SQL Editor 运行最新版 SUPABASE_SETUP.sql（或 MIGRATION_ONLY_MOMENTS.sql），然后 Settings → API 点击 “Reload schema”。', 'err');
    }else{
      toast('操作失败', msg, 'err');
    }
  }finally{
    btn.disabled = false;
  }
}

async function toggleFavorite(btn){
  if(!isConfigured()) return;
  if(!supabase) await ensureSupabase();
  if(!supabase) return;

  const ok = await ensureAuthed('login.html?next=moments.html');
  if(!ok) return;
  await initAuth();
  if(!currentUser) return;

  const momentId = Number(btn.getAttribute('data-fav'));
  if(!momentId) return;

  const faved = btn.getAttribute('data-faved') === '1';
  const labelEl = btn.querySelector('[data-fav-label]');

  btn.disabled = true;
  try{
    if(faved){
      const { error } = await supabase
        .from('moment_favorites')
        .delete()
        .eq('moment_id', momentId)
        .eq('user_id', currentUser.id);
      if(error) throw error;
      btn.setAttribute('data-faved','0');
      btn.classList.remove('primary');
      if(labelEl) labelEl.textContent = '收藏';
    }else{
      const { error } = await supabase
        .from('moment_favorites')
        .insert({ moment_id: momentId, user_id: currentUser.id });
      if(error) throw error;
      btn.setAttribute('data-faved','1');
      btn.classList.add('primary');
      if(labelEl) labelEl.textContent = '已收藏';
    }
  }catch(e){
    const msg = e?.message || String(e);
    if(/moment_favorites/i.test(msg) && /does not exist|relation/i.test(msg)){
      toast('收藏功能未初始化', '请在 Supabase SQL Editor 运行 MIGRATION_20260110_FAVORITES.sql，然后 Settings → API 点击 “Reload schema”。', 'err');
    }else{
      toast('操作失败', _humanizeRlsError(e), 'err');
    }
  }finally{
    btn.disabled = false;
  }
}


async function deleteMomentSafe(momentId){
  const nowIso = new Date().toISOString();

  // 1) Prefer RPC
  try{
    const { error } = await supabase.rpc('delete_moment', { _moment_id: momentId });
    if(!error) return;
    if(!_isMissingRpc(error, 'delete_moment')) throw error;
  }catch(e){
    if(!_isMissingRpc(e, 'delete_moment')) throw e;
  }

  // 2) Fallback: soft delete via update
  const { error: uerr } = await supabase
    .from('moments')
    .update({ deleted_at: nowIso })
    .eq('id', momentId);

  if(uerr) throw uerr;
}

async function deleteMoment(btn){
  if(!isConfigured()) return;
  if(!supabase) await ensureSupabase();
  if(!supabase) return;
  const ok = await ensureAuthed('login.html?next=moments.html');
  if(!ok) return;
  await initAuth();
  if(!currentUser) return;

  const id = Number(btn.getAttribute('data-del'));
  if(!id) return;
  if(!confirm('确定删除这条动态吗？删除后普通用户不可见。')) return;

  btn.disabled = true;
  try{
    await deleteMomentSafe(id);
    toast('已删除', '动态已删除。', 'ok');
    await loadFeed({ reset:true });
  }catch(e){
    toast('删除失败', _humanizeRlsError(e), 'err');
  }finally{
    btn.disabled = false;
  }
}

// ------------------------------
// Realtime (optional)
// ------------------------------

let _rtChannel = null;

async function initRealtime(){
  if(!isConfigured()) return;
  if(!supabase) await ensureSupabase();
  if(!supabase) return;
  if(_rtChannel) return;

  try{
    _rtChannel = supabase
      .channel('moments-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'moments' }, (payload) => {
        // If the page is open on another device, auto-refresh the feed.
        // Keep it lightweight: only refresh when not publishing right now.
        const row = payload?.new;
        if(row && row.deleted_at) return;
        // debounce a little
        clearTimeout(window.__ks_rt_moments);
        window.__ks_rt_moments = setTimeout(()=>{
          loadFeed({ reset:true });
        }, 350);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'moments' }, (payload) => {
        const row = payload?.new;
        // If a moment was deleted or like_count changed, refresh.
        if(row){
          clearTimeout(window.__ks_rt_moments);
          window.__ks_rt_moments = setTimeout(()=>{
            loadFeed({ reset:true });
          }, 450);
        }
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'moments' }, () => {
        clearTimeout(window.__ks_rt_moments);
        window.__ks_rt_moments = setTimeout(()=>{
          loadFeed({ reset:true });
        }, 450);
      });

    await _rtChannel.subscribe();
  }catch(_e){
    // Realtime is optional. Ignore failures.
    _rtChannel = null;
  }
}

// boot
initUploader();

// Paging controls
if(els.loadMoreBtn){
  els.loadMoreBtn.addEventListener('click', ()=> loadMoreFeed());
}
if(els.refreshFeedBtn){
  els.refreshFeedBtn.addEventListener('click', ()=> loadFeed({ reset:true }));
}

loadFeed({ reset:true });
initRealtime();
