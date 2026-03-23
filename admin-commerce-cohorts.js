/**
 * admin-commerce-cohorts.js — 班期管理模块
 */
import { supabase, toast, formatBeijingDateTime } from './supabaseClient.js?v=20260322_001';
import { esc, fmtDate, statusDot, showModal, closeModal } from './admin-commerce.js?v=20260322_001';

const STATUS_MAP = {
  draft:      { label: '草稿', dot: 'gray' },
  recruiting: { label: '招募中', dot: 'green' },
  closed:     { label: '已关闭', dot: 'yellow' },
  ended:      { label: '已结束', dot: 'gray' },
};

function statusLabel(s) {
  const m = STATUS_MAP[s] || { label: s, dot: 'gray' };
  return `${statusDot(m.dot)}${esc(m.label)}`;
}

let _projects = [];

async function loadProjectOptions() {
  const { data } = await supabase.from('learning_projects').select('id, title').order('sort_order');
  _projects = data || [];
}

async function loadCohorts() {
  const wrap = document.getElementById('cohortsTableWrap');
  if (!wrap) return;

  await loadProjectOptions();

  const { data, error } = await supabase
    .from('cohorts')
    .select('*, learning_projects(title)')
    .order('created_at', { ascending: false });

  if (error) {
    wrap.innerHTML = `<div class="note">${esc(error.message)}</div>`;
    return;
  }

  const rows = data || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="muted">暂无班期，点击"新建班期"添加。</div>';
    return;
  }

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>班期编码</th><th>名称</th><th>所属项目</th><th>日期</th><th>名额</th><th>状态</th><th>操作</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td><code>${esc(r.cohort_code)}</code></td>
            <td>${esc(r.title)}</td>
            <td class="small">${esc(r.learning_projects?.title || '—')}</td>
            <td class="small">${esc(r.start_date || '—')} ~ ${esc(r.end_date || '—')}</td>
            <td>${r.enrolled_count ?? 0}${r.quota ? ` / ${r.quota}` : ''}</td>
            <td>${statusLabel(r.status)}</td>
            <td>
              <button class="btn tiny" data-edit-cohort="${r.id}" type="button">编辑</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

function cohortFormHtml(c) {
  const isEdit = !!c;
  c = c || {};
  return `
    <form id="cohortForm">
      <div class="grid cols-2" style="gap:10px">
        <label>班期编码 *<input class="input" name="cohort_code" value="${esc(c.cohort_code || '')}" required /></label>
        <label>班期名称 *<input class="input" name="title" value="${esc(c.title || '')}" required /></label>
        <label>所属项目 *
          <select class="input" name="project_id" required>
            <option value="">请选择</option>
            ${_projects.map(p => `<option value="${p.id}" ${c.project_id === p.id ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
          </select>
        </label>
        <label>状态
          <select class="input" name="status">
            ${Object.entries(STATUS_MAP).map(([k, v]) => `<option value="${k}" ${c.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select>
        </label>
        <label>开始日期<input class="input" name="start_date" type="date" value="${esc(c.start_date || '')}" /></label>
        <label>结束日期<input class="input" name="end_date" type="date" value="${esc(c.end_date || '')}" /></label>
        <label>报名截止<input class="input" name="registration_deadline" type="datetime-local" value="${c.registration_deadline ? c.registration_deadline.slice(0,16) : ''}" /></label>
        <label>名额上限<input class="input" name="quota" type="number" value="${c.quota ?? ''}" /></label>
      </div>
      <div class="hr"></div>
      <h4>入群设置</h4>
      <div class="grid cols-2" style="gap:10px">
        <label><input type="checkbox" name="group_required" ${c.group_required ? 'checked' : ''} /> 需要入群</label>
        <label>群类型
          <select class="input" name="group_type">
            <option value="wechat_group" ${c.group_type === 'wechat_group' ? 'selected' : ''}>微信群</option>
            <option value="wecom_group" ${c.group_type === 'wecom_group' ? 'selected' : ''}>企微群</option>
            <option value="other" ${c.group_type === 'other' ? 'selected' : ''}>其他</option>
          </select>
        </label>
        <label>入群方式
          <select class="input" name="group_join_mode">
            <option value="qr_code" ${c.group_join_mode === 'qr_code' ? 'selected' : ''}>扫码入群</option>
            <option value="manual_invite" ${c.group_join_mode === 'manual_invite' ? 'selected' : ''}>手动邀请</option>
            <option value="operator_add" ${c.group_join_mode === 'operator_add' ? 'selected' : ''}>管理员拉入</option>
          </select>
        </label>
        <label>群二维码URL<input class="input" name="group_qr_url" value="${esc(c.group_qr_url || '')}" /></label>
        <label>群管理员<input class="input" name="group_manager_name" value="${esc(c.group_manager_name || '')}" /></label>
        <label>管理员联系方式<input class="input" name="group_manager_contact" value="${esc(c.group_manager_contact || '')}" /></label>
      </div>
      ${isEdit ? `<input type="hidden" name="_id" value="${c.id}" />` : ''}
    </form>`;
}

function showCohortForm(cohort) {
  const isEdit = !!cohort;
  showModal(
    isEdit ? '编辑班期' : '新建班期',
    cohortFormHtml(cohort),
    `<button class="btn" type="button" onclick="document.getElementById('modalContainer').innerHTML=''">取消</button>
     <button class="btn primary" id="saveCohortBtn" type="button">保存</button>`,
  );

  document.getElementById('saveCohortBtn').addEventListener('click', async () => {
    const form = document.getElementById('cohortForm');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const row = {
      cohort_code: fd.get('cohort_code').trim(),
      title: fd.get('title').trim(),
      project_id: fd.get('project_id'),
      status: fd.get('status'),
      start_date: fd.get('start_date') || null,
      end_date: fd.get('end_date') || null,
      registration_deadline: fd.get('registration_deadline') ? new Date(fd.get('registration_deadline')).toISOString() : null,
      quota: fd.get('quota') ? parseInt(fd.get('quota')) : null,
      group_required: !!fd.get('group_required'),
      group_type: fd.get('group_type'),
      group_join_mode: fd.get('group_join_mode'),
      group_qr_url: fd.get('group_qr_url')?.trim() || null,
      group_manager_name: fd.get('group_manager_name')?.trim() || null,
      group_manager_contact: fd.get('group_manager_contact')?.trim() || null,
    };

    try {
      if (isEdit) {
        const { error } = await supabase.from('cohorts').update(row).eq('id', cohort.id);
        if (error) throw error;
        toast('已更新', '班期信息已保存。', 'ok');
      } else {
        const { error } = await supabase.from('cohorts').insert(row);
        if (error) throw error;
        toast('已创建', '班期已添加。', 'ok');
      }
      closeModal();
      loadCohorts();
    } catch (err) {
      toast('保存失败', err.message, 'err');
    }
  });
}

function bindEvents() {
  document.getElementById('cohortsTableWrap')?.addEventListener('click', async e => {
    const editBtn = e.target.closest('button[data-edit-cohort]');
    if (editBtn) {
      const { data } = await supabase.from('cohorts').select('*').eq('id', editBtn.dataset.editCohort).single();
      if (data) showCohortForm(data);
    }
  });

  document.getElementById('btnAddCohort')?.addEventListener('click', () => showCohortForm(null));
  document.getElementById('panel-cohorts')?.addEventListener('panel:show', loadCohorts);
}

export function init() {
  bindEvents();
}
