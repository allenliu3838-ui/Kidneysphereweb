/**
 * nephro-pro.js — 肾域 Pro 落地页逻辑
 *
 * 渲染 Hero 区下的 Paywall 门、六大模块卡片、合规说明。
 * 用 canAccessNephroPro() 判定按钮文案与跳转：
 *   已付费 → 进入对应模块（atlas 模块跳 atlas.html, 其他模块"敬请期待"）
 *   未付费 → 升级 CTA
 */

import {
  ensureSupabase,
  supabase,
  getCurrentUser,
  canAccessNephroPro,
} from './supabaseClient.js?v=20260401_fix';
import { NEPHRO_PRO_MODULES } from './nephro-pro-data.js';
import { renderNephroProGate } from './paywall.js';

function esc(s){
  return String(s||'').replace(/[&<>\"']/g, m => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]
  ));
}

function moduleCard(m, hasAccess){
  const isLive = m.status === 'live';
  let ctaHtml;
  if(isLive){
    ctaHtml = `<a class="btn primary tiny" href="${esc(m.href)}">${hasAccess ? '进入' : '查看预览'}</a>`;
  } else if(hasAccess){
    ctaHtml = '<span class="small muted">敬请期待</span>';
  } else {
    ctaHtml = '<span class="small muted">开通后将逐步上线</span>';
  }

  const sampleItems = (m.items || []).slice(0, 3).map(item => `
    <li style="margin-bottom:4px;">
      <span>${esc(item.title)}</span>
      <span class="badge" style="margin-left:6px;font-size:11px;">${esc(item.evidenceLevel || '')}</span>
    </li>
  `).join('');

  return `
    <article class="card" style="padding:16px;display:flex;flex-direction:column;gap:8px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:28px;line-height:1;">${m.icon}</span>
        <div style="flex:1;">
          <h3 style="margin:0;">${esc(m.title)}</h3>
          ${!isLive ? '<span class="small muted">敬请期待</span>' : '<span class="small" style="color:#4ade80;">已上线</span>'}
        </div>
      </div>
      <p style="margin:4px 0 0 0;">${esc(m.summary)}</p>
      ${sampleItems ? `<ul style="margin:6px 0 0 0;padding-left:18px;font-size:13px;color:inherit;opacity:.9;">${sampleItems}</ul>` : ''}
      <div style="margin-top:auto;padding-top:8px;">${ctaHtml}</div>
    </article>
  `;
}

function renderModules(hasAccess){
  const container = document.getElementById('nephroProModules');
  if(!container) return;
  container.innerHTML = NEPHRO_PRO_MODULES.map(m => moduleCard(m, hasAccess)).join('');
}

async function init(){
  await ensureSupabase();
  if(!supabase) return;

  const gateEl = document.getElementById('nephroProGate');
  await renderNephroProGate(gateEl, { enterUrl: 'atlas.html' });

  // determine access for module card states
  let hasAccess = false;
  try {
    const user = await getCurrentUser();
    if(user) hasAccess = await canAccessNephroPro(user);
  } catch(_e){}

  renderModules(hasAccess);
}

init().catch(err => console.warn('[nephro-pro.js]', err));
