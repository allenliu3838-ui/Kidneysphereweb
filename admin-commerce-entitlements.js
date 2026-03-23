/**
 * admin-commerce-entitlements.js — 权益管理模块
 */
import { supabase, toast, formatBeijingDateTime } from './supabaseClient.js?v=20260322_001';
import { esc, statusDot, showModal, closeModal } from './admin-commerce.js?v=20260322_001';

const ENT_LABELS = {
  membership: '会员',
  specialty_bundle: '专科整套课',
  single_video: '单视频',
  project_access: '项目权限',
  cohort_access: '班期权限',
};

async function loadEntitlements(userId) {
  const wrap = document.getElementById('entitlementsTableWrap');
  if (!wrap) return;

  let q = supabase
    .from('user_entitlements')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  if (userId) q = q.eq('user_id', userId);

  const { data, error } = await q;
  if (error) {
    wrap.innerHTML = `<div class="note">${esc(error.message)}</div>`;
    return;
  }

  const rows = data || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="muted">暂无权益记录。</div>';
    return;
  }

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>用户ID</th><th>类型</th><th>状态</th><th>开始</th><th>到期</th><th>来源</th><th>操作</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => {
          const expired = r.end_at && new Date(r.end_at) < new Date();
          const dot = r.status === 'active' && !expired ? 'green' : (r.status === 'revoked' ? 'red' : 'gray');
          return `
            <tr>
              <td><code class="small">${esc(String(r.user_id).slice(0, 8))}…</code></td>
              <td>${esc(ENT_LABELS[r.entitlement_type] || r.entitlement_type)}</td>
              <td>${statusDot(dot)}${esc(r.status)}${expired ? ' (过期)' : ''}</td>
              <td class="small">${esc(formatBeijingDateTime(r.start_at))}</td>
              <td class="small">${r.end_at ? esc(formatBeijingDateTime(r.end_at)) : '永久'}</td>
              <td class="small">${esc(r.grant_reason || '—')}</td>
              <td>
                ${r.status === 'active' ? `<button class="btn tiny danger" data-revoke-ent="${r.id}" type="button">撤销</button>` : ''}
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

async function revokeEntitlement(id) {
  if (!confirm('确定撤销此权益？')) return;
  const { error } = await supabase
    .from('user_entitlements')
    .update({ status: 'revoked' })
    .eq('id', id);
  if (error) {
    toast('撤销失败', error.message, 'err');
    return;
  }
  toast('已撤销', '', 'ok');
  loadEntitlements();
}

function showGrantForm() {
  showModal('手动发放权益', `
    <form id="grantForm">
      <div class="grid cols-2" style="gap:10px">
        <label>用户ID *<input class="input" name="user_id" required placeholder="UUID" /></label>
        <label>权益类型 *
          <select class="input" name="entitlement_type" required>
            ${Object.entries(ENT_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
          </select>
        </label>
        <label>关联专科ID<input class="input" name="specialty_id" /></label>
        <label>关联视频ID<input class="input" name="video_id" /></label>
        <label>关联项目ID<input class="input" name="project_id" /></label>
        <label>有效天数<input class="input" name="days" type="number" value="365" /></label>
      </div>
      <label style="margin-top:10px">原因<input class="input" name="reason" value="admin_manual_grant" /></label>
    </form>`,
    `<button class="btn" type="button" onclick="document.getElementById('modalContainer').innerHTML=''">取消</button>
     <button class="btn primary" id="grantEntBtn" type="button">发放</button>`);

  document.getElementById('grantEntBtn')?.addEventListener('click', async () => {
    const form = document.getElementById('grantForm');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const days = parseInt(fd.get('days')) || 365;
    const row = {
      user_id: fd.get('user_id').trim(),
      entitlement_type: fd.get('entitlement_type'),
      specialty_id: fd.get('specialty_id')?.trim() || null,
      video_id: fd.get('video_id')?.trim() || null,
      project_id: fd.get('project_id')?.trim() || null,
      start_at: new Date().toISOString(),
      end_at: new Date(Date.now() + days * 86400000).toISOString(),
      status: 'active',
      grant_reason: fd.get('reason')?.trim() || 'admin_manual_grant',
    };
    try {
      const { error } = await supabase.from('user_entitlements').insert(row);
      if (error) throw error;
      toast('已发放', '权益已成功发放。', 'ok');
      closeModal();
      loadEntitlements();
    } catch (err) {
      toast('发放失败', err.message, 'err');
    }
  });
}

function bindEvents() {
  document.getElementById('entitlementsTableWrap')?.addEventListener('click', e => {
    const btn = e.target.closest('button[data-revoke-ent]');
    if (btn) revokeEntitlement(btn.dataset.revokeEnt);
  });

  document.getElementById('entSearchBtn')?.addEventListener('click', () => {
    const val = document.getElementById('entSearchInput')?.value?.trim();
    loadEntitlements(val || undefined);
  });

  document.getElementById('refreshEntitlements')?.addEventListener('click', () => loadEntitlements());

  // Add grant button (reuse the refresh area)
  const refreshBtn = document.getElementById('refreshEntitlements');
  if (refreshBtn) {
    const grantBtn = document.createElement('button');
    grantBtn.className = 'btn primary';
    grantBtn.textContent = '手动发放';
    grantBtn.type = 'button';
    grantBtn.addEventListener('click', showGrantForm);
    refreshBtn.parentNode.insertBefore(grantBtn, refreshBtn);
  }

  document.getElementById('panel-entitlements')?.addEventListener('panel:show', () => loadEntitlements());
}

export function init() {
  bindEvents();
}
