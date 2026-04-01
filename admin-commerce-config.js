/**
 * admin-commerce-config.js — 系统配置模块（含收款码图片上传）
 */
import { supabase, toast } from './supabaseClient.js?v=20260401_fix';
import { esc } from './admin-commerce.js?v=20260325_001';

/* keys that should render as image-upload fields */
const IMAGE_KEYS = new Set(['wechat_pay_qr_url', 'alipay_pay_qr_url']);

const IMAGE_LABELS = {
  wechat_pay_qr_url: '微信收款码',
  alipay_pay_qr_url: '支付宝收款码',
};

const CONFIG_GROUPS = [
  { title: '支付设置', keys: ['wechat_pay_qr_url', 'alipay_pay_qr_url', 'bank_name', 'bank_account', 'bank_account_name', 'payment_notice'] },
  { title: '会员设置', keys: ['membership_enabled', 'membership_monthly_price', 'membership_yearly_price'] },
  { title: '课程定价', keys: ['specialty_bundle_default_price', 'single_video_default_price', 'bundle_auto_upgrade_enabled'] },
  { title: '公司信息', keys: ['company_name', 'contact_wechat', 'contact_email'] },
  { title: '退款政策', keys: ['refund_policy'] },
];

let _configData = {};

/* ── image upload helper ── */
async function uploadQrImage(file, key) {
  const bucket = 'sponsor_logos';
  const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
  const path = `qr-codes/${key}_${Date.now()}.${ext}`;

  const { error: upErr } = await supabase.storage.from(bucket).upload(path, file, {
    upsert: true,
    contentType: file.type || 'image/png',
  });
  if (upErr) throw upErr;

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

/* ── render image upload field ── */
function renderImageField(key, value) {
  const label = IMAGE_LABELS[key] || key;
  const hasImage = !!value;
  return `
    <div class="small" style="grid-column:1/-1" data-image-field="${esc(key)}">
      <div style="margin-bottom:6px"><b>${esc(label)}</b></div>
      <div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">
        <!-- preview -->
        <div style="width:160px;min-height:80px;border-radius:10px;overflow:hidden;background:rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center">
          ${hasImage
            ? `<img src="${esc(value)}" alt="${esc(label)}" style="max-width:160px;max-height:200px;border-radius:10px" data-preview-img="${esc(key)}" />`
            : `<span class="muted small" data-preview-img="${esc(key)}">未上传</span>`}
        </div>
        <!-- controls -->
        <div style="flex:1;min-width:200px">
          <input type="file" accept="image/*" id="fileInput_${key}" style="display:none" />
          <button class="btn tiny primary" type="button" data-upload-btn="${esc(key)}">上传图片</button>
          ${hasImage ? `<button class="btn tiny danger" type="button" data-clear-btn="${esc(key)}" style="margin-left:6px">清除</button>` : ''}
          <div class="small muted" style="margin-top:6px" data-upload-status="${esc(key)}">支持 JPG / PNG，建议 400×400 以上</div>
          <!-- hidden input holds the URL value for saveConfig -->
          <input type="hidden" data-config-key="${esc(key)}" value="${esc(value || '')}" />
        </div>
      </div>
    </div>`;
}

/* ── load config ── */
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

      if (IMAGE_KEYS.has(key)) {
        html += renderImageField(key, item.value || '');
      } else if (isBool) {
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
  bindImageUploads();
}

/* ── bind upload / clear buttons ── */
function bindImageUploads() {
  for (const key of IMAGE_KEYS) {
    const uploadBtn = document.querySelector(`[data-upload-btn="${key}"]`);
    const clearBtn = document.querySelector(`[data-clear-btn="${key}"]`);
    const fileInput = document.getElementById(`fileInput_${key}`);

    uploadBtn?.addEventListener('click', () => fileInput?.click());

    fileInput?.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;

      const status = document.querySelector(`[data-upload-status="${key}"]`);
      status.textContent = '上传中…';
      uploadBtn.disabled = true;

      try {
        const url = await uploadQrImage(file, key);
        // Update hidden input value
        const hidden = document.querySelector(`input[data-config-key="${key}"]`);
        if (hidden) hidden.value = url;
        // Update preview
        const previewArea = document.querySelector(`[data-preview-img="${key}"]`);
        if (previewArea) {
          if (previewArea.tagName === 'IMG') {
            previewArea.src = url;
          } else {
            previewArea.outerHTML = `<img src="${esc(url)}" alt="${esc(IMAGE_LABELS[key] || key)}" style="max-width:160px;max-height:200px;border-radius:10px" data-preview-img="${esc(key)}" />`;
          }
        }
        status.textContent = '已上传，记得点"保存全部配置"生效。';
        toast('上传成功', `${IMAGE_LABELS[key]}已上传`, 'ok');
      } catch (err) {
        status.textContent = `上传失败: ${err.message}`;
        toast('上传失败', err.message, 'err');
      } finally {
        uploadBtn.disabled = false;
        fileInput.value = '';
      }
    });

    clearBtn?.addEventListener('click', () => {
      const hidden = document.querySelector(`input[data-config-key="${key}"]`);
      if (hidden) hidden.value = '';
      const previewArea = document.querySelector(`[data-preview-img="${key}"]`);
      if (previewArea) {
        previewArea.outerHTML = `<span class="muted small" data-preview-img="${esc(key)}">未上传</span>`;
      }
      clearBtn.remove();
      const status = document.querySelector(`[data-upload-status="${key}"]`);
      if (status) status.textContent = '已清除，记得点"保存全部配置"生效。';
    });
  }
}

/* ── save config ── */
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
