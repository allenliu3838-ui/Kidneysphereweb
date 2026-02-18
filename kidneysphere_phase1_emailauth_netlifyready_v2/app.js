import { supabase, getUserProfile, ensureAuthed, signOut, toast, isConfigured, isAdminRole, normalizeRole } from './supabaseClient.js';

function setActiveNav(){
  const path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('[data-nav]').forEach(a=>{
    const href = a.getAttribute('href');
    if(href === path){ a.classList.add('active'); }
  });
}

async function renderAuthArea(){
  const auth = document.querySelector('[data-auth]');
  if(!auth) return;

  // If Supabase is not configured, show a warning badge + allow local demo.
  if(!isConfigured()){
    auth.innerHTML = `
      <span class="badge" title="请在 assets/config.js 填入 Supabase 配置后再上线真实注册登录">
        ⚠️ Supabase 未配置
      </span>
      <a class="btn" href="login.html">登录</a>
      <a class="btn primary" href="register.html">注册</a>
    `;
    return;
  }

  let session = null;
  try{
    const res = await supabase.auth.getSession();
    session = res?.data?.session || null;
  }catch(e){
    // If auth can't read session (e.g., key mismatch / storage issue), keep UI usable
    // and surface a small debug hint.
    const msg = (e && (e.message || e.error_description)) ? String(e.message || e.error_description) : '未知错误';
    auth.innerHTML = `
      <span class="badge" title="Auth session 读取失败：${escapeHtml(msg)}">⚠️ 登录状态异常</span>
      <a class="btn" href="login.html">登录</a>
      <a class="btn primary" href="register.html">注册</a>
    `;
    return;
  }

  if(!session){
    auth.innerHTML = `
      <a class="btn" href="login.html">登录</a>
      <a class="btn primary" href="register.html">注册</a>
    `;
    return;
  }

  const user = session.user;
  const profile = await getUserProfile(user);

  const name = profile?.full_name || user.user_metadata?.full_name || user.phone || user.email || 'Member';
  const role = profile?.role || user.user_metadata?.role || 'Member';
  const avatarUrl = profile?.avatar_url || user.user_metadata?.avatar_url || '';
  const initial = (name || 'M').trim().slice(0,1).toUpperCase();

  auth.innerHTML = `
    <div class="pill" title="${name}">
      <div class="avatar">${avatarUrl ? `<img alt="avatar" src="${avatarUrl}" style="width:28px;height:28px;border-radius:999px;object-fit:cover">` : initial}</div>
      <div class="who">
        <b>${escapeHtml(name)}</b>
        <span>${escapeHtml(role)}</span>
      </div>
    </div>
    <button class="btn danger" data-logout>退出</button>
  `;

  auth.querySelector('[data-logout]')?.addEventListener('click', async ()=>{
    await signOut();
  });
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

setActiveNav();
renderAuthArea();

// keep auth UI updated
if(isConfigured()){
  supabase.auth.onAuthStateChange((_event, _session) => renderAuthArea());
}

// expose helpers
window.KS = { ensureAuthed, toast };

// ------------------------------
// About page: admin-editable showcase blocks
// ------------------------------
async function initAboutShowcase(){
  const root = document.querySelector('[data-about-showcase]');
  if(!root) return;

  const lists = {
    flagship: document.querySelector('[data-showcase-list="flagship"]'),
    partners: document.querySelector('[data-showcase-list="partners"]'),
    experts: document.querySelector('[data-showcase-list="experts"]'),
  };

  // Demo mode (no Supabase configured)
  if(!isConfigured() || !supabase){
    Object.keys(lists).forEach(k=>{
      if(lists[k]){
        lists[k].innerHTML = `<div class="muted small">（演示模式）配置 Supabase 后可由管理员在此增删条目。</div>`;
      }
    });
    return;
  }

  const { data: { session } } = await supabase.auth.getSession();
  const user = session?.user || null;
  const profile = user ? await getUserProfile(user) : null;
  // IMPORTANT: do NOT trust user_metadata for admin privileges.
  const role = normalizeRole(profile?.role);
  const isAdmin = isAdminRole(role);

  // Toggle admin panels
  document.querySelectorAll('[data-admin-panel]').forEach(el=>{
    el.hidden = !isAdmin;
  });

  // Load + render
  await loadAndRender();

  // Bind forms (admin only)
  if(isAdmin){
    document.querySelectorAll('[data-showcase-form]').forEach(form=>{
      form.addEventListener('submit', async (e)=>{
        e.preventDefault();
        const category = form.getAttribute('data-showcase-form');
        const fd = new FormData(form);
        const title = (fd.get('title') || '').toString().trim();
        const description = (fd.get('description') || '').toString().trim();
        const link = (fd.get('link') || '').toString().trim();
        if(!title){ toast('请输入名称/标题','', 'err'); return; }

        const { error } = await supabase
          .from('about_showcase')
          .insert({ category, title, description: description || null, link: link || null, sort: 0 });
        if(error){ toast('添加失败', error.message, 'err'); return; }
        form.reset();
        toast('已添加', '条目已写入。', 'ok');
        await loadAndRender();
      });
    });
  }

  async function loadAndRender(){
    const { data, error } = await supabase
      .from('about_showcase')
      .select('id, category, title, description, link, sort, created_at')
      .order('sort', { ascending: true })
      .order('created_at', { ascending: false });
    if(error){
      Object.keys(lists).forEach(k=>{ if(lists[k]) lists[k].innerHTML = `<div class="muted small">读取失败：${escapeHtml(error.message)}</div>`; });
      return;
    }
    const byCat = { flagship: [], partners: [], experts: [] };
    (data || []).forEach(row=>{
      if(byCat[row.category]) byCat[row.category].push(row);
    });
    Object.keys(byCat).forEach(cat=> renderList(cat, byCat[cat]));
  }

  function renderList(category, items){
    const el = lists[category];
    if(!el) return;
    if(!items || items.length === 0){
      el.innerHTML = `<div class="muted small">暂无条目。管理员可在下方添加。</div>`;
      return;
    }
    el.innerHTML = items.map(it=>{
      const link = it.link ? `<a class="small" href="${escapeHtml(it.link)}" target="_blank" rel="noopener">链接</a>` : '';
      const del = isAdmin ? `<button class="btn tiny danger" data-del="${it.id}" data-cat="${category}">删除</button>` : '';
      return `
        <div class="showcase-item">
          <div class="showcase-main">
            <b>${escapeHtml(it.title)}</b>
            ${it.description ? `<div class="small muted" style="margin-top:4px">${escapeHtml(it.description)}</div>` : ''}
            ${link ? `<div style="margin-top:6px">${link}</div>` : ''}
          </div>
          ${del}
        </div>
      `;
    }).join('');

    if(isAdmin){
      el.querySelectorAll('[data-del]').forEach(btn=>{
        btn.addEventListener('click', async ()=>{
          const id = btn.getAttribute('data-del');
          const { error } = await supabase.from('about_showcase').delete().eq('id', id);
          if(error){ toast('删除失败', error.message, 'err'); return; }
          toast('已删除', '条目已移除。', 'ok');
          await loadAndRender();
        });
      });
    }
  }
}

initAboutShowcase();
