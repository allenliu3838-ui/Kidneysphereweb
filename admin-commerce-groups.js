/**
 * admin-commerce-groups.js — 学习群中心模块
 */
import { supabase, toast, formatBeijingDateTime } from './supabaseClient.js?v=20260325_001';
import { esc, fmtDate, statusDot, showModal, closeModal } from './admin-commerce.js?v=20260325_001';

const INVITE_STATUS = {
  pending:   { label: '待处理', dot: 'yellow' },
  sent:      { label: '已发送', dot: 'green' },
  joined:    { label: '已入群', dot: 'green' },
  expired:   { label: '已过期', dot: 'gray' },
  cancelled: { label: '已取消', dot: 'gray' },
};

async function loadGroups() {
  const wrap = document.getElementById('groupsTableWrap');
  if (!wrap) return;

  const { data, error } = await supabase
    .from('study_groups')
    .select('*, learning_projects(title), cohorts(title)')
    .order('created_at', { ascending: false });

  if (error) {
    wrap.innerHTML = `<div class="note">${esc(error.message)}</div>`;
    return;
  }

  const rows = data || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="muted">暂无学习群，点击"新建学习群"添加。</div>';
    return;
  }

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>群名称</th><th>类型</th><th>入群方式</th><th>所属项目</th><th>班期</th><th>状态</th><th>操作</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => {
          const typeLabel = r.group_type === 'wechat_group' ? '微信群' : (r.group_type === 'wecom_group' ? '企微群' : '其他');
          const modeLabel = r.join_mode === 'qr_code' ? '扫码' : (r.join_mode === 'manual_invite' ? '手动邀请' : '管理员拉入');
          return `
            <tr>
              <td>${esc(r.name)}</td>
              <td class="small">${esc(typeLabel)}</td>
              <td class="small">${esc(modeLabel)}</td>
              <td class="small">${esc(r.learning_projects?.title || '—')}</td>
              <td class="small">${esc(r.cohorts?.title || '—')}</td>
              <td>${r.is_active ? '<span class="status-dot green"></span>活跃' : '<span class="status-dot gray"></span>停用'}</td>
              <td>
                <button class="btn tiny" data-edit-group="${r.id}" type="button">编辑</button>
                <button class="btn tiny ${r.is_active ? 'danger' : 'primary'}" data-toggle-group="${r.id}" data-active="${r.is_active}" type="button">${r.is_active ? '停用' : '启用'}</button>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

async function loadInvites() {
  const wrap = document.getElementById('groupInvitesWrap');
  if (!wrap) return;

  const { data, error } = await supabase
    .from('group_invites')
    .select('*, study_groups(name)')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    wrap.innerHTML = `<div class="note">${esc(error.message)}</div>`;
    return;
  }

  const rows = data || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="muted">暂无入群邀请记录。</div>';
    return;
  }

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>学习群</th><th>用户ID</th><th>状态</th><th>发送时间</th><th>入群时间</th><th>操作</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => {
          const st = INVITE_STATUS[r.status] || { label: r.status, dot: 'gray' };
          return `
            <tr>
              <td>${esc(r.study_groups?.name || '—')}</td>
              <td><code class="small">${esc(String(r.user_id).slice(0, 8))}…</code></td>
              <td>${statusDot(st.dot)}${esc(st.label)}</td>
              <td class="small">${r.sent_at ? esc(formatBeijingDateTime(r.sent_at)) : '—'}</td>
              <td class="small">${r.joined_at ? esc(formatBeijingDateTime(r.joined_at)) : '—'}</td>
              <td>
                ${r.status === 'pending' ? `<button class="btn tiny primary" data-mark-sent="${r.id}" type="button">标记已发送</button>` : ''}
                ${r.status === 'sent' ? `<button class="btn tiny primary" data-mark-joined="${r.id}" type="button">标记已入群</button>` : ''}
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

let _projects = [];
let _cohorts = [];

async function loadOptions() {
  const [p, c] = await Promise.all([
    supabase.from('learning_projects').select('id, title').order('sort_order'),
    supabase.from('cohorts').select('id, title').order('created_at', { ascending: false }),
  ]);
  _projects = p.data || [];
  _cohorts = c.data || [];
}

function groupFormHtml(g) {
  const isEdit = !!g;
  g = g || {};
  return `
    <form id="groupForm">
      <div class="grid cols-2" style="gap:10px">
        <label>群名称 *<input class="input" name="name" value="${esc(g.name || '')}" required /></label>
        <label>群类型
          <select class="input" name="group_type">
            <option value="wechat_group" ${g.group_type === 'wechat_group' ? 'selected' : ''}>微信群</option>
            <option value="wecom_group" ${g.group_type === 'wecom_group' ? 'selected' : ''}>企微群</option>
            <option value="other" ${g.group_type === 'other' ? 'selected' : ''}>其他</option>
          </select>
        </label>
        <label>入群方式
          <select class="input" name="join_mode">
            <option value="qr_code" ${g.join_mode === 'qr_code' ? 'selected' : ''}>扫码入群</option>
            <option value="manual_invite" ${g.join_mode === 'manual_invite' ? 'selected' : ''}>手动邀请</option>
            <option value="operator_add" ${g.join_mode === 'operator_add' ? 'selected' : ''}>管理员拉入</option>
          </select>
        </label>
        <label>群二维码URL<input class="input" name="qr_url" value="${esc(g.qr_url || '')}" /></label>
        <label>所属项目
          <select class="input" name="project_id">
            <option value="">不关联</option>
            ${_projects.map(p => `<option value="${p.id}" ${g.project_id === p.id ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
          </select>
        </label>
        <label>所属班期
          <select class="input" name="cohort_id">
            <option value="">不关联</option>
            ${_cohorts.map(c => `<option value="${c.id}" ${g.cohort_id === c.id ? 'selected' : ''}>${esc(c.title)}</option>`).join('')}
          </select>
        </label>
        <label>群管理员<input class="input" name="manager_name" value="${esc(g.manager_name || '')}" /></label>
        <label>管理员联系方式<input class="input" name="manager_contact" value="${esc(g.manager_contact || '')}" /></label>
      </div>
      <div style="display:flex;gap:16px;margin-top:10px">
        <label><input type="checkbox" name="is_active" ${g.is_active !== false ? 'checked' : ''} /> 活跃</label>
      </div>
      ${isEdit ? `<input type="hidden" name="_id" value="${g.id}" />` : ''}
    </form>`;
}

function showGroupForm(group) {
  const isEdit = !!group;
  showModal(
    isEdit ? '编辑学习群' : '新建学习群',
    groupFormHtml(group),
    `<button class="btn" type="button" onclick="document.getElementById('modalContainer').innerHTML=''">取消</button>
     <button class="btn primary" id="saveGroupBtn" type="button">保存</button>`,
  );

  document.getElementById('saveGroupBtn').addEventListener('click', async () => {
    const form = document.getElementById('groupForm');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const row = {
      name: fd.get('name').trim(),
      group_type: fd.get('group_type'),
      join_mode: fd.get('join_mode'),
      qr_url: fd.get('qr_url')?.trim() || null,
      project_id: fd.get('project_id') || null,
      cohort_id: fd.get('cohort_id') || null,
      manager_name: fd.get('manager_name')?.trim() || null,
      manager_contact: fd.get('manager_contact')?.trim() || null,
      is_active: !!fd.get('is_active'),
    };

    try {
      if (isEdit) {
        const { error } = await supabase.from('study_groups').update(row).eq('id', group.id);
        if (error) throw error;
        toast('已更新', '学习群信息已保存。', 'ok');
      } else {
        const { error } = await supabase.from('study_groups').insert(row);
        if (error) throw error;
        toast('已创建', '学习群已添加。', 'ok');
      }
      closeModal();
      loadGroups();
    } catch (err) {
      toast('保存失败', err.message, 'err');
    }
  });
}

async function toggleGroup(id, currentActive) {
  const newActive = currentActive === 'true' ? false : true;
  const { error } = await supabase.from('study_groups').update({ is_active: newActive }).eq('id', id);
  if (error) {
    toast('操作失败', error.message, 'err');
    return;
  }
  toast(newActive ? '已启用' : '已停用', '', 'ok');
  loadGroups();
}

async function updateInviteStatus(id, status) {
  const updates = { status };
  if (status === 'sent') updates.sent_at = new Date().toISOString();
  if (status === 'joined') updates.joined_at = new Date().toISOString();

  const { error } = await supabase.from('group_invites').update(updates).eq('id', id);
  if (error) {
    toast('更新失败', error.message, 'err');
    return;
  }
  toast('已更新', '', 'ok');
  loadInvites();
}

function bindEvents() {
  document.getElementById('groupsTableWrap')?.addEventListener('click', async e => {
    const editBtn = e.target.closest('button[data-edit-group]');
    if (editBtn) {
      await loadOptions();
      const { data } = await supabase.from('study_groups').select('*').eq('id', editBtn.dataset.editGroup).single();
      if (data) showGroupForm(data);
      return;
    }
    const toggleBtn = e.target.closest('button[data-toggle-group]');
    if (toggleBtn) {
      toggleGroup(toggleBtn.dataset.toggleGroup, toggleBtn.dataset.active);
    }
  });

  document.getElementById('groupInvitesWrap')?.addEventListener('click', e => {
    const sentBtn = e.target.closest('button[data-mark-sent]');
    if (sentBtn) { updateInviteStatus(sentBtn.dataset.markSent, 'sent'); return; }
    const joinedBtn = e.target.closest('button[data-mark-joined]');
    if (joinedBtn) { updateInviteStatus(joinedBtn.dataset.markJoined, 'joined'); }
  });

  document.getElementById('btnAddGroup')?.addEventListener('click', async () => {
    await loadOptions();
    showGroupForm(null);
  });

  document.getElementById('panel-groups')?.addEventListener('panel:show', () => {
    loadGroups();
    loadInvites();
  });
}

export function init() {
  bindEvents();
}
