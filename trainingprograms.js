// trainingPrograms.js (v8.14)
//
// - 首页：动态渲染“学习中心 · 培训项目”列表（可后台编辑）
// - 学习中心：动态渲染“培训项目”卡片
//
// 数据来源：public.training_programs（见 MIGRATION_20260121_TRAINING_MODERATORS.sql）

import {
  supabase,
  ensureSupabase,
  isConfigured,
  formatBeijingDateTime,
  toast,
} from './supabaseClient.js?v=20260128_030';

const homeListEl = document.getElementById('homeTrainingList');
const gridEl = document.getElementById('trainingProgramsGrid');
const hintEl = document.getElementById('trainingProgramsHint');

const DEMO_PROGRAMS = [
  { title: '肾小球与间质性肾病培训项目', status:'active', badge:'进行中', description:'覆盖 IgAN、膜性肾病、FSGS、ANCA 相关肾炎等核心病种，系统化课程体系。', sort: 10 },
  { title: '肾移植内科培训项目', status:'coming_soon', badge:'即将启动', description:'围绕随访管理、感染与免疫、并发症管理等。', sort: 20 },
  { title: '儿童肾脏病培训项目', status:'coming_soon', badge:'即将启动', description:'儿童遗传肾病、肾综、透析/移植随访等方向。', sort: 30 },
  { title: 'AI 肾病培训项目', status:'coming_soon', badge:'即将启动', description:'AI 在肾病学中的应用与实践案例。', sort: 40 },
];

function esc(str){
  return String(str ?? '').replace(/[&<>'"]/g, s => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'
  }[s]));
}

function chip(status){
  const s = String(status||'').toLowerCase();
  if(s === 'active') return { cls:'soon', label:'进行中' };
  if(s === 'archived') return { cls:'todo', label:'已结束' };
  if(s === 'coming_soon') return { cls:'todo', label:'即将启动' };
  return { cls:'todo', label:'即将启动' };
}

function normalize(rows){
  const arr = Array.isArray(rows) ? rows.slice() : [];
  arr.sort((a,b)=>{
    const sa = Number(a.sort ?? 0);
    const sb = Number(b.sort ?? 0);
    if(sa !== sb) return sa - sb;
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    return ta - tb;
  });
  return arr;
}

function renderHome(rows){
  if(!homeListEl) return;
  const list = normalize(rows);
  homeListEl.innerHTML = list.map(p=>{
    const c = chip(p.status);
    const badge = p.badge ? `<span class="chip ${c.cls}">${esc(p.badge)}</span>` : `<span class="chip ${c.cls}">${c.label}</span>`;
    return `<li><b>${esc(p.title)}</b>${badge}</li>`;
  }).join('');
}

function renderGrid(rows){
  if(!gridEl) return;
  const list = normalize(rows);
  gridEl.innerHTML = list.map(p=>{
    const c = chip(p.status);
    const badgeText = p.badge ? esc(p.badge) : c.label;
    const desc = p.description ? esc(p.description) : '';
    const link = String(p.link || '').trim();
    const cta = link
      ? `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener">了解更多</a>`
      : `<span class="small muted">详情页筹备中</span>`;

    return `
      <div class="card soft">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
          <div style="min-width:0">
            <h3 style="margin:0 0 6px">${esc(p.title)}</h3>
            ${desc ? `<p class="small" style="margin:0 0 10px">${desc}</p>` : ``}
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
              <span class="chip ${c.cls}">${badgeText}</span>
              ${cta}
            </div>
          </div>
          <span class="badge">Training</span>
        </div>
      </div>
    `;
  }).join('');
}

function showHint(msg){
  if(!hintEl) return;
  hintEl.hidden = false;
  hintEl.innerHTML = msg;
}

async function loadPrograms(){
  // Demo mode
  if(!isConfigured()){
    renderHome(DEMO_PROGRAMS);
    renderGrid(DEMO_PROGRAMS);
    return;
  }

  // Ensure client
  try{ await ensureSupabase(); }catch(_e){}
  if(!supabase){
    renderHome(DEMO_PROGRAMS);
    renderGrid(DEMO_PROGRAMS);
    showHint('<b>提示：</b>Supabase 客户端未初始化，已使用演示数据。');
    return;
  }

  try{
    const { data, error } = await supabase
      .from('training_programs')
      .select('id, title, description, status, badge, is_paid, link, sort, created_at, updated_at, deleted_at')
      .is('deleted_at', null)
      .order('sort', { ascending: true })
      .order('created_at', { ascending: true });

    if(error) throw error;

    const rows = Array.isArray(data) ? data : [];
    if(rows.length === 0){
      renderHome([]);
      renderGrid([]);
      showHint('<b>提示：</b>培训项目即将上线，敬请关注。');
      return;
    }

    renderHome(rows);
    renderGrid(rows);

  }catch(e){
    const msg = String(e?.message || e || '');
    // Likely missing table or schema cache not refreshed
    if(/training_programs/i.test(msg) && /(does not exist|relation|schema cache|could not find|not find)/i.test(msg)){
      renderHome(DEMO_PROGRAMS);
      renderGrid(DEMO_PROGRAMS);
      showHint(
        '<b>提示：</b>未检测到 <code>training_programs</code> 表。\n' +
        '请在 Supabase SQL Editor 运行 <code>MIGRATION_20260121_TRAINING_MODERATORS.sql</code>，然后 Settings → API 点击 <b>Reload schema</b>。'
      );
      return;
    }
    // Other errors (network, RLS, etc.)
    renderHome(DEMO_PROGRAMS);
    renderGrid(DEMO_PROGRAMS);
    showHint('<b>提示：</b>读取培训项目失败，已使用演示数据。错误：' + esc(msg));
    try{ toast('培训项目加载失败', msg); }catch(_e){}
  }
}

loadPrograms();
