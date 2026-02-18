import { supabase, ensureSupabase, isConfigured, toast, getCurrentUser, getUserProfile, isAdminRole, normalizeRole } from './supabaseClient.js?v=20260128_030';

// Admin UI view mode (frontend-only)
// Why: admin/super-admin accounts may want to browse as a normal member.
// This only controls UI visibility; it does NOT change DB/RLS permissions.
const VIEW_MODE_KEY = 'ks_view_mode';

function readViewModePref(){
  try{
    const v = localStorage.getItem(VIEW_MODE_KEY);
    if(v === 'admin' || v === 'member') return v;
  }catch(_e){}
  return 'member';
}

const channelGrid = document.getElementById('channelGrid');
const sectionGrid = document.getElementById('sectionGrid');
const adminBox = document.getElementById('sectionAdmin');
const addForm = document.getElementById('addSectionForm');
const seedBtn = document.getElementById('seedDefaultBtn');

const DEFAULT_CHANNELS = [
  {
    id: 'case',
    title_zh: '病例讨论',
    title_en: 'Cases',
    description: '按肾脏亚专科分区进入：发布病例、回复讨论、沉淀知识。',
    status: 'active',
  },
  {
    id: 'literature',
    title_zh: '文献学习',
    title_en: 'Journal Club',
    description: '指南/综述/临床试验/新药机制：可发帖、可上传 PDF/图片，支持讨论与收藏。',
    status: 'active',
  },
  {
    id: 'research',
    title_zh: '科研讨论',
    title_en: 'Research',
    description: '临床 + 基础研究的想法碰撞、方案讨论、数据解读；支持附件与长文。',
    status: 'active',
  },
  {
    id: 'english',
    title_zh: '国际讨论专区',
    title_en: 'English Discussion',
    description: '面向国际协作与学术沟通的英语版块（即将开放）。',
    status: 'coming_soon',
  },
];

const DEFAULT_SECTIONS = [
  { key: 'glom', title_zh: '肾小球与间质性肾病社区', description: 'IgAN、MN、FSGS、MCD、AAV、补体相关病、间质性肾炎/药物相关肾损伤等。' },
  { key: 'tx', title_zh: '肾移植内科社区', description: '排斥、感染、免疫抑制、妊娠、围手术期与长期随访。' },
  { key: 'icu', title_zh: '重症肾内（电解质/酸碱）与透析社区', description: 'AKI/CRRT、休克、液体管理与抗凝、电解质/酸碱紊乱、透析并发症。' },
  { key: 'peds', title_zh: '儿童肾脏病社区', description: '儿肾病例、遗传肾病、儿童透析与移植随访、发育相关问题。' },
  { key: 'rare', title_zh: '罕见肾脏病社区', description: '遗传/罕见肾病、C3G/aHUS、MGRS、Fabry 等疑难病例与机制讨论。' },
];

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

function statusBadge(status){
  const s = (status || '').toString().toLowerCase();
  if(s === 'active') return `<span class="badge">已开放</span>`;
  if(s === 'hidden') return `<span class="badge">隐藏</span>`;
  return `<span class="badge" style="border-color:rgba(255,255,255,.18);background:rgba(255,255,255,.06)">敬请期待</span>`;
}

function renderChannels(channels){
  const src = (channels || DEFAULT_CHANNELS);
  const items = src.filter(Boolean).map(ch => {
    const id = String(ch.id || '').toLowerCase();
    let status = (ch.status || '').toString().toLowerCase();

    // 需求：文献学习 & 科研讨论开放；国际讨论专区（英语）显示为筹备中。
    // 即便 channels 表还没更新 status，这里也以页面“已开放/筹备中”为准，避免入口被挡住。
    if(id === 'english') status = 'coming_soon';
    if(id === 'research' || id === 'literature') status = 'active';
    const title = ch.title_zh || ch.name_zh || ch.title || ch.id;
    const en = ch.title_en || ch.name_en || '';
    const desc = ch.description || '';

    let button = '';
    if(status === 'active'){
      if(id === 'case'){
        button = `<a class="btn" href="#sectionsTop">查看分区</a>`;
      }else if(id === 'literature'){
        button = `
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <a class="btn" href="board.html?c=literature">进入板块</a>
            <a class="btn" href="post-case.html?c=literature">发布讨论</a>
          </div>
        `;
      }else if(id === 'research'){
        button = `
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <a class="btn" href="board.html?c=research">进入板块</a>
            <a class="btn" href="post-case.html?c=research">发布讨论</a>
          </div>
        `;
      }else{
        button = `<a class="btn" href="#">进入板块</a>`;
      }
    }else{
      button = `<span class="btn disabled" aria-disabled="true">敬请期待</span>`;
    }

    return `
      <div class="card soft">
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:10px">
          <div>
            <h3>${escapeHtml(title)}${en ? ` <span class="en">${escapeHtml(en)}</span>` : ''}</h3>
            <p class="small">${escapeHtml(desc)}</p>
          </div>
          ${statusBadge(status)}
        </div>
        <div style="margin-top:12px">${button}</div>
      </div>
    `;
  }).join('');

  channelGrid.innerHTML = items;
}

function renderSections(sections, isAdmin){
  const cards = (sections || DEFAULT_SECTIONS).map(sec => {
    const key = sec.key;
    const title = sec.title_zh || sec.title || key;
    const desc = sec.description || '';
    const id = sec.id;

    const del = (isAdmin && id)
      ? `<button class="btn tiny danger" data-del-section="${id}" title="删除分区">删除</button>`
      : '';

    return `
      <div class="card soft">
        <h3>${escapeHtml(title)}</h3>
        <p class="small">${escapeHtml(desc)}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
          <a class="btn" href="board.html?c=case&s=${encodeURIComponent(key)}">进入板块</a>
          ${del}
        </div>
      </div>
    `;
  }).join('');

  const moreCard = `
    <div class="card soft" id="moreSections">
      <h3>+ 更多分区</h3>
      <p class="small">核心社区会持续扩容（例如：肾脏病理、肾脏感染、肿瘤相关肾病等）。国际讨论专区（英语）将于后续开放。</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
        ${isAdmin ? `<button class="btn primary" id="jumpAdminBtn" type="button">新增分区</button>` : `<span class="small">（管理员开放后可新增）</span>`}
      </div>
    </div>
  `;

  sectionGrid.innerHTML = cards + moreCard;

  if(isAdmin){
    sectionGrid.querySelector('#jumpAdminBtn')?.addEventListener('click', ()=>{
      adminBox?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    sectionGrid.querySelectorAll('[data-del-section]').forEach(btn => {
      btn.addEventListener('click', async ()=>{
        const id = btn.getAttribute('data-del-section');
        if(!id) return;
        if(!confirm('确定要删除这个分区吗？已发布的病例仍会保留在 cases 表中，但入口将消失（建议谨慎）。')) return;
        // Soft-hide (sections 表 Phase 1 仅维护 status 字段)
        const { error } = await supabase
          .from('sections')
          .update({ status: 'hidden' })
          .eq('id', id);
        if(error){ toast('删除失败', error.message, 'err'); return; }
        toast('已删除', '分区已移除。', 'ok');
        await reloadSections(isAdmin);
      });
    });
  }
}

async function tryFetchChannels(){
  if(!isConfigured() || !supabase) return null;
  try{
    const { data, error } = await supabase
      .from('channels')
      .select('id, title_zh, title_en, description, status, sort')
      .order('sort', { ascending: true })
      .order('id', { ascending: true });
    if(error) throw error;
    if(!data || data.length === 0) return null;
    return data;
  }catch(_e){
    return null;
  }
}

async function tryFetchSections(){
  if(!isConfigured() || !supabase) return null;
  try{
    const { data, error } = await supabase
      .from('sections')
      .select('id, channel_id, key, title_zh, title_en, description, status, sort, created_at')
      .eq('channel_id', 'case')
      .eq('status', 'active')
      .order('sort', { ascending: true })
      .order('created_at', { ascending: false });
    if(error) throw error;
    if(!data || data.length === 0) return [];
    return data;
  }catch(_e){
    return null;
  }
}

async function reloadSections(isAdmin){
  const sections = await tryFetchSections();
  if(sections === null){
    renderSections(DEFAULT_SECTIONS, isAdmin);
  }else{
    renderSections((sections.length ? sections : DEFAULT_SECTIONS), isAdmin);
  }
}

async function bindAdminActions(isAdmin){
  if(!isAdmin) return;

  adminBox.hidden = false;

  addForm?.addEventListener('submit', async (e)=>{
    e.preventDefault();

    if(!isConfigured() || !supabase){
      toast('Supabase 还未配置','请先在 assets/config.js 填入 SUPABASE_URL 与 SUPABASE_ANON_KEY。','err');
      return;
    }

    const fd = new FormData(addForm);
    const key = (fd.get('key') || '').toString().trim().toLowerCase();
    const title_zh = (fd.get('title_zh') || '').toString().trim();
    const description = (fd.get('description') || '').toString().trim();

    if(!key || !/^[a-z0-9_]{2,32}$/.test(key)){
      toast('Key 不合法','请使用 2-32 位英文小写/数字/下划线，例如 glom / tx / dialysis。','err');
      return;
    }
    if(!title_zh){
      toast('请输入中文标题','例如：透析与通路','err');
      return;
    }

    const payload = {
      channel_id: 'case',
      key,
      title_zh,
      description: description || null,
      status: 'active',
      sort: 0,
    };

    const { error } = await supabase.from('sections').insert(payload);
    if(error){
      toast('添加失败', error.message + '（请确认已建表 sections 并配置 RLS / unique key。）', 'err');
      return;
    }

    addForm.reset();
    toast('已添加', '新分区已写入。', 'ok');
    await reloadSections(isAdmin);
  });

  seedBtn?.addEventListener('click', async ()=>{
    if(!isConfigured() || !supabase){
      toast('Supabase 还未配置','请先在 assets/config.js 填入 SUPABASE_URL 与 SUPABASE_ANON_KEY。','err');
      return;
    }

    const rows = DEFAULT_SECTIONS.map((s, idx)=>({
      channel_id: 'case',
      key: s.key,
      title_zh: s.title_zh,
      description: s.description,
      status: 'active',
      sort: (idx + 1) * 10
    }));

    const { error } = await supabase
      .from('sections')
      .upsert(rows, { onConflict: 'channel_id,key', ignoreDuplicates: true });

    if(error){
      toast('写入失败', error.message + '（请确认 sections 有唯一约束 channel_id+key。）', 'err');
      return;
    }

    toast('已写入', `默认 ${DEFAULT_SECTIONS.length} 个分区已准备好。`, 'ok');
    await reloadSections(isAdmin);
  });
}

async function main(){
  // First paint with defaults
  renderChannels(DEFAULT_CHANNELS);
  renderSections(DEFAULT_SECTIONS, false);

  // Ensure client first (this script can run before app.js)
  if(isConfigured() && !supabase){
    try{ await ensureSupabase(); }catch(_e){ /* ignore */ }
  }

  if(!isConfigured() || !supabase){
    adminBox.hidden = true;
    return;
  }

  // Determine admin from profiles table (authoritative)
  const user = await getCurrentUser();
  const profile = user ? await getUserProfile(user) : null;
  const role = normalizeRole(profile?.role);
  const isAdminUser = isAdminRole(role);
  const viewMode = readViewModePref();
  const isAdminUi = !!isAdminUser && viewMode === 'admin';

  // Admin tools are only visible in "管理模式"
  adminBox.hidden = !isAdminUi;

  // Load data-driven channels/sections if the tables exist
  const channels = await tryFetchChannels();
  if(channels) renderChannels(channels);

  await reloadSections(isAdminUi);
  await bindAdminActions(isAdminUi);
}

main();
