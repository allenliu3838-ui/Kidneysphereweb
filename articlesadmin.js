import {
  getSupabase,
  getCurrentUser,
  getUserProfile,
  isAdminRole,
} from './supabaseClient.js?v=20260128_030';

const root = document.getElementById('adminArticlesList');

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function fmt(ts){
  try{
    const d = new Date(ts);
    const opts = { timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' };
    const parts = new Intl.DateTimeFormat('zh-CN', opts).formatToParts(d);
    const m = Object.fromEntries(parts.map(p=>[p.type,p.value]));
    return `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}`;
  }catch(_e){
    return String(ts || '');
  }
}

function renderRow(a){
  const title = a.title || '未命名';
  const status = String(a.status || 'draft');
  const when = a.published_at || a.updated_at || a.created_at;
  const meta = `${fmt(when)}${a.author_name ? ' · ' + a.author_name : ''}`;

  return `
    <a class="list-item" href="article-editor.html?id=${encodeURIComponent(a.id)}">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
        <div style="min-width:0">
          <b style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</b>
          <div class="small muted" style="margin-top:6px">${esc(meta)}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${a.pinned ? `<span class="chip soon">置顶</span>` : ''}
          ${status === 'published' ? `<span class="chip">已发布</span>` : `<span class="chip todo">${esc(status === 'draft' ? '草稿' : status)}</span>`}
          <span class="chip">编辑</span>
        </div>
      </div>
    </a>
  `;
}

async function main(){
  if(!root) return;

  try{
    const supabase = await getSupabase();
    const user = await getCurrentUser();
    if(!user){
      root.innerHTML = `<div class="muted small">未登录。</div>`;
      return;
    }
    const profile = await getUserProfile(user.id);
    if(!isAdminRole(profile?.role)){
      root.innerHTML = `<div class="muted small">你没有管理员权限。</div>`;
      return;
    }

    root.innerHTML = `<div class="muted small">加载中…</div>`;

    const { data, error } = await supabase
      .from('articles')
      .select('id, title, status, pinned, author_name, created_at, updated_at, published_at, deleted_at')
      .is('deleted_at', null)
      .order('pinned', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(10);

    if(error) throw error;

    const items = data || [];
    if(items.length === 0){
      root.innerHTML = `<div class="muted small">暂无文章。点击上方“写文章”创建。</div>`;
      return;
    }
    root.innerHTML = items.map(renderRow).join('');

  }catch(e){
    root.innerHTML = `
      <div class="muted small">加载失败：${esc(e?.message || String(e))}</div>
      <div class="small muted" style="margin-top:8px">提示：请在 Supabase 运行 <b>MIGRATION_20260107_NEXT.sql</b> 创建 articles 表并刷新 schema。</div>
    `;
  }
}

main();
