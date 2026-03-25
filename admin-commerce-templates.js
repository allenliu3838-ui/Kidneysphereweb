/**
 * admin-commerce-templates.js — 通知模板模块
 */
import { supabase, toast, formatBeijingDateTime } from './supabaseClient.js?v=20260325_001';
import { esc, fmtDate, statusDot, showModal, closeModal } from './admin-commerce.js?v=20260325_001';

const CHANNEL_LABELS = {
  site:  '站内通知',
  email: '邮件',
  sms:   '短信',
};

async function loadTemplates() {
  const wrap = document.getElementById('templatesTableWrap');
  if (!wrap) return;

  const { data, error } = await supabase
    .from('notification_templates')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    wrap.innerHTML = `<div class="note">${esc(error.message)}</div>`;
    return;
  }

  const rows = data || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="muted">暂无通知模板，点击"新建模板"添加。</div>';
    return;
  }

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>模板编码</th><th>标题</th><th>类型</th><th>渠道</th><th>状态</th><th>操作</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td><code>${esc(r.code)}</code></td>
            <td>${esc(r.title)}</td>
            <td class="small">${esc(r.type)}</td>
            <td class="small">${esc(CHANNEL_LABELS[r.channel] || r.channel)}</td>
            <td>${r.is_active ? '<span class="status-dot green"></span>启用' : '<span class="status-dot gray"></span>停用'}</td>
            <td>
              <button class="btn tiny" data-edit-tpl="${r.id}" type="button">编辑</button>
              <button class="btn tiny ${r.is_active ? 'danger' : 'primary'}" data-toggle-tpl="${r.id}" data-active="${r.is_active}" type="button">${r.is_active ? '停用' : '启用'}</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

function templateFormHtml(t) {
  const isEdit = !!t;
  t = t || {};
  return `
    <form id="templateForm">
      <div class="grid cols-2" style="gap:10px">
        <label>模板编码 *<input class="input" name="code" value="${esc(t.code || '')}" required placeholder="如 order_approved" /></label>
        <label>模板标题 *<input class="input" name="title" value="${esc(t.title || '')}" required /></label>
        <label>类型<input class="input" name="type" value="${esc(t.type || 'general')}" placeholder="general" /></label>
        <label>渠道
          <select class="input" name="channel">
            ${Object.entries(CHANNEL_LABELS).map(([k, v]) => `<option value="${k}" ${t.channel === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </label>
        <label>邮件主题<input class="input" name="subject" value="${esc(t.subject || '')}" /></label>
      </div>
      <label style="margin-top:10px">模板正文 *<textarea class="input" name="body" rows="6" required placeholder="支持 {{user_name}} {{order_no}} 等变量">${esc(t.body || '')}</textarea></label>
      <div style="display:flex;gap:16px;margin-top:10px">
        <label><input type="checkbox" name="is_active" ${t.is_active !== false ? 'checked' : ''} /> 启用</label>
      </div>
      ${isEdit ? `<input type="hidden" name="_id" value="${t.id}" />` : ''}
    </form>`;
}

function showTemplateForm(tpl) {
  const isEdit = !!tpl;
  showModal(
    isEdit ? '编辑通知模板' : '新建通知模板',
    templateFormHtml(tpl),
    `<button class="btn" type="button" onclick="document.getElementById('modalContainer').innerHTML=''">取消</button>
     <button class="btn primary" id="saveTemplateBtn" type="button">保存</button>`,
  );

  document.getElementById('saveTemplateBtn').addEventListener('click', async () => {
    const form = document.getElementById('templateForm');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const row = {
      code: fd.get('code').trim(),
      title: fd.get('title').trim(),
      type: fd.get('type')?.trim() || 'general',
      channel: fd.get('channel'),
      subject: fd.get('subject')?.trim() || null,
      body: fd.get('body').trim(),
      is_active: !!fd.get('is_active'),
    };

    try {
      if (isEdit) {
        const { error } = await supabase.from('notification_templates').update(row).eq('id', tpl.id);
        if (error) throw error;
        toast('已更新', '模板已保存。', 'ok');
      } else {
        const { error } = await supabase.from('notification_templates').insert(row);
        if (error) throw error;
        toast('已创建', '模板已添加。', 'ok');
      }
      closeModal();
      loadTemplates();
    } catch (err) {
      toast('保存失败', err.message, 'err');
    }
  });
}

async function toggleTemplate(id, currentActive) {
  const newActive = currentActive === 'true' ? false : true;
  const { error } = await supabase.from('notification_templates').update({ is_active: newActive }).eq('id', id);
  if (error) {
    toast('操作失败', error.message, 'err');
    return;
  }
  toast(newActive ? '已启用' : '已停用', '', 'ok');
  loadTemplates();
}

function bindEvents() {
  document.getElementById('templatesTableWrap')?.addEventListener('click', async e => {
    const editBtn = e.target.closest('button[data-edit-tpl]');
    if (editBtn) {
      const { data } = await supabase.from('notification_templates').select('*').eq('id', editBtn.dataset.editTpl).single();
      if (data) showTemplateForm(data);
      return;
    }
    const toggleBtn = e.target.closest('button[data-toggle-tpl]');
    if (toggleBtn) {
      toggleTemplate(toggleBtn.dataset.toggleTpl, toggleBtn.dataset.active);
    }
  });

  document.getElementById('btnAddTemplate')?.addEventListener('click', () => showTemplateForm(null));
  document.getElementById('panel-templates')?.addEventListener('panel:show', loadTemplates);
}

export function init() {
  bindEvents();
}
