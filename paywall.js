/**
 * paywall.js — 通用 Paywall 组件
 *
 * 用法：
 *   import { renderNephroProGate } from './paywall.js';
 *   await renderNephroProGate(document.getElementById('gate'));
 *
 * 三种状态：
 *   未登录       → 提示登录, 列出权益
 *   已登录未付费 → 提示开通教育会员, 列出权益, CTA 跳 checkout
 *   已付费       → 显示已解锁, CTA 跳 atlas.html (或调用方指定)
 */

import {
  ensureSupabase,
  getCurrentUser,
  canAccessNephroPro,
} from './supabaseClient.js?v=20260401_fix';
import { NEPHRO_PRO_BENEFITS } from './nephro-pro-data.js';

function esc(s){
  return String(s||'').replace(/[&<>\"']/g, m => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]
  ));
}

function benefitList(items){
  return `<ul style="margin:8px 0 0 0;padding-left:18px;line-height:1.7;">${
    items.map(b => `<li>${esc(b)}</li>`).join('')
  }</ul>`;
}

export async function renderNephroProGate(container, opts = {}){
  if(!container) return;
  const benefits = opts.benefits || NEPHRO_PRO_BENEFITS;
  const enterUrl = opts.enterUrl || 'atlas.html';
  const upgradeUrl = opts.upgradeUrl || 'checkout.html?product=MEMBERSHIP-YEARLY';
  const loginUrl = opts.loginUrl || 'login.html?next=' + encodeURIComponent(location.pathname);

  container.innerHTML = '<div class="small muted">正在校验权限…</div>';

  try { await ensureSupabase(); } catch {}
  const user = await getCurrentUser().catch(() => null);

  if(!user){
    container.innerHTML = `
      <div style="padding:14px 16px;border:1px solid rgba(168,85,247,.25);background:rgba(168,85,247,.05);border-radius:10px;">
        <div style="font-weight:600;margin-bottom:4px;">登录后可查看你的会员权益</div>
        <div class="small muted">开通后即可解锁肾域 Pro 全部内容：</div>
        ${benefitList(benefits)}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
          <a class="btn primary" href="${esc(loginUrl)}">登录</a>
          <a class="btn" href="register.html">注册</a>
        </div>
      </div>
    `;
    return { state: 'guest', user: null };
  }

  const hasAccess = await canAccessNephroPro(user);

  if(hasAccess){
    container.innerHTML = `
      <div style="padding:14px 16px;border:1px solid rgba(34,197,94,.4);background:rgba(34,197,94,.08);border-radius:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div>
            <div style="font-weight:600;color:#4ade80;">✓ 已开通肾域 Pro</div>
            <div class="small muted" style="margin-top:2px;">你的 GlomCon 教育会员 / 项目学员身份已解锁全部肾域 Pro 内容。</div>
          </div>
          <a class="btn primary" href="${esc(enterUrl)}">进入肾域 Pro</a>
        </div>
      </div>
    `;
    return { state: 'unlocked', user };
  }

  container.innerHTML = `
    <div style="padding:14px 16px;border:1px solid rgba(168,85,247,.25);background:rgba(168,85,247,.05);border-radius:10px;">
      <div style="font-weight:600;margin-bottom:4px;">开通 GlomCon 教育会员即可解锁肾域 Pro</div>
      <div class="small muted">教育会员权益包含视频学习、病例讨论与下方全部肾域 Pro 内容：</div>
      ${benefitList(benefits)}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
        <a class="btn primary" href="${esc(upgradeUrl)}">开通 GlomCon 教育会员 ¥299/年</a>
        <a class="btn" href="academy.html#membership">了解会员详情</a>
      </div>
    </div>
  `;
  return { state: 'locked', user };
}
