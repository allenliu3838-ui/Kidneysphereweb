import { supabase, isConfigured, toast, ensureAuthed, getCurrentUser, getUserProfile, isAdminRole, normalizeRole, formatBeijingDateTime } from './supabaseClient.js?v=20260128_030';
import { pickDoctor, formatMention, insertAtCursor } from './mentionPicker.js?v=20260130_001';
import { mountKSEditor } from './ks_editor.js?v=20260213_001';
import { renderSafeHtml } from './ks_richtext.js?v=20260213_001';

const qs = new URLSearchParams(location.search);
const caseIdRaw = qs.get('id') || '';
const caseId = Number(caseIdRaw);

const titleEl = document.getElementById('caseTitle');
const metaEl = document.getElementById('caseMeta');
const tagsEl = document.getElementById('caseTags');
const bodyEl = document.getElementById('caseBody');
const caseAttachBlock = document.getElementById('caseAttachBlock');
const aiSummaryBlock = document.getElementById('aiSummaryBlock');
const aiStructuredBlock = document.getElementById('aiStructuredBlock');
const aiToolsBlock = document.getElementById('aiToolsBlock');
const listEl = document.getElementById('commentList');
const delBtn = document.getElementById('deleteBtn');
const likeBtn = document.getElementById('likeBtn');
let likeCountEl = document.getElementById('likeCount');
// 收藏按钮（此前缺少声明会导致模块脚本报错，进而整页"加载中…"卡死）
const favBtn = document.getElementById('favBtn');

const form = document.getElementById('commentForm');
const bodyInput = document.getElementById('commentBody');
const submitBtn = document.getElementById('commentSubmit');
const hintEl = document.getElementById('commentHint');

// Word-like rich editor for discussion replies (sync plain text back to textarea)
const commentEditor = bodyInput ? mountKSEditor(bodyInput, {
  mode: 'comment',
  placeholder: '写回复…（支持加粗/颜色/列表；从 Word 粘贴可自动排版）',
  syncToTextarea: true,
}) : null;
const commentDropEl = commentEditor ? commentEditor.surface : bodyInput;
const commentHoverEl = commentEditor ? commentEditor.root : bodyInput;
const mentionAuthorBtn = document.getElementById('commentMentionAuthor');
const mentionDoctorBtn = document.getElementById('commentMentionDoctor');

// Attachments picker (for case comments)
const attachInput = document.getElementById('caseAttachInput');
const attachPickBtn = document.getElementById('casePickAttachBtn');
const attachClearBtn = document.getElementById('caseClearAttachBtn');
const attachPreview = document.getElementById('caseAttachPreview');

// Thread-style modal (for reading a single comment)
const modalEl = document.getElementById('commentModal');
const modalAuthor = document.getElementById('modalAuthor');
const modalWhen = document.getElementById('modalWhen');
const modalLikeBtn = document.getElementById('modalLikeBtn');
const modalBody = document.getElementById('modalBody');
const modalAttaches = document.getElementById('modalAttaches');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalDeleteBtn = document.getElementById('modalDeleteBtn');

function esc(str){
  return String(str ?? '').replace(/[&<>"']/g, s => ({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[s]));
}

// Render text with:
// - escape HTML
// - @mentions:
//     - legacy: @[Name](uuid)
//     - new: @Name (no uuid)
// - auto-linkify URLs
// - preserve newlines
function renderRichText(str){
  const s = String(str ?? '');
  const tokenRe = /@\[([^\]]+?)\]\(([0-9a-fA-F-]{36})\)|(^|[\s(（【\[{\u3000>《"‘'"、，。！？;:])@([A-Za-z0-9_\-\u4e00-\u9fa5·]{1,24})|(?:https?:\/\/|www\.)[^\s<]+/gm;

  let out = '';
  let last = 0;
  for(const m of s.matchAll(tokenRe)){
    const start = m.index ?? 0;
    const full = String(m[0] ?? '');
    out += esc(s.slice(last, start));

    if(full.startsWith('@[')){
      const name = String(m[1] ?? '').trim() || '医生';
      const id = String(m[2] ?? '').trim();
      out += `<span class="mention" data-uid="${esc(id)}">@${esc(name)}</span>`;
      last = start + full.length;
      continue;
    }

    // Plain mention token (boundary + name)
    if(typeof m[4] === 'string' && m[4]){
      const prefix = String(m[3] ?? '');
      const name = String(m[4] ?? '').trim();
      if(prefix) out += esc(prefix);
      out += `<span class="mention">@${esc(name)}</span>`;
      last = start + full.length;
      continue;
    }

    // URL
    let rawUrl = full;
    let url = rawUrl;
    let trailing = '';
    while(url.length){
      const ch = url[url.length - 1];
      if(/[\)\]\}\.,!?;:，。！？；：》」』"’"']/.test(ch)){
        trailing = ch + trailing;
        url = url.slice(0, -1);
        continue;
      }
      break;
    }
    const href = url.startsWith('www.') ? `https://${url}` : url;
    if(url){
      out += `<a class="auto-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`;
    }else{
      out += esc(rawUrl);
    }
    if(trailing) out += esc(trailing);
    last = start + rawUrl.length;
  }
  out += esc(s.slice(last));
  return out.replace(/\n/g, '<br/>');
}

// Lightweight Markdown renderer for AI summary (safe, no raw HTML)
// Supports: #/##/### headings, -/* bullet lists, numbered lists, bold **text**
function renderMarkdownLite(md){
  const src = String(md ?? '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  let html = '';
  let inUl = false;
  let inOl = false;

  const closeLists = ()=>{
    if(inUl){ html += '</ul>'; inUl = false; }
    if(inOl){ html += '</ol>'; inOl = false; }
  };

  const inline = (s)=>{
    // escape first
    let x = esc(s);
    // bold
    x = x.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    // linkify URLs
    x = x.replace(/((?:https?:\/\/|www\.)[^\s<]+)/g, (m)=>{
      let url = m;
      let trailing = '';
      while(url.length){
        const ch = url[url.length - 1];
        if(/[\)\]\}\.,!?;:，。！？；：》」』"’"']/.test(ch)){
          trailing = ch + trailing;
          url = url.slice(0, -1);
          continue;
        }
        break;
      }
      const href = url.startsWith('www.') ? `https://${url}` : url;
      const a = url ? `<a class="auto-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>` : esc(m);
      return a + esc(trailing);
    });
    return x;
  };

  for(const raw of lines){
    const line = String(raw ?? '');
    if(!line.trim()){
      closeLists();
      html += '<div style="height:10px"></div>';
      continue;
    }

    // Headings
    if(/^###\s+/.test(line)){
      closeLists();
      html += `<h4 style="margin:12px 0 6px">${inline(line.replace(/^###\s+/, ''))}</h4>`;
      continue;
    }
    if(/^##\s+/.test(line)){
      closeLists();
      html += `<h3 style="margin:14px 0 8px;font-size:18px">${inline(line.replace(/^##\s+/, ''))}</h3>`;
      continue;
    }
    if(/^#\s+/.test(line)){
      closeLists();
      html += `<h2 style="margin:16px 0 10px;font-size:20px">${inline(line.replace(/^#\s+/, ''))}</h2>`;
      continue;
    }

    // Bullet list
    if(/^\s*[-*]\s+/.test(line)){
      if(inOl){ html += '</ol>'; inOl = false; }
      if(!inUl){ html += '<ul style="margin:8px 0 8px 20px">'; inUl = true; }
      html += `<li style="margin:4px 0">${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`;
      continue;
    }

    // Numbered list
    if(/^\s*\d+[\.|、]\s+/.test(line)){
      if(inUl){ html += '</ul>'; inUl = false; }
      if(!inOl){ html += '<ol style="margin:8px 0 8px 22px">'; inOl = true; }
      html += `<li style="margin:4px 0">${inline(line.replace(/^\s*\d+[\.|、]\s+/, ''))}</li>`;
      continue;
    }

    closeLists();
    html += `<div style="line-height:1.8;margin:4px 0">${inline(line)}</div>`;
  }
  closeLists();
  return html;
}

function detectPrivacyFlags(text){
  const s = String(text || '');
  const flags = [];
  // Mainland China mobile numbers
  if(/(?:\+?86)?1[3-9]\d{9}/.test(s)) flags.push('疑似手机号');
  // PRC ID number (rough)
  if(/\b\d{17}[0-9Xx]\b/.test(s)) flags.push('疑似身份证号');
  // Hospitalization number keywords
  if(/(住院号|门诊号|病案号|就诊号|ID[:：]?)/i.test(s)) flags.push('疑似就诊/住院编号');
  return flags;
}

async function copyText(text){
  const t = String(text || '');
  if(!t.trim()) return false;
  try{
    await navigator.clipboard.writeText(t);
    return true;
  }catch(_e){
    try{
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    }catch(_e2){
      return false;
    }
  }
}

function tagChip(t){
  return `<span class="badge" style="border-color:rgba(255,255,255,.14);background:rgba(255,255,255,.06)">${esc(t)}</span>`;
}

// ------------------------------------------------------------
// Attachments (case_comment)
// ------------------------------------------------------------
const MAX_ATTACH_BYTES = 20 * 1024 * 1024; // 20MB per file
const MAX_ATTACH_COUNT = 9;
const ALLOWED_ATTACH_MIMES = [
  'image/jpeg','image/png','image/gif','image/webp','image/bmp',
  'application/pdf',
  'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
];
const ALLOWED_ATTACH_EXTS = /\.(jpe?g|png|gif|webp|bmp|pdf|docx?|pptx?)$/i;
let attachPicks = []; // { file, id, url? }

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
    .normalize ? stemRaw.normalize('NFKD') : stemRaw;
  stem = stem
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  if(!stem) stem = 'file';

  let ext = String(extRaw || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
  return ext ? `${stem}.${ext}` : stem;
}

function renderAttachDraft(){
  if(!attachPreview) return;
  if(!attachPicks.length){
    attachPreview.innerHTML = '';
    if(attachClearBtn) attachClearBtn.disabled = true;
    return;
  }
  if(attachClearBtn) attachClearBtn.disabled = false;
  attachPreview.innerHTML = attachPicks.map(p=>{
    const file = p.file;
    const kind = guessKindFromMime(file?.type, file?.name);
    const icon = kind === 'image' ? '🖼️' : (kind === 'pdf' ? '📄' : (kind === 'doc' ? '📝' : '📎'));
    return `
      <div class="attach-item" data-attach-item="${p.id}">
        <div class="left">
          <div class="name">${icon} ${esc(file?.name || '附件')}</div>
          <div class="meta">${esc(String(file?.type || ''))}${file?.size ? ' · ' + fmtSize(file.size) : ''}</div>
        </div>
        <button class="btn tiny" type="button" data-attach-remove="${p.id}">移除</button>
      </div>
    `;
  }).join('');
}

function isAllowedAttachment(file){
  const mime = String(file.type || '').toLowerCase();
  const name = String(file.name || '');
  if(ALLOWED_ATTACH_MIMES.includes(mime)) return true;
  if(ALLOWED_ATTACH_EXTS.test(name)) return true;
  return false;
}

function addAttachFiles(files){
  const list = Array.from(files || []);
  if(!list.length) return;
  const next = [...attachPicks];
  for(const f of list){
    if(next.length >= MAX_ATTACH_COUNT) break;
    if(!isAllowedAttachment(f)){
      toast('文件类型不支持', `${f.name} 不在允许的类型范围内。支持：图片、PDF、Word、PPT。`, 'err');
      continue;
    }
    if((f.size || 0) > MAX_ATTACH_BYTES){
      const mb = Math.round((f.size || 0) / 1024 / 1024);
      toast('附件过大', `${f.name}（${mb}MB）超出限制（单个≤${Math.round(MAX_ATTACH_BYTES/1024/1024)}MB）。`, 'err');
      continue;
    }
    next.push({ file: f, id: `${Date.now()}_${Math.random().toString(16).slice(2)}` });
  }
  attachPicks = next;
  renderAttachDraft();
}

function clearAttachDraft(){
  attachPicks = [];
  if(attachInput) attachInput.value = '';
  renderAttachDraft();
}

// ------------------------------------------------------------
// Thread-style comment list + modal
// ------------------------------------------------------------
let commentRows = [];
let attachmentsByComment = new Map();
let openCommentId = null;
let commentLikeSupported = true;
let likedCommentIds = new Set();

function snip(text, max=140){
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if(s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function isMobileViewport(){
  return window.matchMedia('(max-width: 860px)').matches;
}

function initials(name){
  const s = String(name || '').trim();
  if(!s) return 'KS';
  const chars = Array.from(s.replace(/\s+/g, ''));
  // Chinese names: 2 chars; English: take 2 initials
  if(/[\u4E00-\u9FFF]/.test(chars.join(''))){
    return chars.slice(0, 2).join('');
  }
  const parts = s.split(/\s+/g).filter(Boolean);
  const pick = (parts[0]?.[0] || '') + (parts[1]?.[0] || parts[0]?.[1] || '');
  return (pick || s.slice(0, 2)).toUpperCase();
}

// Attachments renderer
// - Images: show as a grid of thumbnails
// - Files: show as chips
// - PDF (desktop): additionally show an inline first-page preview thumbnail (best-effort)
function renderAttachmentsBlock(attaches, opts={}){
  const raw = Array.isArray(attaches) ? attaches : [];
  if(!raw.length) return '';

  // Only render links we can actually open. For private buckets, URLs are resolved
  // via signed URLs at load time; anonymous users may not have access.
  const a = raw.filter(x => x && String(x.public_url || '').trim().length > 0);
  if(!a.length){
    return '<div class="small muted">（附件仅登录后可查看）</div>';
  }

  const thumbPdf = Boolean(opts.thumbPdf);
  const imgs = a.filter(x => String(x.kind || '') === 'image');
  const files = a.filter(x => String(x.kind || '') !== 'image');
  const pdfs = files.filter(x => String(x.kind || '') === 'pdf');

  const imgHtml = imgs.length ? `
    <div class="attach-grid">
      ${imgs.map(x=>`<a class="attach-img" href="${esc(x.public_url || '')}" target="_blank" rel="noopener"><img alt="img" src="${esc(x.public_url || '')}"/></a>`).join('')}
    </div>
  ` : '';

  // PDF first-page preview (desktop best-effort). We keep file chips as the reliable open/download.
  const pdfThumbHtml = (thumbPdf && pdfs.length) ? `
    <div class="pdf-grid" aria-label="PDF previews">
      ${pdfs.map(x=>{
        const url = String(x.public_url || '');
        const nm = x.original_name || x.path || 'PDF';
        const src = url ? `${url}#page=1&view=FitH` : '';
        return `
          <a class="pdf-card" href="${esc(url)}" target="_blank" rel="noopener">
            <div class="pdf-frame">${src ? `<iframe loading="lazy" src="${esc(src)}" title="${esc(nm)}"></iframe>` : ''}</div>
            <div class="pdf-cap">📄 ${esc(nm)}</div>
          </a>
        `;
      }).join('')}
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

  return imgHtml + pdfThumbHtml + fileHtml;
}

const ATTACH_SIGN_TTL_SECONDS = 60 * 60; // 1 hour

async function hydrateSignedUrlsForAttachments(attRows){
  const rows = Array.isArray(attRows) ? attRows : [];
  if(!rows.length) return;

  const need = rows.filter(a => a && String(a.bucket || 'attachments') === 'attachments' && a.path);
  if(!need.length) return;

  // Case pages are authenticated, but keep it defensive.
  if(!currentUser){
    for(const a of need){ a.public_url = ''; }
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

// Load attachments attached to the case itself (target_type = 'case')
async function loadCaseAttachments(){
  if(!caseAttachBlock) return;
  if(!currentCase) { caseAttachmentRows = []; caseAttachBlock.innerHTML = ''; return; }

  try{
    const { data, error } = await supabase
      .from('attachments')
      .select('id, target_type, target_id, kind, bucket, path, public_url, original_name, created_at')
      .eq('target_type', 'case')
      .eq('target_id', Number(currentCase.id))
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
    if(error) throw error;

    const rows = data || [];
    await hydrateSignedUrlsForAttachments(rows);
    caseAttachmentRows = rows;
    if(!rows.length){
      caseAttachBlock.innerHTML = '';
      return;
    }

    caseAttachBlock.innerHTML = `<div class="small muted" style="margin-bottom:8px"><b>病例附件</b></div>` + renderAttachmentsBlock(rows, { thumbPdf: !isMobileViewport() });
  }catch(_e){
    // attachments table may not exist on some environments; fail silently
    caseAttachmentRows = [];
    caseAttachBlock.innerHTML = '';
  }
}

function commentActionsHtml(c, canDelete){
  const likeCount = Number(c.like_count || 0);
  const isLiked = likedCommentIds && typeof likedCommentIds.has === 'function' ? likedCommentIds.has(String(c.id)) : false;
  const likeText = isLiked ? `💙 已赞 · ${likeCount}` : `👍 点赞 · ${likeCount}`;
  const likeBtnHtml = commentLikeSupported
    ? `<button class="btn tiny ${isLiked ? 'primary' : ''}" type="button" data-like-comment="${c.id}" data-liked="${isLiked ? '1' : '0'}" data-count="${likeCount}">${likeText}</button>`
    : `<span class="small muted">👍 ${likeCount}</span>`;
  const replyBtn = `<button class="btn tiny" type="button" data-reply-comment="${c.id}">回复</button>`;
  const delBtn = canDelete ? `<button class="btn tiny danger" type="button" data-del-comment="${c.id}">删除</button>` : '';
  return `${likeBtnHtml}${replyBtn}${delBtn}`;
}

function commentCardDesktop(c, canDelete){
  const when = c.created_at ? formatBeijingDateTime(c.created_at) : '';
  const attaches = attachmentsByComment.get(String(c.id)) || [];
  const attachBlock = attaches.length ? `<div class="msg-attaches">${renderAttachmentsBlock(attaches, { thumbPdf: true })}</div>` : '';
  const isMod = !!(moderatorIds && moderatorIds.has(String(c.author_id)));
  const modBadge = isMod ? `<span class="badge mod mini" style="margin-left:6px">版主</span>` : '';
  const bHtml = String(c.body_html || '').trim();
  const renderedBody = bHtml ? renderSafeHtml(bHtml, { mode:'comment', linkify:true, mentionify:true }) : renderRichText(String(c.body || ''));
  return `
    <article id="comment-${c.id}" class="msg msg-desktop" data-comment-id="${c.id}">
      <div class="msg-left">
        <div class="msg-avatar" aria-hidden="true">${esc(initials(c.author_name || 'Member'))}</div>
      </div>
      <div class="msg-content">
        <div class="msg-head">
          <div class="msg-meta">
            <b class="msg-author">${esc(c.author_name || 'Member')}</b>${modBadge}
            <span class="msg-when">${esc(when)}</span>
          </div>
          <div class="msg-actions">${commentActionsHtml(c, canDelete)}</div>
        </div>
        <div class="msg-body ks-prose">${renderedBody}</div>
        ${attachBlock}
      </div>
    </article>
  `;
}

function commentCardMobile(c, canDelete){
  const when = c.created_at ? formatBeijingDateTime(c.created_at) : '';
  const attaches = attachmentsByComment.get(String(c.id)) || [];
  const likeCount = Number(c.like_count || 0);
  const hint = `👍 ${likeCount}${attaches.length ? ` · 📎 ${attaches.length}` : ''}`;
  const attachBlock = attaches.length ? `<div class="msg-attaches">${renderAttachmentsBlock(attaches, { thumbPdf: false })}</div>` : '';
  const isMod = !!(moderatorIds && moderatorIds.has(String(c.author_id)));
  const modBadge = isMod ? `<span class="badge mod mini" style="margin-left:6px">版主</span>` : '';
  const bHtml = String(c.body_html || '').trim();
  const renderedBody = bHtml ? renderSafeHtml(bHtml, { mode:'comment', linkify:true, mentionify:true }) : renderRichText(String(c.body || ''));
  return `
    <details id="comment-${c.id}" class="msg msg-mobile" data-comment-id="${c.id}">
      <summary class="msg-summary">
        <div class="msg-s-top">
          <div class="msg-left"><div class="msg-avatar" aria-hidden="true">${esc(initials(c.author_name || 'M'))}</div></div>
          <div class="msg-s-main">
            <div class="msg-meta">
              <b class="msg-author">${esc(c.author_name || 'Member')}</b>${modBadge}
              <span class="msg-when">${esc(when)}</span>
            </div>
            <div class="msg-snippet">${esc(snip(c.body || '', 120))}</div>
            <div class="small muted" data-like-hint="${c.id}" style="margin-top:6px">${esc(hint)}</div>
          </div>
          <div class="msg-chevron" aria-hidden="true">▾</div>
        </div>
      </summary>
      <div class="msg-detail">
        <div class="msg-actions">${commentActionsHtml(c, canDelete)}</div>
        <div class="msg-body ks-prose">${renderedBody}</div>
        ${attachBlock}
      </div>
    </details>
  `;
}

function scrollToCommentFromHash(){
  const h = String(location.hash || '');
  if(!h || !h.startsWith('#comment-')) return;
  const el = document.querySelector(h);
  if(!el) return;
  try{
    if(el.tagName === 'DETAILS') el.open = true;
    el.classList.add('highlight');
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(()=>el.classList.remove('highlight'), 2600);
  }catch(_e){}
}

window.addEventListener('hashchange', ()=>setTimeout(scrollToCommentFromHash, 50));

function renderCommentList(){
  if(!listEl) return;
  const rows = Array.isArray(commentRows) ? commentRows : [];
  if(!rows.length){
    listEl.innerHTML = '<div class="muted small">暂无评论。欢迎发表第一条回复。</div>';
    return;
  }
  const uid = currentUser?.id || '';
  const canModerate = Boolean(
    isAdminUi
    || isModeratorUser
    || isBoardModeratorUser
    || (uid && currentCase && String(currentCase.author_id) === String(uid))
  );
  const mobile = isMobileViewport();
  listEl.innerHTML = rows.map(c => {
    const canDelete = Boolean(
      canModerate
      || (uid && String(c.author_id) === String(uid))
    );
    return mobile ? commentCardMobile(c, canDelete) : commentCardDesktop(c, canDelete);
  }).join('');

  // If the URL has #comment-xxx (e.g., from通知中心/红点跳转), scroll to it.
  setTimeout(scrollToCommentFromHash, 60);
}

function replyToComment(commentId){
  const id = Number(commentId);
  const c = commentRows.find(r => Number(r.id) === id);
  if(!c) return;
  const name = c.author_name || 'Member';
  const uid = String(c.author_id || '').trim();
  // Best-effort mention format if we have author_id (uuid)
  try{
    if(uid && /^[0-9a-fA-F-]{36}$/.test(uid)){
      insertAtCursor(bodyInput, formatMention({ id: uid, full_name: name }) + ' ');
    }else{
      insertAtCursor(bodyInput, '@' + name + ' ');
    }
  }catch(_e){
    bodyInput.value = (bodyInput.value || '') + '\n@' + name + ' ';
  }
  bodyInput?.focus?.();
  try{ form?.scrollIntoView?.({ behavior: 'smooth', block: 'center' }); }catch(_e){}
}

// Re-render on viewport breakpoint changes (e.g., rotate phone)
let _lastMobile = null;
function _syncCommentLayout(){
  const m = isMobileViewport();
  if(_lastMobile === null) _lastMobile = m;
  if(m !== _lastMobile){
    _lastMobile = m;
    renderCommentList();
  }
}
window.addEventListener('resize', ()=>{
  // Light debounce
  clearTimeout(window.__ks_case_resize_t);
  window.__ks_case_resize_t = setTimeout(_syncCommentLayout, 120);
});

function setLoading(){
  titleEl.textContent = '加载中…';
  metaEl.textContent = '';
  tagsEl.innerHTML = '';
  bodyEl.innerHTML = '<p class="muted">正在读取病例内容…</p>';
  listEl.innerHTML = '<div class="muted small">加载评论中…</div>';
  if(aiSummaryBlock) aiSummaryBlock.innerHTML = '';
  if(aiStructuredBlock) aiStructuredBlock.innerHTML = '';
  if(aiToolsBlock){ aiToolsBlock.innerHTML = ''; aiToolsBlock.hidden = true; }
}

function setError(msg){
  titleEl.textContent = '无法加载';
  bodyEl.innerHTML = `<div class="note"><b>提示：</b>${esc(msg)}</div>`;
  listEl.innerHTML = '';
  if(aiSummaryBlock) aiSummaryBlock.innerHTML = '';
  if(aiStructuredBlock) aiStructuredBlock.innerHTML = '';
  if(aiToolsBlock){ aiToolsBlock.innerHTML = ''; aiToolsBlock.hidden = true; }
}

let currentUser = null;
let currentProfile = null;
let isAdminUser = false;
let isAdminUi = false;
// Extra moderation roles (not full admin UI)
let isModeratorUser = false;       // profiles.role === 'moderator'
let isBoardModeratorUser = false;  // in board_moderators for current case board
let currentCase = null;
let canPostCaseComments = true;

// Per-board moderators (for "版主" badge)
let moderatorIds = new Set();

async function loadBoardModerators(boardKey){
  moderatorIds = new Set();
  const bk = String(boardKey || '').toLowerCase();
  if(!bk) return;
  if(!isConfigured() || !supabase) return;
  try{
    const { data, error } = await supabase
      .from('board_moderators')
      .select('user_id')
      .eq('board_key', bk);
    if(error) throw error;
    moderatorIds = new Set((data || []).map(r => r.user_id));
  }catch(e){
    const msg = String(e && e.message ? e.message : e || '');
    // If table not created yet, silently ignore
    if(/board_moderators/i.test(msg) && /(does not exist|relation|schema cache|not find|could not find)/i.test(msg)) return;
  }
}

// AI features are paused (Stage 1 removed per product decision)
const ENABLE_AI_FEATURES = false;

function applyDoctorGateUI(){
  if(canPostCaseComments) return;
  const next = encodeURIComponent((location.pathname.split('/').pop() || 'case.html') + location.search);
  const href = `verify-doctor.html?next=${next}`;
  // Append a clear callout without overwriting existing hint text.
  hintEl.innerHTML = `${hintEl.innerHTML}<div style="margin-top:8px"><b>医生认证提示：</b>回复病例讨论/上传附件需要完成医生认证（邀请码快速认证或人工审核）。 <a class="btn tiny" href="${href}">去认证</a></div>`;

  // Disable submit + attachment UI
  try{
    submitBtn.disabled = true;
    attachPickBtn.disabled = true;
    attachClearBtn.disabled = true;
    attachInput.disabled = true;
    mentionAuthorBtn.disabled = true;
    mentionDoctorBtn.disabled = true;
    textarea.placeholder = '回复功能需先完成医生认证';
  }catch(_e){}
}

// Attachments on the case itself (loaded from attachments table)
let caseAttachmentRows = [];

// AI artifacts (Stage 1: generated externally, pasted back and saved)
let aiSummaryRow = null;      // kind: summary_md
let aiStructuredRow = null;   // kind: structured_json
let aiSourceHashNow = '';
let aiArtifactsSupported = true;
let liked = false;
let likeSupported = true;
// 收藏状态（case_favorites）
let faved = false;
let favSupported = true;
// NOTE: Keep like state simple and avoid duplicate declarations.
// The actual like feature is implemented below (updateLikeBtn + loadLikeState).

// ------------------------------------------------------------
// AI Artifacts (Stage 1: Free AI + manual paste-back)
// ------------------------------------------------------------
function roleLower(){
  return String(normalizeRole(currentProfile?.role) || '').toLowerCase();
}

function canEditAi(){
  if(!currentUser || !currentCase) return false;
  const r = roleLower();
  const isAdmin = isAdminRole(r);
  const isDoctorVerified = (r === 'doctor_verified');
  const isAuthor = String(currentCase.author_id) === String(currentUser.id);
  // Stage 1: allow case author + doctor_verified + admin/super_admin
  return Boolean(isAdmin || isDoctorVerified || isAuthor);
}

function maxIso(a, b){
  if(!a) return b || '';
  if(!b) return a || '';
  try{
    return (new Date(a).getTime() >= new Date(b).getTime()) ? a : b;
  }catch(_e){
    return a || b || '';
  }
}

// Tiny non-crypto hash for change detection (FNV-1a 32bit)
function fastHash(s){
  const str = String(s ?? '');
  let h = 2166136261;
  for(let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(36);
}

function computeAiSourceHash(){
  if(!currentCase) return '';
  // cases table does not always have updated_at; include a lightweight hash of title/summary/content
  const caseBaseTime = currentCase.updated_at || currentCase.created_at || '';
  const caseText = `${currentCase.title || ''}\n${currentCase.summary || ''}\n${currentCase.content || ''}`;
  const caseTextHash = fastHash(caseText.slice(0, 40000));
  const caseUpdated = `${caseBaseTime}#${caseTextHash}`;
  let lastComment = '';
  for(const c of (commentRows || [])){
    if(c?.deleted_at) continue;
    lastComment = maxIso(lastComment, c.created_at);
  }
  let lastAttach = '';
  for(const a of (caseAttachmentRows || [])){
    lastAttach = maxIso(lastAttach, a.created_at);
  }
  for(const arr of (attachmentsByComment?.values?.() || [])){
    for(const a of (arr || [])){
      lastAttach = maxIso(lastAttach, a.created_at);
    }
  }
  // Keep it deterministic and human-readable (no crypto needed)
  return `${caseUpdated}|${lastComment}|${lastAttach}`;
}

function aiHumanUpdatedAt(row){
  const t = row?.updated_at || row?.created_at;
  return t ? formatBeijingDateTime(t) : '';
}

function aiStale(row){
  const sig = aiSourceHashNow || '';
  const saved = String(row?.source_hash || '');
  if(!sig || !saved) return false;
  return sig !== saved;
}

function renderAiSummary(){
  if(!aiSummaryBlock) return;

  if(!aiArtifactsSupported){
    aiSummaryBlock.innerHTML = '';
    return;
  }

  const row = aiSummaryRow;
  const canEdit = canEditAi();

  if(!row){
    aiSummaryBlock.innerHTML = `
      <div class="note">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap">
          <div>
            <b>讨论摘要（人工确认）</b>
            <div class="small muted" style="margin-top:6px">当前暂无摘要。建议使用下方 <b>AI 整理工具（免费）</b> 生成后粘贴保存。</div>
          </div>
          <span class="badge">AI Summary</span>
        </div>
      </div>
    `;
    return;
  }

  const stale = aiStale(row);
  const badge = stale ? '<span class="badge" style="border-color:rgba(245,158,11,.35);background:rgba(245,158,11,.08)">待更新</span>' : '<span class="badge">AI Summary</span>';
  const meta = `整理：${esc(row?.creator_name || row?.created_by_name || row?.created_by || '成员')} · ${esc(aiHumanUpdatedAt(row))}${stale ? ' · <b style="color:#b45309">讨论已更新</b>' : ''}`;
  const content = String(row?.content_md || '').trim();

  aiSummaryBlock.innerHTML = `
    <div class="note">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap">
        <div>
          <b>讨论摘要（人工确认）</b>
          <div class="small muted" style="margin-top:6px">${meta}</div>
        </div>
        ${badge}
      </div>
      <div style="margin-top:12px;line-height:1.8">${renderMarkdownLite(content)}</div>
      ${stale ? `<div class="small" style="margin-top:10px;color:#b45309">提示：评论或附件有更新，建议重新生成并保存摘要。</div>` : ''}
    </div>
  `;
}

function renderAiStructured(){
  if(!aiStructuredBlock) return;
  if(!aiArtifactsSupported){
    aiStructuredBlock.innerHTML = '';
    return;
  }
  const row = aiStructuredRow;
  if(!row){
    aiStructuredBlock.innerHTML = '';
    return;
  }

  const stale = aiStale(row);
  const badge = stale ? '<span class="badge" style="border-color:rgba(245,158,11,.35);background:rgba(245,158,11,.08)">待更新</span>' : '<span class="badge">Structured</span>';
  const meta = `整理：${esc(row?.creator_name || row?.created_by_name || row?.created_by || '成员')} · ${esc(aiHumanUpdatedAt(row))}${stale ? ' · <b style="color:#b45309">讨论已更新</b>' : ''}`;
  let obj = row?.content_json;
  if(typeof obj === 'string'){
    try{ obj = JSON.parse(obj); }catch(_e){ obj = null; }
  }

  const safeVal = (v)=>{
    if(v === null || v === undefined) return '';
    if(typeof v === 'string') return v;
    if(typeof v === 'number' || typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
  };

  const demographics = obj?.demographics || {};
  const presentation = obj?.presentation || {};
  const labs = obj?.key_labs || {};
  const pathology = obj?.pathology || {};
  const followup = obj?.followup || {};
  const points = Array.isArray(obj?.discussion_points) ? obj.discussion_points : [];
  const opens = Array.isArray(obj?.open_questions) ? obj.open_questions : [];
  const treatments = Array.isArray(obj?.treatments) ? obj.treatments : [];

  const kv = (k, v)=>{
    const val = safeVal(v);
    if(!val) return '';
    return `<div style="margin:2px 0"><span class="small muted">${esc(k)}：</span><span>${esc(val)}</span></div>`;
  };

  const section = (title, inner)=>{
    if(!inner) return '';
    return `
      <div style="margin-top:10px">
        <div class="small muted" style="margin-bottom:6px"><b>${esc(title)}</b></div>
        <div style="padding-left:2px">${inner}</div>
      </div>
    `;
  };

  const treatHtml = treatments.length ? `
    <ol style="margin:6px 0 0 18px">
      ${treatments.map(t=>{
        const s = [t?.date_or_phase, t?.meds, t?.dose, t?.response].filter(Boolean).join('｜');
        return `<li style="margin:4px 0">${esc(s)}</li>`;
      }).join('')}
    </ol>
  ` : '';

  const pointsHtml = points.length ? `<ul style="margin:6px 0 0 18px">${points.map(x=>`<li style="margin:4px 0">${esc(String(x))}</li>`).join('')}</ul>` : '';
  const opensHtml = opens.length ? `<ul style="margin:6px 0 0 18px">${opens.map(x=>`<li style="margin:4px 0">${esc(String(x))}</li>`).join('')}</ul>` : '';

  const inner = [
    section('基本信息', kv('性别', demographics.sex) + kv('年龄', demographics.age)),
    section('主诉与病程', kv('主诉', presentation.chief_complaint) + kv('病程概述', presentation.course_summary)),
    section('关键化验', kv('Scr', labs.scr) + kv('eGFR', labs.egfr) + kv('蛋白尿', labs.proteinuria) + kv('白蛋白', labs.albumin) + kv('PLA2R', labs.pla2r) + kv('补体', labs.complements) + kv('其他', labs.other)),
    section('病理要点', kv('要点', pathology.key_findings)),
    section('治疗与调整', treatHtml),
    section('随访/结局', kv('结局', followup.outcomes)),
    section('讨论要点', pointsHtml),
    section('未解问题', opensHtml),
  ].join('');

  aiStructuredBlock.innerHTML = `
    <div class="note">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap">
        <div>
          <b>结构化要点（人工确认）</b>
          <div class="small muted" style="margin-top:6px">${meta}</div>
        </div>
        ${badge}
      </div>
      <div style="margin-top:10px">${inner || '<div class="small muted">（结构化内容为空或格式不完整）</div>'}</div>
      ${stale ? `<div class="small" style="margin-top:10px;color:#b45309">提示：评论或附件有更新，建议重新生成并保存结构化要点。</div>` : ''}
    </div>
  `;
}

function buildAiContextText({ includeAttachments=true, maxComments=30 }={}){
  if(!currentCase) return '';
  const board = String(currentCase.board || '').toLowerCase();
  const boardName = (board === 'research') ? '科研讨论' : (board === 'literature' ? '文献学习' : '病例讨论');
  const lines = [];
  lines.push(`【病例标题】${currentCase.title || ''}`);
  lines.push(`【板块】${boardName}`);
  lines.push(`【作者】${currentCase.author_name || ''}`);
  lines.push(`【发布时间】${formatBeijingDateTime(currentCase.created_at)}（北京时间）`);
  lines.push('');
  if(String(currentCase.summary || '').trim()){
    lines.push('【摘要】');
    lines.push(String(currentCase.summary || '').trim());
    lines.push('');
  }
  const body = String(currentCase.content || '').trim();
  if(body){
    lines.push('【正文】');
    lines.push(body);
    lines.push('');
  }

  if(includeAttachments){
    const allAtt = [];
    for(const a of (caseAttachmentRows || [])) allAtt.push({ where:'病例', a });
    for(const [cid, arr] of (attachmentsByComment?.entries?.() || [])){
      for(const a of (arr || [])) allAtt.push({ where:`评论#${cid}`, a });
    }
    if(allAtt.length){
      lines.push('【附件清单】');
      for(const x of allAtt){
        const a = x.a || {};
        const nm = a.original_name || a.path || '附件';
        const kind = a.kind || '';
        const url = a.public_url || '';
        lines.push(`- ${x.where}｜${nm}${kind ? '（'+kind+'）' : ''}${url ? '｜'+url : ''}`);
      }
      lines.push('');
    }
  }

  const rows = Array.isArray(commentRows) ? commentRows.filter(x=>!x?.deleted_at) : [];
  const picked = rows.slice(Math.max(0, rows.length - maxComments));
  lines.push(`【讨论评论（最近 ${picked.length} 条）】`);
  picked.forEach((c, idx)=>{
    const n = idx + 1;
    const who = c.author_name || 'Member';
    const when = c.created_at ? formatBeijingDateTime(c.created_at) + '（北京时间）' : '';
    const txt = String(c.body || '').trim();
    lines.push(`评论#${n}｜${who}${when ? '｜'+when : ''}`);
    lines.push(txt);

    // attachments hint for this comment (if any)
    const att = attachmentsByComment.get(String(c.id)) || [];
    if(att.length){
      lines.push(`（该评论包含附件：${att.map(a=>a.original_name||a.path||'附件').join('、')}）`);
    }
    lines.push('');
  });

  lines.push('【提醒】请确认以上内容已去标识化（姓名/电话/住院号/身份证等）。如发现疑似隐私，请先在网站内修改后再复制。');
  return lines.join('\n');
}

const AI_PROMPT_VERSION = 'stage1_free_v1';

function buildAiSummaryPrompt(){
  const prompt = [
    '你是医学学术讨论整理助手。请仅基于我提供的病例正文与评论内容进行归纳总结，不要编造未出现的信息。',
    '不要输出任何个体化处方或医疗建议，用"讨论中提到/观点认为/可能性"表述。',
    '',
    '请输出 Markdown，严格按以下结构：',
    '1) 一句话摘要（≤60字）',
    '2) 关键信息速览（要点列表）',
    '3) 时间线（如文本里有日期/时间则整理，没有就跳过）',
    '4) 讨论焦点与分歧（列出不同观点及依据）',
    '5) 阶段性共识/下一步建议（仅"讨论建议"，不得给个体化治疗处方）',
    '6) 信息缺口清单（缺哪些检查/病理描述/随访信息）',
    '7) 引用来源：用"病例正文/评论#编号（作者，时间）"标注',
    '',
    '重要：请提醒避免任何可识别个人信息（姓名/电话/住院号等）。若发现疑似信息请标注"疑似隐私信息：xxx（建议删除）"。',
    '',
    '---',
    buildAiContextText({ includeAttachments: true, maxComments: 30 }),
  ].join('\n');
  return prompt;
}

function buildAiStructuredPrompt(){
  const prompt = [
    '你是医学病例结构化抽取助手。请仅抽取我给出的文本中明确出现的信息，不要推断、不要补全缺失字段。',
    '输出严格为 JSON（不要带任何额外解释文字）。',
    '',
    'JSON 字段如下（没有就留空/null 或不输出该字段）：',
    '- demographics: {sex, age}',
    '- presentation: {chief_complaint, course_summary}',
    '- key_labs: {scr, egfr, proteinuria, albumin, pla2r, complements, other}',
    '- pathology: {key_findings}',
    '- treatments: [{date_or_phase, meds, dose, response}]',
    '- followup: {outcomes}',
    '- discussion_points: [..]',
    '- open_questions: [..]',
    '- privacy_flags: [..]  （若检测到可能隐私信息，列出并提示删改）',
    '',
    '重要：不得输出具体处方建议；只做信息抽取与整理。',
    '',
    '---',
    buildAiContextText({ includeAttachments: true, maxComments: 30 }),
  ].join('\n');
  return prompt;
}

function mountAiToolsUI(){
  if(!aiToolsBlock) return;

  if(!aiArtifactsSupported){
    aiToolsBlock.hidden = true;
    aiToolsBlock.innerHTML = '';
    return;
  }

  // Everyone who can view the case can use the copy-to-AI prompts.
  // Saving back to the site is restricted by RLS (author / doctor_verified / admin).
  const canSave = canEditAi();

  aiToolsBlock.hidden = false;
  aiToolsBlock.innerHTML = `
    <details class="note" ${isMobileViewport() ? '' : 'open'}>
      <summary style="cursor:pointer"><b>AI 整理工具（免费）</b> <span class="small muted">（网站不调用AI；复制到任意免费AI生成后粘贴回填）</span></summary>
      <div style="margin-top:10px">
        <div class="small muted" style="margin-bottom:8px">
          建议先确认已去标识化。若文本包含手机号/身份证/住院号等，请先在帖子中删除或打码。
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
          <button class="btn tiny" type="button" id="aiCopySummaryBtn">复制AI总结提示词+内容</button>
          <button class="btn tiny" type="button" id="aiCopyStructBtn">复制结构化提示词+内容</button>
        </div>

        ${canSave ? `
          <div class="hr" style="margin:12px 0"></div>

          <label class="small muted">粘贴 AI 总结（Markdown / 纯文本均可）</label>
          <textarea class="input" id="aiSummaryInput" rows="10" placeholder="将免费AI生成的总结粘贴到这里…"></textarea>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;align-items:center">
            <button class="btn primary" type="button" id="aiSaveSummaryBtn">保存为讨论摘要</button>
            <span class="small muted" id="aiSaveSummaryHint"></span>
          </div>

          <div class="hr" style="margin:14px 0"></div>

          <label class="small muted">粘贴 AI 结构化结果（JSON）</label>
          <textarea class="input" id="aiStructInput" rows="10" placeholder='请粘贴 JSON（例如：{"demographics":{...}}）'></textarea>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;align-items:center">
            <button class="btn primary" type="button" id="aiSaveStructBtn">保存结构化要点</button>
            <span class="small muted" id="aiSaveStructHint"></span>
          </div>
        ` : `
          <div class="small muted" style="margin-top:10px">
            你当前仅可复制提示词用于个人整理；如需在网站内保存摘要/结构化，请联系管理员开通权限（作者 / 认证医生 / 管理员）。
          </div>
        `}
      </div>
    </details>
  `;

  const copySummaryBtn = document.getElementById('aiCopySummaryBtn');
  const copyStructBtn = document.getElementById('aiCopyStructBtn');
  const summaryInput = document.getElementById('aiSummaryInput');
  const structInput = document.getElementById('aiStructInput');
  const saveSummaryBtn = document.getElementById('aiSaveSummaryBtn');
  const saveStructBtn = document.getElementById('aiSaveStructBtn');
  const summaryHint = document.getElementById('aiSaveSummaryHint');
  const structHint = document.getElementById('aiSaveStructHint');

  copySummaryBtn?.addEventListener('click', async ()=>{
    const text = buildAiSummaryPrompt();
    const flags = detectPrivacyFlags(text);
    if(flags.length){
      const ok = confirm(`检测到可能隐私信息：${flags.join('、')}\n\n建议先在网站内删除/打码后再复制。\n\n仍要复制吗？`);
      if(!ok) return;
    }
    const ok = await copyText(text);
    if(ok){
      toast('已复制', '已复制到剪贴板。可粘贴到任意免费AI生成总结。', 'ok');
    }else{
      toast('复制失败', '浏览器可能阻止了剪贴板权限。请手动选中复制。', 'err');
    }
  });

  copyStructBtn?.addEventListener('click', async ()=>{
    const text = buildAiStructuredPrompt();
    const flags = detectPrivacyFlags(text);
    if(flags.length){
      const ok = confirm(`检测到可能隐私信息：${flags.join('、')}\n\n建议先在网站内删除/打码后再复制。\n\n仍要复制吗？`);
      if(!ok) return;
    }
    const ok = await copyText(text);
    if(ok){
      toast('已复制', '已复制到剪贴板。可粘贴到任意免费AI生成结构化JSON。', 'ok');
    }else{
      toast('复制失败', '浏览器可能阻止了剪贴板权限。请手动选中复制。', 'err');
    }
  });

  saveSummaryBtn?.addEventListener('click', async ()=>{
    if(!currentUser || !currentCase) return;
    const md = String(summaryInput?.value || '').trim();
    if(!md){ toast('内容为空', '请先粘贴 AI 总结内容。', 'err'); return; }

    const flags = detectPrivacyFlags(md);
    if(flags.length){
      const ok = confirm(`总结内容中检测到：${flags.join('、')}\n\n建议先删除/打码后再保存。\n\n仍要保存吗？`);
      if(!ok) return;
    }

    saveSummaryBtn.disabled = true;
    if(summaryHint) summaryHint.textContent = '保存中…';
    try{
      aiSourceHashNow = computeAiSourceHash();
      const creatorName = currentProfile?.full_name || currentUser.email || 'Member';
      const row = {
        case_id: Number(currentCase.id),
        kind: 'summary_md',
        content_md: md,
        content_json: null,
        source_hash: aiSourceHashNow,
        prompt_version: AI_PROMPT_VERSION,
        model: 'manual_free_ai',
        created_by: currentUser.id,
        creator_name: creatorName,
      };

      // Prefer upsert by unique key (case_id, kind)
      const res = await supabase
        .from('case_ai_artifacts')
        .upsert(row, { onConflict: 'case_id,kind' });
      if(res?.error) throw res.error;

      toast('已保存', '讨论摘要已更新。', 'ok');
      await loadAiArtifacts();
      renderAiSummary();
    }catch(e){
      const msg = String(e?.message || e || '');
      if(/case_ai_artifacts/i.test(msg) && /(does not exist|relation|schema cache|could not find|not find)/i.test(msg)){
        toast('AI摘要未初始化', '请在 Supabase SQL Editor 运行 MIGRATION_20260118_CASE_AI_ARTIFACTS.sql，然后 Settings → API 点击 "Reload schema"。', 'err');
      }else{
        toast('保存失败', msg, 'err');
      }
    }finally{
      saveSummaryBtn.disabled = false;
      if(summaryHint) summaryHint.textContent = '';
    }
  });

  saveStructBtn?.addEventListener('click', async ()=>{
    if(!currentUser || !currentCase) return;
    const raw = String(structInput?.value || '').trim();
    if(!raw){ toast('内容为空', '请先粘贴 AI 输出的 JSON。', 'err'); return; }
    let obj = null;
    try{ obj = JSON.parse(raw); }catch(_e){
      toast('JSON 格式错误', '请确保粘贴的是严格 JSON（不带多余解释文字）。', 'err');
      return;
    }

    saveStructBtn.disabled = true;
    if(structHint) structHint.textContent = '保存中…';
    try{
      aiSourceHashNow = computeAiSourceHash();
      const creatorName = currentProfile?.full_name || currentUser.email || 'Member';
      const row = {
        case_id: Number(currentCase.id),
        kind: 'structured_json',
        content_md: null,
        content_json: obj,
        source_hash: aiSourceHashNow,
        prompt_version: AI_PROMPT_VERSION,
        model: 'manual_free_ai',
        created_by: currentUser.id,
        creator_name: creatorName,
      };
      const res = await supabase
        .from('case_ai_artifacts')
        .upsert(row, { onConflict: 'case_id,kind' });
      if(res?.error) throw res.error;
      toast('已保存', '结构化要点已更新。', 'ok');
      await loadAiArtifacts();
      renderAiStructured();
    }catch(e){
      const msg = String(e?.message || e || '');
      if(/case_ai_artifacts/i.test(msg) && /(does not exist|relation|schema cache|could not find|not find)/i.test(msg)){
        toast('AI结构化未初始化', '请在 Supabase SQL Editor 运行 MIGRATION_20260118_CASE_AI_ARTIFACTS.sql，然后 Settings → API 点击 "Reload schema"。', 'err');
      }else{
        toast('保存失败', msg, 'err');
      }
    }finally{
      saveStructBtn.disabled = false;
      if(structHint) structHint.textContent = '';
    }
  });
}

async function loadAiArtifacts(){
  if(!currentCase) return;
  aiArtifactsSupported = true;
  try{
    const { data, error } = await supabase
      .from('case_ai_artifacts')
      .select('id, case_id, kind, content_md, content_json, source_hash, created_by, creator_name, created_at, updated_at')
      .eq('case_id', Number(currentCase.id));
    if(error) throw error;

    const rows = Array.isArray(data) ? data : [];
    aiSummaryRow = rows.find(r => String(r.kind) === 'summary_md') || null;
    aiStructuredRow = rows.find(r => String(r.kind) === 'structured_json') || null;
  }catch(e){
    // Table not initialized: hide silently (but keep clear errors on save)
    aiArtifactsSupported = false;
    aiSummaryRow = null;
    aiStructuredRow = null;
  }
}

// ------------------------------
// UI: Attachments picker bindings
// ------------------------------
renderAttachDraft();
if(attachClearBtn) attachClearBtn.disabled = true;

attachPickBtn?.addEventListener('click', ()=>{
  attachInput?.click();
});
attachClearBtn?.addEventListener('click', ()=>{
  clearAttachDraft();
});
attachInput?.addEventListener('change', (e)=>{
  addAttachFiles(e.target.files);
});
attachPreview?.addEventListener('click', (e)=>{
  const btn = e.target?.closest?.('[data-attach-remove]');
  if(!btn) return;
  const id = String(btn.getAttribute('data-attach-remove') || '');
  if(!id) return;
  attachPicks = attachPicks.filter(x => x.id !== id);
  renderAttachDraft();
});

// Drag & drop / paste attachments directly into the composer
(function bindComposerPasteAndDrop(){
  if(!commentDropEl) return;
  const targets = [commentDropEl, attachPreview, form].filter(Boolean);
  const setHover = (on) => {
    try{ (commentHoverEl || commentDropEl).classList.toggle('drop-hover', !!on); }catch(_e){}
  };

  targets.forEach(t=>{
    t.addEventListener('dragover', (e)=>{
      const types = Array.from(e.dataTransfer?.types || []);
      if(types.includes('Files')){
        e.preventDefault();
        setHover(true);
      }
    });
    t.addEventListener('dragleave', ()=> setHover(false));
    t.addEventListener('drop', (e)=>{
      const files = e.dataTransfer?.files;
      if(files && files.length){
        e.preventDefault();
        setHover(false);
        addAttachFiles(files);
        toast('已添加附件', `已添加 ${files.length} 个文件`, 'ok');
      }
    });
  });

  commentDropEl.addEventListener('paste', (e)=>{
    const dt = e.clipboardData;
    if(!dt) return;
    const files = [];
    for(const item of Array.from(dt.items || [])){
      if(item.kind === 'file'){
        const f = item.getAsFile();
        if(f) files.push(f);
      }
    }
    if(!files.length) return;
    const hasText = Boolean(dt.getData('text/plain'));
    if(!hasText) e.preventDefault();
    addAttachFiles(files);
    toast('已添加附件', '已从剪贴板添加', 'ok');
  });
})();

// ------------------------------
// UI: Thread modal
// ------------------------------
function closeCommentModal(){
  openCommentId = null;
  if(modalEl) modalEl.hidden = true;
  if(modalBody) modalBody.innerHTML = '';
  if(modalAttaches) modalAttaches.innerHTML = '';
  if(modalLikeBtn){
    modalLikeBtn.dataset.commentId = '';
    modalLikeBtn.dataset.liked = '0';
    modalLikeBtn.dataset.count = '0';
    modalLikeBtn.classList.remove('primary');
    modalLikeBtn.textContent = '👍 点赞 · 0';
  }
}

function openCommentModal(commentId){
  const id = Number(commentId);
  const c = commentRows.find(r => Number(r.id) === id);
  if(!c) return;
  openCommentId = id;
  const when = c.created_at ? formatBeijingDateTime(c.created_at) : '';

  if(modalAuthor) modalAuthor.textContent = c.author_name || 'Member';
  if(modalWhen) modalWhen.textContent = when;
  if(modalBody){
    const bHtml = String(c.body_html || '').trim();
    modalBody.innerHTML = bHtml
      ? renderSafeHtml(bHtml, { mode:'comment', linkify:true, mentionify:true })
      : renderRichText(String(c.body || ''));
  }

  // Like status in modal
  if(modalLikeBtn){
    if(!commentLikeSupported){
      modalLikeBtn.hidden = true;
    }else{
      modalLikeBtn.hidden = false;
      const cnt = Number(c.like_count || 0);
      const isLiked = likedCommentIds && typeof likedCommentIds.has === 'function' ? likedCommentIds.has(String(c.id)) : false;
      modalLikeBtn.dataset.commentId = String(c.id);
      modalLikeBtn.dataset.liked = isLiked ? '1' : '0';
      modalLikeBtn.dataset.count = String(cnt);
      modalLikeBtn.classList.toggle('primary', isLiked);
      modalLikeBtn.textContent = (isLiked ? '💙 已赞' : '👍 点赞') + ' · ' + cnt;
    }
  }

  const attaches = attachmentsByComment.get(String(id)) || [];
  if(modalAttaches){
    modalAttaches.innerHTML = attaches.length ? (`<div class="small muted" style="margin-bottom:8px">附件</div>` + renderAttachmentsBlock(attaches)) : '';
  }

  const uid = currentUser?.id || '';
  const canDel = Boolean(
    uid
    && (
      isAdminUi
      || isModeratorUser
      || isBoardModeratorUser
      || (currentCase && String(currentCase.author_id) === String(uid))
      || String(uid) === String(c.author_id)
    )
  );
  if(modalDeleteBtn){
    modalDeleteBtn.hidden = !canDel;
  }
  if(modalEl) modalEl.hidden = false;
}

modalCloseBtn?.addEventListener('click', closeCommentModal);
modalEl?.addEventListener('click', (e)=>{
  if(e.target === modalEl) closeCommentModal();
});
document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape' && modalEl && !modalEl.hidden) closeCommentModal();
});

// Delegation for comment list (like / reply / delete)
listEl?.addEventListener('click', async (e)=>{
  const lk = e.target?.closest?.('[data-like-comment]');
  if(lk){
    e.preventDefault();
    e.stopPropagation();
    const id = Number(lk.getAttribute('data-like-comment') || 0);
    if(!id) return;
    await toggleCaseCommentLike(id);
    return;
  }

  const rep = e.target?.closest?.('[data-reply-comment]');
  if(rep){
    e.preventDefault();
    e.stopPropagation();
    const id = Number(rep.getAttribute('data-reply-comment') || 0);
    if(!id) return;
    replyToComment(id);
    return;
  }

  const del = e.target?.closest?.('[data-del-comment]');
  if(del){
    e.preventDefault();
    e.stopPropagation();
    const id = Number(del.getAttribute('data-del-comment') || 0);
    if(!id) return;
    if(!confirm('确定删除这条评论吗？')) return;
    try{
      await deleteCommentSafe(id);
      toast('已删除', '评论已删除。', 'ok');
      closeCommentModal();
      await loadComments();
    }catch(err){
      toast('删除失败', _humanizeRlsError(err), 'err');
    }
    return;
  }
});

// Modal delete button
modalLikeBtn?.addEventListener('click', async ()=>{
  if(!commentLikeSupported) return;
  const id = Number(modalLikeBtn.dataset.commentId || openCommentId || 0);
  if(!id) return;
  await toggleCaseCommentLike(id);
});

// Modal delete button
modalDeleteBtn?.addEventListener('click', async ()=>{
  if(!openCommentId) return;
  if(!confirm('确定删除这条评论吗？')) return;
  try{
    await deleteCommentSafe(openCommentId);
    toast('已删除', '评论已删除。', 'ok');
    closeCommentModal();
    await loadComments();
  }catch(err){
    toast('删除失败', _humanizeRlsError(err), 'err');
  }
});

// ------------------------------
// Delete helpers (RPC preferred, fallback to soft-delete update)
// ------------------------------
function _isMissingRpc(err, fnName){
  const msg = String((err && (err.message || err.error_description)) ? (err.message || err.error_description) : (err || ''));
  return msg.includes('PGRST202') || msg.includes('Could not find the function') || (msg.includes('function') && msg.includes(fnName));
}

function _humanizeRlsError(err){
  const msg = String((err && (err.message || err.error_description)) ? (err.message || err.error_description) : (err || ''));
  const showDev = Boolean(typeof window !== 'undefined' && window.__SHOW_DEV_HINTS__);
  if(/row-level security|rls|permission denied|403|PGRST/i.test(msg)){
    if(showDev){
      return msg + '\n\n提示：这通常是 Supabase 的 RLS 权限/策略未配置好导致。请在 Supabase → SQL Editor 重新运行最新版 SUPABASE_SETUP.sql，然后到 Settings → API 执行 Reload schema 再重试。';
    }
    return '操作失败，权限不足或系统维护中，请稍后重试。';
  }
  if(showDev) return msg;
  // Strip potential database internals for non-admin users
  if(/PGRST|pg_|relation "|column "|duplicate key|violates|Could not find/i.test(msg)){
    return '操作失败，请稍后重试。';
  }
  return msg;
}

async function deleteCaseSafe(caseId){
  const nowIso = new Date().toISOString();

  // 1) Prefer RPC (bypasses tricky RLS edge cases)
  try{
    const { error } = await supabase.rpc('delete_case', { _case_id: caseId });
    if(!error) return;
    if(!_isMissingRpc(error, 'delete_case')) throw error;
  }catch(e){
    if(!_isMissingRpc(e, 'delete_case')) throw e;
  }

  // 2) Fallback: soft delete via update (requires correct RLS)
  const { error: uerr } = await supabase
    .from('cases')
    .update({ deleted_at: nowIso })
    .eq('id', caseId);

  if(uerr) throw uerr;
}

async function deleteCommentSafe(commentId){
  const nowIso = new Date().toISOString();

  // 1) Prefer RPC
  try{
    const { error } = await supabase.rpc('delete_case_comment', { _comment_id: commentId });
    if(!error) return;
    if(!_isMissingRpc(error, 'delete_case_comment')) throw error;
  }catch(e){
    if(!_isMissingRpc(e, 'delete_case_comment')) throw e;
  }

  // 2) Fallback: soft delete via update
  const { error: uerr } = await supabase
    .from('case_comments')
    .update({ deleted_at: nowIso })
    .eq('id', commentId);

  if(uerr) throw uerr;
}

function updateCaseCommentLikeUI(commentId){
  const id = String(commentId);
  const row = commentRows.find(r => String(r.id) === id);
  const cnt = Number(row?.like_count || 0);
  const isLiked = likedCommentIds && typeof likedCommentIds.has === 'function' ? likedCommentIds.has(id) : false;

  // Update list buttons
  document.querySelectorAll(`[data-like-comment="${id}"]`).forEach(btn=>{
    btn.dataset.liked = isLiked ? '1' : '0';
    btn.dataset.count = String(cnt);
    btn.classList.toggle('primary', isLiked);
    btn.textContent = (isLiked ? '💙 已赞' : '👍 点赞') + ' · ' + cnt;
  });

  // Update mobile collapsed hint (summary)
  document.querySelectorAll(`[data-like-hint="${id}"]`).forEach(el=>{
    const attaches = attachmentsByComment.get(id) || [];
    el.textContent = `👍 ${cnt}${attaches.length ? ` · 📎 ${attaches.length}` : ''}`;
  });

  // Update modal button
  if(modalLikeBtn && String(modalLikeBtn.dataset.commentId || '') === id){
    modalLikeBtn.dataset.liked = isLiked ? '1' : '0';
    modalLikeBtn.dataset.count = String(cnt);
    modalLikeBtn.classList.toggle('primary', isLiked);
    modalLikeBtn.textContent = (isLiked ? '💙 已赞' : '👍 点赞') + ' · ' + cnt;
  }
}

async function toggleCaseCommentLike(commentId){
  if(!commentLikeSupported){
    toast('暂未开启', '该环境未开启评论点赞功能（请运行最新迁移 SQL）。', 'err');
    return;
  }
  if(!isConfigured() || !supabase){
    toast('未配置', 'Supabase 未配置。', 'err');
    return;
  }
  if(!currentUser){
    toast('请先登录', '登录后才能点赞。', 'err');
    return;
  }

  const id = String(commentId);
  const row = commentRows.find(r => String(r.id) === id);
  const curCount = Number(row?.like_count || 0);
  const isLiked = likedCommentIds && typeof likedCommentIds.has === 'function' ? likedCommentIds.has(id) : false;

  try{
    if(!isLiked){
      const { error } = await supabase
        .from('case_comment_likes')
        .insert({ comment_id: Number(commentId), user_id: currentUser.id });
      if(error) throw error;
      likedCommentIds.add(id);
      if(row) row.like_count = curCount + 1;
    }else{
      const { error } = await supabase
        .from('case_comment_likes')
        .delete()
        .eq('comment_id', Number(commentId))
        .eq('user_id', currentUser.id);
      if(error) throw error;
      likedCommentIds.delete(id);
      if(row) row.like_count = Math.max(0, curCount - 1);
    }

    updateCaseCommentLikeUI(commentId);
  }catch(e){
    const msg = String(e?.message || e || '');
    if(/relation .*case_comment_likes.* does not exist/i.test(msg)){
      commentLikeSupported = false;
      toast('未开启点赞表', '请先在 Supabase SQL Editor 执行最新版迁移（创建 case_comment_likes）。', 'err');
      await loadComments();
      return;
    }
    toast('操作失败', _humanizeRlsError(e), 'err');
  }
}

async function loadCase(){
  if(!caseId || Number.isNaN(caseId)){
    setError('缺少病例 id。请从社区板块列表进入。');
    return;
  }

  if(isConfigured()){
    const ok = await ensureAuthed('login.html');
    if(!ok) return;
  }

  setLoading();

  try{
    if(!isConfigured() || !supabase){
      setError('Supabase 未配置。请先在 assets/config.js 填写配置。');
      return;
    }

    currentUser = await getCurrentUser();
    currentProfile = currentUser ? await getUserProfile(currentUser) : null;
    const role = normalizeRole(currentProfile?.role || currentUser?.user_metadata?.role || 'member');
    isAdminUser = isAdminRole(role);
    isModeratorUser = (String(role || '').toLowerCase() === 'moderator');
    // Admin users can optionally browse in "member view" (hide admin UI)
    const viewMode = (localStorage.getItem('ks_view_mode') || 'member');
    isAdminUi = Boolean(isAdminUser && viewMode === 'admin');

    // Doctor verification gate (Channel A: invite code)
    // - Applies to: replying in case discussion + uploading attachments
    // - Backend RLS is the final enforcement
    // NOTE: board moderators should also be allowed; we finalize this after
    // we load board_moderators for the current case board.
    const baseCanPost = Boolean(
      isAdminRole(role)
      || String(role || '').toLowerCase() === 'owner'
      || String(role || '').toLowerCase() === 'moderator'
      || String(role || '').toLowerCase() === 'doctor_verified'
      || String(role || '').toLowerCase() === 'doctor'
    );
    canPostCaseComments = baseCanPost;

    const { data: c, error } = await supabase
      .from('cases')
      .select('*')
      .eq('id', caseId)
      .maybeSingle();

    if(error) throw error;
    if(!c) { setError('未找到该病例，或你没有权限查看。'); return; }
    if(c.deleted_at){ setError('该病例已被作者删除。'); return; }

    currentCase = c;

    // Load moderators for this board (for "版主" badges)
    await loadBoardModerators(c.board);

    // Board moderator permissions (post/reply/delete)
    isBoardModeratorUser = Boolean(
      currentUser && moderatorIds && typeof moderatorIds.has === 'function' && moderatorIds.has(String(currentUser.id))
    );
    canPostCaseComments = Boolean(baseCanPost || isBoardModeratorUser);
    applyDoctorGateUI();

    // Badge label depends on board type (病例 / 文献 / 科研)
    const badgeEl = document.getElementById('caseBadge');
    if(badgeEl){
      const b = String(c.board || '').toLowerCase();
      if(b === 'research') badgeEl.textContent = 'Research · 科研讨论';
      else if(b === 'literature') badgeEl.textContent = 'Journal Club · 文献学习';
      else badgeEl.textContent = 'Case · 病例';
    }

    titleEl.textContent = c.title || '（无标题）';
    const __authorName = esc(c.author_name || 'Member');
    const __modBadge = (moderatorIds && moderatorIds.has(c.author_id)) ? ' <span class="badge mod mini">版主</span>' : '';
    metaEl.innerHTML = `作者：<b>${__authorName}</b>${__modBadge} · ${formatBeijingDateTime(c.created_at)}`;

    // Like count (quality signal)
    if(likeCountEl){
      const lc = Number(c.like_count || 0);
      likeCountEl.textContent = String(Number.isFinite(lc) ? lc : 0);
    }

    tagsEl.innerHTML = (c.tags || []).map(tagChip).join(' ');

    const content = (c.content || '').trim();
    if(content){
      bodyEl.innerHTML = `<div style="white-space:pre-wrap;line-height:1.75">${esc(content)}</div>`;
    }else{
      const sumHtml = String(c.summary_html || '').trim();
      const sumRendered = sumHtml ? renderSafeHtml(sumHtml, { mode:'comment', linkify:true, mentionify:true }) : '';
      bodyEl.innerHTML = `
        <div class="note">
          <b>摘要：</b>
          <div class="ks-prose" style="margin-top:8px">
            ${sumRendered || `<div style="white-space:pre-wrap;line-height:1.75">${esc(c.summary || '') || '（无摘要）'}</div>`}
          </div>
          <div class="small muted" style="margin-top:8px">
            目前正文结构还在迭代中。已支持附件上传；后续将补充结构化模板。
          </div>
        </div>
      `;
    }

    await loadCaseAttachments();

    const canDelete = Boolean(
      (currentUser && (String(currentUser.id) === String(c.author_id)))
      || isAdminUi
      || isModeratorUser
      || isBoardModeratorUser
    );
    delBtn.hidden = !canDelete;
    if (canDelete) {
  // 用 onclick 覆盖，避免重复绑定
  delBtn.onclick = async () => {
if (!confirm('确定删除该病例吗？删除后普通用户不可见。')) return;

// ★ 删除前再次确保是 authenticated（稳）
if (isConfigured()) {
  const ok = await ensureAuthed('login.html');
  if (!ok) return;
}

// 防止连点
delBtn.disabled = true;

try {
  // 优先使用 RPC（更稳，避免 RLS 边界问题）；若未部署 RPC，则回退到软删除 update
  await deleteCaseSafe(currentCase.id);

  toast('已删除', '病例已删除。', 'ok');
  setTimeout(() => location.href = 'community.html', 600);
} catch (e) {
  toast('删除失败', _humanizeRlsError(e), 'err');
  delBtn.disabled = false;
}
  };
}

    await loadComments();

    // AI (暂停)：当前版本不在站内展示 AI 摘要/结构化工具
    if(ENABLE_AI_FEATURES){
      aiSourceHashNow = computeAiSourceHash();
      await loadAiArtifacts();
      renderAiSummary();
      renderAiStructured();
      mountAiToolsUI();
    }else{
      if(aiSummaryBlock){ aiSummaryBlock.innerHTML = ''; aiSummaryBlock.hidden = true; }
      if(aiStructuredBlock){ aiStructuredBlock.innerHTML = ''; aiStructuredBlock.hidden = true; }
      if(aiToolsBlock){ aiToolsBlock.innerHTML = ''; aiToolsBlock.hidden = true; }
    }

    await loadLikeState();
  await loadFavState();
  }catch(e){
    setError(e.message || String(e));
  }
}

function updateLikeBtn(){
  if(!likeBtn || !likeCountEl) return;
  const prefix = liked ? '💙 已赞 ' : '👍 赞 ';
  if(likeBtn.firstChild && likeBtn.firstChild.nodeType === Node.TEXT_NODE){
    likeBtn.firstChild.textContent = prefix;
  }else{
    // fallback
    likeBtn.insertBefore(document.createTextNode(prefix), likeBtn.firstChild);
  }
  likeBtn.classList.toggle('primary', liked);
}



  function updateFavBtn(){
    if(!favBtn) return;
    const label = faved ? '⭐ 已收藏' : '⭐ 收藏';
    favBtn.textContent = label;
    favBtn.classList.toggle('primary', faved);
  }

  async function loadFavState(){
    if(!favBtn) return;
    updateFavBtn();
    if(!currentUser || !currentCase) return;
    try{
      const { data, error } = await supabase
        .from('case_favorites')
        .select('case_id')
        .eq('case_id', currentCase.id)
        .eq('user_id', currentUser.id)
        .maybeSingle();
      if(error){
        favSupported = false;
        return;
      }
      faved = !!data;
      updateFavBtn();
    }catch(_e){
      favSupported = false;
    }
  }

  async function loadLikeState(){
  if(!likeBtn || !likeCountEl) return;
  if(!isConfigured() || !supabase) return;
  if(!currentUser || !currentCase) return;

  try{
    const { data, error } = await supabase
      .from('case_likes')
      .select('case_id')
      .eq('case_id', currentCase.id)
      .eq('user_id', currentUser.id)
      .maybeSingle();

    if(error){
      // Table may not exist yet; gracefully hide the feature.
      likeSupported = false;
      likeBtn.hidden = true;
      return;
    }
    liked = !!data;
    updateLikeBtn();
  }catch(_e){
    likeSupported = false;
    likeBtn.hidden = true;
  }
}

async function loadComments(){
  if(!currentCase) return;
  try{
    const isMissingColumn = (err, col)=>{
      const msg = String(err?.message || err || '').toLowerCase();
      const c = String(col || '').toLowerCase();
      return msg.includes(c) && (msg.includes('does not exist') || msg.includes('column') || msg.includes('schema cache'));
    };

    const selWithHtml = 'id, created_at, case_id, author_id, author_name, body, body_html, like_count, deleted_at';
    const selLegacy = 'id, created_at, case_id, author_id, author_name, body, like_count, deleted_at';

    let data = null;
    let error = null;
    {
      const res = await supabase
        .from('case_comments')
        .select(selWithHtml)
        .eq('case_id', currentCase.id)
        .order('created_at', { ascending: true });
      data = res.data;
      error = res.error;
      if(error && isMissingColumn(error, 'body_html')){
        const res2 = await supabase
          .from('case_comments')
          .select(selLegacy)
          .eq('case_id', currentCase.id)
          .order('created_at', { ascending: true });
        data = res2.data;
        error = res2.error;
      }
    }

    if(error) throw error;

    const rows = (data || []).filter(x => !x.deleted_at);
    commentRows = rows;

    // Load attachments (optional: table may not exist yet)
    attachmentsByComment = new Map();
    const ids = rows.map(r => Number(r.id)).filter(Boolean);
    if(ids.length){
      try{
        const { data: at, error: atErr } = await supabase
          .from('attachments')
          .select('id, created_at, target_id, author_id, author_name, bucket, path, public_url, mime_type, original_name, size_bytes, kind, deleted_at')
          .eq('target_type', 'case_comment')
          .in('target_id', ids)
          .is('deleted_at', null)
          .order('created_at', { ascending: true });
        if(!atErr && Array.isArray(at)){
          await hydrateSignedUrlsForAttachments(at);
          at.forEach(a=>{
            const k = String(a.target_id);
            if(!attachmentsByComment.has(k)) attachmentsByComment.set(k, []);
            attachmentsByComment.get(k).push(a);
          });
        }
      }catch(_e){
        // ignore
      }
    }

    // Load which comments the current user has liked (optional)
    likedCommentIds = new Set();
    commentLikeSupported = true;
    if(currentUser && ids.length){
      try{
        const { data: likes, error: lErr } = await supabase
          .from('case_comment_likes')
          .select('comment_id')
          .eq('user_id', currentUser.id)
          .in('comment_id', ids);
        if(lErr) throw lErr;
        if(Array.isArray(likes)){
          likedCommentIds = new Set(likes.map(x => String(x.comment_id)));
        }
      }catch(_e){
        // Table may not exist yet; gracefully hide the feature.
        commentLikeSupported = false;
      }
    }

    _lastMobile = isMobileViewport();
    renderCommentList();

    // Refresh AI artifacts staleness after comments/attachments changed
    try{
      aiSourceHashNow = computeAiSourceHash();
      if(aiSummaryRow) renderAiSummary();
      if(aiStructuredRow) renderAiStructured();
    }catch(_e){}

  }catch(e){
    listEl.innerHTML = `<div class="muted small">读取评论失败：${esc(e.message || String(e))}</div>`;
  }
}

form.addEventListener('submit', async (e)=>{
  e.preventDefault();
  if(isConfigured()){
    const ok = await ensureAuthed('login.html');
    if(!ok) return;
  }
  if(!currentUser){ toast('请先登录', '登录后可回复。', 'err'); return; }
  if(!canPostCaseComments){ toast('需要医生认证', '回复病例讨论与上传附件需要先完成医生认证（邀请码快速认证或人工审核）。', 'err'); return; }
  const body = (bodyInput.value || '').trim();
  if(!body){ toast('请输入内容', '评论不能为空。', 'err'); return; }

  const body_html = (commentEditor && body) ? String(commentEditor.getHtml() || '').trim() : '';

  submitBtn.disabled = true;
  hintEl.textContent = '提交中…';

  try{
    const name = currentProfile?.full_name || currentUser.email || 'Member';

    // 1) Insert comment first (get id)

    const isMissingColumn = (err, col)=>{
      const msg = String(err?.message || err || '').toLowerCase();
      const c = String(col || '').toLowerCase();
      return msg.includes(c) && (msg.includes('does not exist') || msg.includes('column') || msg.includes('schema cache'));
    };

    const insertPayload = {
      case_id: currentCase.id,
      author_id: currentUser.id,
      author_name: name,
      body,
      body_html: body_html || null,
      deleted_at: null,
    };

    let ins = await supabase
      .from('case_comments')
      .insert(insertPayload)
      .select('id');

    if(ins?.error && isMissingColumn(ins.error, 'body_html')){
      const retry = { ...insertPayload };
      delete retry.body_html;
      ins = await supabase.from('case_comments').insert(retry).select('id');
    }

    if(ins?.error) throw ins.error;
    const commentId = Array.isArray(ins?.data) ? ins.data?.[0]?.id : ins?.data?.id;

    // 2) Upload attachments (optional)
    if(commentId && attachPicks.length){
      try{
        const total = attachPicks.length;
        for(let i=0;i<total;i++){
          const f = attachPicks[i]?.file;
          if(!f) continue;
          hintEl.textContent = `上传附件 ${i+1}/${total}…`;

          const kind = guessKindFromMime(f.type, f.name);
          const rid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
          const key = `${currentUser.id}/case_comment/${commentId}/${rid}_${safeFilename(f.name)}`;

          const up = await supabase
            .storage
            .from('attachments')
            .upload(key, f, { upsert:false, contentType: f.type || undefined, cacheControl: '3600' });
          if(up?.error) throw up.error;

          const url = null; // attachments bucket is private; resolve via signed URLs when rendering

          const ares = await supabase
            .from('attachments')
            .insert({
              target_type: 'case_comment',
              target_id: Number(commentId),
              author_id: currentUser.id,
              author_name: name,
              bucket: 'attachments',
              path: key,
              public_url: url,
              mime_type: f.type || null,
              original_name: f.name || null,
              size_bytes: f.size || null,
              kind,
              deleted_at: null,
            });
          if(ares?.error){
            // If attachments table is not deployed, show a clear hint
            const msg = String(ares.error.message || ares.error);
            if(/relation .*attachments.* does not exist|does not exist|PGRST/i.test(msg)){
              throw new Error('附件功能未初始化：请在 Supabase SQL Editor 运行最新版 SUPABASE_SETUP.sql（包含 attachments 表与 Storage bucket），然后到 Settings → API 点击 Reload schema。');
            }
            throw ares.error;
          }
        }
      }catch(attErr){
        toast('附件上传失败', attErr.message || String(attErr), 'err');
      }
    }

    if(commentEditor) commentEditor.setHtml('');
    bodyInput.value = '';
    clearAttachDraft();
    toast('发布成功', '回复已发布。', 'ok');
    await loadComments();
  }catch(err){
    toast('发布失败', err.message || String(err), 'err');
  }finally{
    submitBtn.disabled = false;
    hintEl.textContent = '';
  }
});

// Mentions in case comment composer
mentionAuthorBtn?.addEventListener('click', ()=>{
  if(!currentCase){
    toast('尚未加载完成', '病例还在加载中，请稍后再试。', 'err');
    return;
  }
  const name = currentCase.author_name || '作者';
  const id = currentCase.author_id || '';
  const mention = formatMention({ id, full_name: name }) + ' ';
  if(commentEditor) commentEditor.insertText(mention);
  else insertAtCursor(bodyInput, mention);
  commentEditor ? commentEditor.focus() : bodyInput?.focus?.();
});

mentionDoctorBtn?.addEventListener('click', async ()=>{
  if(isConfigured()){
    const ok = await ensureAuthed('login.html');
    if(!ok) return;
  }
  if(!currentUser){
    toast('请先登录', '登录后才能 @医生。', 'err');
    return;
  }
  const p = await pickDoctor({ title: '@医生', placeholder: '搜索医生姓名…' });
  if(!p) return;
  const mention = formatMention(p) + ' ';
  if(commentEditor) commentEditor.insertText(mention);
  else insertAtCursor(bodyInput, mention);
  commentEditor ? commentEditor.focus() : bodyInput?.focus?.();
});

if(likeBtn){
  likeBtn.addEventListener('click', async ()=>{
    if(!likeSupported){
      toast('功能未启用', '请先运行最新 Supabase SQL（创建 case_likes 表）。', 'err');
      return;
    }
    if(isConfigured()){
      const next = encodeURIComponent(location.pathname + location.search);
      const ok = await ensureAuthed(`login.html?next=${next}`);
      if(!ok) return;
    }
    if(!currentUser || !currentCase){ return; }

    const origLiked = liked;
    const origCount = Number(likeCountEl?.textContent || 0) || 0;

    // optimistic UI
    const nextLiked = !origLiked;
    const nextCount = Math.max(origCount + (nextLiked ? 1 : -1), 0);
    liked = nextLiked;
    if(likeCountEl) likeCountEl.textContent = String(nextCount);
    updateLikeBtn();

    likeBtn.disabled = true;
    try{
      if(nextLiked){
        const row = { case_id: currentCase.id, user_id: currentUser.id };
        let res = await supabase
          .from('case_likes')
          .upsert(row, { onConflict: 'case_id,user_id', ignoreDuplicates: true });
        if(res?.error){
          // Fallback for older client versions
          res = await supabase.from('case_likes').insert(row);
          if(res?.error){
            const msg = String(res.error.message || res.error);
            if(!(/duplicate key/i.test(msg) || String(res.error.code || '') === '23505')){
              throw res.error;
            }
          }
        }
      }else{
        const { error } = await supabase
          .from('case_likes')
          .delete()
          .eq('case_id', currentCase.id)
          .eq('user_id', currentUser.id);
        if(error) throw error;
      }

      // Sync like_count from DB (trigger-updated)
      try{
        const { data } = await supabase
          .from('cases')
          .select('like_count')
          .eq('id', currentCase.id)
          .maybeSingle();
        if(data && typeof data.like_count !== 'undefined'){
          const n = Math.max(0, Number(data.like_count || 0));
          if(likeCountEl) likeCountEl.textContent = String(n);
        }
      }catch(_e){}
    }catch(err){
      // rollback UI
      liked = origLiked;
      if(likeCountEl) likeCountEl.textContent = String(Math.max(origCount, 0));
      updateLikeBtn();

      const msg = err?.message || String(err);
      if(/case_likes/i.test(msg) && /does not exist|relation/i.test(msg)){
        toast('点赞功能未初始化', '请在 Supabase SQL Editor 运行最新版 SUPABASE_SETUP.sql，然后 Settings → API 点击 "Reload schema"。', 'err');
      }else{
        toast('操作失败', msg, 'err');
      }
    }finally{
      likeBtn.disabled = false;
    }
  });
}

// 收藏 / 取消收藏
if(favBtn){
  favBtn.addEventListener('click', async ()=>{
    if(!isConfigured()){
      toast('未配置', '请先在 config.js 填入 Supabase 信息。', 'err');
      return;
    }

    // Require login for favorites
    if(!currentUser){
      const q = new URLSearchParams(location.search);
      const caseId = q.get('id') || '';
      const next = `case.html?id=${caseId}`;
      const ok = await ensureAuthed(`login.html?next=${encodeURIComponent(next)}`);
      if(!ok) return;
    }
    if(!currentUser || !currentCase) return;

    const origFaved = faved;
    const nextFaved = !origFaved;

    // Optimistic UI
    faved = nextFaved;
    updateFavBtn();

    favBtn.disabled = true;
    try{
      if(nextFaved){
        const row = { case_id: currentCase.id, user_id: currentUser.id };
        const res = await supabase
          .from('case_favorites')
          .upsert(row, { onConflict: 'case_id,user_id', ignoreDuplicates: true });
        if(res?.error){
          // Fallback for older client versions
          const r2 = await supabase.from('case_favorites').insert(row);
          if(r2?.error){
            const msg = String(r2.error.message || r2.error);
            if(!(/duplicate key/i.test(msg) || String(r2.error.code || '') === '23505')){
              throw r2.error;
            }
          }
        }
      }else{
        const { error } = await supabase
          .from('case_favorites')
          .delete()
          .eq('case_id', currentCase.id)
          .eq('user_id', currentUser.id);
        if(error) throw error;
      }
    }catch(err){
      // Rollback UI
      faved = origFaved;
      updateFavBtn();

      const msg = String(err?.message || err || '');
      // Supabase/PostgREST 在刚建表但未 Reload schema 时，常见报错："schema cache" / "could not find"。
      if(/case_favorites/i.test(msg) && /(does not exist|relation|schema cache|could not find|not find)/i.test(msg)){
        toast('收藏功能未初始化', '请在 Supabase SQL Editor 运行 MIGRATION_20260110_FAVORITES.sql，然后 Settings → API 点击 "Reload schema"。', 'err');
      }else{
        toast('操作失败', msg, 'err');
      }
    }finally{
      favBtn.disabled = false;
    }
  });
}

loadCase();
