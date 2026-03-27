import {
  supabase,
  ensureSupabase,
  isConfigured,
  getCurrentUser,
  getUserProfile,
  normalizeRole,
  isAdminRole,
  toast,
} from './supabaseClient.js?v=20260128_030';

const gate = document.getElementById('adminGate');
const root = document.getElementById('adminRoot');

async function initAdminGate(){
  if(!gate) return;

  if(isConfigured() && !supabase){
    await ensureSupabase();
  }

  if(!isConfigured() || !supabase){
    location.replace('index.html');
    return;
  }

  try{
    const u = await getCurrentUser();
    if(!u){
      location.replace('login.html?next=' + encodeURIComponent(location.pathname.split('/').pop() + location.search + location.hash));
      return;
    }
    const p = await getUserProfile(u);
    const role = normalizeRole(p?.role || u?.user_metadata?.role);
    const ok = isAdminRole(role);

    if(!ok){
      location.replace('index.html');
      return;
    }

    // Auth passed — inject admin content
    gate.textContent = '已登录管理员：你可以在下方管理内容。';
    await injectAdminContent(role);

    // If hash provided, scroll to section
    const h = String(location.hash || '');
    if(h && h.length > 1){
      const el = document.getElementById(h.replace('#',''));
      if(el) el.scrollIntoView({ behavior:'smooth', block:'start' });
    }
  }catch(e){
    location.replace('login.html?next=' + encodeURIComponent(location.pathname.split('/').pop()));
  }
}

async function injectAdminContent(role){
  if(!root) return;

  const isSuperAdmin = role === 'super_admin';

  root.innerHTML = `
    <section class="hero" style="padding-top:0">
      <div class="container">
        <div class="card">
          <div class="section-title">
            <div>
              <h2>管理后台</h2>
              <p>管理员/超级管理员可在此统一管理：会议与活动、临床研究中心（中心信息 + 研究项目）。</p>
            </div>
            <span class="badge">Admin Console</span>
          </div>

          <div class="hr"></div>

          <div class="tabs" style="display:flex;gap:10px;flex-wrap:wrap">
            <a class="btn" href="#events">管理会议与活动</a>
            <a class="btn" href="#research">管理临床研究中心</a>
            <a class="btn" href="#articles">文章管理</a>
            <a class="btn" href="#training">培训项目</a>
            <a class="btn" href="#moderators">版主管理</a>
            <a class="btn" href="#doctor">医生认证</a>
            ${isSuperAdmin ? '<a class="btn" href="#roles">权限与管理员</a>' : ''}
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <div class="stack">

          <div class="card soft" id="events">
            <div class="section-title">
              <div><h3>会议与活动</h3><p>可新增、编辑、更新状态与入会信息。</p></div>
              <span class="badge">Events</span>
            </div>
            <div class="grid cols-2" id="eventsGrid" style="margin-top:12px"></div>
            <div class="admin" id="eventsAdmin" hidden>
              <div class="hr"></div>
              <div class="note"><b>管理员：管理会议与活动</b><br/>你可以在这里更新会议时间、状态（确认/改期/取消）、以及"已确认会议"的入会链接与口令。</div>
              <form class="form" id="addEventForm" style="margin-top:12px">
                <div class="form-row">
                  <div><label>Key（唯一标识） <input class="input" name="key" placeholder="e.g. sun_zoom" required></label></div>
                  <div><label>平台 <input class="input" name="platform" placeholder="Zoom / 腾讯会议 / 线下" /></label></div>
                </div>
                <label>中文标题 <input class="input" name="title_zh" placeholder="例如：每周日 10:00（北京时间）" required></label>
                <label>英文标题（可选） <input class="input" name="title_en" placeholder="Weekly Meeting" /></label>
                <label>简介（可选） <textarea class="input" name="description" rows="2" placeholder="一句话说明会议定位"></textarea></label>
                <div class="form-row">
                  <div><label>状态 <select class="input" name="status"><option value="pending">筹备中</option><option value="planning">计划中</option><option value="confirmed">已确认</option><option value="rescheduled">已改期</option><option value="canceled">已取消</option></select></label></div>
                  <div><label>下次时间（可选） <input class="input" name="next_time" type="datetime-local" /></label></div>
                </div>
                <label>规则说明（可选） <textarea class="input" name="rule_zh" rows="2" placeholder="例如：每周日 10:00（北京时间）"></textarea></label>
                <div class="form-row"><button class="btn primary" type="submit">新增会议</button></div>
              </form>
              <div class="hr"></div>
              <div class="section-title" style="margin-top:0"><div><h3>现有会议（可编辑）</h3><p>修改后会立即反映到公开页面。</p></div><span class="badge">Edit</span></div>
              <div id="adminEventsList" class="stack" style="margin-top:12px"></div>
            </div>
          </div>

          <div class="card soft" id="research">
            <div class="section-title"><div><h3>临床研究中心</h3><p>管理中心信息（公开展示）与研究项目库。</p></div><span class="badge">Research</span></div>
            <div class="card soft" id="researchInfoCard" style="margin-top:12px">
              <div class="section-title"><div><h3>中心信息</h3></div><span class="badge">Info</span></div>
              <div id="researchInfo" class="small" style="line-height:1.75"><div class="small muted">加载中…</div></div>
            </div>
            <div class="hr"></div>
            <div class="section-title" style="margin-top:0"><div><h3>研究项目库</h3></div><span class="badge">Projects</span></div>
            <div id="projectGrid" class="grid cols-2" style="margin-top:12px"></div>
            <div class="admin" id="adminBox" hidden>
              <div class="hr"></div>
              <div class="section-title" style="margin-top:12px"><div><h3>中心信息编辑</h3></div><span class="badge">Admin</span></div>
              <form class="form" id="settingsForm" style="margin-top:12px">
                <label>中心介绍（可多行）<textarea class="input" name="intro" rows="4" placeholder="例如：研究中心定位、目标、流程等"></textarea></label>
                <label>联系方式（可多行）<textarea class="input" name="contact" rows="2"></textarea></label>
                <label>地址（可多行）<textarea class="input" name="address" rows="2"></textarea></label>
                <button class="btn primary" type="submit">保存中心信息</button>
              </form>
              <div class="hr"></div>
              <form class="form" id="projectForm" style="margin-top:12px">
                <div class="form-row">
                  <div><label>项目名称 <input class="input" name="title" placeholder="例如：IgAN 多中心回顾性队列" required></label></div>
                  <div><label>状态 <select class="input" name="status"><option value="planning">筹备中</option><option value="starting">启动中</option><option value="recruiting">招募中</option><option value="ongoing">进行中</option><option value="completed">已完成</option></select></label></div>
                </div>
                <div class="form-row">
                  <div><label>研究类型（可选） <input class="input" name="study_type" placeholder="回顾性/前瞻性/随机对照…" /></label></div>
                  <div><label>PI（可选） <input class="input" name="pi" placeholder="负责人/PI" /></label></div>
                </div>
                <label>摘要（可选） <textarea class="input" name="summary" rows="3"></textarea></label>
                <button class="btn primary" type="submit">添加项目</button>
              </form>
              <div class="hr"></div>
              <div id="adminProjectsList" class="stack" style="margin-top:12px"></div>
            </div>
          </div>

          <div class="card soft" id="articles">
            <div class="section-title"><div><h3>文章管理</h3><p>管理员可发布文章，并在首页自动推送最新文章。</p></div><span class="badge">Articles</span></div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
              <a class="btn primary" href="article-editor.html">写文章</a>
              <a class="btn" href="articles.html">查看文章列表</a>
            </div>
            <div class="hr"></div>
            <div id="adminArticlesList" class="stack" style="margin-top:12px"></div>
          </div>

          <div class="card soft" id="training">
            <div class="section-title"><div><h3>培训项目</h3><p>用于首页与学习中心的"培训项目"板块。</p></div><span class="badge">Training</span></div>
            <div class="admin" id="trainingAdmin" hidden>
              <div class="hr"></div>
              <form class="form" id="addTrainingForm" style="margin-top:12px;max-width:920px">
                <div class="form-row">
                  <div style="flex:1;min-width:240px"><label>项目名称</label><input class="input" name="title" required placeholder="例如：肾移植内科培训项目" /></div>
                  <div style="min-width:220px"><label>状态</label><select class="input" name="status"><option value="active">进行中</option><option value="planning" selected>规划中</option><option value="coming_soon">即将启动</option><option value="archived">已结束</option></select></div>
                </div>
                <div class="form-row">
                  <div style="flex:1;min-width:240px"><label>Badge 文案（可选）</label><input class="input" name="badge" placeholder="例如：6月启动 / 规划中" /></div>
                  <div style="min-width:220px"><label>排序（越小越靠前）</label><input class="input" name="sort" type="number" value="10" /></div>
                </div>
                <label>简介（可选）</label><textarea class="input" name="description" rows="3"></textarea>
                <div class="form-row">
                  <div style="flex:1;min-width:240px"><label>详情链接（可选）</label><input class="input" name="link" placeholder="外部链接或站内页面" /></div>
                  <div style="min-width:220px"><label>是否预留付费接口</label><select class="input" name="is_paid"><option value="true" selected>是（默认）</option><option value="false">否</option></select></div>
                </div>
                <button class="btn primary" type="submit">新增培训项目</button>
                <span class="small muted" id="trainingHint" style="margin-left:10px"></span>
              </form>
              <div class="hr"></div>
              <div id="trainingList" class="stack" style="margin-top:12px"></div>
            </div>
            <div class="note" id="trainingNeedAdmin" style="margin-top:12px">需要管理员权限才能编辑。</div>
          </div>

          <div class="card soft" id="moderators">
            <div class="section-title"><div><h3>版主管理</h3><p>为每个讨论板块设置多个版主。</p></div><span class="badge">Moderators</span></div>
            <div class="admin" id="moderatorsAdmin" hidden>
              <div class="hr"></div>
              <form class="form" id="addModeratorForm" style="margin-top:12px;max-width:920px">
                <div class="form-row">
                  <div style="min-width:240px"><label>板块</label><select class="input" name="board_key" id="modBoardKey"></select></div>
                  <div style="flex:1;min-width:300px"><label>用户ID（uuid）</label><input class="input" name="user_id" required placeholder="从权限管理复制用户ID" /></div>
                </div>
                <div class="form-row">
                  <div style="flex:1;min-width:260px"><label>展示姓名（可选）</label><input class="input" name="display_name" /></div>
                  <div style="flex:1;min-width:260px"><label>头像URL（可选）</label><input class="input" name="avatar_url" /></div>
                </div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
                  <button class="btn primary" type="submit">添加/更新版主</button>
                  <button class="btn" type="button" id="modAutoFillBtn">自动读取资料</button>
                  <span class="small muted" id="modHint"></span>
                </div>
              </form>
              <div class="hr"></div>
              <div id="moderatorList" class="stack" style="margin-top:12px"></div>
            </div>
            <div class="note" id="moderatorsNeedAdmin" style="margin-top:12px">需要管理员权限才能编辑。</div>
          </div>

          <div class="card soft" id="doctor">
            <div class="section-title"><div><h3>医生认证</h3><p>支持：邀请码快速认证（通道A） + 人工审核认证（通道B）。</p></div><span class="badge">Verification</span></div>
            <div class="grid cols-2" style="margin-top:12px">
              <div class="card" style="margin:0">
                <div class="section-title"><div><h4 style="margin:0">邀请码管理（通道A）</h4></div><span class="badge">Codes</span></div>
                <form class="form" id="inviteCodeForm" style="margin-top:10px">
                  <div class="form-row">
                    <div><label>邀请码 <input class="input" name="code" placeholder="例如：DOCTOR2026" required></label></div>
                    <div><label>状态 <select class="input" name="active"><option value="true" selected>启用</option><option value="false">停用</option></select></label></div>
                  </div>
                  <label>备注（可选） <input class="input" name="note" /></label>
                  <div class="form-row">
                    <div><label>使用次数上限（可选） <input class="input" name="max_uses" type="number" min="1" /></label></div>
                    <div><label>过期时间（可选） <input class="input" name="expires_at" type="datetime-local" /></label></div>
                  </div>
                  <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px">
                    <button class="btn primary" type="submit">新增/更新邀请码</button>
                    <span class="small muted" id="inviteCodeHint"></span>
                  </div>
                </form>
                <div class="hr"></div>
                <div id="inviteCodeList" class="small"></div>
              </div>
              <div class="card" style="margin:0">
                <div class="section-title"><div><h4 style="margin:0">人工审核（通道B）</h4></div><span class="badge">Review</span></div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;align-items:center">
                  <button class="btn" id="refreshDoctorQueue" type="button">刷新列表</button>
                  <label class="small" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="dvOnlyPending" checked /> 仅显示待审核</label>
                  <span class="small muted" id="doctorQueueHint"></span>
                </div>
                <div class="hr"></div>
                <div id="doctorQueue" class="small"></div>
              </div>
            </div>
          </div>

          ${isSuperAdmin ? `
          <div class="card soft" id="roles">
            <div class="section-title"><div><h3>权限与管理员</h3><p>仅超级管理员可将成员提升为管理员。</p></div><span class="badge">Super</span></div>
            <div class="form-row" style="gap:10px;flex-wrap:wrap;align-items:center">
              <input class="input" id="roleSearchInput" placeholder="搜索姓名 / 用户ID（UUID）…" style="flex:1;min-width:260px" />
              <button class="btn" id="roleSearchBtn" type="button">搜索</button>
              <button class="btn" id="roleRefreshBtn" type="button">刷新</button>
            </div>
            <div class="hr"></div>
            <div id="roleSearchResults" class="stack"></div>
          </div>` : ''}

        </div>
      </div>
    </section>`;

  // Dynamically load admin sub-modules after DOM is ready
  const modules = [
    'events.js?v=20260327_001',
    'research.js?v=20260327_001',
    'articlesAdmin.js?v=20260327_001',
    'doctorAdmin.js?v=20260327_001',
    'trainingAdmin.js?v=20260327_001',
    'moderatorsAdmin.js?v=20260327_001',
  ];

  if(isSuperAdmin){
    modules.push('roles.js?v=20260327_001');
  }

  for(const src of modules){
    try{
      const s = document.createElement('script');
      s.type = 'module';
      s.src = src;
      document.body.appendChild(s);
    }catch(_e){}
  }
}

initAdminGate();
