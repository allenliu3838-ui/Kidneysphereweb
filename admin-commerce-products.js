/**
 * admin-commerce-products.js — 商品管理模块
 */
import { supabase, toast } from './supabaseClient.js?v=20260401_fix';
import { esc, showModal, closeModal } from './admin-commerce.js?v=20260914_payment1';
import { validateProductBinding, productBindingPolicy } from './admin-commerce-review.js?v=20260914_payment1';

const TYPE_LABELS = {
  membership_plan: '会员方案',
  specialty_bundle: '专科整套课',
  single_video: '单视频',
  project_registration: '项目报名',
  registration_plus_bundle: '报名+整套课',
  combo_package: '组合套餐',
};

async function loadProducts() {
  const wrap = document.getElementById('productsTableWrap');
  if (!wrap) return;

  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('sort_order', { ascending: true });

  if (error) {
    wrap.innerHTML = `<div class="note">${esc(error.message)}</div>`;
    return;
  }

  const rows = data || [];
  if (!rows.length) {
    wrap.innerHTML = '<div class="muted">暂无商品，点击"新建商品"添加。</div>';
    return;
  }

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>商品编码</th><th>名称</th><th>类型</th><th>价格</th><th>状态</th><th>操作</th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td><code>${esc(r.product_code)}</code></td>
            <td>${esc(r.title)}${r.recommended ? ' ⭐' : ''}</td>
            <td class="small">${esc(TYPE_LABELS[r.product_type] || r.product_type)}</td>
            <td><b>¥${esc(String(r.price_cny))}</b>${r.list_price_cny ? ` <s class="small muted">¥${esc(String(r.list_price_cny))}</s>` : ''}</td>
            <td>${r.is_active ? '<span class="status-dot green"></span>在售' : '<span class="status-dot gray"></span>下架'}</td>
            <td>
              <button class="btn tiny" data-edit-product="${r.id}" type="button">编辑</button>
              <button class="btn tiny ${r.is_active ? 'danger' : 'primary'}" data-toggle-product="${r.id}" data-active="${r.is_active}" type="button">${r.is_active ? '下架' : '上架'}</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
}

function cohortOptions(projectId, cohortId, cohorts) {
  const available = cohorts.filter(cohort => cohort.project_id === projectId);
  const missing = cohortId && !available.some(cohort => cohort.id === cohortId);
  return `<option value="">不指定班期（仅归属所选项目）</option>${missing ? `<option value="${esc(cohortId)}" selected>原班期不可用，请重新选择 · ${esc(cohortId)}</option>` : ''}${available.map(cohort =>
    `<option value="${esc(cohort.id)}" ${cohort.id === cohortId ? 'selected' : ''}>${esc(cohort.title)} · ${esc(cohort.cohort_code || cohort.id)} (${esc(cohort.status || '—')})</option>`).join('')}`;
}

function projectOptions(product, projects) {
  const policy = productBindingPolicy(product);
  const available = policy.projectForbidden ? [] : projects.filter(project => !policy.expectedProjectCode || project.project_code === policy.expectedProjectCode);
  return `<option value="">${policy.projectForbidden ? '不关联项目（此商品不含培训报名）' : '请选择项目或不关联项目'}</option>
    ${product.project_id && !available.some(project => project.id === product.project_id) ? `<option value="${esc(product.project_id)}" selected>原绑定不适用，请重新选择 · ${esc(product.project_id)}</option>` : ''}
    ${available.map(project => `<option value="${esc(project.id)}" ${product.project_id === project.id ? 'selected' : ''}>${esc(project.title)} · ${esc(project.project_code || project.id)}</option>`).join('')}`;
}

function productBindingHelp(product) {
  const policy = productBindingPolicy(product);
  return policy.projectForbidden ? '此商品只含视频学习权益，不建立培训报名，请勿关联项目或班期。'
    : policy.expectedProjectCode ? `本商品只允许归属 ${policy.expectedProjectCode}，班期也必须属于该项目。` : '报名商品请选择真实项目，再选择该项目下的班期。';
}

function productFormHtml(p, projects, cohorts) {
  const isEdit = !!p;
  p = p || {};
  return `
    <form id="productForm">
      <div class="grid cols-2" style="gap:10px">
        <label>商品编码 *<input class="input" name="product_code" value="${esc(p.product_code || '')}" required /></label>
        <label>商品类型 *
          <select class="input" name="product_type" required>
            ${Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}" ${p.product_type === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </label>
        <label>商品名称 *<input class="input" name="title" value="${esc(p.title || '')}" required /></label>
        <label>副标题<input class="input" name="subtitle" value="${esc(p.subtitle || '')}" /></label>
        <label>售价(元) *<input class="input" name="price_cny" type="number" step="0.01" value="${p.price_cny ?? 0}" required /></label>
        <label>原价(元)<input class="input" name="list_price_cny" type="number" step="0.01" value="${p.list_price_cny ?? ''}" /></label>
        <label>有效天数<input class="input" name="duration_days" type="number" value="${p.duration_days ?? 365}" /></label>
        <label>排序(小在前)<input class="input" name="sort_order" type="number" value="${p.sort_order ?? 0}" /></label>
        <label>封面图URL<input class="input" name="cover_url" value="${esc(p.cover_url || '')}" /></label>
        <label>关联专科ID<input class="input" name="specialty_id" value="${esc(p.specialty_id || '')}" /></label>
        <label>归属项目（报名商品必选）
          <select class="input" name="project_id">${projectOptions(p, projects)}</select>
        </label>
        <label>归属班期
          <select class="input" name="cohort_id">${cohortOptions(p.project_id, p.cohort_id, productBindingPolicy(p).projectForbidden ? [] : cohorts)}</select>
        </label>
        <label>关联视频ID<input class="input" name="video_id" value="${esc(p.video_id || '')}" /></label>
      </div>
      <p class="small muted" id="productBindingHelp">${esc(productBindingHelp(p))}</p>
      <p class="small muted">未指定班期时不会自动选择或猜测班期。修改商品绑定仅影响新订单，已下单的项目和期限以购买时记录为准。</p>
      <label style="margin-top:10px">描述<textarea class="input" name="description" rows="3">${esc(p.description || '')}</textarea></label>
      <div style="display:flex;gap:16px;margin-top:10px">
        <label><input type="checkbox" name="recommended" ${p.recommended ? 'checked' : ''} /> 推荐</label>
        <label><input type="checkbox" name="requires_review" ${p.requires_review !== false ? 'checked' : ''} /> 需审核</label>
        <label><input type="checkbox" name="invoice_supported" ${p.invoice_supported ? 'checked' : ''} /> 支持开票</label>
        <label><input type="checkbox" name="is_active" ${p.is_active !== false ? 'checked' : ''} /> 上架</label>
      </div>
      ${isEdit ? `<input type="hidden" name="_id" value="${p.id}" />` : ''}
    </form>`;
}

async function showProductForm(product) {
  const isEdit = !!product;
  let projects, cohorts;
  try {
    const [projectResult, cohortResult] = await Promise.all([
      supabase.from('learning_projects').select('id, title, project_code').order('sort_order'),
      supabase.rpc('admin_get_cohorts', { p_project_id: null }),
    ]);
    if (projectResult.error) throw projectResult.error;
    if (cohortResult.error) throw cohortResult.error;
    projects = projectResult.data || [];
    cohorts = cohortResult.data || [];
  } catch (error) {
    toast('加载项目和班期失败', error.message, 'err');
    return;
  }
  showModal(
    isEdit ? '编辑商品' : '新建商品',
    productFormHtml(product, projects, cohorts),
    `<button class="btn" type="button" onclick="document.getElementById('modalContainer').innerHTML=''">取消</button>
     <button class="btn primary" id="saveProductBtn" type="button">保存</button>`,
  );

  const form = document.getElementById('productForm');
  const projectSelect = form.elements.namedItem('project_id');
  const cohortSelect = form.elements.namedItem('cohort_id');
  const currentProduct = () => ({ product_code: form.elements.namedItem('product_code').value.trim(), product_type: form.elements.namedItem('product_type').value, project_id: projectSelect.value });
  const refreshBinding = () => {
    const current = currentProduct();
    projectSelect.innerHTML = projectOptions(current, projects);
    cohortSelect.innerHTML = cohortOptions(projectSelect.value, cohortSelect.value, productBindingPolicy(current).projectForbidden ? [] : cohorts);
    document.getElementById('productBindingHelp').textContent = productBindingHelp(current);
  };
  form.elements.namedItem('product_code').addEventListener('change', refreshBinding);
  form.elements.namedItem('product_type').addEventListener('change', refreshBinding);
  projectSelect.addEventListener('change', () => {
    cohortSelect.innerHTML = cohortOptions(projectSelect.value, null, productBindingPolicy(currentProduct()).projectForbidden ? [] : cohorts);
  });
  let saving = false;
  const saveButton = document.getElementById('saveProductBtn');
  saveButton.addEventListener('click', async () => {
    if (saving) return;
    const form = document.getElementById('productForm');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const row = {
      product_code: fd.get('product_code').trim(),
      product_type: fd.get('product_type'),
      title: fd.get('title').trim(),
      subtitle: fd.get('subtitle')?.trim() || null,
      description: fd.get('description')?.trim() || null,
      cover_url: fd.get('cover_url')?.trim() || null,
      price_cny: parseFloat(fd.get('price_cny')) || 0,
      list_price_cny: fd.get('list_price_cny') ? parseFloat(fd.get('list_price_cny')) : null,
      duration_days: parseInt(fd.get('duration_days')) || 365,
      sort_order: parseInt(fd.get('sort_order')) || 0,
      specialty_id: fd.get('specialty_id')?.trim() || null,
      project_id: fd.get('project_id')?.trim() || null,
      cohort_id: fd.get('cohort_id')?.trim() || null,
      video_id: fd.get('video_id')?.trim() || null,
      recommended: !!fd.get('recommended'),
      requires_review: !!fd.get('requires_review'),
      invoice_supported: !!fd.get('invoice_supported'),
      is_active: !!fd.get('is_active'),
    };

    const bindingError = validateProductBinding(row, projects, cohorts);
    if (bindingError) { toast('请检查归属', bindingError, 'err'); return; }
    saving = true;
    saveButton.disabled = true;
    try {
      if (isEdit) {
        const { error } = await supabase.from('products').update(row).eq('id', product.id);
        if (error) throw error;
        toast('已更新', '商品信息已保存。', 'ok');
      } else {
        const { error } = await supabase.from('products').insert(row);
        if (error) throw error;
        toast('已创建', '商品已添加。', 'ok');
      }
      closeModal();
      loadProducts();
    } catch (err) {
      toast('保存失败', err.message, 'err');
    } finally {
      saving = false;
      saveButton.disabled = false;
    }
  });
}

async function toggleProduct(id, currentActive) {
  const newActive = currentActive === 'true' ? false : true;
  const { error } = await supabase.from('products').update({ is_active: newActive }).eq('id', id);
  if (error) {
    toast('操作失败', error.message, 'err');
    return;
  }
  toast(newActive ? '已上架' : '已下架', '', 'ok');
  loadProducts();
}

function bindEvents() {
  document.getElementById('productsTableWrap')?.addEventListener('click', async e => {
    const editBtn = e.target.closest('button[data-edit-product]');
    if (editBtn) {
      const { data } = await supabase.from('products').select('*').eq('id', editBtn.dataset.editProduct).single();
      if (data) showProductForm(data);
      return;
    }
    const toggleBtn = e.target.closest('button[data-toggle-product]');
    if (toggleBtn) {
      toggleProduct(toggleBtn.dataset.toggleProduct, toggleBtn.dataset.active);
    }
  });

  document.getElementById('btnAddProduct')?.addEventListener('click', () => showProductForm(null));
}

export function init() {
  bindEvents();
  // Lazy load on tab show
  document.getElementById('panel-products')?.addEventListener('panel:show', loadProducts);
}
