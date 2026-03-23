/**
 * admin-commerce-config.js — 系统配置模块
 */
import { supabase, toast } from './supabaseClient.js?v=20260322_001';
import { esc } from './admin-commerce.js?v=20260322_001';

const CONFIG_GROUPS = [
  { title: '支付设置', keys: ['wechat_pay_qr_url', 'alipay_pay_qr_url', 'bank_name', 'bank_account', 'bank_account_name', 'payment_notice'] },
  { title: '会员设置', keys: ['membership_enabled', 'membership_monthly_price', 'membership_yearly_price'] },
  { title: '课程定价', keys: ['specialty_bundle_default_price', 'single_video_default_price', 'bundle_auto_upgrade_enabled'] },
  { title: '公司信息', keys: ['company_name', 'contact_wechat', 'contact_email'] },
  { title: '退款政策', keys: ['refund_policy'] },
];

let _configData = {};

async function loadConfig() {
  const wrap = document.getElementById('configForm');
  if (!wrap) return;

  const { data, error } = await supabase.from('system_config').select('*').order('key');
  if (error) {
    wrap.innerHTML = `<div class="note">${esc(error.message)}</div>`;
    return;
  }

  _configData = {};
  (data || []).forEach(r => { _configData[r.key] = r; });

  let html = '';
  const usedKeys = new Set();

  for (const group of CONFIG_GROUPS) {
    html += `<h4 style="margin:16px 0 8px">${esc(group.title)}</h4><div class="grid cols-2" style="gap:8px">`;
    for (const key of group.keys) {
      usedKeys.add(key);
      const item = _configData[key] || { key, value: '', description: key };
      const desc = item.description || key;
      const isBool = key.endsWith('_enabled');
      if (isBool) {
        html += `
          <label class="small">${esc(desc)}
            <select class="input" data-config-key="${esc(key)}">
              <option value="true" ${item.value === 'true' ? 'selected' : ''}>开启</option>
              <option value="false" ${item.value !== 'true' ? 'selected' : ''}>关闭</option>
            </select>
          </label>`;
      } else if (key.endsWith('_policy') || key.endsWith('_notice')) {
        html += `
          <label class="small" style="grid-column:1/-1">${esc(desc)}
            <textarea class="input" data-config-key="${esc(key)}" rows="2">${esc(item.value || '')}</textarea>
          </label>`;
      } else {
        html += `
          <label class="small">${esc(desc)}
            <input class="input" data-config-key="${esc(key)}" value="${esc(item.value || '')}" />
          </label>`;
      }
    }
    html += '</div>';
  }

  // Show any remaining keys not in groups
  const remaining = Object.keys(_configData).filter(k => !usedKeys.has(k));
  if (remaining.length) {
    html += `<h4 style="margin:16px 0 8px">其他配置</h4><div class="grid cols-2" style="gap:8px">`;
    for (const key of remaining) {
      const item = _configData[key];
      html += `
        <label class="small">${esc(item.description || key)}
          <input class="input" data-config-key="${esc(key)}" value="${esc(item.value || '')}" />
        </label>`;
    }
    html += '</div>';
  }

  html += `<div style="margin-top:16px"><button class="btn primary" id="saveConfigBtn" type="button">保存全部配置</button></div>`;
  wrap.innerHTML = html;

  document.getElementById('saveConfigBtn')?.addEventListener('click', saveConfig);
}

async function saveConfig() {
  const els = document.querySelectorAll('[data-config-key]');
  let count = 0;
  let errCount = 0;

  for (const el of els) {
    const key = el.dataset.configKey;
    const value = el.value ?? '';
    const old = _configData[key]?.value ?? '';
    if (value === old) continue;

    const { error } = await supabase.rpc('admin_update_config', { p_key: key, p_value: value });
    if (error) {
      console.error(`Config save error for ${key}:`, error);
      errCount++;
    } else {
      count++;
    }
  }

  if (errCount) {
    toast('部分失败', `${count} 项已保存，${errCount} 项失败。`, 'err');
  } else if (count) {
    toast('已保存', `${count} 项配置已更新。`, 'ok');
  } else {
    toast('无变更', '没有修改任何配置。', 'ok');
  }

  loadConfig();
}

export function init() {
  document.getElementById('refreshConfig')?.addEventListener('click', loadConfig);
  document.getElementById('panel-config')?.addEventListener('panel:show', loadConfig);
}
