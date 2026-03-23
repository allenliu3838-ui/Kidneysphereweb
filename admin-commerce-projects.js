/**
 * admin-commerce-projects.js — 项目中心 + 班期管理模块
 * Handles: learning_projects CRUD + cohorts CRUD + enrollment list
 */
import { supabase, toast } from './supabaseClient.js?v=20260323_001';
import { esc, fmtDate, showModal, closeModal } from './admin-commerce.js?v=20260323_001';

const STATUS_LABELS = {
  draft:      { label: '草稿',   dot: 'gray' },
  recruiting: { label: '招募中', dot: 'green' },
  closed:     { label: '已关闭', dot: 'yellow' },
  ended:      { label: '已结束', dot: 'gray' },
};

const ENROLL_STATUS_LABELS = {
  pending:   '待确认',
  confirmed: '已确认',
  cancelled: '已取消',
  expired:   '已过期',
};

function statusDot(color) {
  return `<span class="status-dot ${color}"></span>`;
}

/* ============================================================
   PROJECTS LIST
============================================================ */
async function loadProjects() {
  const wrap = document.getElementById('projectsTableWrap');
  if (!wrap) return;

  const { data, error } = await supabase
    .from('learning_projects')
    .select('id, project_code, title, status, sort_order, registration_fee_cny, is_active, created_at')
    .order('sort_order', { ascending: true });

  if (error) {
    wrap.innerHTML = `<div class="note">${esc(error.message)}</div>`;
    return;
  }

  const rows = data || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="muted">暂无项目，点击"新建项目"添加。</div>';
    return;
  }

  const sl = STATUS_LABELS;
  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>项目编码</th><th>名称</th><th>报名费</th><th>状态</th><th>操作</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => {
          const s = sl[r.status] || { label: r.status, dot: 'gray' };
          return `
            <tr>
              <td><code>${esc(r.project_code)}</code></td>
              <td>${esc(r.title)}</td>
              <td>¥${esc(String(r.registration_fee_cny ?? 0))}</td>
              <td>${statusDot(s.dot)}${esc(s.label)}</td>
              <td style="display:flex;gap:6px;flex-wrap:wrap">
                <button class="btn tiny" data-edit-project="${r.id}" type="button">编辑</button>
                <button class="btn tiny" data-manage-cohorts="${r.id}" data-project-title="${esc(r.title)}" type="button">班期</button>
                <button class="btn tiny" data-project-enrollments="${r.id}" type="button">报名者</button>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  // Bind buttons
  wrap.querySelectorAll('[data-edit-project]').forEach(btn =>
    btn.addEventListener('click', () => openProjectModal(btn.dataset.editProject)));
  wrap.querySelectorAll('[data-manage-cohorts]').forEach(btn =>
    btn.addEventListener('click', () => openCohortsModal(btn.dataset.manageCohorts, btn.dataset.projectTitle)));
  wrap.querySelectorAll('[data-project-enrollments]').forEach(btn =>
    btn.addEventListener('click', () => openEnrollmentsModal(btn.dataset.projectEnrollments)));
}

/* ============================================================
   PROJECT EDIT MODAL
============================================================ */
async function openProjectModal(projectId) {
  let proj = null;
  if (projectId) {
    const { data } = await supabase.from('learning_projects').select('*').eq('id', projectId).single();
    proj = data;
  }

  // Fetch products for bundle link dropdown
  const { data: products } = await supabase
    .from('products')
    .select('id, product_code, title, product_type')
    .eq('is_active', true)
    .in('product_type', ['specialty_bundle', 'project_registration', 'registration_plus_bundle'])
    .order('sort_order');

  const productOptions = (products || []).map(p =>
    `<option value="${esc(p.id)}" ${proj?.includes_bundle_product_id === p.id ? 'selected' : ''}>
      ${esc(p.product_code)} — ${esc(p.title)}
    </option>`
  ).join('');

  const isEdit = !!proj;
  const title = isEdit ? '编辑项目' : '新建项目';

  showModal(title, `
    <form id="projectForm" class="form" style="display:flex;flex-direction:column;gap:12px">
      <div class="form-row">
        <div style="flex:1">
          <label>项目编码 <span class="small muted">（唯一，不可重复）</span></label>
          <input class="input" id="pfCode" required placeholder="如 PROJ-ICU-2026" value="${esc(proj?.project_code || '')}" ${isEdit ? 'readonly' : ''} />
        </div>
        <div style="flex:1">
          <label>状态</label>
          <select class="input" id="pfStatus">
            ${['draft','recruiting','closed','ended'].map(s =>
              `<option value="${s}" ${proj?.status === s ? 'selected' : ''}>${STATUS_LABELS[s]?.label || s}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div>
        <label>项目名称</label>
        <input class="input" id="pfTitle" required placeholder="如 重症肾内科规范化培训项目 · 2026" value="${esc(proj?.title || '')}" />
      </div>
      <div>
        <label>项目简介</label>
        <textarea class="input" id="pfIntro" rows="3" placeholder="面向学员的简短介绍…">${esc(proj?.intro || '')}</textarea>
      </div>
      <div class="form-row">
        <div style="flex:1">
          <label>报名费（元）</label>
          <input class="input" id="pfFee" type="number" min="0" step="0.01" value="${esc(String(proj?.registration_fee_cny ?? 0))}" />
        </div>
        <div style="flex:1">
          <label>排序权重</label>
          <input class="input" id="pfSort" type="number" min="0" value="${esc(String(proj?.sort_order ?? 0))}" />
        </div>
      </div>
      <div>
        <label>关联 Bundle 商品（可选）</label>
        <select class="input" id="pfBundle">
          <option value="">— 不关联 —</option>
          ${productOptions}
        </select>
      </div>
      <div>
        <label>退款政策说明</label>
        <textarea class="input" id="pfRefund" rows="2">${esc(proj?.refund_policy_text || '开课前7天以上申请全额退款；开课后不支持退款。')}</textarea>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <input type="checkbox" id="pfActive" ${proj?.is_active !== false ? 'checked' : ''} />
        <label for="pfActive">已启用（上架）</label>
      </div>
    </form>`,
    `<button class="btn" type="button" id="projSaveBtn">保存</button>
     <button class="btn" type="button" onclick="document.getElementById('modalContainer').innerHTML=''">取消</button>`
  );

  document.getElementById('projSaveBtn')?.addEventListener('click', async () => {
    const code    = document.getElementById('pfCode')?.value.trim();
    const status  = document.getElementById('pfStatus')?.value;
    const title_  = document.getElementById('pfTitle')?.value.trim();
    const intro   = document.getElementById('pfIntro')?.value.trim();
    const fee     = parseFloat(document.getElementById('pfFee')?.value || '0');
    const sort    = parseInt(document.getElementById('pfSort')?.value || '0', 10);
    const bundle  = document.getElementById('pfBundle')?.value || null;
    const refund  = document.getElementById('pfRefund')?.value.trim();
    const active  = document.getElementById('pfActive')?.checked ?? true;

    if (!code || !title_) { toast('请填写项目编码和名称', '', 'err'); return; }

    const payload = {
      project_code: code, status, title: title_, intro, sort_order: sort,
      registration_fee_cny: fee, includes_bundle_product_id: bundle || null,
      refund_policy_text: refund, is_active: active, updated_at: new Date().toISOString(),
    };

    let err;
    if (isEdit) {
      ({ error: err } = await supabase.from('learning_projects').update(payload).eq('id', projectId));
    } else {
      ({ error: err } = await supabase.from('learning_projects').insert({ ...payload, requires_review: true }));
    }

    if (err) { toast('保存失败', err.message, 'err'); return; }
    toast('保存成功', '', 'ok');
    closeModal();
    loadProjects();
  });
}

/* ============================================================
   COHORTS MODAL
============================================================ */
async function openCohortsModal(projectId, projectTitle) {
  const { data: cohorts, error } = await supabase
    .from('cohorts')
    .select('*')
    .eq('project_id', projectId)
    .order('start_date', { ascending: true });

  const rows = cohorts || [];
  const rowsHtml = rows.length ? rows.map(c => `
    <tr>
      <td><code>${esc(c.cohort_code)}</code></td>
      <td>${esc(c.title)}</td>
      <td>${esc(String(c.start_date || '—'))}</td>
      <td>${esc(String(c.quota || '不限'))}</td>
      <td>${esc(String(c.enrolled_count || 0))}</td>
      <td>${statusDot(STATUS_LABELS[c.status]?.dot || 'gray')}${esc(STATUS_LABELS[c.status]?.label || c.status)}</td>
      <td><button class="btn tiny" data-edit-cohort="${c.id}" type="button">编辑</button></td>
    </tr>`).join('')
  : '<tr><td colspan="7" class="muted">暂无班期</td></tr>';

  showModal(`班期管理 · ${esc(projectTitle)}`, `
    <div style="margin-bottom:10px;display:flex;justify-content:flex-end">
      <button class="btn primary" id="btnAddCohortInModal" type="button">新建班期</button>
    </div>
    <div style="overflow-x:auto">
      <table class="data-table" id="cohortsInnerTable">
        <thead><tr>
          <th>编码</th><th>名称</th><th>开始日期</th><th>名额</th><th>已报名</th><th>状态</th><th>操作</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`, '');

  document.getElementById('btnAddCohortInModal')?.addEventListener('click', () => openCohortEditModal(null, projectId, projectTitle));
  document.querySelectorAll('[data-edit-cohort]').forEach(btn =>
    btn.addEventListener('click', () => openCohortEditModal(btn.dataset.editCohort, projectId, projectTitle)));
}

async function openCohortEditModal(cohortId, projectId, projectTitle) {
  let c = null;
  if (cohortId) {
    const { data } = await supabase.from('cohorts').select('*').eq('id', cohortId).single();
    c = data;
  }
  const isEdit = !!c;

  showModal(isEdit ? `编辑班期 · ${esc(projectTitle)}` : `新建班期 · ${esc(projectTitle)}`, `
    <form id="cohortForm" class="form" style="display:flex;flex-direction:column;gap:12px">
      <div class="form-row">
        <div style="flex:1">
          <label>班期编码</label>
          <input class="input" id="cfCode" required placeholder="如 C-2026-01" value="${esc(c?.cohort_code || '')}" ${isEdit ? 'readonly' : ''} />
        </div>
        <div style="flex:1">
          <label>状态</label>
          <select class="input" id="cfStatus">
            ${['draft','recruiting','closed','ended'].map(s =>
              `<option value="${s}" ${c?.status === s ? 'selected' : ''}>${STATUS_LABELS[s]?.label || s}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div>
        <label>班期名称</label>
        <input class="input" id="cfTitle" required placeholder="如 春季班第1期" value="${esc(c?.title || '')}" />
      </div>
      <div class="form-row">
        <div style="flex:1">
          <label>开始日期</label>
          <input class="input" id="cfStart" type="date" value="${esc(String(c?.start_date || ''))}" />
        </div>
        <div style="flex:1">
          <label>结束日期</label>
          <input class="input" id="cfEnd" type="date" value="${esc(String(c?.end_date || ''))}" />
        </div>
        <div style="flex:1">
          <label>报名截止</label>
          <input class="input" id="cfDeadline" type="datetime-local" value="${c?.registration_deadline ? c.registration_deadline.slice(0,16) : ''}" />
        </div>
      </div>
      <div class="form-row">
        <div style="flex:1">
          <label>名额（空=不限）</label>
          <input class="input" id="cfQuota" type="number" min="0" value="${esc(String(c?.quota ?? ''))}" />
        </div>
      </div>
      <div>
        <label>微信群二维码 URL</label>
        <input class="input" id="cfQr" placeholder="https://…" value="${esc(c?.group_qr_url || '')}" />
      </div>
      <div>
        <label>备用二维码 URL（可选）</label>
        <input class="input" id="cfQrB" placeholder="https://…" value="${esc(c?.group_qr_backup_url || '')}" />
      </div>
      <div class="form-row">
        <div style="flex:1">
          <label>群管理员姓名</label>
          <input class="input" id="cfMgrName" value="${esc(c?.group_manager_name || '')}" />
        </div>
        <div style="flex:1">
          <label>群管理员联系方式</label>
          <input class="input" id="cfMgrContact" value="${esc(c?.group_manager_contact || '')}" />
        </div>
      </div>
    </form>`,
    `<button class="btn" id="cohortSaveBtn" type="button">保存</button>
     <button class="btn" type="button" onclick="document.getElementById('modalContainer').innerHTML=''">取消</button>`
  );

  document.getElementById('cohortSaveBtn')?.addEventListener('click', async () => {
    const code    = document.getElementById('cfCode')?.value.trim();
    const status  = document.getElementById('cfStatus')?.value;
    const title_  = document.getElementById('cfTitle')?.value.trim();
    const start   = document.getElementById('cfStart')?.value || null;
    const end     = document.getElementById('cfEnd')?.value || null;
    const ddl     = document.getElementById('cfDeadline')?.value || null;
    const quota   = document.getElementById('cfQuota')?.value ? parseInt(document.getElementById('cfQuota').value, 10) : null;
    const qr      = document.getElementById('cfQr')?.value.trim() || null;
    const qrb     = document.getElementById('cfQrB')?.value.trim() || null;
    const mgrName = document.getElementById('cfMgrName')?.value.trim() || null;
    const mgrCon  = document.getElementById('cfMgrContact')?.value.trim() || null;

    if (!code || !title_) { toast('请填写编码和名称', '', 'err'); return; }

    const payload = {
      cohort_code: code, project_id: projectId, status, title: title_,
      start_date: start, end_date: end,
      registration_deadline: ddl ? new Date(ddl).toISOString() : null,
      quota, group_qr_url: qr, group_qr_backup_url: qrb,
      group_manager_name: mgrName, group_manager_contact: mgrCon,
      updated_at: new Date().toISOString(),
    };

    let err;
    if (isEdit) {
      ({ error: err } = await supabase.from('cohorts').update(payload).eq('id', cohortId));
    } else {
      ({ error: err } = await supabase.from('cohorts').insert(payload));
    }

    if (err) { toast('保存失败', err.message, 'err'); return; }
    toast('保存成功', '', 'ok');
    openCohortsModal(projectId, projectTitle);
  });
}

/* ============================================================
   ENROLLMENTS MODAL
============================================================ */
async function openEnrollmentsModal(projectId) {
  const { data, error } = await supabase
    .from('project_enrollments')
    .select(`
      id, user_id, enrollment_status, approval_status,
      joined_group_status, created_at,
      cohorts ( title )
    `)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(100);

  const rows = data || [];
  const rowsHtml = rows.length ? rows.map(e => `
    <tr>
      <td><code class="small">${esc(String(e.user_id).slice(0,8))}…</code></td>
      <td>${esc(e.cohorts?.title || '—')}</td>
      <td>${esc(ENROLL_STATUS_LABELS[e.enrollment_status] || e.enrollment_status)}</td>
      <td>${esc(e.approval_status === 'approved' ? '✅ 已批准' : e.approval_status === 'rejected' ? '❌ 驳回' : '⏳ 待审批')}</td>
      <td>${esc(fmtDate(e.created_at))}</td>
      <td>
        ${e.approval_status === 'pending' ? `
          <button class="btn tiny" data-approve-enroll="${e.id}" type="button">批准</button>
          <button class="btn tiny" data-reject-enroll="${e.id}" type="button">驳回</button>
        ` : ''}
      </td>
    </tr>`).join('')
  : '<tr><td colspan="6" class="muted">暂无报名记录</td></tr>';

  showModal('报名者列表', `
    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr>
          <th>用户ID</th><th>班期</th><th>报名状态</th><th>审批状态</th><th>报名时间</th><th>操作</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`, '');

  // Approve / reject enrollments
  document.querySelectorAll('[data-approve-enroll]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const { error: err } = await supabase.from('project_enrollments')
        .update({ approval_status: 'approved', enrollment_status: 'confirmed',
          approved_by: (await supabase.auth.getUser()).data.user?.id,
          approved_at: new Date().toISOString() })
        .eq('id', btn.dataset.approveEnroll);
      if (err) toast('操作失败', err.message, 'err');
      else { toast('已批准', '', 'ok'); openEnrollmentsModal(projectId); }
    }));

  document.querySelectorAll('[data-reject-enroll]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const { error: err } = await supabase.from('project_enrollments')
        .update({ approval_status: 'rejected' })
        .eq('id', btn.dataset.rejectEnroll);
      if (err) toast('操作失败', err.message, 'err');
      else { toast('已驳回', '', 'ok'); openEnrollmentsModal(projectId); }
    }));
}

/* ============================================================
   PUBLIC INIT — called by admin-commerce.js
============================================================ */
export function init() {
  // Load projects when panel is shown
  const panel = document.getElementById('panel-projects');
  if (!panel) return;

  panel.addEventListener('panel:show', () => loadProjects(), { once: false });

  // New project button
  document.getElementById('btnAddProject')?.addEventListener('click', () => openProjectModal(null));

  // Initial load if panel already active
  if (panel.classList.contains('active')) loadProjects();
}
