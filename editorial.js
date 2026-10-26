import {
  getSupabase,
  getCurrentUser,
  getUserProfile,
  isAdminRole,
} from './supabaseClient.js?v=20260917_content1';

const gate = document.getElementById('editorialGate');
const root = document.getElementById('editorialRoot');
const list = document.getElementById('editorialList');
const reviewCount = document.getElementById('reviewCount');
const draftCount = document.getElementById('draftCount');
const roleEl = document.getElementById('editorialRole');
const refreshBtn = document.getElementById('editorialRefresh');
const filters = document.getElementById('editorialFilters');
const adminLink = document.getElementById('editorialAdminLink');

let supabase;
let canPublish = false;
let currentFilter = 'all';
let rows = [];

function esc(value){
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function fmt(ts){
  if(!ts) return '';
  try{
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit'
    }).format(new Date(ts));
  }catch(_e){ return String(ts); }
}

function statusLabel(status){
  if(status === 'in_review') return '待审核';
  if(status === 'draft') return '草稿';
  return status || '草稿';
}

function render(){
  if(!list) return;
  const visible = currentFilter === 'all' ? rows : rows.filter(row => row.status === currentFilter);
  reviewCount.textContent = String(rows.filter(row => row.status === 'in_review').length);
  draftCount.textContent = String(rows.filter(row => row.status === 'draft').length);
  if(!visible.length){
    list.innerHTML = '<div class="muted small">当前没有符合条件的内容。</div>';
    return;
  }
  list.innerHTML = visible.map(row => {
    const tags = Array.isArray(row.tags) ? row.tags : [];
    const ai = tags.includes('AI待审');
    const daily = row.daily_learning || null;
    return `<article class="list-item">
      <div style="display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap">
        <div style="min-width:260px;flex:1">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <b>${esc(row.title || '未命名')}</b>
            <span class="chip todo">${esc(statusLabel(row.status))}</span>
            ${ai ? '<span class="chip soon">AI 待审</span>' : ''}
            ${daily ? `<span class="chip">每日一学 · ${esc(daily.scheduled_date || '待排期')}</span>` : ''}
          </div>
          <div class="small muted" style="margin-top:7px">${esc(fmt(row.updated_at || row.created_at))}${row.author_name ? ` · ${esc(row.author_name)}` : ''}</div>
          ${row.summary ? `<div class="small" style="margin-top:8px">${esc(row.summary)}</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn tiny" href="article-editor.html?id=${encodeURIComponent(row.id)}">审核 / 编辑</a>
          ${canPublish && row.status === 'in_review' ? `<button class="btn tiny primary" type="button" data-publish="${esc(row.id)}">${daily ? '审核通过并上线每日一学' : '审核通过并发布'}</button>` : ''}
        </div>
      </div>
    </article>`;
  }).join('');
}

async function load(){
  list.innerHTML = '<div class="muted small">加载中…</div>';
  const { data, error } = await supabase
    .from('articles')
    .select('id,title,summary,tags,status,author_id,author_name,created_at,updated_at')
    .in('status',['draft','in_review'])
    .is('deleted_at',null)
    .order('updated_at',{ascending:false})
    .limit(100);
  if(error) throw error;
  rows = data || [];
  const ids = rows.map(row => row.id).filter(Boolean);
  if(ids.length){
    const daily = await supabase.from('daily_learning_cards')
      .select('article_id,scheduled_date,active').in('article_id',ids);
    if(!daily.error){
      const byArticle = new Map((daily.data || []).map(item => [item.article_id,item]));
      rows = rows.map(row => ({...row,daily_learning:byArticle.get(row.id) || null}));
    }
  }
  render();
}

async function publishArticle(id, button){
  if(!canPublish) return;
  const row = rows.find(item => item.id === id);
  const message = row?.daily_learning
    ? '确认已完成医学内容与来源审核，并按计划上线“每日一学”？'
    : '确认已完成医学内容审核并公开发布？';
  if(!confirm(message)) return;
  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = '发布中…';
  try{
    const { error } = await supabase.rpc('publish_article_from_review',{p_article_id:id});
    if(error) throw error;
    rows = rows.filter(row => row.id !== id);
    render();
  }catch(error){
    button.disabled = false;
    button.textContent = oldText;
    alert(`发布失败：${error?.message || error}`);
  }
}

async function main(){
  try{
    supabase = await getSupabase();
    const user = await getCurrentUser();
    if(!user){
      location.replace(`login.html?next=${encodeURIComponent('editorial.html')}`);
      return;
    }
    const profile = await getUserProfile(user.id);
    const editorCheck = await supabase.rpc('is_content_editor');
    if(editorCheck.error) throw editorCheck.error;
    if(editorCheck.data !== true){
      gate.innerHTML = '<div class="small">当前账号没有内容编辑权限。</div>';
      return;
    }
    canPublish = isAdminRole(profile?.role);
    adminLink.hidden = !canPublish;
    roleEl.textContent = canPublish ? '管理员 / 发布人' : '内容编辑';
    gate.hidden = true;
    root.hidden = false;
    await load();
  }catch(error){
    gate.hidden = false;
    gate.innerHTML = `<div class="small">内容工作台加载失败：${esc(error?.message || error)}</div>`;
  }
}

refreshBtn?.addEventListener('click', () => load().catch(error => {
  list.innerHTML = `<div class="small">刷新失败：${esc(error?.message || error)}</div>`;
}));

filters?.addEventListener('click', event => {
  const button = event.target.closest('[data-status]');
  if(!button) return;
  currentFilter = button.dataset.status || 'all';
  filters.querySelectorAll('[data-status]').forEach(item => item.classList.toggle('primary', item === button));
  render();
});

list?.addEventListener('click', event => {
  const button = event.target.closest('[data-publish]');
  if(button) publishArticle(button.dataset.publish, button);
});

main();
