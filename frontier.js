import {
  supabase,
  ensureSupabase,
  isConfigured,
  toast,
  getCurrentUser,
  getUserProfile,
  isAdminRole,
  normalizeRole,
} from './supabaseClient.js?v=20260128_030';

const els = {
  root: document.getElementById('frontierModules'),
  hint: document.getElementById('frontierHint'),
  admin: document.getElementById('frontierAdmin'),
  moduleSelect: document.getElementById('moduleSelect'),
  addModuleForm: document.getElementById('addModuleForm'),
  addCardForm: document.getElementById('addCardForm'),
  addSponsorForm: document.getElementById('addSponsorForm'),
};

function esc(str){
  return String(str ?? '').replace(/[&<>"]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s]));
}

function escAll(str){
  return String(str ?? '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

function nl2br(str){ return escAll(str).replace(/\n/g,'<br/>'); }

function extFromFilename(name){
  const n = String(name || '').toLowerCase();
  const m = n.match(/\.([a-z0-9]+)$/);
  if(!m) return '';
  const ext = m[1];
  if(['jpg','jpeg','png','webp','gif'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  return ext;
}

async function uploadSponsorLogo(file, sponsorId){
  if(!file || !(file instanceof File) || file.size === 0) return null;
  if(!String(file.type || '').startsWith('image/')){
    throw new Error('Logo 必须为图片文件（jpg/png/webp/gif）。');
  }
  const maxMB = 2;
  if(file.size > maxMB * 1024 * 1024){
    throw new Error(`Logo 过大（>${maxMB}MB）。建议压缩后再上传。`);
  }

  const ext = extFromFilename(file.name) || (String(file.type||'').includes('png') ? 'png' : 'jpg');
  const rand = Math.random().toString(16).slice(2);
  const path = `sponsor_${sponsorId}/${Date.now()}_${rand}.${ext}`;

  const bucket = 'sponsor_logos';
  const { error: upErr } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type || undefined,
  });
  if(upErr){
    // Helpful hint if bucket is missing
    const msg = String(upErr.message || upErr);
    if(/Bucket not found/i.test(msg)){
      throw new Error('Storage bucket 未创建：请在 Supabase SQL Editor 运行 MIGRATION_20260107_SPONSOR_LOGOS.sql（或最新版迁移）创建 sponsor_logos bucket。');
    }
    throw upErr;
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl || null;
}

let currentUser = null;
let currentProfile = null;
let isAdmin = false;

async function initAuth(){
  if(!isConfigured()) return;
  // IMPORTANT: This page script may run before app.js finishes initializing
  // the Supabase client. Always ensure the client here.
  if(!supabase){
    try{ await ensureSupabase(); }catch(_e){ /* ignore */ }
  }
  if(!supabase) return;
  try{
    currentUser = await getCurrentUser();
    if(currentUser){
      currentProfile = await getUserProfile(currentUser);
      // Admin privileges should be driven by profiles.role (RLS-protected).
      const role = normalizeRole(currentProfile?.role);
      isAdmin = isAdminRole(role);
    }
  }catch(_e){ /* ignore */ }
}

function kindBadge(kind){
  const k = String(kind||'').toLowerCase();
  if(k === 'richtext') return '<span class="chip">Richtext</span>';
  if(k === 'sponsors') return '<span class="chip">Sponsors</span>';
  return '<span class="chip">Cards</span>';
}

function moduleShell(m, innerHtml){
  const desc = m.description ? `<div class="small muted" style="margin-top:6px">${escAll(m.description)}</div>` : '';

  const adminRow = isAdmin ? `
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <span class="small muted">ID: ${m.id}</span>
      <label class="small muted" style="margin:0">排序 <input data-mod-sort="${m.id}" type="number" value="${Number(m.sort||0)}" style="width:90px" class="input" /></label>
      <button class="btn tiny" type="button" data-mod-toggle="${m.id}" data-enabled="${m.enabled ? '1':'0'}">${m.enabled ? '隐藏' : '显示'}</button>
      <button class="btn tiny danger" type="button" data-mod-del="${m.id}">删除</button>
    </div>
  ` : '';

  const adminRich = (isAdmin && String(m.kind).toLowerCase() === 'richtext') ? `
    <form class="form" data-rich-form="${m.id}" style="margin-top:12px">
      <label style="margin-top:0">编辑正文（Richtext）</label>
      <textarea class="input" name="body" rows="6" placeholder="支持粘贴文本（建议不要粘贴复杂富文本）">${escAll(m.body || '')}</textarea>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
        <button class="btn primary" type="submit">保存正文</button>
        <span class="small muted">保存后将对所有用户生效</span>
      </div>
    </form>
  ` : '';

  return `
    <div class="card soft" style="padding:18px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div style="min-width:0">
          <h3 style="margin:0">${escAll(m.title_zh || '未命名板块')}</h3>
          <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            ${kindBadge(m.kind)}
            ${m.enabled ? '<span class="chip soon">启用</span>' : '<span class="chip todo">隐藏</span>'}
          </div>
          ${desc}
        </div>
        ${adminRow}
      </div>

      <div style="margin-top:14px">
        ${innerHtml}
      </div>

      ${adminRich}
    </div>
  `;
}

function cardsGrid(items){
  if(!items || items.length === 0) return `<div class="muted small">暂无内容。</div>`;

  return `
    <div class="grid cols-2">
      ${items.map(it=>{
        const img = it.image_url ? `<img alt="img" src="${escAll(it.image_url)}" style="width:100%;height:180px;object-fit:cover;border-radius:16px;border:1px solid rgba(255,255,255,.12);margin-bottom:10px">` : '';
        const link = it.link_url ? `<a class="btn" target="_blank" rel="noopener" href="${escAll(it.link_url)}">打开链接</a>` : '';
        const adminDel = isAdmin ? `<button class="btn tiny danger" type="button" data-card-del="${it.id}">删除</button>` : '';
        return `
          <div class="card soft" style="padding:16px">
            ${img}
            <b>${escAll(it.title || '未命名')}</b>
            ${it.summary ? `<div class="small muted" style="margin-top:6px">${escAll(it.summary)}</div>` : ''}
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
              ${link}
              ${adminDel}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function sponsorsGrid(items){
  if(!items || items.length === 0) return `<div class="muted small">暂无赞助商信息。</div>`;

  const tierSelect = (tier)=>{
    const t = String(tier || 'partner').toLowerCase();
    const opt = (val, label)=>{
      const sel = t === val ? 'selected' : '';
      return `<option value="${val}" ${sel}>${label}</option>`;
    };
    return `
      <select class="input" name="tier">
        ${opt('partner','Partner')}
        ${opt('supporter','Supporter')}
        ${opt('sponsor','Sponsor')}
      </select>
    `;
  };

  return `
    <div class="grid cols-2">
      ${items.map(s=>{
        const logo = s.logo_url
          ? `<img alt="logo" src="${escAll(s.logo_url)}" style="width:44px;height:44px;border-radius:12px;border:1px solid rgba(255,255,255,.12);object-fit:cover">`
          : `<div class="avatar">S</div>`;
        const tier = s.tier ? `<span class="chip">${escAll(String(s.tier).toUpperCase())}</span>` : '';
        const home = (typeof s.show_on_home === 'undefined') ? true : Boolean(s.show_on_home);
        const homeBadge = home ? `<span class="chip soon">首页展示</span>` : `<span class="chip todo">不在首页</span>`;
        const enabledBadge = s.enabled ? `<span class="chip soon">启用</span>` : `<span class="chip todo">下线</span>`;
        const link = s.website ? `<a class="btn" target="_blank" rel="noopener" href="${escAll(s.website)}">了解更多</a>` : '';

        const adminControls = isAdmin ? `
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px">
            <label class="small muted" style="margin:0">排序 <input data-sponsor-sort="${s.id}" type="number" value="${Number(s.sort||0)}" style="width:90px" class="input" /></label>
            <button class="btn tiny" type="button" data-sponsor-toggle-home="${s.id}" data-on="${home?'1':'0'}">${home ? '取消首页展示' : '设为首页展示'}</button>
            <button class="btn tiny" type="button" data-sponsor-toggle-enabled="${s.id}" data-enabled="${s.enabled ? '1':'0'}">${s.enabled ? '下线' : '上线'}</button>
            <button class="btn tiny danger" type="button" data-sponsor-del="${s.id}">删除</button>
          </div>
        ` : '';

        const editPanel = isAdmin ? `
          <details class="admin-details" style="margin-top:12px">
            <summary class="btn tiny" style="cursor:pointer;display:inline-flex;align-items:center;gap:8px;list-style:none">
              编辑资料
            </summary>

            <form class="form" data-sponsor-edit-form="${s.id}" style="margin-top:12px">
              <div class="form-row">
                <div>
                  <label>名称
                    <input class="input" name="name" value="${escAll(s.name || '')}" placeholder="例如：某某医疗" />
                  </label>
                </div>
                <div>
                  <label>级别
                    ${tierSelect(s.tier)}
                  </label>
                </div>
              </div>

              <label>简介（可选）
                <textarea class="input" name="description" rows="2" placeholder="主营、产品关键词、合作方向…">${escAll(s.description || '')}</textarea>
              </label>

              <div class="form-row">
                <div>
                  <label>官网/介绍链接（可选）
                    <input class="input" name="website" value="${escAll(s.website || '')}" placeholder="https://..." />
                  </label>
                </div>
                <div>
                  <label>Logo URL（可选）
                    <input class="input" name="logo_url" value="${escAll(s.logo_url || '')}" placeholder="https://..." />
                  </label>
                </div>
              </div>

              <div class="form-row">
                <div style="flex:1">
                  <label>Logo（上传，推荐）
                    <input class="input" type="file" accept="image/*" name="logo_file" />
                  </label>
                  <div class="small muted" style="margin-top:6px">上传后将覆盖 Logo URL（公开显示在首页）。建议 ≤2MB。</div>
                </div>
                <div style="display:flex;align-items:flex-end;gap:10px;justify-content:flex-end">
                  ${s.logo_url ? `<button class="btn danger tiny" type="button" data-sponsor-clear-logo="${s.id}">清空 Logo</button>` : ''}
                </div>
              </div>

              <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">
                <button class="btn primary" type="submit">保存</button>
                <span class="small muted">保存后会同步影响首页展示与 Sponsors 模块。</span>
              </div>
            </form>
          </details>
        ` : '';

        return `
          <div class="card soft" style="padding:16px">
            <div style="display:flex;gap:12px;align-items:center;justify-content:space-between">
              <div style="display:flex;gap:10px;align-items:center;min-width:0">
                ${logo}
                <div style="min-width:0">
                  <b style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escAll(s.name || 'Sponsor')}</b>
                  <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">${tier} ${homeBadge} ${enabledBadge}</div>
                </div>
              </div>
            </div>

            ${s.description ? `<div class="small muted" style="margin-top:10px">${escAll(s.description)}</div>` : ''}
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
              ${link}
            </div>

            ${adminControls}
            ${editPanel}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

async function loadAndRender(){
  if(!els.root) return;

  // Ensure client first (this script can run before app.js)
  if(isConfigured() && !supabase){
    try{ await ensureSupabase(); }catch(_e){ /* ignore */ }
  }

  // Demo / no Supabase
  if(!isConfigured() || !supabase){
    els.root.innerHTML = `
      <div class="note"><b>演示模式：</b>请在 assets/config.js 配置 Supabase 后启用数据库驱动的 Frontier。</div>
      <div class="card soft" style="padding:18px">
        <h3 style="margin:0">IgA 申明 · 最新要务（示例）</h3>
        <div class="small muted" style="margin-top:6px">上线后可由管理员随时新增/维护板块与卡片。</div>
        <div style="margin-top:14px" class="grid cols-2">
          <div class="card soft" style="padding:16px"><b>IgAN 新药：iptacopan</b><div class="small muted" style="margin-top:6px">机制、试验进展与临床要点。</div></div>
          <div class="card soft" style="padding:16px"><b>补体相关病：C3G/aHUS</b><div class="small muted" style="margin-top:6px">诊疗路径与最新综述。</div></div>
        </div>
      </div>
    `;
    if(els.hint) els.hint.textContent = '';
    if(els.admin) els.admin.hidden = true;
    return;
  }

  await initAuth();
  if(els.admin) els.admin.hidden = !isAdmin;

  let modules = [];
  try{
    const { data, error } = await supabase
      .from('frontier_modules')
      .select('id, title_zh, description, kind, body, enabled, sort, created_at')
      .order('sort', { ascending: true })
      .order('created_at', { ascending: false });
    if(error) throw error;
    modules = (data || []).filter(m => isAdmin ? true : Boolean(m.enabled));
  }catch(e){
    els.root.innerHTML = `
      <div class="note"><b>读取失败：</b>${escAll(e.message || String(e))}<br/><span class="small">若你刚升级到 v11，请先运行新的 SUPABASE_SETUP.sql 创建 frontier_* 表。</span></div>
    `;
    if(els.hint) els.hint.textContent = '';
    return;
  }

  // Populate module select (cards only)
  if(els.moduleSelect){
    const cardMods = modules.filter(m => String(m.kind||'').toLowerCase() === 'cards');
    els.moduleSelect.innerHTML = cardMods.length
      ? cardMods.map(m => `<option value="${m.id}">${escAll(m.title_zh || ('模块 ' + m.id))}</option>`).join('')
      : `<option value="">（暂无卡片板块）</option>`;
  }

  // Fetch cards/sponsors in batch
  const modIds = modules.map(m=>m.id);
  const cardsByMod = new Map();
  if(modIds.length){
    try{
      const { data } = await supabase
        .from('frontier_cards')
        .select('id, module_id, title, summary, image_url, link_url, enabled, sort, created_at')
        .in('module_id', modIds)
        .order('sort', { ascending: true })
        .order('created_at', { ascending: false });
      (data || []).forEach(it=>{
        if(!isAdmin && !it.enabled) return;
        if(!cardsByMod.has(it.module_id)) cardsByMod.set(it.module_id, []);
        cardsByMod.get(it.module_id).push(it);
      });
    }catch(_e){
      // ignore (table might not exist yet)
    }
  }

  let sponsors = [];
  try{
    // v4.1: prefer show_on_home column when available (fallback for older DBs)
    let res = await supabase
      .from('sponsors')
      .select('id, name, tier, logo_url, description, website, enabled, sort, created_at, show_on_home')
      .order('sort', { ascending: true })
      .order('created_at', { ascending: false });

    if(res?.error && String(res.error.message||'').toLowerCase().includes('column')){
      res = await supabase
        .from('sponsors')
        .select('id, name, tier, logo_url, description, website, enabled, sort, created_at')
        .order('sort', { ascending: true })
        .order('created_at', { ascending: false });
    }
    if(res?.error) throw res.error;
    sponsors = (res.data || []).filter(s => isAdmin ? true : Boolean(s.enabled));
  }catch(_e){
    sponsors = [];
  }

  // Render
  if(modules.length === 0){
    els.root.innerHTML = `<div class="muted small">暂无板块。${isAdmin ? '你可以在下方管理面板新增。' : ''}</div>`;
    if(els.hint) els.hint.textContent = '';
    return;
  }

  els.root.innerHTML = modules.map(m=>{
    const kind = String(m.kind||'cards').toLowerCase();
    if(kind === 'richtext'){
      const body = m.body ? `<div style="line-height:1.75">${nl2br(String(m.body))}</div>` : `<div class="muted small">暂无正文。</div>`;
      return moduleShell(m, body);
    }
    if(kind === 'sponsors'){
      return moduleShell(m, sponsorsGrid(sponsors));
    }
    return moduleShell(m, cardsGrid(cardsByMod.get(m.id) || []));
  }).join('');

  if(els.hint) els.hint.textContent = modules.length ? `已加载 ${modules.length} 个板块。` : '';

  // Admin bindings (delete/toggle/sort)
  if(isAdmin){
    bindAdminActions();
  }
}

function bindAdminActions(){
  // module toggle
  document.querySelectorAll('[data-mod-toggle]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = Number(btn.getAttribute('data-mod-toggle'));
      const enabled = btn.getAttribute('data-enabled') === '1';
      if(!id) return;
      try{
        const { error } = await supabase
          .from('frontier_modules')
          .update({ enabled: !enabled })
          .eq('id', id);
        if(error) throw error;
        toast('已更新', '板块状态已更新。', 'ok');
        await loadAndRender();
      }catch(e){
        toast('操作失败', e.message || String(e), 'err');
      }
    });
  });

  // module sort
  document.querySelectorAll('[data-mod-sort]').forEach(input=>{
    input.addEventListener('change', async ()=>{
      const id = Number(input.getAttribute('data-mod-sort'));
      if(!id) return;
      const sort = Number(input.value || 0);
      try{
        const { error } = await supabase
          .from('frontier_modules')
          .update({ sort })
          .eq('id', id);
        if(error) throw error;
        toast('已保存', '排序已更新。', 'ok');
        await loadAndRender();
      }catch(e){
        toast('保存失败', e.message || String(e), 'err');
      }
    });
  });

  // module delete
  document.querySelectorAll('[data-mod-del]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = Number(btn.getAttribute('data-mod-del'));
      if(!id) return;
      if(!confirm('确定删除该板块吗？（会同时删除其卡片内容）')) return;
      try{
        const { error } = await supabase
          .from('frontier_modules')
          .delete()
          .eq('id', id);
        if(error) throw error;
        toast('已删除', '板块已删除。', 'ok');
        await loadAndRender();
      }catch(e){
        toast('删除失败', e.message || String(e), 'err');
      }
    });
  });

  // card delete
  document.querySelectorAll('[data-card-del]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = Number(btn.getAttribute('data-card-del'));
      if(!id) return;
      if(!confirm('确定删除这张卡片吗？')) return;
      try{
        const { error } = await supabase
          .from('frontier_cards')
          .delete()
          .eq('id', id);
        if(error) throw error;
        toast('已删除', '卡片已删除。', 'ok');
        await loadAndRender();
      }catch(e){
        toast('删除失败', e.message || String(e), 'err');
      }
    });
  });

  // sponsor sort
  document.querySelectorAll('[data-sponsor-sort]').forEach(input=>{
    input.addEventListener('change', async ()=>{
      const id = Number(input.getAttribute('data-sponsor-sort'));
      if(!id) return;
      const sort = Number(input.value || 0);
      try{
        const { error } = await supabase
          .from('sponsors')
          .update({ sort })
          .eq('id', id);
        if(error) throw error;
        toast('已保存', '赞助商排序已更新。', 'ok');
        await loadAndRender();
      }catch(e){
        toast('保存失败', e.message || String(e), 'err');
      }
    });
  });

  // sponsor toggle: show on home
  document.querySelectorAll('[data-sponsor-toggle-home]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = Number(btn.getAttribute('data-sponsor-toggle-home'));
      const on = btn.getAttribute('data-on') === '1';
      if(!id) return;
      try{
        const { error } = await supabase
          .from('sponsors')
          .update({ show_on_home: !on })
          .eq('id', id);
        if(error) throw error;
        toast('已更新', '首页展示状态已更新。', 'ok');
        await loadAndRender();
      }catch(e){
        const msg = String(e?.message || e);
        if(msg.toLowerCase().includes('column')){
          toast('需要更新数据库', '请运行最新 SUPABASE_SETUP.sql（含 show_on_home 字段）后再试。', 'err');
        }else{
          toast('操作失败', msg, 'err');
        }
      }
    });
  });

  // sponsor toggle: enabled
  document.querySelectorAll('[data-sponsor-toggle-enabled]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = Number(btn.getAttribute('data-sponsor-toggle-enabled'));
      const enabled = btn.getAttribute('data-enabled') === '1';
      if(!id) return;
      try{
        const { error } = await supabase
          .from('sponsors')
          .update({ enabled: !enabled })
          .eq('id', id);
        if(error) throw error;
        toast('已更新', '启用状态已更新。', 'ok');
        await loadAndRender();
      }catch(e){
        toast('操作失败', e.message || String(e), 'err');
      }
    });
  });

  // sponsor delete
  document.querySelectorAll('[data-sponsor-del]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = Number(btn.getAttribute('data-sponsor-del'));
      if(!id) return;
      if(!confirm('确定删除该赞助商吗？')) return;
      try{
        const { error } = await supabase
          .from('sponsors')
          .delete()
          .eq('id', id);
        if(error) throw error;
        toast('已删除', '赞助商已删除。', 'ok');
        await loadAndRender();
      }catch(e){
        toast('删除失败', e.message || String(e), 'err');
      }
    });
  });


  // sponsor edit save
  document.querySelectorAll('[data-sponsor-edit-form]').forEach(form=>{
    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const id = Number(form.getAttribute('data-sponsor-edit-form'));
      if(!id) return;

      const fd = new FormData(form);
      const name = String(fd.get('name') || '').trim();
      const tier = String(fd.get('tier') || 'partner').trim();
      const description = String(fd.get('description') || '').trim();
      const website = String(fd.get('website') || '').trim();
      const logo_url_input = String(fd.get('logo_url') || '').trim();

      if(!name){
        toast('请输入名称', '赞助商名称不能为空。', 'err');
        return;
      }

      const payload = {
        name,
        tier,
        description: description || null,
        website: website || null,
        logo_url: logo_url_input || null,
      };

      const btn = form.querySelector('button[type="submit"]');
      if(btn) btn.disabled = true;

      try{
        const logoFile = fd.get('logo_file');
        if(logoFile && logoFile instanceof File && logoFile.size > 0){
          const url = await uploadSponsorLogo(logoFile, id);
          if(url) payload.logo_url = url;
        }

        const { error } = await supabase
          .from('sponsors')
          .update(payload)
          .eq('id', id);

        if(error) throw error;

        toast('已保存', '赞助商信息已更新。', 'ok');
        await loadAndRender();
      }catch(err){
        toast('保存失败', err.message || String(err), 'err');
      }finally{
        if(btn) btn.disabled = false;
      }
    });
  });

  // sponsor clear logo
  document.querySelectorAll('[data-sponsor-clear-logo]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = Number(btn.getAttribute('data-sponsor-clear-logo'));
      if(!id) return;
      if(!confirm('确认清空该赞助商 Logo？')) return;
      btn.disabled = true;
      try{
        const { error } = await supabase
          .from('sponsors')
          .update({ logo_url: null })
          .eq('id', id);
        if(error) throw error;
        toast('已清空', 'Logo 已移除。', 'ok');
        await loadAndRender();
      }catch(err){
        toast('操作失败', err.message || String(err), 'err');
      }finally{
        btn.disabled = false;
      }
    });
  });


  // richtext save
  document.querySelectorAll('[data-rich-form]').forEach(form=>{
    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const id = Number(form.getAttribute('data-rich-form'));
      if(!id) return;
      const body = String(new FormData(form).get('body') || '').trim();
      const btn = form.querySelector('button[type="submit"]');
      if(btn) btn.disabled = true;
      try{
        const { error } = await supabase
          .from('frontier_modules')
          .update({ body })
          .eq('id', id);
        if(error) throw error;
        toast('已保存', '正文已更新。', 'ok');
        await loadAndRender();
      }catch(err){
        toast('保存失败', err.message || String(err), 'err');
      }finally{
        if(btn) btn.disabled = false;
      }
    });
  });
}

// ------------------------------
// Admin forms (create)
// ------------------------------
function bindAdminForms(){
  if(!els.addModuleForm || !els.addCardForm || !els.addSponsorForm) return;
  if(!isConfigured() || !supabase) return;

  els.addModuleForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!isAdmin){ toast('无权限','仅管理员可操作。','err'); return; }
    const fd = new FormData(els.addModuleForm);
    const title_zh = String(fd.get('title_zh') || '').trim();
    const kind = String(fd.get('kind') || 'cards').trim();
    const description = String(fd.get('description') || '').trim();
    const sort = Number(fd.get('sort') || 0);
    if(!title_zh){ toast('请输入标题','板块标题不能为空。','err'); return; }
    try{
      const { error } = await supabase
        .from('frontier_modules')
        .insert({ title_zh, kind, description: description || null, sort, enabled: true });
      if(error) throw error;
      els.addModuleForm.reset();
      toast('已添加', '板块已创建。', 'ok');
      await loadAndRender();
    }catch(err){
      toast('添加失败', err.message || String(err), 'err');
    }
  });

  els.addCardForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!isAdmin){ toast('无权限','仅管理员可操作。','err'); return; }
    const fd = new FormData(els.addCardForm);
    const module_id = Number(fd.get('module_id') || 0);
    const title = String(fd.get('title') || '').trim();
    const summary = String(fd.get('summary') || '').trim();
    const link_url = String(fd.get('link_url') || '').trim();
    const image_url = String(fd.get('image_url') || '').trim();
    if(!module_id){ toast('请选择板块','请先创建卡片板块。','err'); return; }
    if(!title){ toast('请输入标题','卡片标题不能为空。','err'); return; }
    try{
      const { error } = await supabase
        .from('frontier_cards')
        .insert({ module_id, title, summary: summary || null, link_url: link_url || null, image_url: image_url || null, enabled: true, sort: 0 });
      if(error) throw error;
      els.addCardForm.reset();
      toast('已添加', '卡片已创建。', 'ok');
      await loadAndRender();
    }catch(err){
      toast('添加失败', err.message || String(err), 'err');
    }
  });

    els.addSponsorForm.addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!isAdmin){ toast('无权限','仅管理员可操作。','err'); return; }
    const fd = new FormData(els.addSponsorForm);
    const name = String(fd.get('name') || '').trim();
    const tier = String(fd.get('tier') || 'partner').trim();
    const description = String(fd.get('description') || '').trim();
    const website = String(fd.get('website') || '').trim();
    const logo_url = String(fd.get('logo_url') || '').trim();
    const show_on_home = Boolean(fd.get('show_on_home'));
    const logoFile = fd.get('logo_file');

    if(!name){ toast('请输入名称','赞助商名称不能为空。','err'); return; }

    try{
      const payloadV2 = { name, tier, description: description || null, website: website || null, logo_url: logo_url || null, enabled: true, show_on_home, sort: 0 };
      const payloadV1 = { name, tier, description: description || null, website: website || null, logo_url: logo_url || null, enabled: true, sort: 0 };

      let res = await supabase
        .from('sponsors')
        .insert(payloadV2)
        .select('id')
        .single();

      // Backward compatibility if show_on_home column is not created yet
      if(res?.error && String(res.error.message||'').toLowerCase().includes('column')){
        res = await supabase
          .from('sponsors')
          .insert(payloadV1)
          .select('id')
          .single();
      }

      if(res?.error) throw res.error;

      const sponsorId = res?.data?.id;

      // Upload logo file (optional). We upload AFTER insert so we can use sponsorId in path.
      if(sponsorId && logoFile && logoFile instanceof File && logoFile.size > 0){
        try{
          const url = await uploadSponsorLogo(logoFile, sponsorId);
          if(url){
            const { error: uerr } = await supabase
              .from('sponsors')
              .update({ logo_url: url })
              .eq('id', sponsorId);
            if(uerr) throw uerr;
          }
        }catch(upErr){
          toast('Logo 上传失败', upErr.message || String(upErr), 'err');
        }
      }

      els.addSponsorForm.reset();
      toast('已添加', '赞助商已创建。', 'ok');
      await loadAndRender();
    }catch(err){
      toast('添加失败', err.message || String(err), 'err');
    }
  });


}

// boot
loadAndRender().then(()=>{
  if(isAdmin) bindAdminForms();
});
