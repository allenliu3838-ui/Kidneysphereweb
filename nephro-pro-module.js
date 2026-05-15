/**
 * nephro-pro-module.js — 肾域 Pro 通用模块详情页
 *
 * URL: nephro-pro-module.html?id=<module-id>
 * 5 个非 atlas 模块共用此模板。数据来源 nephro-pro-data.js。
 *
 * 渲染逻辑：
 *   - 顶部 module header (icon + 标题 + 简介)
 *   - Paywall gate (3 状态：未登录 / 已登录未付费 / 已付费)
 *   - items 网格：免费用户看 cover_url，付费用户看 hd_image_url
 *   - 没图但有 external_link：纯文本卡 + "查看原文 ↗"
 *   - 完全没内容：显示"敬请期待"
 */

import {
  ensureSupabase,
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

function getModuleId(){
  const params = new URLSearchParams(location.search);
  return params.get('id') || params.get('module') || '';
}

function renderHeader(mod){
  const el = document.getElementById('moduleHeader');
  if(!el) return;
  document.title = `${mod.title} · 肾域 Pro`;
  const live = mod.status === 'live';
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:10px;">
      <span style="font-size:36px;line-height:1;">${mod.icon || '📘'}</span>
      <div>
        <h1 style="margin:0;">${esc(mod.title)}</h1>
        <div class="small muted" style="margin-top:2px;">
          肾域 Pro · 六大模块之一
          ${live
            ? '<span class="badge" style="margin-left:6px;color:#4ade80;border-color:rgba(34,197,94,.4);background:rgba(34,197,94,.1);">已上线</span>'
            : '<span class="badge" style="margin-left:6px;color:#fbbf24;border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.08);">敬请期待</span>'}
        </div>
      </div>
    </div>
    <p style="margin:8px 0 0 0;line-height:1.7;">${esc(mod.summary || '')}</p>
  `;
}

function itemCard(item, hasAccess){
  const cover = item.cover_url || '';
  const hd = item.hd_image_url || '';
  const showHD = hasAccess && hd;
  const imgSrc = showHD ? hd : cover;

  let imgHtml = '';
  if(imgSrc){
    imgHtml = `<img src="${esc(imgSrc)}" alt="${esc(item.title || '')}" loading="lazy"
      style="width:100%;border-radius:8px;background:rgba(255,255,255,.04);object-fit:contain;max-height:320px;${showHD ? 'cursor:zoom-in;' : ''}" />`;
  }

  const badges = [];
  if(item.evidenceLevel) badges.push(`<span class="badge">${esc(item.evidenceLevel)}</span>`);
  if(!hasAccess && hd) badges.push('<span class="badge" style="background:rgba(168,85,247,.15);border-color:rgba(168,85,247,.4);color:#c084fc;">高清待解锁</span>');
  if(item.reviewStatus === 'reviewed') badges.push('<span class="badge" style="color:#4ade80;border-color:rgba(34,197,94,.4);background:rgba(34,197,94,.08);">已审核</span>');

  const externalBtn = item.external_link
    ? `<a class="btn tiny" href="${esc(item.external_link)}" target="_blank" rel="noopener">查看原文 ↗</a>`
    : '';

  const upgradeBtn = (!hasAccess && hd)
    ? `<a class="btn primary tiny" href="checkout.html?product=MEMBERSHIP-YEARLY">解锁高清</a>`
    : '';

  return `
    <article class="card" style="padding:14px;display:flex;flex-direction:column;gap:8px;">
      ${imgHtml}
      <h3 style="margin:0;font-size:15px;">${esc(item.title || '')}</h3>
      ${item.summary ? `<p style="margin:0;font-size:13px;opacity:.85;line-height:1.6;">${esc(item.summary)}</p>` : ''}
      ${badges.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;">${badges.join('')}</div>` : ''}
      ${(externalBtn || upgradeBtn) ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:auto;padding-top:6px;">${externalBtn}${upgradeBtn}</div>` : ''}
    </article>
  `;
}

function renderItems(items, hasAccess){
  const el = document.getElementById('moduleItems');
  if(!el) return;
  if(!items || items.length === 0){
    el.innerHTML = '<div class="note">该模块暂无内容，敬请期待。</div>';
    return;
  }
  el.innerHTML = items.map(it => itemCard(it, hasAccess)).join('');
}

function renderNotFound(){
  const main = document.querySelector('main.container');
  if(!main) return;
  main.innerHTML = `
    <div style="padding:60px 20px;text-align:center;">
      <h1 style="margin:0 0 8px 0;">模块不存在</h1>
      <p class="muted">URL 中的 id 参数无效。</p>
      <p style="margin-top:18px;"><a class="btn primary" href="nephro-pro.html">← 返回肾域 Pro</a></p>
    </div>
  `;
}

async function init(){
  await ensureSupabase();

  const id = getModuleId();
  const mod = NEPHRO_PRO_MODULES.find(m => m.id === id);
  if(!mod){
    renderNotFound();
    return;
  }

  renderHeader(mod);

  let hasAccess = false;
  try {
    const user = await getCurrentUser();
    if(user) hasAccess = await canAccessNephroPro(user);
  } catch(_e){}

  // 已付费用户：不显示 paywall（"进入"按钮在自己页面上无意义）
  // 未付费 / 未登录：显示 paywall (gate 内部会自己判定状态)
  const gateEl = document.getElementById('moduleGate');
  if(hasAccess){
    gateEl.hidden = true;
  } else {
    await renderNephroProGate(gateEl);
  }

  renderItems(mod.items, hasAccess);
}

init().catch(err => console.warn('[nephro-pro-module.js]', err));
