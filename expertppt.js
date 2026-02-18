import {
  getSupabase,
  isConfigured,
  getCurrentUser,
  getUserProfile,
  isAdminRole,
  toast,
  formatBeijingDateTime,
} from './supabaseClient.js?v=20260128_030';

// Expert PPT module:
// - Members: browse + search
// - Admins: create + upload PDF/images (paste/drag/drop) + delete

const MAX_FILES = 9;
const MAX_BYTES = 20 * 1024 * 1024; // 20MB

// Supabase Storage bucket for Expert PPT files
const BUCKET = 'expert_ppt';

// Admin UI view mode (frontend-only)
// Admin/super-admin accounts can browse as normal members.
// This preference only affects UI visibility and client-side actions.
const VIEW_MODE_KEY = 'ks_view_mode';
function readViewModePref(){
  try{
    const v = localStorage.getItem(VIEW_MODE_KEY);
    if(v === 'admin' || v === 'member') return v;
  }catch(_e){/* ignore */}
  return 'member';
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[c]));
}

function safeFilename(name) {
  // Supabase Storage validates object keys against URL-safe characters.
  // Non-ASCII (e.g. Chinese) may trigger "Invalid key" errors in supabase-js.
  // Use an ASCII-only filename for the storage key; preserve the original
  // display name in database fields.
  const raw = String(name || 'file').trim();

  // Split extension, keep it short and alphanumeric.
  const parts = raw.split('.');
  const extRaw = parts.length > 1 ? parts.pop() : '';
  const stemRaw = parts.join('.') || 'file';

  const stem = stemRaw
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100) || 'file';

  const ext = String(extRaw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 10);

  return ext ? `${stem}.${ext}` : stem;
}

function guessKind(mime) {
  if (!mime) return 'file';
  const t = String(mime).toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t === 'application/pdf') return 'pdf';
  if (
    t === 'application/vnd.ms-powerpoint' ||
    t === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    t.includes('powerpoint') ||
    t.includes('presentation')
  ) {
    return 'ppt';
  }
  return 'file';
}

function formatBytes(bytes) {
  const b = Number(bytes || 0);
  if (!b) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function extractDataImageUrlsFromHtml(html) {
  try {
    const out = [];
    const re = /src\s*=\s*"(?=data:image\/)(data:image\/[^"]+)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      out.push(m[1]);
      if (out.length >= 10) break;
    }
    return out;
  } catch {
    return [];
  }
}

function dataUrlToFile(dataUrl, filenameBase) {
  try {
    const parts = String(dataUrl || '').split(',');
    if (parts.length < 2) return null;
    const header = parts[0];
    const b64 = parts.slice(1).join(',');
    const mimeMatch = header.match(/data:([^;]+);base64/i);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const ext = (mime.split('/')[1] || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: mime });
    const name = safeFilename(`${filenameBase}.${ext}`);
    return new File([blob], name, { type: mime });
  } catch {
    return null;
  }
}

function dedupeFiles(files) {
  const out = [];
  const seen = new Set();
  for (const f of files || []) {
    if (!f) continue;
    const key = `${f.name}::${f.size}::${f.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

async function pickClipboardFiles(clipboardData) {
  const out = [];
  if (!clipboardData) return out;

  // 1) Some browsers expose files directly
  if (clipboardData.files && clipboardData.files.length) {
    out.push(...Array.from(clipboardData.files));
  }

  // 2) Standard clipboard items (images/files)
  const items = clipboardData.items ? Array.from(clipboardData.items) : [];
  for (const it of items) {
    if (it && it.kind === 'file' && it.getAsFile) {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }

  if (out.length) return dedupeFiles(out);

  // 3) Some apps provide clipboard image as dataURL in HTML
  const htmlItem = items.find(it => it && it.type === 'text/html' && it.getAsString);
  if (htmlItem) {
    const html = await new Promise(resolve => htmlItem.getAsString(resolve));
    const dataUrls = extractDataImageUrlsFromHtml(html);
    dataUrls.forEach((url, i) => {
      const f = dataUrlToFile(url, `clipboard_${Date.now()}_${i}`);
      if (f) out.push(f);
    });
  }

  if (out.length) return dedupeFiles(out);

  // 4) Or as dataURL in plain text
  const textItem = items.find(it => it && it.type === 'text/plain' && it.getAsString);
  if (textItem) {
    const txt = await new Promise(resolve => textItem.getAsString(resolve));
    const maybe = String(txt || '').trim();
    if (maybe.startsWith('data:image/')) {
      const f = dataUrlToFile(maybe, `clipboard_${Date.now()}`);
      if (f) out.push(f);
    }
  }

  // 5) Some browsers/apps (notably Office on macOS) don't expose the image as
  //    clipboardData.items/files, but *do* via navigator.clipboard.read().
  //    This API is permissioned; if denied we just fall back gracefully.
  if (!out.length && navigator.clipboard && navigator.clipboard.read) {
    try {
      const clipItems = await navigator.clipboard.read();
      for (const ci of clipItems || []) {
        const types = Array.isArray(ci.types) ? ci.types : [];
        for (const t of types) {
          // We primarily care about images; keep it conservative.
          if (!t || !String(t).startsWith('image/')) continue;
          const blob = await ci.getType(t);
          if (!blob) continue;
          const safeType = String(t);
          const ext = safeType.split('/')[1] ? safeType.split('/')[1].replace(/[^a-z0-9+.-]/gi, '_') : 'png';
          const file = new File([blob], `clipboard_${Date.now()}.${ext}`, { type: safeType });
          out.push(file);
        }
      }
    } catch (_e) {
      // ignore permission errors
    }
  }

	return dedupeFiles(out);
}

// Clipboard helpers:
// When copying text from PPT/Word, the clipboard can also include an image preview.
// If we blindly treat any clipboard file as an attachment, it will block normal
// text paste in input/textarea. We therefore allow default paste whenever the
// user is pasting into a text field AND the clipboard contains text.
function clipboardHasText(dt) {
  try {
    if (!dt || !dt.getData) return false;
    const t = String(dt.getData('text/plain') || '').trim();
    const h = String(dt.getData('text/html') || '').trim();
    return Boolean(t || h);
  } catch {
    return false;
  }
}

function isTextField(el) {
  if (!el) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = String(el.getAttribute('type') || 'text').toLowerCase();
    // Treat most inputs as text fields (so we don't hijack their paste).
    if (['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'range', 'color'].includes(type)) return false;
    return true;
  }
  if (el.isContentEditable) return true;
  return false;
}

async function pickDataTransferFiles(dt) {
  const out = [];
  if (!dt) return out;

  if (dt.files && dt.files.length) {
    out.push(...Array.from(dt.files));
    return dedupeFiles(out);
  }

  const items = dt.items ? Array.from(dt.items) : [];
  for (const it of items) {
    if (it && it.kind === 'file' && it.getAsFile) {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  if (out.length) return dedupeFiles(out);

  // Dragging images/links from browser tabs may provide a URL
  const uri = dt.getData && (dt.getData('text/uri-list') || dt.getData('text/plain'));
  const url = (uri || '').trim();
  if (/^https?:\/\//i.test(url)) {
    try {
      const resp = await fetch(url, { mode: 'cors' });
      if (!resp.ok) throw new Error('fetch failed');
      const blob = await resp.blob();
      const nameGuess = safeFilename(url.split('/').pop() || `link_${Date.now()}`);
      out.push(new File([blob], nameGuess, { type: blob.type || 'application/octet-stream' }));
      return dedupeFiles(out);
    } catch {
      // ignore
    }
  }

  return out;
}



function isSupportedFile(f) {
  if (!f) return false;
  const t = (f.type || '').toLowerCase();
  if (t === 'application/pdf') return true;
  if (t === 'application/vnd.ms-powerpoint') return true;
  if (t === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return true;
  if (t.startsWith('image/')) return true;
  // Some browsers may miss mime for drag files; fallback by ext.
  const n = (f.name || '').toLowerCase();
  if (n.endsWith('.pdf')) return true;
  if (n.endsWith('.ppt')) return true;
  if (n.endsWith('.pptx')) return true;
  return false;
}

function normalizeMime(f) {
  if (f.type) return f.type;
  const n = (f.name || '').toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.ppt')) return 'application/vnd.ms-powerpoint';
  if (n.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  return '';
}


function isPdfFile(mime, name) {
  const t = String(mime || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  return t === 'application/pdf' || n.endsWith('.pdf');
}

function isPptFile(mime, name) {
  const t = String(mime || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  return (
    t === 'application/vnd.ms-powerpoint' ||
    t === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    t.includes('powerpoint') ||
    t.includes('presentation') ||
    n.endsWith('.ppt') ||
    n.endsWith('.pptx')
  );
}

function officeEmbedUrl(publicUrl) {
  const u = String(publicUrl || '').trim();
  if (!u) return '';
  // Microsoft Office Online viewer (no API key). Requires a publicly accessible URL.
  return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(u)}`;
}


// Upload a file to the "expert_ppt" bucket and return its public URL.
// NOTE: the bucket must be PUBLIC (or you need to switch to signed URLs).
async function uploadToStorage(supabase, path, file) {
  if (!supabase || !supabase.storage) throw new Error('Supabase 未初始化（storage 不可用）');
  const mime = normalizeMime(file);
  const opts = {
    upsert: false,
    ...(mime ? { contentType: mime } : {}),
  };

  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, opts);
  if (upErr) throw upErr;

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error('无法生成公开链接（publicUrl）');
  return data.publicUrl;
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr || []) {
    const k = keyFn(x);
    const bucket = m.get(k) || [];
    bucket.push(x);
    m.set(k, bucket);
  }
  return m;
}

function renderAttachmentsBlock(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  const imgs = list.filter((a) => a && a.kind === 'image');
  const pdfs = list.filter((a) => a && a.kind === 'pdf');
  const ppts = list.filter((a) => a && a.kind === 'ppt');
  const files = list.filter((a) => a && !['image', 'pdf', 'ppt'].includes(a.kind));

  const parts = [];

  if (imgs.length) {
    parts.push(`
      <div class="thumb-grid">${imgs
        .map((a) => {
          const url = a.public_url;
          const label = a.original_name || '图片';
          return `
            <a class="thumb" href="${escapeHtml(url)}" target="_blank" rel="noopener">
              <img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy" />
            </a>`;
        })
        .join('')}
      </div>
    `);
  }

  if (pdfs.length) {
    parts.push(`
      <div class="pdf-grid">${pdfs
        .map((a) => {
          const url = a.public_url;
          const name = a.original_name || 'PDF';
          return `
            <a class="pdf-card" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="${escapeHtml(name)}">
              <iframe src="${escapeHtml(url)}#page=1&view=FitH" loading="lazy"></iframe>
              <div class="pdf-meta">
                <div class="pdf-name">${escapeHtml(name)}</div>
                <div class="pdf-sub small muted">${escapeHtml(formatBytes(a.size_bytes || 0))}</div>
              </div>
            </a>`;
        })
        .join('')}
      </div>
    `);
  }

  if (ppts.length) {
    parts.push(`
      <div class="attach-grid">${ppts
        .map((a) => {
          const url = a.public_url;
          const name = a.original_name || 'PPT';
          const sub = formatBytes(a.size_bytes || 0);
          return `
            <div class="attach-item" style="min-width: min(520px, 100%);">
              <div class="left">
                <div class="name">📊 ${escapeHtml(name)}</div>
                <div class="meta">${escapeHtml(sub || '')}</div>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="btn tiny" type="button" data-act="preview-ppt" data-url="${escapeHtml(url)}" data-name="${escapeHtml(name)}">预览</button>
                <a class="btn tiny ghost" href="${escapeHtml(url)}" target="_blank" rel="noopener">下载</a>
              </div>
            </div>`;
        })
        .join('')}
      </div>
    `);
  }

  if (files.length) {
    parts.push(`
      <div class="attach-grid">${files
        .map((a) => {
          const url = a.public_url;
          const name = a.original_name || '文件';
          const sub = formatBytes(a.size_bytes || 0);
          return `
            <a class="file-chip" href="${escapeHtml(url)}" target="_blank" rel="noopener">
              <span class="clip">📎</span>
              <span class="name">${escapeHtml(name)}</span>
              <span class="small muted">${escapeHtml(sub)}</span>
            </a>`;
        })
        .join('')}
      </div>
    `);
  }

  return parts.join('');
}

async function loadSections(supabase) {
  const filterSel = document.querySelector('#pptSection');
  const uploadSel = document.querySelector('#pptSectionInput');
  const initMsg = document.querySelector('#pptInitMsg');

  const fallback = [
    { key: 'glomerular', title_zh: '肾小球与间质性肾病' },
    { key: 'transplant', title_zh: '肾移植内科' },
    { key: 'critical', title_zh: '重症肾内（电解质/酸碱）与透析' },
    { key: 'pediatric', title_zh: '儿童肾脏病' },
    { key: 'rare', title_zh: '罕见肾脏病' },
    { key: 'pathology', title_zh: '肾脏病理' },
  ];

  const setOptions = (rows, note) => {
    const items = (rows || [])
      .filter((s) => s && s.key)
      .map((s) => ({
        key: s.key,
        title_zh: s.title_zh || s.title || s.key,
      }));

    // Build map for resolving names on cards
    const map = new Map();
    for (const it of items) map.set(it.key, it.title_zh);
    window.__pptSections = map;

    const optHtml = items
      .map((s) => `<option value="${escapeHtml(s.key)}">${escapeHtml(s.title_zh)}</option>`)
      .join('');

    if (filterSel) {
      filterSel.innerHTML = `<option value="">全部主题</option>` + optHtml;
    }

    if (uploadSel) {
      // For upload form, prefer having a valid default selection
      const placeholder = `<option value="" disabled>请选择主题分区</option>`;
      uploadSel.innerHTML = placeholder + optHtml;
      // If current value missing, default to first real option
      const current = String(uploadSel.value || '');
      if (!current && items.length) {
        uploadSel.value = items[0].key;
      } else if (current && !map.has(current) && items.length) {
        uploadSel.value = items[0].key;
      }
    }

    if (initMsg) {
      initMsg.textContent = note || (items.length ? '主题分区已加载。' : '已加载默认主题分区。');
    }
  };

  // Try DB-driven sections first; fall back gracefully for older schemas.
  try {
    let data = null;

    // Attempt: sections has channel_id
    {
      const { data: d, error } = await supabase
        .from('sections')
        .select('key,title_zh,title,is_active,sort_order,channel_id')
        .eq('channel_id', 'case')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
      if (!error && Array.isArray(d) && d.length) data = d;
    }

    // Attempt: sections WITHOUT channel_id
    if (!data) {
      const { data: d2, error: e2 } = await supabase
        .from('sections')
        .select('key,title_zh,title,is_active,sort_order')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
      if (!e2 && Array.isArray(d2) && d2.length) data = d2;
    }

    if (data && Array.isArray(data) && data.length) {
      setOptions(data, '主题分区已加载。');
    } else {
      setOptions(fallback, '未检测到自定义主题分区，已使用默认分区。');
    }
  } catch (e) {
    console.warn('loadSections failed, fallback to defaults', e);
    setOptions(fallback, '主题分区加载失败，已使用默认分区。');
  }
}

function applyFilterAndRender(allRows) {
  const rowsAll = Array.isArray(allRows) ? allRows : [];
  const search = document.querySelector('#pptSearch');
  const filterSec = document.querySelector('#pptSection');
  const metaEl = document.querySelector('#pptMeta');

  const qRaw = (search?.value || '').trim();
  const q = qRaw.toLowerCase();
  const sec = (filterSec?.value || '').trim();

  let rows = rowsAll.slice();

  // filter: section
  if (sec) rows = rows.filter((r) => r.section_key === sec);

  // filter: keyword (title / speaker / hospital / tags)
  if (q) {
    rows = rows.filter((r) => {
      const hay =
        `${r.title || ''} ${r.speaker || ''} ${r.hospital || ''} ${r.tags || ''} ${r.author_name || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  // meta
  if (metaEl) {
    const total = rowsAll.length;
    const shown = rows.length;
    const secName = sec ? resolveSectionName(sec) : '';
    const parts = [];
    parts.push(`共 ${total} 份`);
    if (secName) parts.push(`分区：${secName}`);
    if (qRaw) parts.push(`搜索：“${qRaw}”`);
    parts.push(`当前显示 ${shown} 份`);
    metaEl.textContent = parts.join(' · ');
  }

  renderPptList(rows);
}

function renderPptList(rows) {
  const el = document.querySelector('#pptCards');
  if (!el) return;

  const sections = window.__pptSections || new Map();
  const canDeleteAll = !!window.__pptCanDeleteAll;
  const canDeleteOwn = !!window.__pptCanDeleteOwn;
  const userId = window.__pptUserId || null;

  if (!rows?.length) {
    el.innerHTML = `<div class="small muted">暂无条目。</div>`;
    return;
  }

  el.innerHTML = rows
    .map((r) => {
      const secTitle = r.section_key ? (sections.get(r.section_key) || r.section_key) : '';
      const metaBits = [];
      if (secTitle) metaBits.push(secTitle);
      if (r.speaker) metaBits.push(r.speaker);
      if (r.hospital) metaBits.push(r.hospital);
      const meta = metaBits.join(' · ');

      const created = formatBeijingDateTime(r.created_at, { withSeconds: false });
      const author = r.author_name ? `上传：${r.author_name}` : '';
      const dl = (typeof r.download_count === 'number' && isFinite(r.download_count)) ? r.download_count : null;

      const tags = (r.tags || '')
        .split(/[，,;；\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 12);

      const tagHtml = tags.length
        ? `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">${tags
            .map((t) => `<span class="chip">${escapeHtml(t)}</span>`)
            .join('')}</div>`
        : '';

      const atts = window.__pptAttById?.get(String(r.id)) || [];
      const attHtml = atts.length ? `<div style="margin-top:12px">${renderAttachmentsBlock(atts)}</div>` : '';

      const deckAtt = atts.find((a) => a && isPptFile(a.mime, a.original_name)) ||
                      atts.find((a) => a && isPdfFile(a.mime, a.original_name)) ||
                      null;
      const deckKind = deckAtt
        ? (isPptFile(deckAtt.mime, deckAtt.original_name) ? 'ppt' : (isPdfFile(deckAtt.mime, deckAtt.original_name) ? 'pdf' : 'file'))
        : '';
      const actionsHtml = deckAtt
        ? `<div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
             <a class="btn tiny primary" href="ppt-viewer.html?id=${r.id}" target="_blank" rel="noopener">在线阅读</a>
             <a class="btn tiny ghost" data-act="ppt-download" data-id="${r.id}" href="${escapeHtml(deckAtt.public_url)}" target="_blank" rel="noopener">下载${deckKind === 'ppt' ? 'PPT' : deckKind === 'pdf' ? 'PDF' : '文件'}</a>
           </div>`
        : '';

      const isMine = !!(userId && r.author_id && r.author_id === userId);

      const manageBtns = (canDeleteAll || (canDeleteOwn && isMine))
        ? `<div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
             <button class="btn tiny" data-act="delete" data-id="${r.id}">删除</button>
           </div>`
        : '';

      return `
        <div class="card soft">
          <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
            <div>
              <div class="small muted">${escapeHtml(meta)}</div>
              <h3 style="margin:6px 0 0">${escapeHtml(r.title || '')}</h3>
            </div>
            <div class="small muted" style="text-align:right">
              <div>${escapeHtml(created)}</div>
              <div>${escapeHtml(author)}</div>
              ${dl !== null ? `<div id="pptDlCount_${escapeHtml(r.id)}">下载：${escapeHtml(String(dl))}</div>` : ''}
            </div>
          </div>

          ${r.summary ? `<div class="small" style="margin-top:10px;white-space:pre-wrap">${escapeHtml(r.summary)}</div>` : ''}
          ${tagHtml}
          ${attHtml}
          ${actionsHtml}
          ${manageBtns}
        </div>
      `;
    })
    .join('');
}

async function loadPpts(supabase) {
  const el = document.querySelector('#pptCards');
  const initMsg = document.querySelector('#pptInitMsg');
  if (!el) return;

  // default: hide init hint
  if (initMsg) initMsg.hidden = true;

  el.innerHTML = `<div class="small muted">加载中…</div>`;

  // Prefer new schema that contains download_count.
  let r = await supabase
    .from('expert_ppts')
    .select('id, section_key, title, speaker, hospital, summary, tags, author_id, author_name, created_at, download_count')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(400);

  // Backward compatibility: older deployments don't have download_count.
  if (r.error && /download_count/i.test(String(r.error.message || ''))) {
    r = await supabase
      .from('expert_ppts')
      .select('id, section_key, title, speaker, hospital, summary, tags, author_id, author_name, created_at')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(400);
  }

  const { data, error } = r;

  if (error) {
    console.error(error);

    // Table missing / not initialized
    if (String(error.code) === '42P01') {
      el.innerHTML = `<div class="small muted">专家 PPT 模块尚未初始化或暂不可用。</div>`;
      // Only show admin hint to admin users
      if (initMsg) initMsg.hidden = !window.__pptIsAdminUser;
      const metaEl = document.querySelector('#pptMeta');
      if (metaEl) metaEl.textContent = '';
      return;
    }

    el.innerHTML = `<div class="small muted">加载失败：${escapeHtml(error.message || '')}</div>`;
    return;
  }

  window.__pptRows = Array.isArray(data) ? data : [];

  // load attachments in batch
  const ids = window.__pptRows.map((r) => String(r.id));
  window.__pptAttById = new Map();

  if (ids.length) {
    // Fetch uploaded files for the PPT list.
    // Primary schema: attachments.original_name / attachments.mime_type / attachments.size_bytes
    // Legacy schema compatibility: attachments.name / attachments.mime / attachments.size
    let atts = null;
    let attErr = null;

    ({ data: atts, error: attErr } = await supabase
      .from('attachments')
      // attachments 表当前使用 public_url / mime_type / original_name / size_bytes。
      // 如你的库仍是旧字段（url/name/mime/size），会走下面的 legacy fallback。
      .select('id,target_id,target_type,original_name,public_url,mime_type,size_bytes,path,created_at')
      .eq('target_type', 'expert_ppt')
      .in('target_id', ids)
      .order('created_at', { ascending: true }));

    // If the project DB is still on the legacy column names, retry with the old schema.
    if (attErr && /schema cache|column/i.test(attErr.message || '')) {
      ({ data: atts, error: attErr } = await supabase
        .from('attachments')
        .select('id,target_id,target_type,name,url,mime,size,path,created_at')
        .eq('target_type', 'expert_ppt')
        .in('target_id', ids)
        .order('created_at', { ascending: true }));
    }

    if (!attErr && Array.isArray(atts)) {
      for (const a of atts) {
				const mimeVal = a.mime_type || a.mime || '';
        const key = String(a.target_id);
        if (!window.__pptAttById.has(key)) window.__pptAttById.set(key, []);
        window.__pptAttById.get(key).push({
          id: a.id,
					kind: guessKind(mimeVal),
			// 新库字段为 public_url；兼容旧库字段 url
			public_url: a.public_url || a.url,
	        original_name: a.original_name || a.name,
          size_bytes: (a.size_bytes ?? a.size ?? null),
					mime: mimeVal,
          path: a.path || null,
          created_at: a.created_at
        });
      }
    } else if (attErr) {
      console.warn('load attachments error', attErr);
    }
  }

  applyFilterAndRender(window.__pptRows);
}

function setupFilters(supabase) {
  const q = document.querySelector('#pptSearch');
  const sec = document.querySelector('#pptSection');
  const btn = document.querySelector('#pptRefresh');

  const rerender = () => applyFilterAndRender(window.__pptRows || []);
  q?.addEventListener('input', rerender);
  sec?.addEventListener('change', rerender);
  btn?.addEventListener('click', async () => {
    await loadPpts(supabase);
  });
}

function renderPendingFiles(files) {
  const el = document.querySelector('#pptFilePreview');
  if (!el) return;
  if (!files.length) {
    el.innerHTML = '<div class="small muted">未选择文件。支持拖拽/粘贴截图。</div>';
    return;
  }

  const items = files.map((f, idx) => {
    const mime = normalizeMime(f);
    const kind = guessKind(mime);
    const name = escapeHtml(f.name || (kind === 'image' ? `image_${idx + 1}.png` : `file_${idx + 1}`));
    const size = formatBytes(f.size || 0);

    if (kind === 'image') {
      const url = URL.createObjectURL(f);
      return `
        <div class="thumb" title="${name}">
          <img src="${url}" alt="${name}" />
        </div>
      `;
    }
    if (kind === 'pdf') {
      const url = URL.createObjectURL(f);
      return `
        <a class="pdf-card" href="#" onclick="return false;" title="${name}">
          <iframe src="${url}#page=1&view=FitH"></iframe>
          <div class="pdf-meta">
            <div class="pdf-name">${name}</div>
            <div class="pdf-sub small muted">${escapeHtml(size)}</div>
          </div>
        </a>
      `;
    }

    return `
      <div class="file-chip" title="${name}">
        <span class="clip">📎</span>
        <span class="name">${name}</span>
        <span class="small muted">${escapeHtml(size)}</span>
      </div>
    `;
  });

  // Use grids for nicer preview
  const hasImg = files.some((f) => guessKind(normalizeMime(f)) === 'image');
  const hasPdf = files.some((f) => guessKind(normalizeMime(f)) === 'pdf');

  const parts = [];
  if (hasImg) {
    parts.push(`<div class="thumb-grid">${items.filter((s) => s.includes('thumb')).join('')}</div>`);
  }
  if (hasPdf) {
    parts.push(`<div class="pdf-grid">${items.filter((s) => s.includes('pdf-card')).join('')}</div>`);
  }
  const rest = items.filter((s) => s.includes('file-chip'));
  if (rest.length) parts.push(`<div class="attach-grid">${rest.join('')}</div>`);

  el.innerHTML = parts.join('');
}

function setupUploader(supabase, user, profile) {
  const panel = document.querySelector('#pptUploaderCard');
  const form = document.querySelector('#pptForm');
  const preview = document.querySelector('#pptFilePreview');

  if (!panel || !form) return;

  // avoid double-bind
  if (panel.dataset.bound === '1') {
    panel.hidden = false;
    return;
  }
  panel.dataset.bound = '1';

  panel.hidden = false;

  const pending = [];

  const renderPending = () => renderPendingFiles(pending);

  const addFiles = (fileList) => {
    const files = Array.from(fileList || []);
    let added = 0;

    for (const f of files) {
      if (!isSupportedFile(f)) {
        toast('不支持的文件类型：仅支持 PDF / PPT / 图片。', 'error');
        continue;
      }
      if (typeof f.size === 'number' && f.size > MAX_BYTES) {
        toast('文件过大：单个文件请小于 20MB。', 'error');
        continue;
      }
      if (pending.length >= 9) {
        toast('最多上传 9 个附件', 'error');
        break;
      }
      pending.push(f);
      added += 1;
    }

    if (added) renderPending();
  };

  // drag / drop / paste
  const drop = document.querySelector('#pptDropZone') || document.querySelector('#pptDropzone');
  if (drop && drop.dataset.bound !== '1') {
    drop.dataset.bound = '1';

    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('hover');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('hover'));
    drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('hover');

    const dt = e.dataTransfer;
    const files = await pickDataTransferFiles(dt);
    if (files.length) {
      addFiles(files);
      toast(`已添加 ${files.length} 个文件`, 'success');
    } else {
      toast('未检测到可上传文件：请拖拽文件，或 Ctrl+V 粘贴截图。', 'info');
    }
  });

    // paste images (Ctrl+V) into drop zone
    drop.addEventListener('paste', async (e) => {
      const files = await pickClipboardFiles(e.clipboardData);
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    });

    // Click / keyboard accessibility: open file picker
    drop.addEventListener('click', () => {
      const fi = document.querySelector('#pptFiles');
      if (fi) fi.click();
    });
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const fi = document.querySelector('#pptFiles');
        if (fi) fi.click();
      }
    });
  }

  // paste screenshots anywhere inside the form (e.g. in the summary textarea)
  if (form && form.dataset.pasteBound !== '1') {
    form.dataset.pasteBound = '1';
    form.addEventListener('paste', async (e) => {
      const files = await pickClipboardFiles(e.clipboardData);
      if (!files.length) return;

      // IMPORTANT: allow normal text paste in form fields.
      // Copying text from PPT/Word often includes an image preview in the clipboard.
      const target = e.target;
      const hasText = clipboardHasText(e.clipboardData);

      // Single-line inputs should always behave like normal.
      if (target && String(target.tagName).toUpperCase() === 'INPUT') return;

      // In textarea/contenteditable, if text exists, do not hijack.
      if (isTextField(target) && hasText) return;

      e.preventDefault();
      addFiles(files);
    });
  }

  
  // Global paste fallback:
  // - users often Ctrl+V while the focus is on search inputs / dropdowns above the uploader
  // - some browsers don't reliably bubble paste events from native controls
  // We only intercept when clipboard contains FILES, so normal text paste is unaffected.
  if (document.documentElement.dataset.pptGlobalPasteBound !== '1') {
    document.documentElement.dataset.pptGlobalPasteBound = '1';
    document.addEventListener('paste', async (e) => {
      if (!panel || panel.hidden) return;
      if (e.defaultPrevented) return;

      const files = await pickClipboardFiles(e.clipboardData);
      if (!files.length) return;

      // If user is pasting into a text field and clipboard has text, do not hijack.
      const target = e.target || document.activeElement;
      const hasText = clipboardHasText(e.clipboardData);
      if (target && String(target.tagName).toUpperCase() === 'INPUT') return;
      if (isTextField(target) && hasText) return;

      e.preventDefault();
      e.stopPropagation();
      addFiles(files);
      toast(`已添加 ${files.length} 个文件`, 'success');
    }, true);

    // Global drag&drop safety net: avoid the browser opening the file when user drops
    // outside the drop zone.
    document.addEventListener('dragover', (e) => {
      if (!panel || panel.hidden) return;
      const dt = e.dataTransfer;
      if (!dt) return;
      const hasFiles = (dt.types && Array.from(dt.types).includes('Files')) || (dt.files && dt.files.length);
      if (!hasFiles) return;
      e.preventDefault();
    }, true);

    document.addEventListener('drop', async (e) => {
      if (!panel || panel.hidden) return;
      const dt = e.dataTransfer;
      if (!dt) return;
      const hasFiles = (dt.types && Array.from(dt.types).includes('Files')) || (dt.files && dt.files.length);
      if (!hasFiles) return;
      e.preventDefault();
      e.stopPropagation();
      const files = await pickDataTransferFiles(dt);
      if (files.length) {
        addFiles(files);
        toast(`已添加 ${files.length} 个文件`, 'success');
      }
    }, true);
  }

// file picker
  const fileInput = document.querySelector('#pptFiles');
  if (fileInput && fileInput.dataset.bound !== '1') {
    fileInput.dataset.bound = '1';
    fileInput.addEventListener('change', () => {
      if (fileInput.files?.length) addFiles(fileInput.files);
      fileInput.value = '';
    }, true);
  }

  // clear
  const clearBtn = document.querySelector('#pptClear');
  if (clearBtn && clearBtn.dataset.bound !== '1') {
    clearBtn.dataset.bound = '1';
    clearBtn.addEventListener('click', () => {
      pending.length = 0;
      renderPending();
      form.reset();
    });
  }

  // remove in preview
  if (preview && preview.dataset.bound !== '1') {
    preview.dataset.bound = '1';
    preview.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('button[data-act="remove-file"][data-idx]');
      if (!btn) return;
      const idx = parseInt(btn.getAttribute('data-idx'), 10);
      if (Number.isFinite(idx) && idx >= 0 && idx < pending.length) {
        pending.splice(idx, 1);
        renderPending();
      }
    });
  }

  // submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!user?.id) {
      toast('请先登录', 'error');
      return;
    }

    const section_key = (document.querySelector('#pptSectionInput')?.value || '').trim();
    const title = (document.querySelector('#pptTitle')?.value || '').trim();
    const speaker = (document.querySelector('#pptSpeaker')?.value || '').trim();
    const hospital = (document.querySelector('#pptHospital')?.value || '').trim();
    const summary = (document.querySelector('#pptSummary')?.value || '').trim();
    const tags = (document.querySelector('#pptTags')?.value || '').trim();

    if (!section_key) {
      toast('请选择分区', 'error');
      return;
    }
    if (!title) {
      toast('请填写标题', 'error');
      return;
    }
    if (!pending.length) {
      toast('请添加至少 1 个附件', 'error');
      return;
    }

    const submitBtn = document.querySelector('#pptSubmit');
    submitBtn && (submitBtn.disabled = true);

    try {
      const author_name =
        profile?.full_name ||
        profile?.display_name ||
        user?.user_metadata?.full_name ||
        user?.email ||
        '认证医生';

      const { data: ppt, error } = await supabase
        .from('expert_ppts')
        .insert({
          section_key,
          title,
          speaker: speaker || null,
          hospital: hospital || null,
          summary: summary || null,
          tags: tags || null,
          author_id: user.id,
          author_name
        })
        .select('id')
        .single();

      if (error) throw error;

      // upload files
      for (const f of pending) {
        const rid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const path = `${user.id}/expert_ppt/${ppt.id}/${rid}_${safeFilename(f.name)}`;
        const publicUrl = await uploadToStorage(supabase, path, f);
        if (!publicUrl) throw new Error('upload failed');

        const mime = f.type || normalizeMime(f);
        const size = f.size || null;

	      // Prefer the current schema: original_name + mime_type + size_bytes.
	      // Fallback to legacy columns if needed.
	      let aerr = null;
		      {
	        const { error } = await supabase.from('attachments').insert({
	          author_id: user.id,
	          target_type: 'expert_ppt',
	          target_id: String(ppt.id),
	          bucket: BUCKET,
	          original_name: f.name,
	          path,
		          public_url: publicUrl,
	          mime_type: mime,
	          size_bytes: size,
	        });
	        aerr = error || null;
	      }

		      if (aerr && /(public_url|original_name|mime_type|size_bytes|bucket)/i.test(String(aerr.message || aerr))) {
	        const { error } = await supabase.from('attachments').insert({
	          author_id: user.id,
	          target_type: 'expert_ppt',
	          target_id: String(ppt.id),
	          // legacy columns
	          name: f.name,
	          path,
	          url: publicUrl,
	          mime,
	          size,
	        });
	        aerr = error || null;
	      }

	      if (aerr) throw aerr;
      }

      toast('上传成功', 'success');
      pending.length = 0;
      renderPending();
      form.reset();
      await loadPpts(supabase);
    } catch (err) {
      console.error(err);
      const raw = String(err?.message || err || '');
      let msg = raw;
      // Helpful hint when users forgot to run the latest RLS migration.
      if (/row\-level security|rls|permission denied|not allowed/i.test(raw)) {
        msg = raw + '（权限不足：请确认已在 Supabase 运行最新的 Expert PPT 权限迁移并 Reload schema）';
      }
      toast('上传失败：' + msg, 'error');
    } finally {
      submitBtn && (submitBtn.disabled = false);
    }
  });

  renderPending();
}

async function bindDeleteHandlers(supabase) {
  if (window.__pptDeleteBound) return;
  window.__pptDeleteBound = true;

  document.addEventListener('click', async (e) => {
    const btn = e.target?.closest?.('button[data-act="delete"][data-id]');
    if (!btn) return;

    const canDeleteAll = !!window.__pptCanDeleteAll;
    const canDeleteOwn = !!window.__pptCanDeleteOwn;
    const userId = window.__pptUserId || null;

    const id = btn.getAttribute('data-id');
    if (!id) return;

    const row = (window.__pptRows || []).find((r) => String(r.id) === String(id));
    const isMine = !!(row && userId && row.author_id && row.author_id === userId);

    if (!(canDeleteAll || (canDeleteOwn && isMine))) {
      toast('你没有权限删除该 PPT。', 'error');
      return;
    }

    if (!confirm('确认删除该 PPT？（将标记为删除）')) return;

    const { error } = await supabase
      .from('expert_ppts')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      console.error(error);
      toast('删除失败：' + (error.message || ''), 'error');
      return;
    }

    toast('已删除');
    await loadPpts(supabase);
  });
}

async function bindDownloadHandlers(supabase) {
  if (window.__pptDownloadBound) return;
  window.__pptDownloadBound = true;

  document.addEventListener('click', async (e) => {
    const a = e.target?.closest?.('a[data-act="ppt-download"][data-id]');
    if (!a) return;
    const id = a.getAttribute('data-id');
    if (!id) return;

    // Fire-and-forget: do not block the actual download/open.
    try {
      const { data: newCount, error } = await supabase.rpc('increment_expert_ppt_download', {
        p_ppt_id: Number(id),
      });
      if (error) return;
      if (typeof newCount === 'number' && isFinite(newCount)) {
        // Update in-memory row
        const rows = window.__pptRows || [];
        const row = rows.find((r) => String(r.id) === String(id));
        if (row) row.download_count = newCount;

        // Update UI if the counter is rendered
        const el = document.getElementById(`pptDlCount_${id}`);
        if (el) el.textContent = `下载：${newCount}`;
      }
    } catch (_e) {
      // Ignore if RPC isn't installed yet.
    }
  });
}



function bindPreviewModal() {
  const modal = document.querySelector('#pptPreviewModal');
  const frame = document.querySelector('#pptPreviewFrame');
  const titleEl = document.querySelector('#pptPreviewTitle');

  if (!modal || !frame || !titleEl) return;

  const close = () => {
    modal.hidden = true;
    // stop loading media
    frame.src = 'about:blank';
  };

  // click close buttons / backdrop
  modal.addEventListener('click', (e) => {
    const tgt = e.target;
    if (tgt && tgt.getAttribute && tgt.getAttribute('data-close') === '1') {
      e.preventDefault();
      close();
    }
  });

  // escape to close
  document.addEventListener('keydown', (e) => {
    if (!modal.hidden && e.key === 'Escape') close();
  });

  // Delegate preview buttons for PPT files
  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('[data-act="preview-ppt"][data-url]');
    if (!btn) return;

    e.preventDefault();
    const url = btn.getAttribute('data-url') || '';
    const name = btn.getAttribute('data-name') || 'PPT';
    const embed = officeEmbedUrl(url);

    if (!embed) {
      toast('无法预览：缺少文件链接', 'error');
      return;
    }

    titleEl.textContent = `PPT 预览：${name}`;
    frame.src = embed;
    modal.hidden = false;
  });
}

async function main() {
  const listEl = document.querySelector('#pptCards');

  if (!isConfigured()) {
    if (listEl) {
      listEl.innerHTML =
        `<div class="small muted">Supabase 未配置：请在 <code>assets/config.js</code> 填写 <code>SUPABASE_URL</code> 与 <code>SUPABASE_ANON_KEY</code> 后刷新。</div>`;
    }
    return;
  }

  const supabase = await getSupabase();

  bindPreviewModal();

  // Filters / sections
  setupFilters(supabase);
  await loadSections(supabase);

  // Auth state
  const user = await getCurrentUser(supabase);
  // NOTE: getUserProfile(...) uses the global exported supabase client internally.
  // Passing (supabase, userId) will silently break because extra args are ignored
  // and the first arg becomes a supabase object (no .id), resulting in null profile.
  const profile = user?.id ? await getUserProfile(user) : null;

  const isAdminUser = isAdminRole(profile?.role);
  const viewMode = readViewModePref();
  const isAdminUi = isAdminUser && viewMode === 'admin';

  let isDoctorVerified = false;
  if (user) {
    if (typeof window.__ks_is_doctor_verified === 'boolean') {
      isDoctorVerified = window.__ks_is_doctor_verified;
    } else {
      const role = String(profile?.role || '').toLowerCase();
      const hasDoctorVerifiedAt = !!profile?.doctor_verified_at;
      isDoctorVerified =
        hasDoctorVerifiedAt ||
        ['owner', 'super_admin', 'admin', 'moderator', 'doctor_verified', 'doctor'].includes(role);

      // Prefer reading doctor_verifications directly (works even if your old
      // is_doctor_verified() only checks profiles.role).
      if (!isDoctorVerified) {
        try {
          // Newer schema usually has `status` + `verified_at`; old schemas might not.
          let dv = await supabase
            .from('doctor_verifications')
            .select('status, verified_at, created_at')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          // If `status` column does not exist, retry without it.
          if (dv?.error && /status/i.test(String(dv.error.message || ''))) {
            dv = await supabase
              .from('doctor_verifications')
              .select('verified_at, created_at, id')
              .eq('user_id', user.id)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
          }

          // If `verified_at` also does not exist, fallback to selecting only `id`.
          if (dv?.error && /verified_at/i.test(String(dv.error.message || ''))) {
            dv = await supabase
              .from('doctor_verifications')
              .select('id')
              .eq('user_id', user.id)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle();
          }

          if (!dv?.error && dv?.data) {
            // Prefer timestamp flag if present.
            if (dv.data.verified_at) {
              isDoctorVerified = true;
            } else {
              const stRaw = String(dv.data.status ?? '').trim();
              const st = stRaw.toLowerCase();
              // If we can't read status, treat existence as verified (legacy schema).
              if (!stRaw) {
                isDoctorVerified = true;
              } else if (
                ['approved', 'verified', 'passed', 'ok'].includes(st) ||
                st.includes('通过') ||
                st.includes('approved')
              ) {
                isDoctorVerified = true;
              }
            }
          }
        } catch (_) {
          // ignore
        }
      }

      // Final fallback to RPC (if present).
      if (!isDoctorVerified) {
        try {
          const { data, error } = await supabase.rpc('is_doctor_verified');
          if (!error) isDoctorVerified = !!data;
        } catch (_) {
          // ignore
        }
      }
    }
  }

  // Expose globally so other pages can reuse the result.
  window.__ks_is_doctor_verified = !!isDoctorVerified;

  // Expose state for renderer
  window.__pptIsAdminUser = !!isAdminUser;
  window.__pptIsAdmin = !!isAdminUi;
  window.__pptUserId = user?.id || null;
  window.__pptIsDoctorVerified = !!isDoctorVerified;

  // Permissions for this page
  const canUpload = !!user && isDoctorVerified;
  window.__pptCanUpload = !!canUpload;
  window.__pptCanDeleteAll = !!isAdminUi;
  window.__pptCanDeleteOwn = !!(user && isDoctorVerified && (!isAdminUser || isAdminUi));

  // Admin UI hint (admin user but currently in member view mode)
  const adminModeHint = document.querySelector('#pptAdminModeHint');
  if (adminModeHint) adminModeHint.hidden = !(isAdminUser && !isAdminUi);

  const switchBtn = document.querySelector('#pptSwitchToAdminBtn');
  if (switchBtn && switchBtn.dataset.bound !== '1') {
    switchBtn.dataset.bound = '1';
    switchBtn.addEventListener('click', () => {
      localStorage.setItem(VIEW_MODE_KEY, 'admin');
      window.location.reload();
    });
  }

  // Upload gate / uploader
  const gateMsg = document.querySelector('#pptUploadGateMsg');
  const uploadCard = document.querySelector('#pptUploaderCard');

  if (uploadCard) uploadCard.hidden = !canUpload;
  if (gateMsg) gateMsg.hidden = !(user && !isDoctorVerified);

  // Load & render list
  await loadPpts(supabase);

  // Download counter (safe if RPC isn't installed yet)
  await bindDownloadHandlers(supabase);

  // Hide the static loading hint once the initial data load finished
  const loadingHint = document.querySelector('#pptLoading');
  if (loadingHint) loadingHint.hidden = true;

  if (canUpload) setupUploader(supabase, user, profile);
  if (window.__pptCanDeleteAll || window.__pptCanDeleteOwn) await bindDeleteHandlers(supabase);
}

document.addEventListener('DOMContentLoaded', main);
