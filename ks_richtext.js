// ks_richtext.js
// Rich HTML utilities (sanitization + paste normalization + safe rendering)
//
// Goals
// - Word/Office paste: remove "mso" noise but keep semantics (headings/lists/tables).
// - Security: strict allowlist of tags/attributes/styles; block XSS vectors.
// - Output HTML matches KidneySphere typography (CSS: .ks-prose / .article-content).

const _DEFAULT_TEXT_COLORS = [
  '#f8fafc',
  '#94a3b8',
  '#22c55e',
  '#eab308',
  '#f97316',
  '#ef4444',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
];

const _DEFAULT_HILITES = [
  'rgba(0,0,0,0)',
  'rgba(234,179,8,.28)',
  'rgba(34,197,94,.22)',
  'rgba(59,130,246,.22)',
  'rgba(139,92,246,.22)',
  'rgba(239,68,68,.22)',
];

function _esc(text){
  return String(text ?? '').replace(/[&<>"]/g, (ch)=>({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[ch]));
}

function _safeUrl(url){
  const raw = String(url || '').trim();
  if(!raw) return '';
  if(/^https?:\/\//i.test(raw)) return raw;
  // block javascript:, data:, file: ...
  if(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return '';
  if(/^www\./i.test(raw)) return `https://${raw}`;
  return '';
}

export function detectOfficeHtml(html){
  const s = String(html || '');
  if(!s) return false;
  return /\bclass=["']?Mso|\bmso-|urn:schemas-microsoft-com|<o:p>|<!--\[if\s+gte\s+mso|OfficeDocumentSettings/i.test(s);
}

function _parseCssColor(input){
  const s = String(input || '').trim();
  if(!s) return null;

  // #rgb #rrggbb #rrggbbaa
  const hex = s.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
  if(hex){
    let h = hex[1];
    if(h.length === 3){
      const r = parseInt(h[0]+h[0], 16);
      const g = parseInt(h[1]+h[1], 16);
      const b = parseInt(h[2]+h[2], 16);
      return { r, g, b, a: 1 };
    }
    if(h.length === 6){
      const r = parseInt(h.slice(0,2), 16);
      const g = parseInt(h.slice(2,4), 16);
      const b = parseInt(h.slice(4,6), 16);
      return { r, g, b, a: 1 };
    }
    if(h.length === 8){
      const r = parseInt(h.slice(0,2), 16);
      const g = parseInt(h.slice(2,4), 16);
      const b = parseInt(h.slice(4,6), 16);
      const a = parseInt(h.slice(6,8), 16) / 255;
      return { r, g, b, a: Math.max(0, Math.min(1, a)) };
    }
  }

  const rgb = s.match(/^rgba?\(([^)]+)\)$/i);
  if(rgb){
    const parts = rgb[1].split(',').map(x=>x.trim()).filter(Boolean);
    if(parts.length < 3) return null;
    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    const a = parts.length >= 4 ? Number(parts[3]) : 1;
    if(!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !Number.isFinite(a)) return null;
    return {
      r: Math.max(0, Math.min(255, Math.round(r))),
      g: Math.max(0, Math.min(255, Math.round(g))),
      b: Math.max(0, Math.min(255, Math.round(b))),
      a: Math.max(0, Math.min(1, a)),
    };
  }

  if(s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  return null;
}

function _rgbToHex({r,g,b}){
  const to2 = (n)=> n.toString(16).padStart(2,'0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

function _nearestPaletteColor(colorStr, palette){
  const c = _parseCssColor(colorStr);
  if(!c) return '';
  if(!Array.isArray(palette) || !palette.length) return _rgbToHex(c);

  let best = '';
  let bestD = Infinity;
  for(const p of palette){
    const pc = _parseCssColor(p);
    if(!pc) continue;
    const d = (c.r-pc.r)**2 + (c.g-pc.g)**2 + (c.b-pc.b)**2 + ((c.a-pc.a)*255)**2;
    if(d < bestD){ bestD = d; best = p; }
  }
  return best || _rgbToHex(c);
}

function _sanitizeStyle(styleText, { allowColor=true, allowHilite=true, allowAlign=true, paletteText=null, paletteHilite=null } = {}){
  const s = String(styleText || '').trim();
  if(!s) return '';

  const out = [];
  const decls = s.split(';').map(x=>x.trim()).filter(Boolean);
  for(const d of decls){
    const idx = d.indexOf(':');
    if(idx <= 0) continue;
    const prop = d.slice(0, idx).trim().toLowerCase();
    const val = d.slice(idx+1).trim();
    if(!val) continue;

    if(prop === 'color' && allowColor){
      const c = _nearestPaletteColor(val, paletteText);
      if(c) out.push(`color:${c}`);
      continue;
    }

    if(prop === 'background-color' && allowHilite){
      const c = _nearestPaletteColor(val, paletteHilite);
      if(c) out.push(`background-color:${c}`);
      continue;
    }

    if(prop === 'text-align' && allowAlign){
      const a = String(val || '').toLowerCase();
      if(['left','center','right','justify'].includes(a)) out.push(`text-align:${a}`);
      continue;
    }
  }

  return out.join(';');
}

function _cleanOfficeHtml(html){
  // Cheap but effective cleanup: remove <style>, <meta>, <link>, mso comments.
  let s = String(html || '');
  // Remove conditional comments
  s = s.replace(/<!--\[if[\s\S]*?\[endif\]-->/gi, '');
  // Remove style/meta/link tags
  s = s.replace(/<(meta|link|style)[^>]*>[\s\S]*?<\/(style)>/gi, '');
  s = s.replace(/<(meta|link)[^>]*>/gi, '');
  // Remove <o:p>
  s = s.replace(/<\/?o:p[^>]*>/gi, '');
  return s;
}

function _textToHtml(text){
  const src = String(text || '').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  const lines = src.split('\n');

  let html = '';
  let inUl = false;
  let inOl = false;

  const closeLists = ()=>{
    if(inUl){ html += '</ul>'; inUl = false; }
    if(inOl){ html += '</ol>'; inOl = false; }
  };

  const asInline = (s)=> _esc(s).replace(/\s{2,}/g,' ');

  for(const rawLine of lines){
    const line = String(rawLine ?? '');
    const t = line.trim();
    if(!t){
      closeLists();
      continue;
    }

    // unordered list
    const ul = t.match(/^([-*•·])\s+(.*)$/);
    if(ul){
      if(inOl){ html += '</ol>'; inOl = false; }
      if(!inUl){ html += '<ul>'; inUl = true; }
      html += `<li>${asInline(ul[2])}</li>`;
      continue;
    }

    // ordered list
    const ol = t.match(/^(\d+)[\.|、\)]\s+(.*)$/);
    if(ol){
      if(inUl){ html += '</ul>'; inUl = false; }
      if(!inOl){ html += '<ol>'; inOl = true; }
      html += `<li>${asInline(ol[2])}</li>`;
      continue;
    }

    closeLists();
    html += `<p>${asInline(t)}</p>`;
  }

  closeLists();
  return html;
}

const _ALLOWED_TAGS = new Set([
  'p','br',
  'b','strong','i','em','u','s',
  'span','mark',
  'a',
  'ul','ol','li',
  'h1','h2','h3',
  'blockquote',
  'pre','code',
  'hr',
  'table','thead','tbody','tr','th','td',
  'figure','figcaption',
  'img',
  'div',
  'sup','sub',
]);

const _BLOCK_TAGS = new Set(['p','h1','h2','h3','blockquote','pre','ul','ol','table','figure','div']);

const _ALLOWED_CLASSES_BY_TAG = {
  pre: new Set(['codeblock']),
  figure: new Set(['ks-figure']),
  a: new Set(['file-chip','ks-media-item','auto-link']),
  div: new Set(['ks-media-grid','ks-table-wrap','article-video']),
  // Font size classes are intentionally limited to a small, controlled set
  // so authors can distinguish headings/body without breaking site typography.
  span: new Set(['mention','ks-fs-12','ks-fs-14','ks-fs-18','ks-fs-20']),
  img: new Set(['article-media']),
  p: new Set(['ks-fs-12','ks-fs-14','ks-fs-18','ks-fs-20']),
  h1: new Set(['ks-fs-12','ks-fs-14','ks-fs-18','ks-fs-20']),
  h2: new Set(['ks-fs-12','ks-fs-14','ks-fs-18','ks-fs-20']),
  h3: new Set(['ks-fs-12','ks-fs-14','ks-fs-18','ks-fs-20']),
  blockquote: new Set(['ks-fs-12','ks-fs-14','ks-fs-18','ks-fs-20']),
  li: new Set(['ks-fs-12','ks-fs-14','ks-fs-18','ks-fs-20']),
};

function _filterClass(tag, classValue){
  const allow = _ALLOWED_CLASSES_BY_TAG[tag];
  if(!allow) return '';
  const parts = String(classValue || '').split(/\s+/).map(x=>x.trim()).filter(Boolean);
  const kept = parts.filter(c=>allow.has(c));
  return kept.join(' ');
}

function _cleanNode(node, outDoc, opts){
  if(!node) return null;

  if(node.nodeType === Node.TEXT_NODE){
    // Keep text as-is
    return outDoc.createTextNode(node.nodeValue || '');
  }

  if(node.nodeType !== Node.ELEMENT_NODE) return null;

  const tag0 = String(node.tagName || '').toLowerCase();

  // Drop dangerous tags entirely
  if(['script','style','iframe','object','embed','svg','math','form','input','textarea','button','select','option'].includes(tag0)){
    return null;
  }

  // Map unknown tags to their children
  let tag = tag0;
  if(!_ALLOWED_TAGS.has(tag)){
    const frag = outDoc.createDocumentFragment();
    for(const ch of Array.from(node.childNodes || [])){
      const clean = _cleanNode(ch, outDoc, opts);
      if(clean) frag.appendChild(clean);
    }
    return frag;
  }

  // Special: convert most divs to paragraphs unless they are known layout wrappers
  if(tag === 'div'){
    const cls = String(node.getAttribute('class') || '');
    const keepCls = _filterClass('div', cls);
    if(!keepCls){
      tag = 'p';
    }
  }

  // Special: span without safe style/class => unwrap
  if(tag === 'span'){
    const cls = _filterClass('span', node.getAttribute('class'));
    const style = _sanitizeStyle(node.getAttribute('style'), {
      allowColor: true,
      allowHilite: true,
      allowAlign: false,
      paletteText: opts?.paletteText,
      paletteHilite: opts?.paletteHilite,
    });
    if(!cls && !style){
      const frag = outDoc.createDocumentFragment();
      for(const ch of Array.from(node.childNodes || [])){
        const clean = _cleanNode(ch, outDoc, opts);
        if(clean) frag.appendChild(clean);
      }
      return frag;
    }
  }

  if(tag === 'img'){
    const src = _safeUrl(node.getAttribute('src'));
    if(!src) return null;
    const el = outDoc.createElement('img');
    el.setAttribute('src', src);
    const alt = String(node.getAttribute('alt') || '').trim();
    if(alt) el.setAttribute('alt', alt);
    const cls = _filterClass('img', node.getAttribute('class'));
    if(cls) el.setAttribute('class', cls);
    return el;
  }

  const el = outDoc.createElement(tag);

  // Class
  const cls = _filterClass(tag, node.getAttribute('class'));
  if(cls) el.setAttribute('class', cls);

  // Style
  const allowAlign = _BLOCK_TAGS.has(tag);
  const style = _sanitizeStyle(node.getAttribute('style'), {
    allowColor: true,
    allowHilite: true,
    allowAlign,
    paletteText: opts?.paletteText,
    paletteHilite: opts?.paletteHilite,
  });
  if(style) el.setAttribute('style', style);

  // Attributes
  if(tag === 'a'){
    const href = _safeUrl(node.getAttribute('href'));
    if(href) el.setAttribute('href', href);
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  }

  if(tag === 'th' || tag === 'td'){
    const colspan = node.getAttribute('colspan');
    const rowspan = node.getAttribute('rowspan');
    if(colspan && /^\d{1,3}$/.test(String(colspan))) el.setAttribute('colspan', String(colspan));
    if(rowspan && /^\d{1,3}$/.test(String(rowspan))) el.setAttribute('rowspan', String(rowspan));
  }

  if(tag === 'pre'){
    // Ensure codeblock styling
    const cur = String(el.getAttribute('class') || '').trim();
    if(!cur){
      el.setAttribute('class', 'codeblock');
    }
  }

  // Recurse children
  for(const ch of Array.from(node.childNodes || [])){
    const clean = _cleanNode(ch, outDoc, opts);
    if(clean) el.appendChild(clean);
  }

  // Normalize empty blocks
  if(['p','h1','h2','h3','blockquote'].includes(tag)){
    const txt = String(el.textContent || '').replace(/\u00a0/g,' ').trim();
    const hasMedia = !!el.querySelector?.('img,table,pre,ul,ol,figure');
    if(!txt && !hasMedia){
      // Keep a single <br> so caret can place there.
      el.innerHTML = '<br/>';
    }
  }

  return el;
}

export function sanitizeHtml(inputHtml, opts={}){
  const mode = String(opts.mode || 'comment'); // 'article'|'comment'
  const paletteText = Array.isArray(opts.textColors) ? opts.textColors : _DEFAULT_TEXT_COLORS;
  const paletteHilite = Array.isArray(opts.hilites) ? opts.hilites : _DEFAULT_HILITES;

  const html = String(inputHtml || '').trim();
  if(!html) return '';

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Build a new safe document
  const outDoc = parser.parseFromString('<div></div>', 'text/html');
  const root = outDoc.body;
  root.innerHTML = '';

  const cfg = { mode, paletteText, paletteHilite };

  for(const n of Array.from(doc.body.childNodes || [])){
    const clean = _cleanNode(n, outDoc, cfg);
    if(clean) root.appendChild(clean);
  }

  // Strip leading/trailing empty paragraphs
  const trimEmptyEdges = ()=>{
    const children = Array.from(root.children || []);
    for(const edge of ['first','last']){
      let el = edge === 'first' ? root.firstElementChild : root.lastElementChild;
      while(el && el.tagName && ['P','DIV'].includes(el.tagName) && String(el.textContent || '').trim() === '' && !el.querySelector('img,table,pre,ul,ol,figure')){
        const next = edge === 'first' ? el.nextElementSibling : el.previousElementSibling;
        el.remove();
        el = next;
      }
    }
  };
  trimEmptyEdges();

  return root.innerHTML;
}

function _wrapTables(root){
  if(!root?.querySelectorAll) return;
  const tables = Array.from(root.querySelectorAll('table'));
  for(const t of tables){
    const p = t.parentElement;
    if(p && p.classList && p.classList.contains('ks-table-wrap')) continue;
    const wrap = root.ownerDocument.createElement('div');
    wrap.className = 'ks-table-wrap';
    t.replaceWith(wrap);
    wrap.appendChild(t);
  }
}

function _walkTextNodes(root, cb){
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node)=>{
      const parent = node?.parentElement;
      if(!parent) return NodeFilter.FILTER_REJECT;
      const tag = String(parent.tagName || '').toLowerCase();
      if(['a','code','pre','style','script'].includes(tag)) return NodeFilter.FILTER_REJECT;
      // skip inside button-like elements
      if(parent.closest && parent.closest('a,code,pre')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodes = [];
  let n;
  while((n = walker.nextNode())) nodes.push(n);
  nodes.forEach(cb);
}

function _linkifyAndMentionify(root, opts){
  const linkify = opts?.linkify !== false; // default true
  const mentionify = !!opts?.mentionify;
  if(!linkify && !mentionify) return;

  const urlRe = /\b((?:https?:\/\/|www\.)[^\s<]+)\b/g;
  const mentionRe = /(^|[\s(（【\[{\u3000>《“‘'"、，。！？;:])@([A-Za-z0-9_\-\u4e00-\u9fa5·]{1,24})/g;

  _walkTextNodes(root, (textNode)=>{
    const raw = String(textNode.nodeValue || '');
    if(!raw.trim()) return;

    const doc = root.ownerDocument;
    const frag = doc.createDocumentFragment();

    let idx = 0;

    // First pass: linkify URLs
    const matches = [];
    if(linkify){
      for(const m of raw.matchAll(urlRe)){
        const start = m.index ?? 0;
        const full = String(m[1] || '');
        if(!full) continue;

        // Trim trailing punctuation
        let url = full;
        let trailing = '';
        while(url.length){
          const ch = url[url.length-1];
          if(/[\)\]\}\.,!?;:，。！？；：》」』”’"']/.test(ch)){
            trailing = ch + trailing;
            url = url.slice(0, -1);
            continue;
          }
          break;
        }

        matches.push({ start, end: start + full.length, url, trailing });
      }
    }

    const applyMentions = (chunk)=>{
      if(!mentionify){
        frag.appendChild(doc.createTextNode(chunk));
        return;
      }
      let last = 0;
      for(const m of chunk.matchAll(mentionRe)){
        const s = m.index ?? 0;
        const pre = String(m[1] || '');
        const name = String(m[2] || '').trim();
        frag.appendChild(doc.createTextNode(chunk.slice(last, s)));
        if(pre) frag.appendChild(doc.createTextNode(pre));
        const span = doc.createElement('span');
        span.className = 'mention';
        span.textContent = `@${name}`;
        frag.appendChild(span);
        last = s + String(m[0] || '').length;
      }
      frag.appendChild(doc.createTextNode(chunk.slice(last)));
    };

    if(!matches.length){
      applyMentions(raw);
      textNode.replaceWith(frag);
      return;
    }

    // Merge overlapping matches (rare)
    matches.sort((a,b)=>a.start-b.start);

    for(const m of matches){
      if(m.start < idx) continue;
      const before = raw.slice(idx, m.start);
      if(before) applyMentions(before);

      if(m.url){
        const a = doc.createElement('a');
        a.className = 'auto-link';
        const href = m.url.startsWith('www.') ? `https://${m.url}` : m.url;
        a.setAttribute('href', href);
        a.setAttribute('target','_blank');
        a.setAttribute('rel','noopener noreferrer');
        a.textContent = m.url;
        frag.appendChild(a);
      }
      if(m.trailing) frag.appendChild(doc.createTextNode(m.trailing));
      idx = m.end;
    }

    if(idx < raw.length){
      applyMentions(raw.slice(idx));
    }

    textNode.replaceWith(frag);
  });
}

export function normalizePastedHtml({ html='', text='', mode='comment' } = {}){
  const m = String(mode || 'comment');

  const rawHtml = String(html || '').trim();
  const rawText = String(text || '').trim();

  if(rawHtml){
    const cleaned = detectOfficeHtml(rawHtml) ? _cleanOfficeHtml(rawHtml) : rawHtml;
    return sanitizeHtml(cleaned, { mode: m });
  }

  if(rawText){
    const asHtml = _textToHtml(rawText);
    return sanitizeHtml(asHtml, { mode: m });
  }

  return '';
}

export function renderSafeHtml(inputHtml, opts={}){
  const safe = sanitizeHtml(String(inputHtml || ''), opts);
  if(!safe) return '';
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="_ks_root">${safe}</div>`, 'text/html');
  const root = doc.getElementById('_ks_root');
  if(!root) return safe;
  _wrapTables(root);
  _linkifyAndMentionify(root, opts);
  return root.innerHTML;
}

export function htmlToPlainText(inputHtml){
  const html = String(inputHtml || '').trim();
  if(!html) return '';
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const txt = String(doc.body?.textContent || '').replace(/\u00a0/g,' ');
  return txt.replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}

export function getDefaultPalette(){
  return {
    textColors: _DEFAULT_TEXT_COLORS.slice(),
    hilites: _DEFAULT_HILITES.slice(),
  };
}
