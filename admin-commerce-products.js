/**
 * admin-commerce-products.js — 商品管理模块
 */
import { supabase, toast } from './supabaseClient.js?v=20260325_001';
import { esc, fmtDate, showModal, closeModal } from './admin-commerce.js?v=20260325_001';

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

function productFormHtml(p) {
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
        <label>关联项目ID<input class="input" name="project_id" value="${esc(p.project_id || '')}" /></label>
        <label>关联视频ID<input class="input" name="video_id" value="${esc(p.video_id || '')}" /></label>
      </div>
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

function showProductForm(product) {
  const isEdit = !!product;
  showModal(
    isEdit ? '编辑商品' : '新建商品',
    productFormHtml(product),
    `<button class="btn" type="button" onclick="document.getElementById('modalContainer').innerHTML=''">取消</button>
     <button class="btn primary" id="saveProductBtn" type="button">保存</button>`,
  );

  document.getElementById('saveProductBtn').addEventListener('click', async () => {
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
      video_id: fd.get('video_id')?.trim() || null,
      recommended: !!fd.get('recommended'),
      requires_review: !!fd.get('requires_review'),
      invoice_supported: !!fd.get('invoice_supported'),
      is_active: !!fd.get('is_active'),
    };

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
