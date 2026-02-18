import { supabase, isConfigured, toast, getCurrentUser, getUserProfile, isAdminRole, normalizeRole } from './supabaseClient.js';

const scheduleEls = Array.from(document.querySelectorAll('[data-schedule]'));
const addButtons = Array.from(document.querySelectorAll('[data-add-session]'));
const adminPanel = document.getElementById('scheduleAdminPanel');
const sessionForm = document.getElementById('sessionForm');
const sessionHint = document.getElementById('sessionHint');
const cancelBtn = document.getElementById('sessionCancelBtn');

let currentUser = null;
let currentProfile = null;
let isAdmin = false;

function esc(str){
  return String(str ?? '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

function fmtTime(ts){
  if(!ts) return '';
  try{
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  }catch(_e){
    return String(ts);
  }
}

function programLabel(k){
  const key = String(k || '');
  if(key === 'glom') return '肾小球与间质性肾病';
  if(key === 'icu_dialysis') return '重症肾内与透析';
  if(key === 'tx') return '肾移植内科';
  if(key === 'peds') return '儿童肾脏病';
  return key;
}

function renderSessions(list, key){
  if(!list || list.length === 0){
    return `<div class="small muted">暂无日程。</div>`;
  }
  return list.map(s => `
    <div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.08)" data-session-id="${esc(s.id)}">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
        <div>
          <b>${esc(s.title)}</b>
          <div class="small muted" style="margin-top:4px">
            ${esc(fmtTime(s.start_time))}${s.end_time ? ` - ${esc(fmtTime(s.end_time))}` : ``}
            ${s.speaker ? ` · 讲者：${esc(s.speaker)}` : ``}
          </div>
          ${s.location ? `<div class="small muted" style="margin-top:4px">地点/平台：${esc(s.location)}</div>` : ``}
          ${s.note ? `<div class="small muted" style="margin-top:4px">备注：${esc(s.note)}</div>` : ``}
          ${s.join_url ? `<div class="small" style="margin-top:6px"><a href="${esc(s.join_url)}" target="_blank" rel="noopener">入会链接 ↗</a></div>` : ``}
        </div>
        ${isAdmin ? `<button class="btn tiny danger" type="button" data-del-session="${esc(s.id)}">删除</button>` : ``}
      </div>
    </div>
  `).join('');
}

async function loadSchedules(){
  if(scheduleEls.length === 0) return;

  if(!isConfigured() || !supabase){
    scheduleEls.forEach(el => el.innerHTML = '（Supabase 未配置）');
    return;
  }

  if(!currentUser){
    scheduleEls.forEach(el => el.innerHTML = `登录后可查看日程。<a href="login.html">去登录</a>`);
    return;
  }

  try{
    // fetch all upcoming sessions for 4 programs
    const nowIso = new Date(Date.now() - 7*24*3600*1000).toISOString();
    const { data, error } = await supabase
      .from('training_sessions')
      .select('id, program_key, title, start_time, end_time, speaker, location, join_url, note, deleted_at')
      .is('deleted_at', null)
      .gte('start_time', nowIso)
      .order('start_time', { ascending: true })
      .limit(60);

    if(error) throw error;

    const byKey = { glom:[], icu_dialysis:[], tx:[], peds:[] };
    (data || []).forEach(s => {
      if(byKey[s.program_key]) byKey[s.program_key].push(s);
    });

    scheduleEls.forEach(el => {
      const key = el.getAttribute('data-schedule');
      const list = (byKey[key] || []).slice(0, 6);
      el.innerHTML = renderSessions(list, key);
    });
  }catch(e){
    console.error(e);
    scheduleEls.forEach(el => el.innerHTML = '日程加载失败');
  }
}

function openAdminPanel(programKey){
  if(!adminPanel || !sessionForm) return;
  adminPanel.hidden = false;
  sessionHint.textContent = `当前项目：${programLabel(programKey)}（${programKey}）`;
  sessionForm.elements.namedItem('program_key').value = programKey;

  // reset fields except program_key
  ['title','start_time','end_time','speaker','location','join_url','note'].forEach(k=>{
    const el = sessionForm.elements.namedItem(k);
    if(el) el.value = '';
  });

  adminPanel.scrollIntoView({ behavior:'smooth', block:'start' });
}

function closeAdminPanel(){
  if(!adminPanel) return;
  adminPanel.hidden = true;
  sessionHint.textContent = '';
}

async function deleteSession(id){
  if(!confirm('确定删除该日程？（删除后会员不可见）')) return;
  try{
    const { error } = await supabase
      .from('training_sessions')
      .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id);
    if(error) throw error;
    toast('已删除', '日程已删除', 'ok');
    await loadSchedules();
  }catch(e){
    toast('删除失败', e.message || String(e), 'err');
  }
}

function initAdminEvents(){
  addButtons.forEach(btn => {
    if(isAdmin) btn.hidden = false;
    btn.addEventListener('click', ()=>{
      const key = btn.getAttribute('data-add-session');
      openAdminPanel(key);
    });
  });

  cancelBtn?.addEventListener('click', closeAdminPanel);

  sessionForm?.addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    if(!isAdmin){
      toast('无权限', '仅管理员可添加日程', 'err');
      return;
    }

    const fd = new FormData(sessionForm);
    const program_key = String(fd.get('program_key') || '').trim();
    const title = String(fd.get('title') || '').trim();
    const start_local = String(fd.get('start_time') || '').trim();
    const end_local = String(fd.get('end_time') || '').trim();

    if(!program_key || !title || !start_local){
      toast('信息不完整', '请填写项目、标题与开始时间', 'err');
      return;
    }

    // datetime-local -> ISO
    const start_time = new Date(start_local).toISOString();
    const end_time = end_local ? new Date(end_local).toISOString() : null;

    const payload = {
      program_key,
      title,
      start_time,
      end_time,
      speaker: String(fd.get('speaker') || '').trim() || null,
      location: String(fd.get('location') || '').trim() || null,
      join_url: String(fd.get('join_url') || '').trim() || null,
      note: String(fd.get('note') || '').trim() || null,
      created_by: currentUser.id,
      updated_at: new Date().toISOString(),
      deleted_at: null,
    };

    try{
      const { error } = await supabase
        .from('training_sessions')
        .insert(payload);
      if(error) throw error;

      toast('已保存', '培训日程已添加', 'ok');
      closeAdminPanel();
      await loadSchedules();
    }catch(e){
      toast('保存失败', e.message || String(e), 'err');
    }
  });

  // Delegate delete
  scheduleEls.forEach(el => {
    el.addEventListener('click', async (e)=>{
      const id = e.target?.getAttribute?.('data-del-session');
      if(!id) return;
      await deleteSession(id);
    });
  });
}

async function init(){
  currentUser = await getCurrentUser().catch(()=>null);
  if(currentUser){
    currentProfile = await getUserProfile(currentUser).catch(()=>null);
    const role = normalizeRole(currentProfile?.role);
    isAdmin = isAdminRole(role);
  }

  // keep admin panel hidden until "添加日程" is clicked
  if(adminPanel) adminPanel.hidden = true;

  initAdminEvents();
  await loadSchedules();
}

init();