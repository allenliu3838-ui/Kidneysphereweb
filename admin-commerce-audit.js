/**
 * admin-commerce-audit.js — 审计日志模块
 */
import { supabase, toast, formatBeijingDateTime } from './supabaseClient.js?v=20260325_001';
import { esc, statusDot, showModal } from './admin-commerce.js?v=20260325_001';

async function loadAuditLogs() {
  const wrap = document.getElementById('auditTableWrap');
  if (!wrap) return;

  const { data, error } = await supabase
    .from('audit_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    wrap.innerHTML = `<div class="note">${esc(error.message)}</div>`;
    return;
  }

  const rows = data || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="muted">暂无审计日志。</div>';
    return;
  }

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>时间</th><th>操作人</th><th>操作</th><th>目标类型</th><th>目标ID</th><th>详情</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td class="small">${esc(formatBeijingDateTime(r.created_at))}</td>
            <td><code class="small">${r.operator_id ? esc(String(r.operator_id).slice(0, 8)) + '…' : '系统'}</code></td>
            <td>${esc(r.action)}</td>
            <td class="small">${esc(r.target_type || '—')}</td>
            <td><code class="small">${r.target_id ? esc(String(r.target_id).slice(0, 8)) + '…' : '—'}</code></td>
            <td>
              <button class="btn tiny" data-audit-detail="${r.id}" type="button">查看</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

function showAuditDetail(row) {
  const beforeStr = row.before_json ? JSON.stringify(row.before_json, null, 2) : '无';
  const afterStr = row.after_json ? JSON.stringify(row.after_json, null, 2) : '无';

  showModal('审计日志详情', `
    <div class="grid cols-2" style="gap:8px;margin-bottom:12px">
      <div><span class="small muted">操作</span><br/><b>${esc(row.action)}</b></div>
      <div><span class="small muted">时间</span><br/>${esc(formatBeijingDateTime(row.created_at))}</div>
      <div><span class="small muted">操作人</span><br/><code class="small">${esc(row.operator_id || '系统')}</code></div>
      <div><span class="small muted">IP</span><br/>${esc(row.ip || '—')}</div>
      <div><span class="small muted">目标类型</span><br/>${esc(row.target_type || '—')}</div>
      <div><span class="small muted">目标ID</span><br/><code class="small">${esc(row.target_id || '—')}</code></div>
    </div>
    <div class="hr"></div>
    <h4>变更前</h4>
    <pre class="small" style="background:rgba(255,255,255,.04);padding:8px;border-radius:8px;overflow-x:auto;max-height:200px">${esc(beforeStr)}</pre>
    <h4 style="margin-top:12px">变更后</h4>
    <pre class="small" style="background:rgba(255,255,255,.04);padding:8px;border-radius:8px;overflow-x:auto;max-height:200px">${esc(afterStr)}</pre>
  `);
}

// Keep rows cached for detail view
let _rows = [];

function bindEvents() {
  document.getElementById('auditTableWrap')?.addEventListener('click', e => {
    const btn = e.target.closest('button[data-audit-detail]');
    if (btn) {
      const row = _rows.find(r => r.id === btn.dataset.auditDetail);
      if (row) showAuditDetail(row);
    }
  });

  document.getElementById('refreshAudit')?.addEventListener('click', loadAndCache);
  document.getElementById('panel-audit')?.addEventListener('panel:show', loadAndCache);
}

async function loadAndCache() {
  const wrap = document.getElementById('auditTableWrap');
  if (!wrap) return;

  const { data, error } = await supabase
    .from('audit_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    wrap.innerHTML = `<div class="note">${esc(error.message)}</div>`;
    return;
  }

  _rows = data || [];
  if (!_rows.length) {
    wrap.innerHTML = '<div class="muted">暂无审计日志。</div>';
    return;
  }

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>时间</th><th>操作人</th><th>操作</th><th>目标类型</th><th>目标ID</th><th>详情</th>
      </tr></thead>
      <tbody>
        ${_rows.map(r => `
          <tr>
            <td class="small">${esc(formatBeijingDateTime(r.created_at))}</td>
            <td><code class="small">${r.operator_id ? esc(String(r.operator_id).slice(0, 8)) + '…' : '系统'}</code></td>
            <td>${esc(r.action)}</td>
            <td class="small">${esc(r.target_type || '—')}</td>
            <td><code class="small">${r.target_id ? esc(String(r.target_id).slice(0, 8)) + '…' : '—'}</code></td>
            <td>
              <button class="btn tiny" data-audit-detail="${r.id}" type="button">查看</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

export function init() {
  bindEvents();
}
