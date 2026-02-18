import {
  supabase,
  ensureSupabase,
  isConfigured,
  toast,
  getCurrentUser,
  getUserProfile,
  isAdminRole,
  normalizeRole,
  formatBeijingDateTime,
} from './supabaseClient.js?v=20260128_030';

const grid = document.getElementById('eventsGrid');
const adminWrap = document.getElementById('eventsAdmin');
const addEventForm = document.getElementById('addEventForm');
const adminList = document.getElementById('adminEventsList');

const DEFAULT_EVENTS = [
  {
    key: 'sun_zoom',
    title_zh: '每周日 10:00（北京时间）',
    title_en: 'Weekly (Sun 10:00 CST)',
    platform: 'Zoom',
    description: 'Zoom 学术会议：病例与前沿进展分享。',
    rule_zh: '常规：每周日 10:00（北京时间）',
    status: 'pending',
  },
  {
    key: 'wed_tencent',
    title_zh: '每周三 20:00（北京时间）',
    title_en: 'Weekly (Wed 20:00 CST)',
    platform: '腾讯会议',
    description: '围绕指南/综述/临床试验的文献学习与讨论。',
    rule_zh: '常规：每周三 20:00（北京时间）',
    status: 'pending',
  },
  {
    key: 'biweekly_case',
    title_zh: '每两周一次 · 周四晚间（北京时间）',
    title_en: 'Biweekly (Thu evening CST)',
    platform: '线上会议',
    description: '病例讨论专场（时间以通知为准）。',
    rule_zh: '常规：每两周一次 周四晚间（北京时间）',
    status: 'pending',
  },
  {
    key: 'peds_zoom',
    title_zh: '儿童肾脏病 Zoom 会议（筹备中）',
    title_en: 'Peds Zoom (Planning)',
    platform: 'Zoom',
    description: '儿童肾脏病与相关专题会议（筹备中）。',
    rule_zh: '筹备中：后续公布时间',
    status: 'planning',
  },
];

function esc(str){
  return String(str ?? '').replace(/[&<>"]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s]));
}

function nl2brEsc(str){
  return esc(str).replace(/\n/g, '<br/>');
}

function statusBadge(status){
  const s = (status || '').toLowerCase();
  if(s === 'confirmed') return '<span class="chip soon">已确认</span>';
  if(s === 'canceled') return '<span class="chip todo">已取消</span>';
  if(s === 'rescheduled') return '<span class="chip todo">已改期</span>';
  if(s === 'planning') return '<span class="chip todo">筹备中</span>';
  return '<span class="chip todo">待确认</span>';
}

function fmtTime(ts){
  return formatBeijingDateTime(ts);
}

function toDatetimeLocal(ts){
  if(!ts) return '';
  const d = new Date(ts);
  if(Number.isNaN(d.getTime())) return '';
  const pad = (n)=> String(n).padStart(2,'0');
  // local time
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth()+1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}


function extFromFilename(name){
  const n = String(name || '').toLowerCase();
  const m = n.match(/\.([a-z0-9]+)$/);
  if(!m) return '';
  const ext = m[1];
  if(['jpg','jpeg','png','webp','gif'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  return ext;
}

async function uploadSpeakerAvatar(file, eventId){
  if(!file || !(file instanceof File) || file.size === 0) return null;
  if(!String(file.type || '').startsWith('image/')){
    throw new Error('头像必须为图片文件（jpg/png/webp/gif）。');
  }
  const maxMB = 2;
  if(file.size > maxMB * 1024 * 1024){
    throw new Error(`头像过大（>${maxMB}MB）。建议压缩后再上传。`);
  }

  const ext = extFromFilename(file.name) || (String(file.type||'').includes('png') ? 'png' : 'jpg');
  const rand = Math.random().toString(16).slice(2);
  const path = `event_${eventId}/${Date.now()}_${rand}.${ext}`;

  const bucket = 'speakers';
  const { error: upErr } = await supabase.storage.from(bucket).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type || undefined,
  });
  if(upErr) throw upErr;

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data?.publicUrl || null;
}

function fromDatetimeLocal(v){
  const val = String(v || '').trim();
  if(!val) return null;
  const d = new Date(val);
  if(Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

let currentUser = null;
let isAdmin = false;
let authed = false;
let _scrolledToAdmin = false;

async function initAuth(){
  if(!isConfigured()) return;
  // IMPORTANT: This page script may run before app.js finishes initializing
  // the Supabase client (race condition). Always ensure the client here.
  if(!supabase){
    try{ await ensureSupabase(); }catch(_e){ /* ignore */ }
  }
  if(!supabase) return;
  try{
    const u = await getCurrentUser();
    currentUser = u;
    authed = Boolean(u);
    const p = u ? await getUserProfile(u) : null;
    // Admin privileges should be driven by profiles.role (RLS-protected).
    const role = normalizeRole(p?.role);
    isAdmin = isAdminRole(role);
  }catch(_e){
    // ignore
  }
}

function publicCard(ev, linkRow){
  const updated = ev.updated_at ? fmtTime(ev.updated_at) : '';
  const next = ev.next_time ? fmtTime(ev.next_time) : '';

  const speakerName = String(ev.speaker_name || '').trim();
  const speakerTitle = String(ev.speaker_title || '').trim();
  const speakerBio = String(ev.speaker_bio || '').trim();
  const speakerAvatar = String(ev.speaker_avatar_url || '').trim();

  const speakerLine = [speakerName ? `<b>${esc(speakerName)}</b>` : '', speakerTitle ? `<span class="muted">${esc(speakerTitle)}</span>` : '']
    .filter(Boolean)
    .join(' · ');

  const speakerHtml = (speakerName || speakerTitle || speakerBio || speakerAvatar)
    ? `
      <div class="speaker-block" style="margin-top:10px">
        ${speakerAvatar ? `<img class="speaker-avatar" src="${esc(speakerAvatar)}" alt="讲者头像" />` : ''}
        <div class="speaker-text">
          <div class="small"><span class="muted">讲者：</span>${speakerLine || '<span class="muted">（待更新）</span>'}</div>
          ${speakerBio ? `<div class="small muted" style="margin-top:6px">${nl2brEsc(speakerBio)}</div>` : ''}
        </div>
      </div>
    `
    : '';

  const linkBtn = (linkRow && linkRow.join_url)
    ? `<a class="btn primary" target="_blank" rel="noopener" href="${esc(linkRow.join_url)}">进入会议</a>`
    : `<span class="small muted">${authed ? '（待确认后显示入会链接）' : '（登录后可查看已确认会议链接）'}</span>`;

  const adminHint = isAdmin ? `<a class="btn" href="#eventsAdmin">管理员面板</a>` : '';

  return `
    <div class="card soft">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap">
        <h3 style="margin:0;min-width:0">${esc(ev.title_zh || '')}</h3>
        ${statusBadge(ev.status)}
      </div>
      ${ev.description ? `<p class="small" style="margin-top:8px">${esc(ev.description)}</p>` : ''}
      ${ev.rule_zh ? `<div class="small muted" style="margin-top:8px">${esc(ev.rule_zh)}</div>` : ''}
      ${next ? `<div class="small" style="margin-top:8px">下次：<b>${esc(next)}</b></div>` : ''}
      ${speakerHtml}
      ${updated ? `<div class="small muted" style="margin-top:6px">最后更新：${esc(updated)}</div>` : ''}

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;align-items:center">
        ${linkBtn}
        <a class="btn" href="community.html">去社区讨论</a>
        ${adminHint}
      </div>
    </div>
  `;
}

function adminEventCard(ev, linkRow){
  const joinUrl = linkRow?.join_url || '';
  const passcode = linkRow?.passcode || '';
  const nextLocal = toDatetimeLocal(ev.next_time);
  return `
    <div class="card soft" style="padding:18px" id="admin-${ev.id}">
      <form class="form" data-admin-form="${ev.id}">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div>
            <b>会议ID：${ev.id}</b>
            <div class="small muted" style="margin-top:6px">Key：${esc(ev.key || '')}</div>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn primary" type="submit">保存</button>
            <button class="btn danger" type="button" data-admin-del="${ev.id}">删除</button>
          </div>
        </div>

        <label style="margin-top:12px">中文标题
          <input class="input" name="title_zh" value="${esc(ev.title_zh || '')}" required />
        </label>

        <div class="form-row">
          <div>
            <label>平台
              <input class="input" name="platform" value="${esc(ev.platform || '')}" placeholder="Zoom / 腾讯会议 / 线下" />
            </label>
          </div>
          <div>
            <label>状态
              <select class="input" name="status">
                ${['pending','confirmed','rescheduled','canceled','planning'].map(s=>`
                  <option value="${s}" ${String(ev.status||'').toLowerCase()===s?'selected':''}>${({pending:'待确认',confirmed:'已确认',rescheduled:'已改期',canceled:'已取消',planning:'筹备中'})[s]}</option>
                `).join('')}
              </select>
            </label>
          </div>
        </div>

        <div class="form-row">
          <div>
            <label>下次时间（北京时间）
              <input class="input" type="datetime-local" name="next_time" value="${esc(nextLocal)}" />
            </label>
          </div>
          <div>
            <label>常规规则（可选）
              <input class="input" name="rule_zh" value="${esc(ev.rule_zh || '')}" placeholder="例如：每周日 10:00（北京时间）" />
            </label>
          </div>
        </div>

        <label>简介（可选）
          <textarea class="input" name="description" rows="2" placeholder="一句话说明会议定位">${esc(ev.description || '')}</textarea>
        </label>

        <div class="form-row">
          <div>
            <label>讲者姓名（公开显示）
              <input class="input" name="speaker_name" value="${esc(ev.speaker_name || '')}" placeholder="例如：张三" />
            </label>
          </div>
          <div>
            <label>讲者头衔/单位（公开显示，可选）
              <input class="input" name="speaker_title" value="${esc(ev.speaker_title || '')}" placeholder="例如：主任医师 · XXX医院" />
            </label>
          </div>
        </div>

        <label>讲者简介（公开显示，可选）
          <textarea class="input" name="speaker_bio" rows="3" placeholder="1-3 句话介绍讲者背景、研究方向等">${esc(ev.speaker_bio || '')}</textarea>
        </label>

        <div class="form-row">
          <div style="flex:1">
            <label>讲者头像（可选）
              <input class="input" type="file" accept="image/*" name="speaker_avatar_file" />
            </label>
            <input type="hidden" name="speaker_avatar_url" value="${esc(ev.speaker_avatar_url || '')}" />
            <div class="small muted" style="margin-top:6px">建议 1:1 比例 jpg/png；上传后将公开显示在首页与活动页。</div>
            ${ev.speaker_avatar_url ? `<div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <img class="speaker-avatar" src="${esc(ev.speaker_avatar_url)}" alt="讲者头像" style="width:56px;height:56px" />
              <button class="btn danger" type="button" data-clear-avatar="${ev.id}">清空头像</button>
            </div>` : ''}
          </div>
        </div>


        <div class="form-row">
          <div>
            <label>入会链接（仅状态=已确认时对登录用户显示）
              <input class="input" name="join_url" value="${esc(joinUrl)}" placeholder="https://..." />
            </label>
          </div>
          <div>
            <label>口令（可选）
              <input class="input" name="passcode" value="${esc(passcode)}" placeholder="例如：123456" />
            </label>
          </div>
        </div>
      </form>
    </div>
  `;
}

function bindAdminHandlers(events, linkMap){
  if(!adminList) return;

  // save
  adminList.querySelectorAll('[data-admin-form]').forEach(form=>{
    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const id = Number(form.getAttribute('data-admin-form'));
      const ev = events.find(x=>x.id===id);
      if(!ev) return;
      const fd = new FormData(form);
      const payload = {
        title_zh: String(fd.get('title_zh')||'').trim(),
        platform: String(fd.get('platform')||'').trim() || null,
        status: String(fd.get('status')||'pending').trim(),
        next_time: fromDatetimeLocal(fd.get('next_time')),
        rule_zh: String(fd.get('rule_zh')||'').trim() || null,
        description: String(fd.get('description')||'').trim() || null,
        speaker_name: String(fd.get('speaker_name')||'').trim() || null,
        speaker_title: String(fd.get('speaker_title')||'').trim() || null,
        speaker_bio: String(fd.get('speaker_bio')||'').trim() || null,
        speaker_avatar_url: String(fd.get('speaker_avatar_url')||'').trim() || null,
        updated_at: new Date().toISOString(),
        updated_by: currentUser?.id || null,
      };

      const join_url = String(fd.get('join_url')||'').trim();
      const passcode = String(fd.get('passcode')||'').trim();

      // speaker avatar upload (optional)
      const avatarFile = fd.get('speaker_avatar_file');
      if(avatarFile && avatarFile instanceof File && avatarFile.size > 0){
        try{
          const url = await uploadSpeakerAvatar(avatarFile, id);
          if(url){
            payload.speaker_avatar_url = url;
            const hidden = form.querySelector('input[name="speaker_avatar_url"]');
            if(hidden) hidden.value = url;
          }
        }catch(upErr){
          toast('头像上传失败', upErr.message || String(upErr), 'err');
          // continue saving other fields
        }
      }


      const btn = form.querySelector('button[type="submit"]');
      if(btn) btn.disabled = true;
      try{
        const { error } = await supabase
          .from('event_series')
          .update(payload)
          .eq('id', id);
        if(error) throw error;

        // links: upsert when any field exists, otherwise delete
        if(join_url || passcode){
          const { error: lerr } = await supabase
            .from('event_links')
            .upsert({ event_id: id, join_url: join_url || null, passcode: passcode || null, updated_at: new Date().toISOString(), updated_by: currentUser?.id || null }, { onConflict: 'event_id' });
          if(lerr) throw lerr;
        }else{
          await supabase
            .from('event_links')
            .delete()
            .eq('event_id', id);
        }

        toast('已保存', '会议已更新。', 'ok');
        await load();
      }catch(err){
        toast('保存失败', err.message || String(err), 'err');
      }finally{
        if(btn) btn.disabled = false;
      }
    });
  });


  // clear speaker avatar
  adminList.querySelectorAll('[data-clear-avatar]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = Number(btn.getAttribute('data-clear-avatar'));
      if(!id) return;
      const ok = confirm('确认清空讲者头像？');
      if(!ok) return;
      btn.disabled = true;
      try{
        const { error } = await supabase.from('event_series').update({ speaker_avatar_url: null, updated_at: new Date().toISOString(), updated_by: currentUser?.id || null }).eq('id', id);
        if(error) throw error;
        toast('已清空', '讲者头像已移除。', 'ok');
        await load();
      }catch(err){
        toast('操作失败', err.message || String(err), 'err');
      }finally{
        btn.disabled = false;
      }
    });
  });

  // delete
  adminList.querySelectorAll('[data-admin-del]').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const id = Number(btn.getAttribute('data-admin-del'));
      if(!id) return;
      if(!confirm('确定删除该会议吗？（会同时删除入会链接记录）')) return;
      btn.disabled = true;
      try{
        const { error } = await supabase
          .from('event_series')
          .delete()
          .eq('id', id);
        if(error) throw error;
        toast('已删除', '会议已删除。', 'ok');
        await load();
      }catch(err){
        toast('删除失败', err.message || String(err), 'err');
      }finally{
        btn.disabled = false;
      }
    });
  });
}

async function load(){
  if(!grid) return;

  await initAuth();
  if(adminWrap) adminWrap.hidden = !isAdmin;

  // Try load from DB
  let events = null;
  if(isConfigured() && supabase){
    try{
      let data = null;
      let error = null;
      // Try with speaker fields (newer schema). If schema not migrated yet, fallback to basic select.
      ({ data, error } = await supabase
        .from('event_series')
        .select('id, key, title_zh, title_en, platform, description, rule_zh, status, next_time, updated_at, speaker_name, speaker_title, speaker_bio, speaker_avatar_url')
        .order('id', { ascending: true }));
      if(error && String(error.message || error).toLowerCase().includes('speaker_')){
        ({ data, error } = await supabase
          .from('event_series')
          .select('id, key, title_zh, title_en, platform, description, rule_zh, status, next_time, updated_at')
          .order('id', { ascending: true }));
      }
      if(error) throw error;
      if(data && data.length) events = data;
    }catch(_e){
      // ignore, fallback
    }
  }
  const list = events || DEFAULT_EVENTS;

  // Load join links (only if authed and DB is available)
  let linkMap = {};
  if(authed && events && events.length){
    try{
      const ids = events.map(e=>e.id);
      const { data, error } = await supabase
        .from('event_links')
        .select('event_id, join_url, passcode')
        .in('event_id', ids);
      if(!error && data){
        data.forEach(r=>{ linkMap[r.event_id] = r; });
      }
    }catch(_e){}
  }

  grid.innerHTML = list.map(ev => publicCard(ev, ev.id ? linkMap[ev.id] : null)).join('');

  // Admin panel requires DB
  if(isAdmin && adminWrap && adminList){
    if(!events){
      adminList.innerHTML = `<div class="note"><b>提示：</b>未检测到数据库表 event_series。请先运行新的 SUPABASE_SETUP.sql（或确认已建表）。</div>`;
    }else{
      adminList.innerHTML = events.map(ev => adminEventCard(ev, linkMap[ev.id])).join('');
      bindAdminHandlers(events, linkMap);
    }
  }

  // add new
  if(isAdmin && addEventForm){
    addEventForm.onsubmit = async (e)=>{
      e.preventDefault();
      const fd = new FormData(addEventForm);
      const key = String(fd.get('key')||'').trim();
      const platform = String(fd.get('platform')||'').trim();
      const title_zh = String(fd.get('title_zh')||'').trim();
      const description = String(fd.get('description')||'').trim();
      const status = String(fd.get('status')||'pending').trim();
      const rule_zh = String(fd.get('rule_zh')||'').trim();
      const next_time = fromDatetimeLocal(fd.get('next_time'));

      if(!key || !title_zh){
        toast('缺少信息','请填写 key 与中文标题。','err');
        return;
      }

      const btn = addEventForm.querySelector('button[type="submit"]');
      if(btn) btn.disabled = true;
      try{
        const { error } = await supabase
          .from('event_series')
          .insert({
            key,
            platform: platform || null,
            title_zh,
            description: description || null,
            status,
            rule_zh: rule_zh || null,
            next_time,
            updated_at: new Date().toISOString(),
            updated_by: currentUser?.id || null,
          });
        if(error) throw error;
        addEventForm.reset();
        toast('已添加','会议已创建。','ok');
        await load();
      }catch(err){
        toast('添加失败', err.message || String(err), 'err');
      }finally{
        if(btn) btn.disabled = false;
      }
    };
  }

  // If user came from the admin menu, jump to admin panel once.
  try{
    if(!_scrolledToAdmin && isAdmin && adminWrap && location.hash === '#eventsAdmin'){
      _scrolledToAdmin = true;
      adminWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }catch(_e){}
}

load();
