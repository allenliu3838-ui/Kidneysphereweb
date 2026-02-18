// trainingAdmin.js (v8.14)
// Admin CRUD for public.training_programs

import {
  supabase,
  ensureSupabase,
  isConfigured,
  toast,
  getCurrentUser,
  getUserProfile,
  normalizeRole,
  isAdminRole,
} from './supabaseClient.js?v=20260128_030';

const wrap = document.getElementById('trainingAdmin');
const need = document.getElementById('trainingNeedAdmin');
const listEl = document.getElementById('trainingList');
const form = document.getElementById('addTrainingForm');
const hint = document.getElementById('trainingHint');

if(!wrap || !need || !listEl || !form){
  // not on this page
} else {
  init();
}

function esc(str){
  return String(str ?? '').replace(/[&<>'"]/g, s => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'
  }[s]));
}

function parseBool(v){
  return String(v).toLowerCase() === 'true' || v === true;
}

function schemaHintFor(err){
  const msg = String(err?.message || err || '');
  if(/training_programs/i.test(msg) && /(does not exist|relation|schema cache|could not find|not find)/i.test(msg)){
    return '请先在 Supabase SQL Editor 运行 MIGRATION_20260121_TRAINING_MODERATORS.sql，然后 Settings → API 点击 “Reload schema”。';
  }
  return null;
}

let _isAdmin = false;

// Some deployments might still have an older supabaseClient.js that doesn't
// export newer helpers. To keep this admin module resilient, we avoid relying
// on optional exports here and implement Beijing time formatting locally.
function formatBJ(ts){
  try{
    const d = ts instanceof Date ? ts : new Date(ts);
    if(Number.isNaN(d.getTime())) return String(ts ?? '');
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(d);
  }catch(_e){
    try{ return String(ts ?? ''); }catch{ return ''; }
  }
}

async function init(){
  // This also helps us confirm (visually) that the JS module loaded.
  if(need) need.textContent = '加载中…';

  if(!isConfigured()){
    need.textContent = '未配置 Supabase。请先在 health.html 配置 SUPABASE_URL / SUPABASE_ANON_KEY。';
    need.hidden = false;
    wrap.hidden = true;
    return;
  }

  await ensureSupabase();
  if(!supabase){
    need.textContent = 'Supabase 初始化失败。请检查网络/CDN/配置。';
    need.hidden = false;
    wrap.hidden = true;
    return;
  }

  const user = await getCurrentUser();
  if(!user){
    need.textContent = '请先登录后再使用培训项目管理。';
    need.hidden = false;
    wrap.hidden = true;
    return;
  }

  const prof = await getUserProfile(user.id);
  const role = normalizeRole(prof?.role || user.user_metadata?.role);
  _isAdmin = isAdminRole(role);

  // Fallback: if role could not be read correctly (profile missing / schema cache),
  // ask the DB helper which reflects current privileges.
  if(!_isAdmin){
    try{
      const { data } = await supabase.rpc('is_admin');
      if(data === true) _isAdmin = true;
    }catch(_e){ /* ignore */ }
  }

  if(!_isAdmin){
    need.textContent = '需要管理员/超级管理员权限才能编辑培训项目。';
    need.hidden = false;
    wrap.hidden = true;
    return;
  }

  need.hidden = true;
  wrap.hidden = false;

  form.addEventListener('submit', onAdd);
  listEl.addEventListener('click', onListClick);
  listEl.addEventListener('submit', onListSubmit);

  await refresh();
}

async function refresh(){
  listEl.innerHTML = '<div class="small muted">加载中…</div>';
  try{
    const { data, error } = await supabase
      .from('training_programs')
      .select('*');
    if(error) throw error;

    const rows = Array.isArray(data) ? data : [];
    rows.sort((a,b)=>{
      const da = a.deleted_at ? 1 : 0;
      const db = b.deleted_at ? 1 : 0;
      if(da !== db) return da - db;
      const sa = Number(a.sort ?? 0);
      const sb = Number(b.sort ?? 0);
      if(sa !== sb) return sa - sb;
      return Number(a.id ?? 0) - Number(b.id ?? 0);
    });

    if(rows.length === 0){
      listEl.innerHTML = '<div class="note">暂无培训项目。你可以在上方新增。</div>';
      return;
    }

    listEl.innerHTML = rows.map(renderRow).join('');
  }catch(err){
    const h = schemaHintFor(err);
    if(h){
      toast('表未初始化', h, 'warn');
      listEl.innerHTML = `<div class="note">${esc(h)}</div>`;
      return;
    }
    listEl.innerHTML = `<div class="note">加载失败：${esc(err?.message || String(err))}</div>`;
  }
}

function renderRow(r){
  const hidden = !!r.deleted_at;
  const status = esc(r.status || 'planning');
  const badge = r.badge ? esc(r.badge) : '—';
  const desc = r.description ? esc(r.description) : '';
  const link = r.link ? esc(r.link) : '';
  const paid = (r.is_paid === false) ? '否' : '是';

  return `
  <div class="card" style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:14px">
    <div style="display:flex;gap:12px;justify-content:space-between;flex-wrap:wrap;align-items:flex-start">
      <div style="min-width:260px;flex:1">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <b>${esc(r.title || '')}</b>
          ${hidden ? '<span class="badge mini">已隐藏</span>' : ''}
        </div>
        ${desc ? `<div class="small muted" style="margin-top:6px">${desc}</div>` : ''}
        <div class="small muted" style="margin-top:8px">
          状态：<b>${status}</b> · Badge：<b>${badge}</b> · sort：<b>${Number(r.sort ?? 0)}</b> · 付费预留：<b>${paid}</b>
        </div>
        ${link ? `<div class="small" style="margin-top:8px">链接：<a href="${link}" target="_blank" rel="noopener">${link}</a></div>` : ''}
        <div class="small muted" style="margin-top:6px">
          更新：${esc(formatBJ(r.updated_at || r.created_at || new Date().toISOString()))}
        </div>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" data-edit="${r.id}">编辑</button>
        <button class="btn ${hidden ? 'primary' : ''}" data-toggle="${r.id}">${hidden ? '恢复显示' : '隐藏'}</button>
        <button class="btn danger" data-delete="${r.id}">删除</button>
      </div>
    </div>

    <form class="form" data-edit-form="${r.id}" hidden style="margin-top:12px">
      <div class="form-row">
        <div style="flex:1;min-width:240px">
          <label>项目名称</label>
          <input class="input" name="title" required value="${esc(r.title || '')}" />
        </div>
        <div style="min-width:220px">
          <label>状态</label>
          <select class="input" name="status">
            <option value="active" ${r.status==='active'?'selected':''}>进行中</option>
            <option value="planning" ${(r.status==='planning' || !r.status)?'selected':''}>规划中</option>
            <option value="coming_soon" ${r.status==='coming_soon'?'selected':''}>即将启动</option>
            <option value="archived" ${r.status==='archived'?'selected':''}>已结束</option>
          </select>
        </div>
      </div>

      <div class="form-row">
        <div style="flex:1;min-width:240px">
          <label>Badge 文案（可选）</label>
          <input class="input" name="badge" value="${esc(r.badge || '')}" placeholder="例如：6月启动" />
        </div>
        <div style="min-width:220px">
          <label>排序（越小越靠前）</label>
          <input class="input" name="sort" type="number" value="${Number(r.sort ?? 0)}" />
        </div>
      </div>

      <label>简介（可选）</label>
      <textarea class="input" name="description" rows="3">${esc(r.description || '')}</textarea>

      <div class="form-row">
        <div style="flex:1;min-width:240px">
          <label>详情链接（可选）</label>
          <input class="input" name="link" value="${esc(r.link || '')}" placeholder="外链或站内页面" />
        </div>
        <div style="min-width:220px">
          <label>是否预留付费接口</label>
          <select class="input" name="is_paid">
            <option value="true" ${r.is_paid!==false?'selected':''}>是（默认）</option>
            <option value="false" ${r.is_paid===false?'selected':''}>否</option>
          </select>
        </div>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn primary" type="submit">保存</button>
        <button class="btn" type="button" data-cancel="${r.id}">取消</button>
        <span class="small muted" style="align-self:center">ID: ${r.id}</span>
      </div>
    </form>
  </div>`;
}

async function onAdd(e){
  e.preventDefault();
  if(!_isAdmin) return;

  const fd = new FormData(form);
  const title = String(fd.get('title') || '').trim();
  if(!title){
    toast('缺少名称', '请填写项目名称。');
    return;
  }

  const row = {
    title,
    status: String(fd.get('status') || 'planning'),
    badge: String(fd.get('badge') || '').trim() || null,
    description: String(fd.get('description') || '').trim() || null,
    link: String(fd.get('link') || '').trim() || null,
    sort: Number(fd.get('sort') || 0),
    is_paid: parseBool(fd.get('is_paid')),
  };

  try{
    hint.textContent = '提交中…';
    const { error } = await supabase.from('training_programs').insert(row);
    if(error) throw error;
    toast('已新增', '培训项目已添加。');
    form.reset();
    // default values
    form.querySelector('input[name="sort"]').value = '10';
    await refresh();
  }catch(err){
    const h = schemaHintFor(err);
    if(h){ toast('表未初始化', h, 'warn'); }
    else toast('新增失败', err?.message || String(err), 'err');
  }finally{
    hint.textContent = '';
  }
}

async function onListClick(e){
  const btn = e.target.closest('button');
  if(!btn) return;

  const editId = btn.getAttribute('data-edit');
  const toggleId = btn.getAttribute('data-toggle');
  const delId = btn.getAttribute('data-delete');
  const cancelId = btn.getAttribute('data-cancel');

  if(editId){
    const f = listEl.querySelector(`[data-edit-form="${editId}"]`);
    if(f) f.hidden = !f.hidden;
    return;
  }

  if(cancelId){
    const f = listEl.querySelector(`[data-edit-form="${cancelId}"]`);
    if(f) f.hidden = true;
    return;
  }

  if(toggleId){
    await toggleHidden(Number(toggleId));
    return;
  }

  if(delId){
    if(confirm('确定要删除该培训项目吗？（不可恢复）')){
      await hardDelete(Number(delId));
    }
  }
}

async function onListSubmit(e){
  const f = e.target.closest('form[data-edit-form]');
  if(!f) return;
  e.preventDefault();

  const id = Number(f.getAttribute('data-edit-form'));
  if(!id) return;

  const fd = new FormData(f);
  const patch = {
    title: String(fd.get('title') || '').trim(),
    status: String(fd.get('status') || 'planning'),
    badge: String(fd.get('badge') || '').trim() || null,
    description: String(fd.get('description') || '').trim() || null,
    link: String(fd.get('link') || '').trim() || null,
    sort: Number(fd.get('sort') || 0),
    is_paid: parseBool(fd.get('is_paid')),
  };

  if(!patch.title){
    toast('缺少名称', '项目名称不能为空。');
    return;
  }

  try{
    const { error } = await supabase.from('training_programs').update(patch).eq('id', id);
    if(error) throw error;
    toast('已保存', '培训项目已更新。');
    f.hidden = true;
    await refresh();
  }catch(err){
    const h = schemaHintFor(err);
    if(h){ toast('表未初始化', h, 'warn'); }
    else toast('保存失败', err?.message || String(err), 'err');
  }
}

async function toggleHidden(id){
  try{
    const { data, error } = await supabase
      .from('training_programs')
      .select('id, deleted_at')
      .eq('id', id)
      .maybeSingle();
    if(error) throw error;

    const isHidden = Boolean(data?.deleted_at);
    const nextDeletedAt = isHidden ? null : new Date().toISOString();

    const { error: e2 } = await supabase
      .from('training_programs')
      .update({ deleted_at: nextDeletedAt })
      .eq('id', id);
    if(e2) throw e2;

    toast(isHidden ? '已恢复' : '已隐藏', isHidden ? '该培训项目已恢复显示。' : '该培训项目已隐藏。');
    await refresh();
  }catch(err){
    const h = schemaHintFor(err);
    if(h){ toast('表未初始化', h, 'warn'); }
    else toast('操作失败', err?.message || String(err), 'err');
  }
}

async function hardDelete(id){
  try{
    const { error } = await supabase.from('training_programs').delete().eq('id', id);
    if(error) throw error;
    toast('已删除', '该培训项目已删除。');
    await refresh();
  }catch(err){
    const h = schemaHintFor(err);
    if(h){ toast('表未初始化', h, 'warn'); }
    else toast('删除失败', err?.message || String(err), 'err');
  }
}
