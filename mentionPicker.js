// Mention picker (v7.2)
//
// Requires Supabase SQL migration:
//   public.search_doctors(_q text, _limit int)
//
// Usage:
//   const p = await pickDoctor({ title: '@医生', placeholder: '搜索姓名…' });
//   if(p) insertAtCursor(textarea, formatMention(p));

import { supabase, ensureSupabase, isConfigured, toast } from './supabaseClient.js?v=20260128_030';

function esc(str){
  return String(str ?? '').replace(/[&<>"']/g, s => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[s]));
}

let mounted = false;
let modalEl = null;
let overlayEl = null;
let titleEl = null;
let inputEl = null;
let listEl = null;
let hintEl = null;
let closeBtn = null;

function ensureMounted(){
  if(mounted) return;
  mounted = true;

  modalEl = document.createElement('div');
  modalEl.className = 'modal';
  modalEl.id = 'mentionPickerModal';
  modalEl.hidden = true;
  modalEl.innerHTML = `
    <div class="modal-panel" style="max-width:560px">
      <div class="modal-head">
        <div style="min-width:0">
          <b id="mpTitle">@医生</b>
          <div class="small muted" id="mpHint" style="margin-top:4px">输入关键字搜索</div>
        </div>
        <div>
          <button class="modal-close" type="button" id="mpClose">关闭</button>
        </div>
      </div>
      <div class="hr"></div>
      <div class="form" style="padding-top:0">
        <input class="input" id="mpInput" placeholder="搜索医生姓名…" autocomplete="off" />
        <div id="mpList" style="margin-top:10px"></div>
        <div class="small muted" style="margin-top:10px">提示：选择后会插入 @ 提及到输入框。</div>
      </div>
    </div>
  `;
  document.body.appendChild(modalEl);

  overlayEl = modalEl; // click outside = close
  titleEl = modalEl.querySelector('#mpTitle');
  inputEl = modalEl.querySelector('#mpInput');
  listEl = modalEl.querySelector('#mpList');
  hintEl = modalEl.querySelector('#mpHint');
  closeBtn = modalEl.querySelector('#mpClose');
}

export function formatMention(p){
  const name = String(p?.full_name || p?.name || '').trim() || '医生';
  // UX: composing should only show the readable name.
  // (Old versions used: @[Name](uuid) which is visually noisy.)
  return `@${name}`;
}

export function insertAtCursor(textarea, text){
  const el = textarea;
  if(!el) return;
  const t = String(text || '');
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  el.value = before + t + after;
  const next = start + t.length;
  el.setSelectionRange(next, next);
  el.focus();
}

function rowHtml(p){
  const name = String(p?.full_name || '').trim() || '医生';
  const role = String(p?.role || '').trim();
  const avatar = String(p?.avatar_url || '').trim();
  const badge = role ? `<span class="badge mini">${esc(role.replace('_',' '))}</span>` : '';

  return `
    <button type="button" class="mention-row" data-pick="${esc(p?.id || '')}">
      <div class="mention-avatar">${avatar ? `<img alt="avatar" src="${esc(avatar)}"/>` : esc(name.slice(0,1).toUpperCase())}</div>
      <div class="mention-main">
        <div class="mention-name">${esc(name)} ${badge}</div>
      </div>
      <div class="mention-cta">选择</div>
    </button>
  `;
}

export async function pickDoctor(opts={}){
  const title = String(opts?.title || '@医生');
  const placeholder = String(opts?.placeholder || '搜索医生姓名…');
  const rpc = String(opts?.rpc || 'search_doctors');
  const limit = Number(opts?.limit || 10);

  if(!isConfigured()){
    toast('未配置 Supabase', '请先在 assets/config.js 填写 Supabase 配置。', 'err');
    return null;
  }

  if(!supabase) await ensureSupabase();
  if(!supabase){
    toast('认证服务不可用', 'Supabase 初始化失败。', 'err');
    return null;
  }

  ensureMounted();

  titleEl.textContent = title;
  hintEl.textContent = '输入关键字搜索（支持模糊匹配）';
  inputEl.placeholder = placeholder;
  inputEl.value = '';
  listEl.innerHTML = '<div class="small muted">请输入 1 个以上字符开始搜索…</div>';

  modalEl.hidden = false;
  setTimeout(()=> inputEl.focus(), 0);

  return new Promise((resolve)=>{
    let alive = true;
    let timer = null;

    function cleanup(val){
      alive = false;
      if(timer) clearTimeout(timer);
      modalEl.hidden = true;
      inputEl.value = '';
      listEl.innerHTML = '';
      inputEl.removeEventListener('input', onInput);
      listEl.removeEventListener('click', onPick);
      closeBtn.removeEventListener('click', onClose);
      modalEl.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onKey);
      resolve(val || null);
    }

    async function doSearch(q){
      if(!alive) return;
      const term = String(q || '').trim();
      if(term.length < 1){
        listEl.innerHTML = '<div class="small muted">请输入 1 个以上字符开始搜索…</div>';
        return;
      }

      listEl.innerHTML = '<div class="small muted">搜索中…</div>';
      try{
        const { data, error } = await supabase.rpc(rpc, { _q: term, _limit: Math.max(1, Math.min(limit, 20)) });
        if(error) throw error;
        const rows = Array.isArray(data) ? data : [];
        if(!rows.length){
          listEl.innerHTML = '<div class="small muted">未找到匹配的医生。</div>';
          return;
        }
        listEl.innerHTML = `<div class="mention-list">${rows.map(rowHtml).join('')}</div>`;
      }catch(e){
        const msg = String(e?.message || e || '');
        listEl.innerHTML = `<div class="small muted">搜索失败：${esc(msg)}</div>`;
      }
    }

    function onInput(){
      if(!alive) return;
      const q = inputEl.value;
      if(timer) clearTimeout(timer);
      timer = setTimeout(()=> doSearch(q), 250);
    }

    function onPick(e){
      const btn = e.target?.closest?.('[data-pick]');
      if(!btn) return;
      const id = String(btn.getAttribute('data-pick') || '').trim();
      if(!id) return;
      // Extract name from DOM to avoid another fetch
      const nameEl = btn.querySelector('.mention-name');
      const full = String(nameEl?.textContent || '').trim();
      const name = full.replace(/\s+\b(doctor|doctor_verified|doctor_pending|moderator|admin|super_admin|owner)\b.*/i,'').trim();
      cleanup({ id, full_name: name || full });
    }

    function onClose(){ cleanup(null); }
    function onOverlay(e){ if(e.target === modalEl) cleanup(null); }
    function onKey(e){ if(e.key === 'Escape') cleanup(null); }

    inputEl.addEventListener('input', onInput);
    listEl.addEventListener('click', onPick);
    closeBtn.addEventListener('click', onClose);
    modalEl.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onKey);
  });
}
