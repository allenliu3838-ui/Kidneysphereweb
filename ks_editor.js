// ks_editor.js
// A lightweight Word-like editor for KidneySphere (no external deps).
//
// Notes
// - Uses contenteditable + execCommand (deprecated but still widely supported).
// - All pasted and exported HTML is sanitized by ks_richtext.js.
// - Keeps an underlying <textarea> hidden for backward-compatible pipelines.

import {
  normalizePastedHtml,
  sanitizeHtml,
  htmlToPlainText,
  getDefaultPalette,
} from './ks_richtext.js?v=20260213_001';

function _el(tag, attrs={}, html=null){
  const e = document.createElement(tag);
  for(const [k,v] of Object.entries(attrs || {})){
    if(v === null || typeof v === 'undefined') continue;
    if(k === 'class') e.className = String(v);
    else if(k === 'dataset'){
      for(const [dk,dv] of Object.entries(v || {})) e.dataset[dk] = String(dv);
    }else{
      e.setAttribute(k, String(v));
    }
  }
  if(html !== null) e.innerHTML = html;
  return e;
}

function _esc(s){
  // Minimal HTML escape for user text inserted into HTML snippets.
  return String(s ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

let _navVarBound = false;
let _navVarTimer = null;
function _ensureNavHeightVar(){
  const update = ()=>{
    try{
      const nav = document.querySelector('.nav');
      const h = nav ? Math.ceil(nav.getBoundingClientRect().height || 0) : 0;
      document.documentElement.style.setProperty('--ks-nav-h', `${h}px`);
    }catch(_e){}
  };
  update();
  if(_navVarBound) return;
  _navVarBound = true;

  const onResize = ()=>{
    if(_navVarTimer) clearTimeout(_navVarTimer);
    _navVarTimer = setTimeout(update, 120);
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', ()=> setTimeout(update, 200));
}

function _exec(cmd, value=null){
  try{
    if(value === null || typeof value === 'undefined') document.execCommand(cmd);
    else document.execCommand(cmd, false, value);
    return true;
  }catch(_e){
    return false;
  }
}

function _insertHtmlAtCursor(html){
  // Try execCommand first
  if(_exec('insertHTML', html)) return true;
  // Fallback: Range API
  try{
    const sel = window.getSelection();
    if(!sel || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const temp = document.createElement('div');
    temp.innerHTML = html;
    const frag = document.createDocumentFragment();
    let node;
    let last = null;
    while((node = temp.firstChild)){
      last = frag.appendChild(node);
    }
    range.insertNode(frag);
    if(last){
      range.setStartAfter(last);
      range.setEndAfter(last);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return true;
  }catch(_e){
    return false;
  }
}

function _formatBlock(tag){
  const t = String(tag || '').toLowerCase();
  if(!t) return;
  _exec('formatBlock', `<${t}>`);
}

function _promptUrl(){
  const raw = prompt('请输入链接（https://...）');
  if(raw === null) return null;
  let url = String(raw || '').trim();
  if(!url) return '';
  if(/^https?:\/\//i.test(url)) return url;
  if(/^www\./i.test(url)) return `https://${url}`;
  return '';
}

function _makePalettePopover({ colors, onPick }){
  const pop = _el('div', { class: 'ks-editor-pop', hidden: 'true' });
  const grid = _el('div', { class: 'ks-editor-pop-grid' });
  for(const c of colors){
    const btn = _el('button', {
      type: 'button',
      class: 'ks-editor-swatch',
      title: c,
      style: `background:${c};`,
    });
    btn.addEventListener('click', ()=> onPick(c));
    grid.appendChild(btn);
  }
  pop.appendChild(grid);
  return pop;
}

function _togglePopover(pop, anchorBtn){
  if(!pop) return;
  const show = pop.hasAttribute('hidden');
  // Close all
  document.querySelectorAll('.ks-editor-pop').forEach(p=> p.setAttribute('hidden','true'));
  if(!show) return;
  pop.removeAttribute('hidden');
  try{
    const r = anchorBtn.getBoundingClientRect();
    pop.style.left = `${Math.max(8, r.left)}px`;
    pop.style.top = `${Math.max(8, r.bottom + 6)}px`;
  }catch(_e){}
}

export function mountKSEditor(textarea, opts={}){
  const src = textarea;
  if(!src) return null;

  // Make sure the sticky toolbar offsets correctly below the site header.
  _ensureNavHeightVar();

  const mode = String(opts.mode || 'comment'); // 'article' | 'comment'
  const placeholder = String(opts.placeholder || (mode === 'article' ? '在这里写正文…' : '写点什么…'));
  const syncToTextarea = Boolean(opts.syncToTextarea);

  const palette = getDefaultPalette();
  const textColors = Array.isArray(opts.textColors) ? opts.textColors : palette.textColors;
  const hilites = Array.isArray(opts.hilites) ? opts.hilites : palette.hilites;

  // Root
  const root = _el('div', { class: `ks-editor ${mode === 'article' ? 'is-article' : 'is-comment'}` });
  const toolbar = _el('div', { class: 'ks-editor-toolbar', role: 'toolbar' });
  const surface = _el('div', {
    class: 'ks-editor-surface ks-prose',
    contenteditable: 'true',
    spellcheck: 'true',
    'data-placeholder': placeholder,
  });

  // Block select
  const blockSel = _el('select', { class: 'ks-editor-select', title: '段落/标题' });
  const blockOpts = (mode === 'article')
    ? [ ['p','正文'], ['h1','标题 H1'], ['h2','标题 H2'], ['h3','标题 H3'], ['blockquote','引用'] ]
    : [ ['p','正文'], ['h2','标题'], ['h3','小标题'], ['blockquote','引用'] ];
  for(const [v, label] of blockOpts){
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    blockSel.appendChild(o);
  }

  // Font size select (Word-like "字号")
  // We only provide a small controlled set to keep the site typography consistent.
  const sizeSel = _el('select', { class: 'ks-editor-select ks-editor-fontsize', title: '字号' });
  const sizeOpts = [
    ['default','16（默认）'],
    ['12','12'],
    ['14','14'],
    ['18','18'],
    ['20','20'],
  ];
  for(const [v, label] of sizeOpts){
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    sizeSel.appendChild(o);
  }

  const btn = (label, title, act)=> _el('button', { type:'button', class:'ks-editor-btn', title, dataset:{ act } }, label);

  const bBold = btn('B', '加粗', 'bold');
  const bItalic = btn('I', '斜体', 'italic');
  const bUnder = btn('U', '下划线', 'underline');
  const bStrike = btn('S', '删除线', 'strike');
  const bUl = btn('• 列表', '无序列表', 'ul');
  const bOl = btn('1. 列表', '有序列表', 'ol');
  const bLeft = btn('⟸', '左对齐', 'left');
  const bCenter = btn('≡', '居中', 'center');
  const bRight = btn('⟹', '右对齐', 'right');
  const bColor = btn('A', '文字颜色', 'color');
  const bHilite = btn('🖍️', '高亮', 'hilite');
  const bLink = btn('🔗', '插入链接', 'link');
  const bUnlink = btn('⛔', '取消链接', 'unlink');
  const bCode = btn('</>', '代码块', 'code');
  const bHr = btn('—', '分割线', 'hr');
  const bUndo = btn('↶', '撤销', 'undo');
  const bRedo = btn('↷', '重做', 'redo');
  const bClear = btn('🧹', '清除格式', 'clear');

  const popColor = _makePalettePopover({
    colors: textColors,
    onPick: (c)=>{
      surface.focus();
      _exec('foreColor', c);
      popColor.setAttribute('hidden','true');
    }
  });
  const popHilite = _makePalettePopover({
    colors: hilites,
    onPick: (c)=>{
      surface.focus();
      if(!_exec('hiliteColor', c)) _exec('backColor', c);
      popHilite.setAttribute('hidden','true');
    }
  });

  // Toolbar layout
  toolbar.appendChild(blockSel);
  toolbar.appendChild(sizeSel);
  toolbar.appendChild(bBold);
  toolbar.appendChild(bItalic);
  toolbar.appendChild(bUnder);
  toolbar.appendChild(bStrike);
  toolbar.appendChild(_el('span', { class:'ks-editor-sep' }));
  toolbar.appendChild(bUl);
  toolbar.appendChild(bOl);
  toolbar.appendChild(_el('span', { class:'ks-editor-sep' }));
  toolbar.appendChild(bLeft);
  toolbar.appendChild(bCenter);
  toolbar.appendChild(bRight);
  toolbar.appendChild(_el('span', { class:'ks-editor-sep' }));
  toolbar.appendChild(bColor);
  toolbar.appendChild(bHilite);
  toolbar.appendChild(_el('span', { class:'ks-editor-sep' }));
  toolbar.appendChild(bLink);
  toolbar.appendChild(bUnlink);
  toolbar.appendChild(bCode);
  if(mode === 'article') toolbar.appendChild(bHr);
  toolbar.appendChild(_el('span', { class:'ks-editor-sep' }));
  toolbar.appendChild(bUndo);
  toolbar.appendChild(bRedo);
  toolbar.appendChild(bClear);

  root.appendChild(toolbar);
  root.appendChild(surface);
  document.body.appendChild(popColor);
  document.body.appendChild(popHilite);

  // Replace textarea in-place (keep textarea hidden for compatibility)
  src.style.display = 'none';
  src.insertAdjacentElement('afterend', root);

  // Seed initial value
  try{
    const initText = String(src.value || '').trim();
    surface.innerHTML = initText ? normalizePastedHtml({ text: initText, mode }) : '';
  }catch(_e){
    surface.innerHTML = '';
  }

  function _sync(){
    if(!syncToTextarea) return;
    src.value = getPlainText();
  }

  function getHtml(){
    return sanitizeHtml(surface.innerHTML, { mode });
  }

  function getPlainText(){
    return htmlToPlainText(getHtml());
  }

  function setHtml(html){
    surface.innerHTML = sanitizeHtml(String(html || ''), { mode });
    _sync();
  }

  function insertHtml(html){
    const safe = sanitizeHtml(String(html || ''), { mode });
    surface.focus();
    _insertHtmlAtCursor(safe);
    _sync();
  }

  function insertText(text){
    const t = String(text || '');
    surface.focus();
    if(!_exec('insertText', t)){
      _insertHtmlAtCursor(_esc(t).replace(/\n/g,'<br/>'));
    }
    _sync();
  }

  function clean(){
    setHtml(getHtml());
  }

  // --- Font size helpers (Word-like "字号") ---
  const _SIZE_CLASSES = ['ks-fs-12','ks-fs-14','ks-fs-18','ks-fs-20'];

  function _clearSizeClasses(el){
    if(!el || !el.classList) return;
    for(const c of _SIZE_CLASSES) el.classList.remove(c);
  }

  function _applySizeClass(el, cls){
    if(!el || !el.classList) return;
    _clearSizeClasses(el);
    if(cls) el.classList.add(cls);
  }

  function _getSelectionRange(){
    try{
      const sel = window.getSelection();
      if(!sel || !sel.rangeCount) return null;
      return sel.getRangeAt(0);
    }catch(_e){
      return null;
    }
  }

  function _getCurrentBlock(){
    const r = _getSelectionRange();
    if(!r) return null;
    let node = r.startContainer;
    if(node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const el = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    const blk = el?.closest?.('p,h1,h2,h3,blockquote,li,pre');
    if(!blk || !surface.contains(blk)) return null;
    return blk;
  }

  function _collectBlocksInRange(range){
    const blocks = [];
    if(!range) return blocks;
    const candidates = surface.querySelectorAll('p,h1,h2,h3,blockquote,li');
    for(const el of Array.from(candidates)){
      try{
        if(range.intersectsNode(el)) blocks.push(el);
      }catch(_e){
        // ignore
      }
    }
    return blocks;
  }

  function _activeSizeValue(){
    const r = _getSelectionRange();
    if(!r) return 'default';
    let node = r.startContainer;
    if(node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const el = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if(!el || !surface.contains(el)) return 'default';
    const hit = el.closest?.('.ks-fs-12, .ks-fs-14, .ks-fs-18, .ks-fs-20');
    if(hit && surface.contains(hit)){
      for(const c of _SIZE_CLASSES){
        if(hit.classList.contains(c)) return c.replace('ks-fs-','');
      }
    }
    return 'default';
  }

  function _syncToolbarState(){
    const blk = _getCurrentBlock();
    if(blk){
      const tag = String(blk.tagName || '').toLowerCase();
      if(Array.from(blockSel.options).some(o=>o.value === tag)) blockSel.value = tag;
    }
    sizeSel.value = _activeSizeValue();
  }

  function _applyFontSize(value){
    const v = String(value || 'default');
    const cls = v === 'default' ? '' : `ks-fs-${v}`;
    const r = _getSelectionRange();
    if(!r) return;

    const blocks = _collectBlocksInRange(r);
    if(blocks.length){
      for(const b of blocks) _applySizeClass(b, cls);
      clean();
      _sync();
      _syncToolbarState();
      return;
    }

    const blk = _getCurrentBlock();
    if(blk && blk.tagName !== 'PRE'){
      _applySizeClass(blk, cls);
      clean();
      _sync();
      _syncToolbarState();
    }
  }

  // Events
  surface.addEventListener('input', ()=> _sync());

  // Keep toolbar selects in sync with the caret position.
  surface.addEventListener('focus', ()=> _syncToolbarState());
  surface.addEventListener('keyup', ()=> _syncToolbarState());
  surface.addEventListener('mouseup', ()=> _syncToolbarState());

  const onSelectionChange = ()=>{
    // Only sync when the editable surface is active to avoid interfering with other editors.
    if(document.activeElement === surface) _syncToolbarState();
  };
  document.addEventListener('selectionchange', onSelectionChange);

  surface.addEventListener('keydown', (e)=>{
    // Ctrl/Cmd+K: insert link
    if((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'k'){
      e.preventDefault();
      const url = _promptUrl();
      if(url) _exec('createLink', url);
      return;
    }
  });

  surface.addEventListener('paste', (e)=>{
    const dt = e.clipboardData;
    if(!dt) return;

    // If clipboard contains files, we let outer logic (attachments) handle it.
    // But we still handle text/html + text.
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    if(!html && !text) return;

    e.preventDefault();
    const normalized = normalizePastedHtml({ html, text, mode });
    if(!normalized) return;
    insertHtml(normalized);
  });

  const onDocClick = (e)=>{
    const t = e.target;
    if(t && (t.closest?.('.ks-editor-pop') || t.closest?.('.ks-editor-btn[data-act="color"]') || t.closest?.('.ks-editor-btn[data-act="hilite"]'))) return;
    popColor.setAttribute('hidden','true');
    popHilite.setAttribute('hidden','true');
  };
  document.addEventListener('click', onDocClick);

  toolbar.addEventListener('click', (e)=>{
    const b = e.target?.closest?.('[data-act]');
    if(!b) return;
    const act = String(b.dataset.act || '');
    if(!act) return;
    surface.focus();

    if(act === 'bold') return _exec('bold');
    if(act === 'italic') return _exec('italic');
    if(act === 'underline') return _exec('underline');
    if(act === 'strike') return _exec('strikeThrough');
    if(act === 'ul') return _exec('insertUnorderedList');
    if(act === 'ol') return _exec('insertOrderedList');
    if(act === 'left') return _exec('justifyLeft');
    if(act === 'center') return _exec('justifyCenter');
    if(act === 'right') return _exec('justifyRight');
    if(act === 'undo') return _exec('undo');
    if(act === 'redo') return _exec('redo');
    if(act === 'unlink') return _exec('unlink');
    if(act === 'hr') return insertHtml('<hr/>');

    if(act === 'clear'){
      _exec('removeFormat');
      clean();
      return;
    }

    if(act === 'link'){
      const url = _promptUrl();
      if(!url) return;
      const sel = window.getSelection();
      const hasSel = sel && sel.rangeCount && !sel.getRangeAt(0).collapsed;
      if(!hasSel) insertText(url);
      _exec('createLink', url);
      return;
    }

    if(act === 'code'){
      const sel = window.getSelection();
      const txt = sel && sel.rangeCount ? sel.toString() : '';
      const content = txt ? _esc(txt) : '';
      insertHtml(`<pre class="codeblock"><code>${content}</code></pre><p><br/></p>`);
      return;
    }

    if(act === 'color') return _togglePopover(popColor, b);
    if(act === 'hilite') return _togglePopover(popHilite, b);
  });

  blockSel.addEventListener('change', ()=>{
    const v = String(blockSel.value || 'p');
    surface.focus();
    _formatBlock(v);
    _syncToolbarState();
    _sync();
  });

  sizeSel.addEventListener('change', ()=>{
    surface.focus();
    _applyFontSize(sizeSel.value);
  });

  function destroy(){
    try{ document.removeEventListener('click', onDocClick); }catch(_e){}
    try{ document.removeEventListener('selectionchange', onSelectionChange); }catch(_e){}
    try{ popColor.remove(); }catch(_e){}
    try{ popHilite.remove(); }catch(_e){}
    try{ root.remove(); }catch(_e){}
    try{ src.style.display = ''; }catch(_e){}
  }

  return {
    root,
    surface,
    source: src,
    getHtml,
    getPlainText,
    setHtml,
    insertHtml,
    insertText,
    clean,
    focus: ()=> surface.focus(),
    destroy,
  };
}
