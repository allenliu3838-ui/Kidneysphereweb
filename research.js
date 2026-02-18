import { supabase, ensureSupabase, isConfigured, toast, getCurrentUser, getUserProfile, isAdminRole, normalizeRole } from './supabaseClient.js?v=20260128_030';

    const grid = document.getElementById('projectGrid');
    const adminBox = document.getElementById('adminBox');
    const form = document.getElementById('projectForm');
    const adminList = document.getElementById('adminProjectsList');

    const infoEl = document.getElementById('researchInfo');
    const settingsForm = document.getElementById('settingsForm');


    function esc(str){ return String(str ?? '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s])); }
    function nl2br(str){ return esc(str).replace(/\n/g, '<br/>'); }


    function statusChip(status){
      const s = (status || '').toLowerCase();
      const map = {
        planning: { zh:'筹备中', cls:'todo' },
        starting: { zh:'启动中', cls:'soon' },
        recruiting:{ zh:'招募中', cls:'soon' },
        ongoing:  { zh:'进行中', cls:'soon' },
        completed:{ zh:'已完成', cls:'soon' },
      };
      const it = map[s] || { zh:'筹备中', cls:'todo' };
      return `<span class="chip ${it.cls}">${it.zh}</span>`;
    }

    function render(items){
      const list = items || [];
      if(list.length === 0){
        grid.innerHTML = '<div class="muted small">暂无项目。我们将在 2026 年逐步发布研究项目与协作计划。</div>';
        return;
      }
      grid.innerHTML = list.map(p=>`
        <div class="card soft">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
            <h3 style="margin:0;min-width:0">${esc(p.title)}</h3>
            ${statusChip(p.status)}
          </div>
          ${p.study_type ? `<div class="small muted" style="margin-top:8px">${esc(p.study_type)}</div>` : ''}
          ${p.summary ? `<p class="small" style="margin-top:10px">${esc(p.summary)}</p>` : ''}
          ${p.pi ? `<div class="small muted" style="margin-top:8px">PI：${esc(p.pi)}</div>` : ''}
        </div>
      `).join('');
    }

    function adminProjectCard(p){
      const active = p.active !== false;
      const sort = (typeof p.sort_order === 'number') ? p.sort_order : 0;
      return `
        <div class="card soft" style="padding:18px" id="rp-${p.id}">
          <form class="form" data-rp-form="${p.id}">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
              <div>
                <b>项目ID：${p.id}</b>
                <div class="small muted" style="margin-top:6px">状态：${active ? '公开' : '已隐藏'}</div>
              </div>
              <div style="display:flex;gap:10px;flex-wrap:wrap">
                <button class="btn primary" type="submit">保存</button>
                <button class="btn ${active ? 'danger' : ''}" type="button" data-rp-toggle="${p.id}">${active ? '隐藏' : '恢复'}</button>
              </div>
            </div>

            <label style="margin-top:12px">项目名称
              <input class="input" name="title" value="${esc(p.title || '')}" required />
            </label>

            <div class="form-row">
              <div>
                <label>状态
                  <select class="input" name="status">
                    ${['planning','starting','recruiting','ongoing','completed'].map(s=>`
                      <option value="${s}" ${String(p.status||'planning')===s?'selected':''}>${({planning:'筹备中',starting:'启动中',recruiting:'招募中',ongoing:'进行中',completed:'已完成'})[s]}</option>
                    `).join('')}
                  </select>
                </label>
              </div>
              <div>
                <label>排序（越小越靠前）
                  <input class="input" type="number" name="sort_order" value="${esc(sort)}" />
                </label>
              </div>
            </div>

            <div class="form-row">
              <div>
                <label>研究类型
                  <input class="input" name="study_type" value="${esc(p.study_type || '')}" placeholder="回顾性 / 前瞻性 / 登记 / 队列 / 试验" />
                </label>
              </div>
              <div>
                <label>负责人（PI）
                  <input class="input" name="pi" value="${esc(p.pi || '')}" placeholder="姓名" />
                </label>
              </div>
            </div>

            <label>一句话摘要
              <textarea class="input" name="summary" rows="3" placeholder="研究目的/主要终点/协作方式">${esc(p.summary || '')}</textarea>
            </label>
          </form>
        </div>
      `;
    }

    function bindAdminListHandlers(items){
      if(!adminList) return;

      // save
      adminList.querySelectorAll('[data-rp-form]').forEach(formEl=>{
        formEl.addEventListener('submit', async (e)=>{
          e.preventDefault();
          const id = Number(formEl.getAttribute('data-rp-form'));
          const p = items.find(x=>Number(x.id)===id);
          if(!p) return;
          const fd = new FormData(formEl);
          const payload = {
            title: String(fd.get('title')||'').trim(),
            status: String(fd.get('status')||'planning'),
            study_type: String(fd.get('study_type')||'').trim() || null,
            summary: String(fd.get('summary')||'').trim() || null,
            pi: String(fd.get('pi')||'').trim() || null,
            sort_order: Number(fd.get('sort_order')||0) || 0,
          };
          if(!payload.title){ toast('缺少名称','请填写项目名称。','err'); return; }
          const btn = formEl.querySelector('button[type="submit"]');
          if(btn) btn.disabled = true;
          try{
            const { error } = await supabase
              .from('research_projects')
              .update(payload)
              .eq('id', id);
            if(error) throw error;
            toast('已保存','项目已更新。','ok');
            await load();
          }catch(err){
            toast('保存失败', err.message || String(err), 'err');
          }finally{
            if(btn) btn.disabled = false;
          }
        });
      });

      // hide / restore
      adminList.querySelectorAll('[data-rp-toggle]').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          const id = Number(btn.getAttribute('data-rp-toggle'));
          const p = items.find(x=>Number(x.id)===id);
          if(!p) return;
          const next = (p.active !== false) ? false : true;
          btn.disabled = true;
          try{
            const { error } = await supabase
              .from('research_projects')
              .update({ active: next })
              .eq('id', id);
            if(error) throw error;
            toast('已更新', next ? '项目已恢复公开。' : '项目已隐藏（对普通用户不可见）。', 'ok');
            await load();
          }catch(err){
            toast('操作失败', err.message || String(err), 'err');
          }finally{
            btn.disabled = false;
          }
        });
      });
    }

    
    async function loadSettings(isAdmin){
      if(!infoEl && !settingsForm) return;
      if(!isConfigured() || !supabase){
        // keep default HTML (static fallback)
        return;
      }

      try{
        const { data, error } = await supabase
          .from('research_settings')
          .select('id, intro, contact, address, updated_at')
          .eq('id', 1)
          .maybeSingle();
        if(error) throw error;

        if(data){
          const parts = [];
          if(data.intro) parts.push(`<div style="line-height:1.75">${nl2br(String(data.intro))}</div>`);
          const meta = [];
          if(data.contact) meta.push(`<div><b>联系方式：</b>${nl2br(String(data.contact))}</div>`);
          if(data.address) meta.push(`<div><b>地址：</b>${nl2br(String(data.address))}</div>`);
          if(meta.length) parts.push(`<div class="small muted" style="margin-top:10px;line-height:1.75">${meta.join('<div style="height:8px"></div>')}</div>`);
          if(infoEl) infoEl.innerHTML = parts.join('') || '<div class="small muted">暂无中心信息。</div>';

          if(settingsForm && isAdmin){
            settingsForm.querySelector('[name="intro"]').value = data.intro || '';
            settingsForm.querySelector('[name="contact"]').value = data.contact || '';
            settingsForm.querySelector('[name="address"]').value = data.address || '';
          }
        }else{
          if(infoEl && !infoEl.innerHTML.trim()){
            infoEl.innerHTML = '<div class="small muted">暂无中心信息。</div>';
          }
        }
      }catch(e){
        // Silent for public
        if(infoEl && !infoEl.innerHTML.trim()){
          infoEl.innerHTML = '<div class="small muted">中心信息加载失败。</div>';
        }
      }
    }

async function load(){
      // Ensure client first (this script can run before app.js)
      if(isConfigured() && !supabase){
        try{ await ensureSupabase(); }catch(_e){ /* ignore */ }
      }

      // Admin check (optional)
      let isAdmin = false;
      try{
        if(isConfigured() && supabase){
          const u = await getCurrentUser();
          const p = u ? await getUserProfile(u) : null;
          // Admin privileges should be driven by profiles.role (RLS-protected).
          const role = normalizeRole(p?.role);
          isAdmin = isAdminRole(role);
        }
      }catch(_e){}
      adminBox.hidden = !isAdmin;

      await loadSettings(isAdmin);


      // Load projects (if table exists)
      if(!isConfigured() || !supabase){
        render([]);
        if(adminList) adminList.innerHTML = '';
        return;
      }

      try{
        // Public list (active only)
        const { data: pubData, error: pubErr } = await supabase
          .from('research_projects')
          .select('id, title, status, study_type, summary, pi, sort_order, created_at, active')
          .eq('active', true)
          .order('sort_order', { ascending: true })
          .order('created_at', { ascending: false });
        if(pubErr) throw pubErr;
        render(pubData || []);

        // Admin list (all)
        if(isAdmin && adminList){
          const { data: allData, error: allErr } = await supabase
            .from('research_projects')
            .select('id, title, status, study_type, summary, pi, sort_order, created_at, active')
            .order('sort_order', { ascending: true })
            .order('created_at', { ascending: false });
          if(allErr) throw allErr;
          const items = allData || [];
          adminList.innerHTML = items.length
            ? items.map(adminProjectCard).join('')
            : '<div class="muted small">暂无项目。</div>';
          bindAdminListHandlers(items);
        }
      }catch(e){
        grid.innerHTML = `<div class="muted small">读取失败：${esc(e.message || String(e))}<br/>（如未初始化表，请先运行 Supabase SQL 初始化脚本）</div>`;
        if(adminList) adminList.innerHTML = '';
      }
    }

    settingsForm?.addEventListener('submit', async (e)=>{
      e.preventDefault();
      if(!isConfigured() || !supabase){ toast('未配置','请先配置 Supabase。','err'); return; }
      try{
        const u = await getCurrentUser();
        const p = u ? await getUserProfile(u) : null;
        const role = normalizeRole(p?.role || u?.user_metadata?.role);
        if(!isAdminRole(role)){ toast('无权限','仅管理员可编辑中心信息。','err'); return; }
        const fd = new FormData(settingsForm);
        const intro = String(fd.get('intro')||'').trim() || null;
        const contact = String(fd.get('contact')||'').trim() || null;
        const address = String(fd.get('address')||'').trim() || null;
        const payload = { id: 1, intro, contact, address, updated_at: new Date().toISOString(), updated_by: u.id };
        const { error } = await supabase.from('research_settings').upsert(payload, { onConflict: 'id' });
        if(error) throw error;
        toast('已保存','中心信息已更新。','ok');
        await loadSettings(true);
      }catch(err){
        toast('保存失败', err.message || String(err), 'err');
      }
    });

form?.addEventListener('submit', async (e)=>{
      e.preventDefault();
      if(!isConfigured() || !supabase){ toast('未配置', '请先配置 Supabase。', 'err'); return; }
      const fd = new FormData(form);
      const payload = {
        title: String(fd.get('title')||'').trim(),
        status: String(fd.get('status')||'planning'),
        study_type: String(fd.get('study_type')||'').trim() || null,
        summary: String(fd.get('summary')||'').trim() || null,
        pi: String(fd.get('pi')||'').trim() || null,
        active: true,
      };
      if(!payload.title){ toast('缺少名称','请填写项目名称。','err'); return; }
      try{
        const { error } = await supabase.from('research_projects').insert(payload);
        if(error) throw error;
        toast('已添加','项目已加入项目库。','ok');
        form.reset();
        await load();
      }catch(err){
        toast('添加失败', err.message || String(err), 'err');
      }
    });

    load();