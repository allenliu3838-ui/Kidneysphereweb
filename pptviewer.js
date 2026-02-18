import {
  getSupabase,
  isConfigured,
  toast,
  formatBeijingDateTime,
} from './supabaseClient.js?v=20260128_030';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[c]));
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

function guessKind(mime, name) {
  if (isPdfFile(mime, name)) return 'pdf';
  if (isPptFile(mime, name)) return 'ppt';
  const t = String(mime || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  return 'file';
}

function officeEmbedUrl(publicUrl) {
  const u = String(publicUrl || '').trim();
  if (!u) return '';
  return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(u)}`;
}

function getQueryParam(name) {
  try {
    const u = new URL(location.href);
    return u.searchParams.get(name);
  } catch {
    return null;
  }
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
                <a class="btn tiny primary" href="${escapeHtml(officeEmbedUrl(url))}" target="_blank" rel="noopener">预览</a>
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

async function main() {
  const statusEl = document.querySelector('#pptViewerStatus');
  const frame = document.querySelector('#pptViewerFrame');
  const titleEl = document.querySelector('#pptViewerTitle');
  const metaEl = document.querySelector('#pptViewerMeta');
  const openBtn = document.querySelector('#pptViewerOpenBtn');
  const downloadBtn = document.querySelector('#pptViewerDownloadBtn');
  const attCard = document.querySelector('#pptViewerAttachmentsCard');
  const attEl = document.querySelector('#pptViewerAttachments');

  const setStatus = (msg) => {
    if (statusEl) statusEl.textContent = msg;
  };

  if (!isConfigured()) {
    setStatus('Supabase 未配置：请在 assets/config.js 填写 SUPABASE_URL 与 SUPABASE_ANON_KEY。');
    return;
  }

  const idRaw = getQueryParam('id') || getQueryParam('ppt_id') || '';
  const id = String(idRaw || '').trim();
  if (!id) {
    setStatus('缺少参数：请从“专家 PPT”列表点击进入。');
    return;
  }

  const supabase = await getSupabase();

  setStatus('加载中…');

  // Load PPT entry (prefer schema with download_count)
  let r = await supabase
    .from('expert_ppts')
    .select('id, section_key, title, speaker, hospital, summary, tags, author_name, created_at, deleted_at, download_count')
    .eq('id', id)
    .maybeSingle();

  // Backward compatibility: older deployments may not have download_count.
  if (r.error && /download_count/i.test(String(r.error.message || ''))) {
    r = await supabase
      .from('expert_ppts')
      .select('id, section_key, title, speaker, hospital, summary, tags, author_name, created_at, deleted_at')
      .eq('id', id)
      .maybeSingle();
  }

  const { data: row, error } = r;

  if (error) {
    console.error(error);
    setStatus('加载失败：' + (error.message || ''));
    return;
  }
  if (!row || row.deleted_at) {
    setStatus('未找到该条目，或已被删除。');
    return;
  }

  if (titleEl) titleEl.textContent = row.title ? row.title : 'PPT 在线阅读';

  // Load attachments
		let attsRaw = null;
		let attErr = null;
			({ data: attsRaw, error: attErr } = await supabase
			  .from('attachments')
				// Prefer new schema: public_url / mime_type / original_name / size_bytes
			  .select('id,original_name,public_url,mime_type,size_bytes,created_at')
		  .eq('target_type', 'expert_ppt')
		  .eq('target_id', String(row.id))
		  .order('created_at', { ascending: true }));

		// Backward compatibility: older deployments used mime/name/size.
		if (attErr && /schema cache|column/i.test(String(attErr.message || attErr))) {
			({ data: attsRaw, error: attErr } = await supabase
			  .from('attachments')
			  .select('id,name,url,mime,size,created_at')
			  .eq('target_type', 'expert_ppt')
			  .eq('target_id', String(row.id))
			  .order('created_at', { ascending: true }));
		}

		if (attErr) {
			console.warn(attErr);
		}

				const atts = (Array.isArray(attsRaw) ? attsRaw : []).map((a) => ({
    id: a.id,
		  kind: guessKind(a.mime_type || a.mime, a.original_name || a.name),
	    // 新库字段为 public_url；兼容旧库字段 url
	    public_url: a.public_url || a.url,
	    original_name: a.original_name || a.name,
	    size_bytes: (a.size_bytes ?? a.size ?? null),
	  mime: a.mime_type || a.mime,
    created_at: a.created_at,
  }));

  const hasDownloadCount = Object.prototype.hasOwnProperty.call(row, 'download_count');
  let downloadCount = hasDownloadCount ? Number(row.download_count || 0) : null;

  const renderMeta = () => {
    const metaBits = [];
    if (row.speaker) metaBits.push(row.speaker);
    if (row.hospital) metaBits.push(row.hospital);
    if (row.author_name) metaBits.push(`上传：${row.author_name}`);
    if (row.created_at) metaBits.push(formatBeijingDateTime(row.created_at, { withSeconds: false }));
    if (downloadCount !== null) metaBits.push(`下载：${downloadCount}`);
    if (metaEl) metaEl.textContent = metaBits.join(' · ');
  };

  renderMeta();

  // Choose best preview target:
  // 1) PDF (pure in-site preview)
  // 2) PPT/PPTX via Office online viewer
  // 3) first image
  // 4) first file
  const deck =
    atts.find((a) => a.kind === 'pdf') ||
    atts.find((a) => a.kind === 'ppt') ||
    atts.find((a) => a.kind === 'image') ||
    atts[0] ||
    null;

  if (!deck) {
    setStatus('该条目暂无可预览文件。');
    if (frame) frame.src = 'about:blank';
    return;
  }

  let iframeSrc = '';
  if (deck.kind === 'pdf') {
    iframeSrc = `${deck.public_url}#page=1&view=FitH`;
  } else if (deck.kind === 'ppt') {
    iframeSrc = officeEmbedUrl(deck.public_url);
  } else if (deck.kind === 'image') {
    // show a single image in the frame
    iframeSrc = deck.public_url;
  } else {
    // fallback to opening raw file
    iframeSrc = deck.public_url;
  }

  if (frame) frame.src = iframeSrc;

  if (openBtn) {
    openBtn.href = deck.kind === 'ppt' ? officeEmbedUrl(deck.public_url) : deck.public_url;
    openBtn.style.display = '';
  }
  if (downloadBtn) {
    downloadBtn.href = deck.public_url;
    downloadBtn.style.display = '';
  }

  // Download counter: count explicit downloads (download button and file chips).
  const bumpDownload = async () => {
    try {
      const { data: newCount, error: incErr } = await supabase.rpc('increment_expert_ppt_download', {
        p_ppt_id: Number(row.id),
      });
      if (!incErr && typeof newCount === 'number' && isFinite(newCount)) {
        downloadCount = newCount;
        renderMeta();
      }
    } catch (_e) {
      // Ignore if RPC isn't installed yet.
    }
  };

  if (downloadBtn && downloadBtn.dataset.bound !== '1') {
    downloadBtn.dataset.bound = '1';
    downloadBtn.addEventListener('click', () => bumpDownload());
  }

  setStatus(deck.kind === 'ppt' ? '已加载（可在右上角打开原文件/下载）' : '已加载');

  // Show attachment list
  if (attCard && attEl && atts.length) {
    attEl.innerHTML = renderAttachmentsBlock(atts);
    attCard.hidden = false;

    if (attEl.dataset.bound !== '1') {
      attEl.dataset.bound = '1';
      attEl.addEventListener('click', (e) => {
        const a = e.target?.closest?.('a');
        if (!a) return;
        // Count file chips, and buttons explicitly labelled "下载".
        const txt = String(a.textContent || '').trim();
        if (a.classList.contains('file-chip') || txt === '下载' || txt.startsWith('下载')) {
          bumpDownload();
        }
      });
    }
  }
}

document.addEventListener('DOMContentLoaded', main);
