import { supabase, ensureSupabase, isConfigured, ensureAuthed, toast, getCurrentUser, formatBeijingDate } from './supabaseClient.js?v=20260401_fix';

const els = {
  casesList: document.getElementById('casesList'),
  momentsList: document.getElementById('momentsList'),
  videosList: document.getElementById('videosList'),
  casesCount: document.getElementById('casesCount'),
  momentsCount: document.getElementById('momentsCount'),
  videosCount: document.getElementById('videosCount'),
  refreshBtn: document.getElementById('refreshBtn'),
  markAllBtn: document.getElementById('markAllBtn'),
  markCasesBtn: document.getElementById('markCasesBtn'),
  markMomentsBtn: document.getElementById('markMomentsBtn'),
  markVideosBtn: document.getElementById('markVideosBtn'),
};

const SEEN_KEYS = {
  cases: 'ks_seen_cases',
  moments: 'ks_seen_moments',
  videos: 'ks_seen_videos',
};

const CASE_SECTION_KEYS = new Set(['glom','tx','icu','peds','rare','path']);
const BOARD_LABEL_ZH = {
  glom: '肾小球与间质性肾病',
  tx: '肾移植内科',
  icu: '重症肾内与透析',
  peds: '儿童肾脏病',
  rare: '罕见肾脏病',
  path: '肾脏病理',
  research: '科研讨论',
  literature: '文献学习',
  english: '国际讨论（英语）',
};

function boardHrefForCase(boardKey, caseId){
  const b = String(boardKey || '').trim().toLowerCase();
  const id = caseId != null ? String(caseId) : '';
  const h = id ? `&highlight=${encodeURIComponent(id)}` : '';
  if(CASE_SECTION_KEYS.has(b)) return `board.html?c=case&s=${encodeURIComponent(b)}${h}`;
  if(b) return `board.html?c=${encodeURIComponent(b)}${h}`;
  return id ? `case.html?id=${encodeURIComponent(id)}` : 'community.html';
}

function boardLabel(boardKey){
  const b = String(boardKey || '').trim().toLowerCase();
  return BOARD_LABEL_ZH[b] || (b || '社区');
}

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function getSeenTs(key){
  try{
    const v = localStorage.getItem(key);
    if(!v) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }catch{ return null; }
}

function setSeenNow(key){
  try{ localStorage.setItem(key, new Date().toISOString()); }catch{}
}

function relTime(ts){
  try{
    const t = Date.parse(ts);
    if(!Number.isFinite(t)) return '';
    const diff = Date.now() - t;
    const sec = Math.floor(diff/1000);
    if(sec < 60) return '刚刚';
    const min = Math.floor(sec/60);
    if(min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min/60);
    if(hr < 24) return `${hr} 小时前`;
    const day = Math.floor(hr/24);
    if(day < 7) return `${day} 天前`;
    return formatBeijingDate(t);
  }catch{ return ''; }
}

function snippet(s, n=110){
  const t = String(s || '').trim();
  if(t.length <= n) return t;
  return t.slice(0, n) + '…';
}

function renderEmpty(label){
  return `<div class="muted small">暂无新${esc(label)}。</div>`;
}

async function loadNewCases(sinceIso){
  if(!els.casesList) return [];
  try{
    const { data, error } = await supabase
      .from('cases')
      .select('id, title, summary, board, created_at, author_name')
      .gt('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(20);
    if(error) throw error;
    return data || [];
  }catch(e){
    els.casesList.innerHTML = `<div class="note"><b>读取病例失败</b><div class="small" style="margin-top:6px">${esc(e?.message || String(e))}</div></div>`;
    return [];
  }
}

async function loadNewCaseReplies(sinceIso){
  // New replies under 病例讨论（case_comments）
  if(!els.casesList) return [];
  try{
    let q = supabase
      .from('case_comments')
      .select('id, case_id, author_name, body, created_at')
      .gt('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(30);
    // Defensive: some schemas may not have deleted_at
    try{ q = q.is('deleted_at', null); }catch(_e){}

    const { data, error } = await q;
    if(error) throw error;
    const rows = data || [];
    if(!rows.length) return [];

    // Fetch case meta for title/board
    const ids = Array.from(new Set(rows.map(r=>r.case_id).filter(Boolean)));
    let metaMap = new Map();
    if(ids.length){
      try{
        const { data: casesMeta } = await supabase
          .from('cases')
          .select('id, title, board')
          .in('id', ids);
        (casesMeta || []).forEach(c=>metaMap.set(String(c.id), c));
      }catch(_e){}
    }

    return rows.map(r=>{
      const meta = metaMap.get(String(r.case_id)) || null;
      return { ...r, _case: meta };
    });
  }catch(e){
    // Don't block the whole page; just return empty on errors
    console.warn('loadNewCaseReplies failed', e);
    return [];
  }
}

async function loadNewMoments(sinceIso){
  if(!els.momentsList) return [];
  try{
    const candidates = [
      { fields: 'id, created_at, author_name, content, images, video_url, deleted_at', filterDeleted: true },
      { fields: 'id, created_at, author_name, content, images, deleted_at', filterDeleted: true },
      { fields: 'id, created_at, author_name, content, images, video_url', filterDeleted: false },
      { fields: 'id, created_at, author_name, content, images', filterDeleted: false },
    ];

    let res = null;
    for(const c of candidates){
      let q = supabase.from('moments').select(c.fields).gt('created_at', sinceIso);
      if(c.filterDeleted) q = q.is('deleted_at', null);
      q = q.order('created_at', { ascending: false }).limit(20);
      res = await q;
      if(!res?.error) break;
      const msg = String(res.error.message || res.error).toLowerCase();
      if(!(msg.includes('column') && (msg.includes('video_url') || msg.includes('deleted_at')))) break;
    }

    const { data, error } = res || {};
    if(error) throw error;
    return data || [];
  }catch(e){
    els.momentsList.innerHTML = `<div class="note"><b>读取动态失败</b><div class="small" style="margin-top:6px">${esc(e?.message || String(e))}</div></div>`;
    return [];
  }
}

function renderCases(casesList, repliesList){
  if(!els.casesList) return;
  const cases = Array.isArray(casesList) ? casesList : [];
  const replies = Array.isArray(repliesList) ? repliesList : [];

  const merged = [
    ...cases.map(c => ({ _kind: 'case', ...c })),
    ...replies.map(r => ({ _kind: 'reply', ...r })),
  ].sort((a,b)=>{
    const ta = Date.parse(a.created_at || '') || 0;
    const tb = Date.parse(b.created_at || '') || 0;
    return tb - ta;
  });

  const total = merged.length;
  els.casesCount && (els.casesCount.textContent = String(total));

  if(!total){
    els.casesList.innerHTML = renderEmpty('病例/回复');
    return;
  }

  els.casesList.innerHTML = merged.map(item=>{
    if(item._kind === 'reply'){
      const metaCase = item._case || {};
      const title = metaCase.title || '未命名病例';
      const board = metaCase.board ? boardLabel(metaCase.board) : '';
      const sum = snippet(item.body, 120);
      const href = `case.html?id=${encodeURIComponent(String(item.case_id))}#comment-${encodeURIComponent(String(item.id))}`;
      const metaParts = [relTime(item.created_at)];
      if(item.author_name) metaParts.push(String(item.author_name));
      if(board) metaParts.push(String(board));
      const meta = metaParts.filter(Boolean).map(esc).join(' · ');
      return `
        <a class="list-item" href="${esc(href)}">
          <b style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">💬 新回复：${esc(title)}</b>
          ${sum ? `<div class="small muted" style="margin-top:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(sum)}</div>` : ''}
          <div class="small muted" style="margin-top:6px">${meta}</div>
        </a>
      `;
    }

    const title = item.title || '未命名病例';
    const sum = snippet(item.summary, 120);
    const href = boardHrefForCase(item.board, item.id);
    const metaParts = [relTime(item.created_at)];
    if(item.author_name) metaParts.push(String(item.author_name));
    if(item.board) metaParts.push(boardLabel(item.board));
    const meta = metaParts.filter(Boolean).map(esc).join(' · ');
    return `
      <a class="list-item" href="${esc(href)}">
        <b style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">🆕 新帖子：${esc(title)}</b>
        ${sum ? `<div class="small muted" style="margin-top:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(sum)}</div>` : ''}
        <div class="small muted" style="margin-top:6px">${meta}</div>
      </a>
    `;
  }).join('');
}

const VIDEO_CAT_ZH = {
  glom: '肾小球与间质性肾病', tx: '肾移植内科', icu: '重症肾内与透析',
  peds: '儿童肾脏病', rare: '罕见肾脏病', meeting: '病例讨论会议',
  path: '肾脏病理', other: '其他肾脏病',
};

async function loadNewVideos(sinceIso){
  if(!els.videosList) return [];
  try{
    const candidates = [
      { fields: 'id, title, category, speaker, kind, source_url, mp4_url, created_at, enabled, deleted_at', filterDeleted: true },
      { fields: 'id, title, category, speaker, kind, source_url, mp4_url, created_at, enabled', filterDeleted: false },
    ];

    let res = null;
    for(const c of candidates){
      let q = supabase.from('learning_videos').select(c.fields)
        .gt('created_at', sinceIso)
        .eq('enabled', true);
      if(c.filterDeleted) q = q.is('deleted_at', null);
      q = q.order('created_at', { ascending: false }).limit(20);
      res = await q;
      if(!res?.error) break;
      const msg = String(res.error.message || res.error).toLowerCase();
      if(!(msg.includes('column') && (msg.includes('deleted_at') || msg.includes('kind') || msg.includes('mp4_url')))) break;
    }

    const { data, error } = res || {};
    if(error) throw error;
    return data || [];
  }catch(e){
    const msg = String(e?.message || e || '');
    // If table doesn't exist yet, silently return empty
    if(/relation .*learning_videos.* does not exist/i.test(msg)) return [];
    els.videosList.innerHTML = `<div class="note"><b>读取视频失败</b><div class="small" style="margin-top:6px">${esc(msg)}</div></div>`;
    return [];
  }
}

function renderVideos(list){
  if(!els.videosList) return;
  els.videosCount && (els.videosCount.textContent = String(list.length || 0));
  if(!list.length){
    els.videosList.innerHTML = renderEmpty('视频');
    return;
  }
  els.videosList.innerHTML = list.map(v=>{
    const title = v.title || '未命名视频';
    const cat = VIDEO_CAT_ZH[v.category] || v.category || '';
    const speaker = v.speaker || '';
    const metaParts = [relTime(v.created_at)];
    if(speaker) metaParts.push(speaker);
    if(cat) metaParts.push(cat);
    const meta = metaParts.filter(Boolean).map(esc).join(' · ');
    return `
      <a class="list-item" href="watch.html?id=${encodeURIComponent(v.id)}">
        <b style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">🎬 新视频：${esc(title)}</b>
        <div class="small muted" style="margin-top:6px">${meta}</div>
      </a>
    `;
  }).join('');
}

function renderMoments(list){
  if(!els.momentsList) return;
  els.momentsCount && (els.momentsCount.textContent = String(list.length || 0));
  if(!list.length){
    els.momentsList.innerHTML = renderEmpty('动态');
    return;
  }
  els.momentsList.innerHTML = list.map(m=>{
    const author = m.author_name || '匿名';
    const text = snippet(m.content, 120);
    const firstImg = Array.isArray(m.images) && m.images.length ? String(m.images[0] || '') : '';
    const meta = `${relTime(m.created_at)}${author ? ' · ' + esc(author) : ''}`;
    return `
      <a class="list-item" href="moments.html?id=${encodeURIComponent(m.id)}">
        <div style="display:flex;gap:10px;align-items:flex-start">
          ${firstImg ? `<img class="thumb" alt="" src="${esc(firstImg)}" />` : ''}
          <div style="min-width:0">
            <b style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(author)}</b>
            ${text ? `<div class="small muted" style="margin-top:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(text)}</div>` : ''}
            <div class="small muted" style="margin-top:6px">${esc(meta)}</div>
          </div>
        </div>
      </a>
    `;
  }).join('');
}

async function refresh(){
  if(!isConfigured()){
    els.casesList && (els.casesList.innerHTML = `<div class="note"><b>演示模式：</b>请在 assets/config.js 配置 Supabase 后启用通知中心。</div>`);
    els.momentsList && (els.momentsList.innerHTML = '');
    return;
  }

  await ensureSupabase();

  const ok = await ensureAuthed('login.html?next=notifications.html');
  if(!ok) return;

  const user = await getCurrentUser();
  if(!user){
    toast('需要登录', '请先登录。', 'err');
    return;
  }

  // Baseline strategy (very important):
  // - If this device already has a "seen" timestamp, use it.
  // - If not, fall back to the user's account creation time.
  //
  // We intentionally DO NOT auto-set baseline to "now" on first open,
  // because users expect the 通知中心 to show existing unread items.
  // (If we set to now first, a user who just posted a new thread may see 0.)
  let seenCases = getSeenTs(SEEN_KEYS.cases);
  let seenMoments = getSeenTs(SEEN_KEYS.moments);
  let seenVideos = getSeenTs(SEEN_KEYS.videos);
  const createdMs = Date.parse(user?.created_at || '');
  const fallbackMs = Number.isFinite(createdMs) ? createdMs : 0;
  const firstUse = { cases: false, moments: false, videos: false };
  if(!seenCases){ seenCases = fallbackMs; firstUse.cases = true; }
  if(!seenMoments){ seenMoments = fallbackMs; firstUse.moments = true; }
  if(!seenVideos){ seenVideos = fallbackMs; firstUse.videos = true; }

  // Update hint copy for first-time devices
  try{
    const hint = document.getElementById('notifHint');
    if(hint){
      if(firstUse.cases || firstUse.moments || firstUse.videos){
        hint.innerHTML = `<b>提示：</b>这是你在本设备首次打开通知中心，默认从账号创建时间开始计算；如不想看历史，请点击右上角"全部标记已读"。`;
      }else{
        hint.innerHTML = `<b>提示：</b>通知以本设备的"最近标记已读时间"为基准（与红点逻辑一致）。`;
      }
    }
  }catch(_e){}

  const sinceCasesIso = new Date(seenCases).toISOString();
  const sinceMomentsIso = new Date(seenMoments).toISOString();
  const sinceVideosIso = new Date(seenVideos).toISOString();

  els.casesList && (els.casesList.innerHTML = `<div class="muted small">加载中…</div>`);
  els.momentsList && (els.momentsList.innerHTML = `<div class="muted small">加载中…</div>`);
  els.videosList && (els.videosList.innerHTML = `<div class="muted small">加载中…</div>`);

  const [newCases, newReplies, newMoments, newVideos] = await Promise.all([
    loadNewCases(sinceCasesIso),
    loadNewCaseReplies(sinceCasesIso),
    loadNewMoments(sinceMomentsIso),
    loadNewVideos(sinceVideosIso),
  ]);

  renderCases(newCases, newReplies);
  renderMoments(newMoments);
  renderVideos(newVideos);
}

function bind(){
  els.refreshBtn?.addEventListener('click', ()=>refresh());

  els.markCasesBtn?.addEventListener('click', ()=>{
    setSeenNow(SEEN_KEYS.cases);
    toast('已标记', '病例/回复通知已标记为已读。', 'ok');
    refresh();
  });

  els.markMomentsBtn?.addEventListener('click', ()=>{
    setSeenNow(SEEN_KEYS.moments);
    toast('已标记', '动态通知已标记为已读。', 'ok');
    refresh();
  });

  els.markVideosBtn?.addEventListener('click', ()=>{
    setSeenNow(SEEN_KEYS.videos);
    toast('已标记', '视频通知已标记为已读。', 'ok');
    refresh();
  });

  els.markAllBtn?.addEventListener('click', ()=>{
    setSeenNow(SEEN_KEYS.cases);
    setSeenNow(SEEN_KEYS.moments);
    setSeenNow(SEEN_KEYS.videos);
    toast('已标记', '全部通知已标记为已读。', 'ok');
    refresh();
  });
}

bind();
refresh().catch(err => {
  console.error(err);
  try{ toast('加载失败', err?.message || String(err), 'err'); }catch(_e){}
});
