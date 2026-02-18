import { supabase, isConfigured, toast, getCurrentUser, getUserProfile, isAdminRole, normalizeRole } from './supabaseClient.js';

const channelGrid = document.getElementById('channelGrid');
const sectionGrid = document.getElementById('sectionGrid');
const adminBox = document.getElementById('sectionAdmin');
const addForm = document.getElementById('addSectionForm');
const seedBtn = document.getElementById('seedDefaultBtn');

const DEFAULT_CHANNELS = [
  {
    id: 'case',
    title_zh: '病例讨论',
    title_en: 'Case Discussion',
    description: '核心板块：按分区沉淀病例与决策要点，支持后续扩容。',
    status: 'active',
  },
  {
    id: 'clinical',
    title_zh: '临床研究讨论',
    title_en: 'Clinical Research',
    description: '试验设计、终点选择、统计解读、真实世界研究等（筹备中）。',
    status: 'coming_soon',
  },
  {
    id: 'basic',
    title_zh: '基础研究讨论',
    title_en: 'Basic Research',
    description: '机制研究、模型、单细胞/空间组学、补体/免疫等（筹备中）。',
    status: 'coming_soon',
  },
  {
    id: 'english',
    title_zh: '英语讨论区',
    title_en: 'English Discussion',
    description: '面向国际协作与学术沟通的英语版块（筹备中）。',
    status: 'coming_soon',
  },
];

const DEFAULT_SECTIONS = [
  { key: 'glom', title_zh: '肾小球病', description: 'IgAN、MN、FSGS、MCD、AAV、补体相关病等。' },
  { key: 'tx', title_zh: '肾移植内科', description: '排斥、感染、免疫抑制、围手术期与长期随访。' },
  { key: 'icu', title_zh: '重症肾内', description: 'AKI/CRRT、休克、抗凝、液体管理、酸碱电解质。' },
  { key: 'peds', title_zh: '儿童肾病', description: '儿肾病例、遗传肾病、补体病、儿童移植随访。' },
];

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

function statusBadge(status){
  const s = (status || '').toString().toLowerCase();
  if(s === 'active') return `<span class="badge">已开放</span>`;
  if(s === 'hidden') return `<span class="badge">隐藏</span>`;
  return `<span class="badge" style="border-color:rgba(255,255,255,.18);background:rgba(255,255,255,.06)">筹备中</span>`;
}

function renderChannels(channels){
  const items = (channels || DEFAULT_CHANNELS).map(ch => {
    const status = (ch.status || '').toString().toLowerCase();
    const title = ch.title_zh || ch.name_zh || ch.title || ch.id;
    const en = ch.title_en || ch.name_en || '';
    const desc = ch.description || '';

    const button = status === 'active'
      ? `<a class="btn" href="#sections">查看分区</a>`
      : `<span class="btn disabled" aria-disabled="true">即将开放</span>`;

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
          <a class="btn" href="board.html?b=${encodeURIComponent(key)}">进入板块</a>
          ${del}
        </div>
      </div>
    `;
  }).join('');

  const moreCard = `
    <div class="card soft" id="sections">
      <h3>+ 更多分区</h3>
      <p class="small">病例讨论分区会持续扩容（如透析/遗传肾病/肾脏病理/肾脏感染等）。</p>
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
        const { error } = await supabase.from('sections').delete().eq('id', id);
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

    toast('已写入', '默认 4 个分区已准备好。', 'ok');
    await reloadSections(isAdmin);
  });
}

async function main(){
  // First paint with defaults
  renderChannels(DEFAULT_CHANNELS);
  renderSections(DEFAULT_SECTIONS, false);

  if(!isConfigured() || !supabase){
    adminBox.hidden = true;
    return;
  }

  // Determine admin from profiles table (authoritative)
  const user = await getCurrentUser();
  const profile = user ? await getUserProfile(user) : null;
  const role = normalizeRole(profile?.role);
  const isAdmin = isAdminRole(role);
  adminBox.hidden = !isAdmin;

  // Load data-driven channels/sections if the tables exist
  const channels = await tryFetchChannels();
  if(channels) renderChannels(channels);

  await reloadSections(isAdmin);
  await bindAdminActions(isAdmin);
}

main();
