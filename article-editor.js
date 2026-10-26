import {
  getSupabase,
  getCurrentUser,
  getUserProfile,
  isAdminRole,
} from './supabaseClient.js?v=20260917_content1';

import { mountKSEditor } from './ks_editor.js?v=20260213_001';
import { renderSafeHtml } from './ks_richtext.js?v=20260213_001';

const gateEl = document.getElementById('editorGate');
const rootEl = document.getElementById('editorRoot');

let loadedArticle = null;
let currentCanEdit = false;
let currentCanPublish = false;
let rtEditor = null;

let _actionsDocked = false;

// DOM element references — populated after auth-gated HTML injection
let els = {};
let statusMsg = null;

function injectEditorHTML() {
  if (!rootEl) return;
  rootEl.innerHTML = `
  <div class="card soft" style="margin-top:14px">
    <div class="form-row" style="gap:10px;flex-wrap:wrap">
      <div style="flex:2;min-width:240px">
        <label class="small muted">标题</label>
        <input class="input" id="aTitle" placeholder="请输入文章标题"/>
      </div>
      <div style="flex:1;min-width:240px">
        <label class="small muted">状态</label>
        <select class="input" id="aStatus">
          <option value="draft">草稿</option>
          <option value="in_review">审核中</option>
          <option value="published">已发布</option>
          <option value="archived">归档</option>
        </select>
      </div>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
        <label class="small muted" style="display:flex;gap:8px;align-items:center">
          <input type="checkbox" id="aPinned"/> 置顶
        </label>
      </div>
    </div>

    <div class="form-row" style="gap:10px;flex-wrap:wrap;margin-top:10px">
      <div style="flex:2;min-width:240px">
        <label class="small muted">摘要（用于列表/首页展示）</label>
        <textarea class="input prose-input" id="aSummary" rows="2" placeholder="可选：简短摘要"></textarea>
      </div>
      <div style="flex:1;min-width:240px">
        <label class="small muted">封面图 URL（可选）</label>
        <input class="input" id="aCover" placeholder="https://..."/>
      </div>
    </div>

    <div class="form-row" style="gap:10px;flex-wrap:wrap;margin-top:10px">
      <div style="flex:1;min-width:320px">
        <label class="small muted">上传图片 / 短视频（MP4 ≤ 50MB）</label>
        <input class="input" id="aMediaFile" type="file" accept="image/*,video/mp4,application/pdf,.pdf,.doc,.docx" />
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;align-items:center">
          <button class="btn tiny" id="aUploadInsert" type="button">上传并插入正文</button>
          <button class="btn tiny" id="aUploadCover" type="button">上传并设为封面</button>
          <span class="small muted" id="aUploadMsg"></span>
        </div>
      </div>
    </div>

    <div class="form-row" style="gap:10px;flex-wrap:wrap;margin-top:10px">
      <div style="flex:1;min-width:240px">
        <label class="small muted">标签（逗号分隔，可选）</label>
        <input class="input" id="aTags" placeholder="例如：AAV, 指南, 综述"/>
      </div>
      <div style="flex:1;min-width:240px">
        <label class="small muted">作者显示名（可选）</label>
        <input class="input" id="aAuthorName" placeholder="例如：刘松 / 肾域 编辑部"/>
      </div>
    </div>

    <details class="card soft daily-editor" id="aDailyDetails" style="margin-top:14px">
      <summary style="cursor:pointer"><b>每日一学</b> <span class="small muted">把本文设为 3–5 分钟临床学习卡</span></summary>
      <div style="margin-top:14px">
        <label style="display:flex;gap:9px;align-items:center">
          <input type="checkbox" id="aDailyEnabled"/> 为本文配置“每日一学”
        </label>
        <div id="aDailyPanel" hidden>
          <div class="note small" style="margin-top:12px">每日学习卡本身免费；可另设一个明确标注的会员回放或培训课程入口。内容编辑可提交，管理员发布文章后才会面向用户显示。</div>
          <div class="form-row" style="gap:10px;flex-wrap:wrap;margin-top:12px">
            <div style="flex:1;min-width:180px"><label class="small muted">专业方向</label><select class="input" id="aDailySpecialty"><option value="glom">肾小球病</option><option value="icu">重症肾内</option><option value="tx">肾移植</option><option value="path">肾脏病理</option><option value="da">血管通路</option><option value="peds">儿童肾脏</option><option value="other">综合肾脏病</option></select></div>
            <div style="flex:1;min-width:180px"><label class="small muted">计划日期（北京时间）</label><input class="input" id="aDailyDate" type="date"/></div>
            <div style="flex:1;min-width:150px"><label class="small muted">预计分钟</label><input class="input" id="aDailyMinutes" type="number" min="1" max="15" value="3"/></div>
          </div>
          <div style="margin-top:10px"><label class="small muted">今日学习目标</label><textarea class="input prose-input" id="aDailyObjective" rows="2" placeholder="例如：判断浓缩尿伴低尿钠时，为什么不能只凭总尿渗透压诊断 SIADH"></textarea></div>
          <div style="margin-top:10px"><label class="small muted">核心要点（每行一个，1–5条）</label><textarea class="input prose-input" id="aDailyPoints" rows="4" placeholder="要点一\n要点二\n要点三"></textarea></div>
          <div style="margin-top:10px"><label class="small muted">检验问题</label><textarea class="input prose-input" id="aDailyQuestion" rows="2" placeholder="一道单选题"></textarea></div>
          <div class="form-row" style="gap:10px;flex-wrap:wrap;margin-top:10px">
            <div style="flex:2;min-width:280px"><label class="small muted">选项（每行一个，2–6项）</label><textarea class="input prose-input" id="aDailyOptions" rows="4" placeholder="选项 A\n选项 B\n选项 C\n选项 D"></textarea></div>
            <div style="flex:1;min-width:170px"><label class="small muted">正确选项序号</label><input class="input" id="aDailyCorrect" type="number" min="1" max="6" value="1"/><div class="small muted" style="margin-top:5px">填写 1、2、3…</div></div>
          </div>
          <div style="margin-top:10px"><label class="small muted">答案解析</label><textarea class="input prose-input" id="aDailyExplanation" rows="3" placeholder="说明为什么正确，以及常见误区"></textarea></div>
          <div class="form-row" style="gap:10px;flex-wrap:wrap;margin-top:10px">
            <div style="flex:1;min-width:220px"><label class="small muted">来源名称</label><input class="input" id="aDailySourceLabel" placeholder="例如：KDIGO 2024 CKD Guideline"/></div>
            <div style="flex:1;min-width:260px"><label class="small muted">来源链接（HTTPS，可选）</label><input class="input" id="aDailySourceUrl" type="url" placeholder="https://..."/></div>
          </div>
          <div class="form-row" style="gap:10px;flex-wrap:wrap;margin-top:10px">
            <div style="flex:1;min-width:210px"><label class="small muted">延伸学习按钮文字（可选）</label><input class="input" id="aDailyRelatedLabel" placeholder="例如：观看本周回放"/></div>
            <div style="flex:1;min-width:250px"><label class="small muted">站内链接（可选）</label><input class="input" id="aDailyRelatedHref" placeholder="videos.html?access=member"/></div>
            <div style="flex:1;min-width:180px"><label class="small muted">延伸内容权限</label><select class="input" id="aDailyRelatedAccess"><option value="">不设置</option><option value="free">免费</option><option value="member">会员回放 · ¥299/年</option><option value="training">培训项目 · 另行付费</option></select></div>
          </div>
          <label id="aDailyActiveWrap" style="display:flex;gap:9px;align-items:center;margin-top:12px"><input type="checkbox" id="aDailyActive"/> 发布文章后在首页启用（管理员）</label>
          <div class="small muted" id="aDailyMsg" style="margin-top:8px"></div>
        </div>
      </div>
    </details>

    <div class="hr"></div>

    <div class="form-row" style="gap:10px;flex-wrap:wrap;margin-top:10px">
      <div style="flex:1;min-width:260px">
        <label class="small muted">文章模板（可选）</label>
        <select class="input" id="aTemplate">
          <option value="">不使用模板</option>
          <option value="im_note">内科笔记模板（学习笔记）</option>
          <option value="case_review">病例复盘模板（Case Review）</option>
          <option value="guideline">指南/共识速览模板</option>
          <option value="drug">用药总结模板</option>
        </select>
      </div>
      <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
        <button class="btn tiny" id="aApplyTemplate" type="button">一键套模板</button>
        <button class="btn tiny" id="aAutoFormat" type="button">一键排版</button>
        <button class="btn tiny" id="aSmartOrganize" type="button" disabled title="智能整理（AI）即将上线">智能整理（即将上线）</button>
      </div>
    </div>

    <div class="form-row" style="gap:10px;flex-wrap:wrap;align-items:flex-start">
      <div style="flex:1;min-width:320px">
        <label class="small muted">正文（所见即所得）</label>
        <textarea class="input prose-input" id="aContent" rows="16" placeholder="# 标题\n\n正文…"></textarea>

        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;align-items:center">
          <button class="btn primary" id="aSaveBtn" type="button">保存</button>
          <button class="btn" id="aPreviewBtn" type="button">预览</button>
          <button class="btn danger" id="aDeleteBtn" type="button">删除</button>
          <span class="small muted" id="aStatusMsg"></span>
        </div>
      </div>

      <div style="flex:1;min-width:320px">
        <div class="small muted">预览</div>
        <div class="card soft article-preview" id="aPreview" style="margin-top:10px;max-height:520px;overflow:auto">
          <div class="muted small">点击"预览"查看渲染效果。</div>
        </div>
      </div>
    </div>
  </div>`;
}

function populateEls() {
  statusMsg = document.getElementById('aStatusMsg');
  els = {
    title: document.getElementById('aTitle'),
    status: document.getElementById('aStatus'),
    pinned: document.getElementById('aPinned'),
    summary: document.getElementById('aSummary'),
    cover: document.getElementById('aCover'),
    tags: document.getElementById('aTags'),
    authorName: document.getElementById('aAuthorName'),
    content: document.getElementById('aContent'),
    preview: document.getElementById('aPreview'),
    saveBtn: document.getElementById('aSaveBtn'),
    previewBtn: document.getElementById('aPreviewBtn'),
    deleteBtn: document.getElementById('aDeleteBtn'),
    tplSelect: document.getElementById('aTemplate'),
    tplApplyBtn: document.getElementById('aApplyTemplate'),
    autoFormatBtn: document.getElementById('aAutoFormat'),
    smartOrganizeBtn: document.getElementById('aSmartOrganize'),
    mediaFile: document.getElementById('aMediaFile'),
    uploadInsertBtn: document.getElementById('aUploadInsert'),
    uploadCoverBtn: document.getElementById('aUploadCover'),
    uploadMsg: document.getElementById('aUploadMsg'),
    dailyDetails: document.getElementById('aDailyDetails'),
    dailyEnabled: document.getElementById('aDailyEnabled'),
    dailyPanel: document.getElementById('aDailyPanel'),
    dailySpecialty: document.getElementById('aDailySpecialty'),
    dailyDate: document.getElementById('aDailyDate'),
    dailyMinutes: document.getElementById('aDailyMinutes'),
    dailyObjective: document.getElementById('aDailyObjective'),
    dailyPoints: document.getElementById('aDailyPoints'),
    dailyQuestion: document.getElementById('aDailyQuestion'),
    dailyOptions: document.getElementById('aDailyOptions'),
    dailyCorrect: document.getElementById('aDailyCorrect'),
    dailyExplanation: document.getElementById('aDailyExplanation'),
    dailySourceLabel: document.getElementById('aDailySourceLabel'),
    dailySourceUrl: document.getElementById('aDailySourceUrl'),
    dailyRelatedLabel: document.getElementById('aDailyRelatedLabel'),
    dailyRelatedHref: document.getElementById('aDailyRelatedHref'),
    dailyRelatedAccess: document.getElementById('aDailyRelatedAccess'),
    dailyActive: document.getElementById('aDailyActive'),
    dailyActiveWrap: document.getElementById('aDailyActiveWrap'),
    dailyMsg: document.getElementById('aDailyMsg'),
  };
}

function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function safeUrl(url){
  const raw = String(url || '').trim();
  if(!raw) return '';
  if(/^https?:\/\//i.test(raw)) return raw;
  return 'https://' + raw;
}

function safeFileName(name){
  const base = String(name || 'file').trim() || 'file';
  return base
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .slice(0, 80);
}

function safeAlt(s){
  // Keep alt/label short and safe for markdown contexts.
  return String(s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\[\]\(\)]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function setUploadMsg(text, cls='muted'){
  if(!els.uploadMsg) return;
  els.uploadMsg.className = `small ${cls}`;
  els.uploadMsg.textContent = String(text || '');
}

function insertAtCursor(textarea, text){
  if(!textarea) return;
  textarea.focus?.();
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  textarea.value = before + text + after;
  const pos = start + text.length;
  textarea.selectionStart = textarea.selectionEnd = pos;
}

// ---------------- Templates & Auto-format (v8.16.14) ----------------

const ARTICLE_TEMPLATES = {
  im_note: {
    title: '内科笔记模板（学习笔记）',
    md: `## 一句话总结\n\n- （用一句话讲清楚：这篇笔记解决什么问题）\n\n## 关键要点（Key points）\n\n- \n- \n- \n\n## 背景与定义\n\n- 定义：\n- 常见场景：\n\n## 病因与机制\n\n- \n\n## 临床表现\n\n- \n\n## 诊断思路\n\n### 必做检查\n\n- \n\n### 关键鉴别诊断\n\n- \n\n## 治疗与管理\n\n### 急性期处理\n\n- \n\n### 长期管理 / 随访\n\n- \n\n### 用药要点与禁忌\n\n- \n\n## 易错点 / 踩坑点\n\n- \n\n## 个人补充（可选）\n\n- \n\n## 参考文献 / 指南链接\n\n- \n- \n`
  },
  case_review: {
    title: '病例复盘模板（Case Review）',
    md: `## 病例信息概览\n\n- 主诉：\n- 关键病史：\n- 既往史 / 用药：\n- 体格检查：\n- 初步印象：\n\n## 检查结果\n\n### 实验室\n\n- \n\n### 影像 / 病理 / 其他\n\n- \n\n## 诊断思路\n\n- 诊断要点：\n- 鉴别诊断：\n\n## 治疗经过\n\n- \n\n## 结局与随访\n\n- \n\n## 复盘要点（Lessons learned）\n\n- \n\n## 参考 / 依据\n\n- \n`
  },
  guideline: {
    title: '指南/共识速览模板',
    md: `## 适用人群与范围\n\n- \n\n## 核心推荐（TL;DR）\n\n- \n- \n- \n\n## 诊断 / 评估要点\n\n- \n\n## 治疗策略\n\n### 一线\n\n- \n\n### 二线 / 特殊人群\n\n- \n\n## 监测与随访\n\n- \n\n## 证据等级与备注\n\n- \n\n## 原文链接 / 参考\n\n- \n`
  },
  drug: {
    title: '用药总结模板',
    md: `## 适应证\n\n- \n\n## 机制与特点\n\n- \n\n## 用法用量\n\n- \n\n## 疗效证据\n\n- \n\n## 不良反应与处理\n\n- \n\n## 禁忌与注意事项\n\n- \n\n## 相互作用\n\n- \n\n## 特殊人群（肾功能 / 肝功能 / 妊娠 / 老年）\n\n- \n\n## 监测指标\n\n- \n\n## 参考\n\n- \n`
  }
};

function getTemplateKeyFromTags(tags){
  const arr = Array.isArray(tags) ? tags : parseTags(tags);
  if(arr.some(t => t === '内科笔记' || t === '大内科笔记')) return 'im_note';
  return '';
}

function applySelectedTemplate(){
  const key = String(els.tplSelect?.value || '').trim();
  if(!key || !ARTICLE_TEMPLATES[key]){
    setMsg('请先选择一个文章模板。', 'err');
    return;
  }
  const tplMd = ARTICLE_TEMPLATES[key].md;
  const tplHtml = mdToHtml(tplMd);

  // Prefer rich editor if mounted
  if(rtEditor){
    const cur = String(rtEditor.getHtml() || '').trim();
    if(!cur){
      rtEditor.setHtml(tplHtml);
      setMsg('已套用模板。', 'muted');
      preview();
      return;
    }
    rtEditor.insertHtml('<hr/>' + tplHtml);
    setMsg('正文已有内容：已将模板追加到文末。', 'muted');
    preview();
    return;
  }

  // Fallback (legacy textarea)
  const cur = String(els.content?.value || '');
  if(!cur.trim()){
    els.content.value = tplMd;
    setMsg('已套用模板。', 'muted');
    preview();
    return;
  }
  const sep = cur.endsWith('\n') ? '' : '\n';
  els.content.value = cur + sep + '\n---\n\n' + tplMd;
  setMsg('正文已有内容：已将模板追加到文末。', 'muted');
  preview();
}

function normalizeMdLine(line){
  let l = String(line || '');
  // Trim trailing spaces
  l = l.replace(/[ \t]+$/g, '');
  // Normalize headings (#/##/###)
  const hm = l.match(/^\s*(#{1,3})\s*(.+?)\s*$/);
  if(hm){
    return `${hm[1]} ${hm[2]}`;
  }
  // Normalize bullet list markers: • / · / * / + / -
  const bm = l.match(/^(\s*)([•·\-*+])\s+(.*)$/);
  if(bm){
    return `${bm[1]}- ${bm[3]}`;
  }
  // Normalize ordered list separators: 1) 1、 1. -> 1.
  const om = l.match(/^(\s*)(\d{1,3})([\)\.、])\s+(.*)$/);
  if(om){
    return `${om[1]}${om[2]}. ${om[4]}`;
  }
  return l;
}

function formatMarkdown(md){
  const raw = String(md || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n');
  const stage1 = [];
  let inFence = false;
  for(let i=0;i<lines.length;i++){
    const line = lines[i];
    const trimmed = String(line).trim();
    if(trimmed.startsWith('```')){
      inFence = !inFence;
      stage1.push(trimmed); // trim fence marker
      continue;
    }
    if(inFence){
      stage1.push(line); // keep as-is inside code fence
      continue;
    }
    stage1.push(normalizeMdLine(line));
  }

  const stage2 = [];
  inFence = false;

  const isBlank = (l)=> /^\s*$/.test(l || '');
  const isFence = (l)=> String(l || '').trim().startsWith('```');
  const isHeading = (l)=> /^#{1,3}\s+\S/.test(String(l || ''));
  const isBullet = (l)=> /^(\s*)-\s+\S/.test(String(l || ''));
  const isOrdered = (l)=> /^(\s*)\d{1,3}\.\s+\S/.test(String(l || ''));
  const isList = (l)=> isBullet(l) || isOrdered(l);
  const isHr = (l)=> /^\s*---\s*$/.test(String(l || ''));

  for(let i=0;i<stage1.length;i++){
    const l0 = stage1[i];
    if(isFence(l0)){
      stage2.push(l0);
      inFence = !inFence;
      continue;
    }
    if(inFence){
      stage2.push(l0);
      continue;
    }

    if(isBlank(l0)){
      // Collapse multiple blank lines
      if(stage2.length && isBlank(stage2[stage2.length-1])) continue;
      stage2.push('');
      continue;
    }

    // HR block: keep blank line around
    if(isHr(l0)){
      if(stage2.length && !isBlank(stage2[stage2.length-1])) stage2.push('');
      stage2.push('---');
      const next = stage1[i+1] || '';
      if(next && !isBlank(next) && !isFence(next)) stage2.push('');
      continue;
    }

    // Headings: ensure blank line before/after
    if(isHeading(l0)){
      if(stage2.length && !isBlank(stage2[stage2.length-1])) stage2.push('');
      stage2.push(l0);
      const next = stage1[i+1] || '';
      if(next && !isBlank(next) && !isFence(next)) stage2.push('');
      continue;
    }

    // Lists: ensure separation from paragraphs
    if(isList(l0)){
      const prev = stage2[stage2.length-1] || '';
      if(stage2.length && !isBlank(prev) && !isList(prev)) stage2.push('');
      stage2.push(l0);
      const next = stage1[i+1] || '';
      if(next && !isBlank(next) && !isList(next) && !isFence(next)) stage2.push('');
      continue;
    }

    stage2.push(l0);
  }

  // Trim leading/trailing blank lines
  while(stage2.length && isBlank(stage2[0])) stage2.shift();
  while(stage2.length && isBlank(stage2[stage2.length-1])) stage2.pop();
  return stage2.join('\n') + '\n';
}

function isMp4(file){
  return String(file?.type || '').toLowerCase() === 'video/mp4' || /\.mp4$/i.test(String(file?.name || ''));
}

function isPdf(file){
  return String(file?.type || '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(String(file?.name || ''));
}
function isDoc(file){
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  return type === 'application/msword' ||
    type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.doc') || name.endsWith('.docx');
}
function isImage(file){
  const type = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '').toLowerCase();
  return type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(name);
}
function isSupportedForContent(file){
  return isImage(file) || isMp4(file) || isPdf(file) || isDoc(file);
}

async function uploadArticleMedia(file){
  if(!file) throw new Error('请选择要上传的文件。');
  const MAX_MP4 = 50 * 1024 * 1024;
  if(isMp4(file) && file.size > MAX_MP4) throw new Error('MP4 文件不能超过 50MB。');

  const sb = await getSupabase();
  if(!sb) throw new Error('Supabase 未配置。');
  const user = await getCurrentUser();
  if(!user) throw new Error('请先登录。');
  if(!currentCanEdit) throw new Error('需要内容编辑权限才能上传文章媒体。');

  const bucket = 'article_media';
  const path = `${user.id}/${Date.now()}_${safeFileName(file.name)}`;
  const { error } = await sb.storage.from(bucket).upload(path, file, { upsert: false, contentType: file.type });
  if(error) throw error;
  const { data } = sb.storage.from(bucket).getPublicUrl(path);
  const url = data?.publicUrl || '';
  if(!url) throw new Error('获取公开 URL 失败。');
  return url;
}

function linkify(htmlEscapedText){
  const urlRe = /\bhttps?:\/\/[^\s<>"']+|(?<!@)\bwww\.[^\s<>"']+/gi;
  return String(htmlEscapedText).replace(urlRe, (m)=>{
    const href = safeUrl(m);
    return `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(m)}</a>`;
  });
}

function mdToHtml(md){
  // Minimal safe renderer:
  // - Escape everything first to avoid XSS
  // - Then apply lightweight Markdown features
  // - Media tokens are forced into standalone blocks for stable layout
  const raw = String(md || '').replace(/\r\n/g, '\n');
  let s = esc(raw);

  // Media embeds (force standalone blocks)
  // - Image: ![alt](url)
  // - Video: {{video:url}}
  // - PDF: {{pdf:url}}
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url)=>{
    const u = safeUrl(String(url || '').trim());
    if(!u) return '';
    return `\n\n__IMG__${esc(alt)}__${esc(u)}__\n\n`;
  });
  s = s.replace(/\{\{video:([^}]+)\}\}/g, (_m, url)=>{
    const u = safeUrl(String(url || '').trim());
    if(!u) return '';
    return `\n\n__VID__${esc(u)}__\n\n`;
  });
  s = s.replace(/\{\{pdf:([^}]+)\}\}/g, (_m, url)=>{
    const u = safeUrl(String(url || '').trim());
    if(!u) return '';
    return `\n\n__PDF__${esc(u)}__\n\n`;
  });

  // Code fences ```...```
  s = s.replace(/```([\s\S]*?)```/g, (_m, code)=>`<pre class="codeblock"><code>${code}</code></pre>`);

  // Horizontal rule
  s = s.replace(/^\s*---\s*$/gm, '<hr/>');

  // Headings
  s = s.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Bold/italic/inline code
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*(.+?)\*/g, '<i>$1</i>');
  s = s.replace(/`(.+?)`/g, '<code>$1</code>');

  // Lists: unordered (- item) and ordered (1. item)
  s = s.replace(/(?:^|\n)(- .+(?:\n- .+)*)/g, (m)=>{
    const lines = m.trim().split('\n').map(l=>l.replace(/^- /,''));
    return '\n<ul>' + lines.map(li=>`<li>${li}</li>`).join('') + '</ul>';
  });
  s = s.replace(/(?:^|\n)((?:\d+\. .+)(?:\n\d+\. .+)*)/g, (m)=>{
    const lines = m.trim().split('\n').map(l=>l.replace(/^\d+\.\s+/,''));
    return '\n<ol>' + lines.map(li=>`<li>${li}</li>`).join('') + '</ol>';
  });

  const blocks = s.split(/\n{2,}/).map(b=>b.trim()).filter(Boolean);

  const isImgBlock = (b)=>/^__IMG__/.test(b);
  const isVidBlock = (b)=>/^__VID__/.test(b);
  const isPdfBlock = (b)=>/^__PDF__/.test(b);

  const shouldCaption = (alt)=>{
    const a = String(alt || '').trim();
    if(!a) return false;
    const low = a.toLowerCase();
    if(low === 'image' || low === 'img' || low === '图片') return false;
    // Avoid captions that look like file names only
    if(/^[a-z0-9_-]+\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(a)) return false;
    return true;
  };

  const renderImgs = (imgs)=>{
    if(!imgs.length) return '';
    if(imgs.length === 1){
      const { alt, url } = imgs[0];
      const cap = shouldCaption(alt) ? `<figcaption>${alt}</figcaption>` : '';
      // Click-to-open in a new tab (useful on mobile too)
      return `
        <figure class="ks-figure">
          <a class="ks-media-item" href="${url}" target="_blank" rel="noopener">
            <img class="article-media" alt="${alt}" src="${url}" />
          </a>
          ${cap}
        </figure>
      `;
    }
    return `
      <div class="ks-media-grid" data-count="${imgs.length}">
        ${imgs.map(({ alt, url }) => `
          <a class="ks-media-item" href="${url}" target="_blank" rel="noopener">
            <img alt="${alt || 'image'}" src="${url}" />
          </a>
        `).join('')}
      </div>
    `;
  };

  const renderVids = (vids)=>{
    if(!vids.length) return '';
    return vids.map(({ url })=>`
      <div class="article-video">
        <video controls playsinline preload="metadata" style="width:100%;max-width:980px;border-radius:16px;background:#000;border:1px solid rgba(255,255,255,.12)">
          <source src="${url}" type="video/mp4" />
          你的浏览器不支持 MP4 播放。
        </video>
      </div>
    `).join('\n');
  };

  const renderPdfs = (pdfs)=>{
    if(!pdfs.length) return '';
    return `
      <div class="attach-list">
        ${pdfs.map(({ url }) => `
          <a class="file-chip" data-act="article-download" data-kind="pdf" href="${url}" target="_blank" rel="noopener">📄 打开 PDF</a>
        `).join('')}
      </div>
    `;
  };

  const out = [];
  for(let i=0;i<blocks.length;i++){
    const b = blocks[i];

    // Structural blocks (already HTML)
    if(/^<h[1-3]>/.test(b) || /^<ul>/.test(b) || /^<ol>/.test(b) || /^<pre /.test(b) || /^<hr\/?>/.test(b)){
      out.push(b);
      continue;
    }

    // Group consecutive images into a grid
    if(isImgBlock(b)){
      const imgs = [];
      let j = i;
      while(j < blocks.length && isImgBlock(blocks[j])){
        const m = blocks[j].match(/^__IMG__(.*?)__(.*?)__$/);
        if(m) imgs.push({ alt: m[1], url: m[2] });
        j++;
      }
      out.push(renderImgs(imgs));
      i = j - 1;
      continue;
    }

    // Group consecutive PDFs into one attachment row
    if(isPdfBlock(b)){
      const pdfs = [];
      let j = i;
      while(j < blocks.length && isPdfBlock(blocks[j])){
        const m = blocks[j].match(/^__PDF__(.*?)__$/);
        if(m) pdfs.push({ url: m[1] });
        j++;
      }
      out.push(renderPdfs(pdfs));
      i = j - 1;
      continue;
    }

    // Videos (usually 1 per block; still supports multiple if needed)
    if(isVidBlock(b)){
      const vids = [];
      let j = i;
      while(j < blocks.length && isVidBlock(blocks[j])){
        const m = blocks[j].match(/^__VID__(.*?)__$/);
        if(m) vids.push({ url: m[1] });
        j++;
      }
      out.push(renderVids(vids));
      i = j - 1;
      continue;
    }

    // Normal paragraph: keep single newlines as <br/>
    out.push(`<p>${b.replace(/\n/g,'<br/>')}</p>`);
  }

  let html = out.join('\n');

  // Auto links (text blocks only; avoid touching HTML attributes)
  html = html.replace(/<p>([\s\S]*?)<\/p>/g, (_m, inner)=>`<p>${linkify(inner)}</p>`);

  return html;
}

function getId(){
  const u = new URL(location.href);
  return u.searchParams.get('id') || '';
}



function getPresetTagsFromUrl(){
  // Optional: allow pre-filling tags when opening the editor from a themed list page.
  // Supported params: ?tag=xxx or ?presetTag=xxx or ?tags=a,b,c
  try{
    const u = new URL(location.href);
    const tagsCsv = String(u.searchParams.get('tags') || '').trim();
    if(tagsCsv) return parseTags(tagsCsv);
    const one = String(u.searchParams.get('tag') || u.searchParams.get('presetTag') || '').trim();
    if(one) return parseTags(one);
  }catch(_e){}
  return [];
}

function setMsg(msg, kind=''){
  if(!statusMsg) return;
  statusMsg.textContent = msg;
  // Keep the toolbar status styling class if the status element is docked
  // into the rich editor toolbar.
  statusMsg.className = kind
    ? `small ${kind} ks-toolbar-status`
    : 'small muted ks-toolbar-status';
}

function dockArticleActionsIntoToolbar(){
  // Article editor UX: keep Save / Preview / Delete always visible by docking
  // them into the sticky rich editor toolbar.
  if(_actionsDocked) return;
  if(!rtEditor?.root) return;

  const toolbar = rtEditor.root.querySelector('.ks-editor-toolbar');
  if(!toolbar) return;

  const oldRow = els.saveBtn?.parentElement || null;
  const group = document.createElement('div');
  group.className = 'ks-toolbar-actions';

  // Move buttons (keep IDs + listeners)
  const btns = [els.saveBtn, els.previewBtn, els.deleteBtn].filter(Boolean);
  for(const b of btns){
    try{ b.classList.add('tiny'); }catch(_e){}
    group.appendChild(b);
  }

  // Move status indicator next to buttons
  if(statusMsg){
    try{ statusMsg.classList.add('ks-toolbar-status'); }catch(_e){}
    group.appendChild(statusMsg);
  }

  // Insert right after the block selector (段落/标题) so it's always visible.
  const blockSel = toolbar.querySelector('.ks-editor-select');
  if(blockSel){
    blockSel.insertAdjacentElement('afterend', group);
  }else{
    toolbar.insertBefore(group, toolbar.firstChild);
  }

  // Visual separator between actions and formatting controls
  const sep = document.createElement('span');
  sep.className = 'ks-editor-sep';
  group.insertAdjacentElement('afterend', sep);

  // Hide the old action row to avoid empty whitespace.
  if(oldRow){
    oldRow.style.display = 'none';
  }

  _actionsDocked = true;
}

function parseTags(s){
  return String(s || '')
    .split(',')
    .map(x=>x.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function splitDailyLines(value, limit){
  return String(value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean).slice(0, limit);
}

function beijingToday(){
  try{
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit',
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }catch(_e){
    return new Date().toISOString().slice(0,10);
  }
}

function setDailyMsg(message, kind='muted'){
  if(!els.dailyMsg) return;
  els.dailyMsg.className = `small ${kind}`;
  els.dailyMsg.textContent = String(message || '');
}

function updateDailyPanel(){
  const enabled = Boolean(els.dailyEnabled?.checked);
  if(els.dailyPanel) els.dailyPanel.hidden = !enabled;
  if(enabled && els.dailyDetails) els.dailyDetails.open = true;
}

async function loadDailyMetadata(supabase, articleId){
  if(!articleId || !els.dailyEnabled) return;
  const { data, error } = await supabase.from('daily_learning_cards').select('*').eq('article_id',articleId).maybeSingle();
  if(error) throw error;
  if(!data){
    els.dailyEnabled.checked = false;
    updateDailyPanel();
    return;
  }
  els.dailyEnabled.checked = true;
  updateDailyPanel();
  els.dailySpecialty.value = data.specialty || 'other';
  els.dailyDate.value = data.scheduled_date || beijingToday();
  els.dailyMinutes.value = String(data.estimated_minutes || 3);
  els.dailyObjective.value = data.learning_objective || '';
  els.dailyPoints.value = Array.isArray(data.key_points) ? data.key_points.join('\n') : '';
  els.dailyQuestion.value = data.quiz_question || '';
  els.dailyOptions.value = Array.isArray(data.quiz_options) ? data.quiz_options.join('\n') : '';
  els.dailyCorrect.value = String((Number(data.correct_option) || 0) + 1);
  els.dailyExplanation.value = data.quiz_explanation || '';
  els.dailySourceLabel.value = data.source_label || '';
  els.dailySourceUrl.value = data.source_url || '';
  els.dailyRelatedLabel.value = data.related_label || '';
  els.dailyRelatedHref.value = data.related_href || '';
  els.dailyRelatedAccess.value = data.related_access || '';
  els.dailyActive.checked = Boolean(data.active);
  setDailyMsg(data.active ? '该学习卡已在首页启用。' : '学习卡已保存，发布文章后才会向用户显示。');
}

async function saveDailyMetadata(supabase, articleId){
  if(!articleId || !els.dailyEnabled) return;
  const enabled = Boolean(els.dailyEnabled.checked);
  if(!enabled){
    const result = await supabase.rpc('save_daily_learning_card', {
      p_article_id:articleId, p_enabled:false,
    });
    if(result.error) throw result.error;
    setDailyMsg('本文未设置为“每日一学”。');
    return;
  }

  const keyPoints = splitDailyLines(els.dailyPoints?.value,5);
  const quizOptions = splitDailyLines(els.dailyOptions?.value,6);
  const correctOption = Number(els.dailyCorrect?.value || 0) - 1;
  if(keyPoints.length < 1) throw new Error('“每日一学”至少需要 1 条核心要点。');
  if(quizOptions.length < 2) throw new Error('“每日一学”至少需要 2 个答题选项。');
  if(!Number.isInteger(correctOption) || correctOption < 0 || correctOption >= quizOptions.length){
    throw new Error('正确选项序号必须对应现有选项。');
  }
  const relatedFields = [els.dailyRelatedLabel?.value,els.dailyRelatedHref?.value,els.dailyRelatedAccess?.value]
    .map(value => String(value || '').trim());
  if(relatedFields.some(Boolean) && !relatedFields.every(Boolean)){
    throw new Error('延伸学习的按钮文字、站内链接和权限标记需要同时填写。');
  }

  const result = await supabase.rpc('save_daily_learning_card', {
    p_article_id:articleId,
    p_enabled:true,
    p_specialty:String(els.dailySpecialty?.value || 'other'),
    p_learning_objective:String(els.dailyObjective?.value || '').trim() || null,
    p_key_points:keyPoints,
    p_estimated_minutes:Number(els.dailyMinutes?.value || 3),
    p_quiz_question:String(els.dailyQuestion?.value || '').trim() || null,
    p_quiz_options:quizOptions,
    p_correct_option:correctOption,
    p_quiz_explanation:String(els.dailyExplanation?.value || '').trim() || null,
    p_source_label:String(els.dailySourceLabel?.value || '').trim() || null,
    p_source_url:String(els.dailySourceUrl?.value || '').trim() || null,
    p_scheduled_date:String(els.dailyDate?.value || beijingToday()),
    p_active:currentCanPublish && Boolean(els.dailyActive?.checked),
    p_related_label:relatedFields[0] || null,
    p_related_href:relatedFields[1] || null,
    p_related_access:relatedFields[2] || null,
  });
  if(result.error) throw result.error;
  setDailyMsg(currentCanPublish && els.dailyActive?.checked ? '学习卡已保存并启用。' : '学习卡已保存，等待管理员发布。');
}

async function loadExisting(supabase, id){
  // The canonical article row contains the current draft/review body.  Prefer it
  // over content_items so an unpublished version never opens as an empty page.
  const article = await supabase.from('articles').select('*').eq('id', id).maybeSingle();
  if(article.error) throw article.error;
  if(article.data){
    loadedArticle = article.data;
    return article.data;
  }

  const c = await supabase.from('content_items').select('*').or(`id.eq.${id},legacy_article_id.eq.${id}`).maybeSingle();
  if(c?.data?.id){
    const vid = c.data.last_published_version_id;
    let v = null;
    if(vid){
      const vr = await supabase.from('content_versions').select('*').eq('id', vid).maybeSingle();
      v = vr.data || null;
    }
    loadedArticle = {
      id: c.data.legacy_article_id || c.data.id,
      title: c.data.title_zh,
      status: c.data.status,
      summary: c.data.summary_zh,
      tags: c.data.tags || [],
      author_name: c.data.author_name,
      content_html: v?.full_body || '',
      content_md: v?.full_body || '',
      published_at: c.data.published_at,
    };
    return loadedArticle;
  }
  return null;
}

async function saveArticle(){
  const supabase = await getSupabase();
  const user = await getCurrentUser();
  if(!user) throw new Error('请先登录管理员账号。');

  const profile = await getUserProfile(user.id);
  if(!currentCanEdit) throw new Error('你没有内容编辑权限。');

  const id = getId();

  const title = String(els.title?.value || '').trim();
  if(!title) throw new Error('标题不能为空。');

  const status = String(els.status?.value || 'draft');
  const pinned = Boolean(els.pinned?.checked);
  const summary = String(els.summary?.value || '').trim();
  const cover_url = String(els.cover?.value || '').trim();
  // Rich editor output
  const content_html = rtEditor ? String(rtEditor.getHtml() || '').trim() : '';
  // Keep legacy field populated (used for excerpt/share/search). We store plain text.
  const content_md = rtEditor ? String(rtEditor.getPlainText() || '').trim() : String(els.content?.value || '').trim();
  let tags = parseTags(els.tags?.value || '');
  if(els.dailyEnabled?.checked && !tags.includes('每日一学')) tags = [...tags,'每日一学'].slice(0,20);
  const author_name = String(els.authorName?.value || '').trim() || (profile?.full_name || user.email || '');

  const { data, error } = await supabase.rpc('save_article_content', {
    p_article_id: id || null,
    p_title: title,
    p_status: status,
    p_pinned: pinned,
    p_summary: summary || null,
    p_cover_url: cover_url || null,
    p_tags: tags,
    p_content_md: content_md || '',
    p_content_html: content_html || null,
    p_author_name: author_name,
  });
  if(error) throw error;

  const saved = Array.isArray(data) ? data[0] : data;
  const savedId = saved?.article_id || id;
  if(savedId && !id){
    history.replaceState({}, '', `article-editor.html?id=${encodeURIComponent(savedId)}`);
  }
  try{
    await saveDailyMetadata(supabase,savedId);
  }catch(error){
    throw new Error(`文章已保存，但“每日一学”设置未保存：${error?.message || String(error)}`);
  }
  loadedArticle = { ...(loadedArticle || {}), id: savedId, status, title, summary, cover_url, tags, content_md, content_html };
  setMsg(status === 'published' ? '已发布并生成版本。' : (status === 'in_review' ? '已提交审核。' : '草稿与版本已保存。'), 'muted');
}

async function deleteArticle(){
  const supabase = await getSupabase();
  const user = await getCurrentUser();
  if(!user) throw new Error('请先登录管理员账号。');

  const profile = await getUserProfile(user.id);
  const role = String(profile?.role || '');
  if(!isAdminRole(role)) throw new Error('你没有管理员权限。');

  const id = getId();
  if(!id) throw new Error('当前是新文章，还未保存。');

  const ok = confirm('确认删除？将做软删除（不会出现在列表/首页）。');
  if(!ok) return;

  const { error } = await supabase.from('articles').update({ deleted_at: new Date().toISOString(), status: 'archived' }).eq('id', id);
  if(error) throw error;

  setMsg('已删除（软删除）', 'muted');
  location.href = 'articles.html';
}

function preview(){
  const title = String(els.title?.value || '').trim();
  const summary = String(els.summary?.value || '').trim();
  const cover = String(els.cover?.value || '').trim();
  const content = String(els.content?.value || '');
  const richHtml = rtEditor ? String(rtEditor.getHtml() || '') : '';

  if(els.preview){
    els.preview.innerHTML = `
      ${title ? `<h2 style="margin:0 0 10px 0">${esc(title)}</h2>` : ''}
      ${cover ? `<img class="article-cover" src="${esc(cover)}" alt="cover"/>` : ''}
      ${summary ? `<div class="note" style="margin-top:10px"><b>摘要</b><div class="small muted" style="margin-top:6px">${esc(summary)}</div></div>` : ''}
      <div class="hr"></div>
      <div class="article-content ks-prose">${richHtml ? renderSafeHtml(richHtml, { mode:'article', linkify:true }) : mdToHtml(content)}</div>
    `;
  }
}

async function main(){
  const supabase = await getSupabase();

  try{
    const user = await getCurrentUser();
    if(!user){
      location.replace('login.html?next=article-editor.html');
      return;
    }

    const profile = await getUserProfile(user.id);
    const role = String(profile?.role || '');

    const editorCheck = await supabase.rpc('is_content_editor');
    if(editorCheck.error) throw editorCheck.error;
    currentCanEdit = editorCheck.data === true;
    if(!currentCanEdit){
      location.replace('index.html');
      return;
    }

    gateEl.hidden = true;
    injectEditorHTML();
    populateEls();

    const canPublish = isAdminRole(role);
    currentCanPublish = canPublish;
    if(!canPublish){
      els.status?.querySelectorAll('option').forEach(option => {
        if(!['draft','in_review'].includes(option.value)) option.remove();
      });
      if(els.pinned){
        els.pinned.checked = false;
        els.pinned.disabled = true;
        if(els.pinned.parentElement) els.pinned.parentElement.hidden = true;
      }
      if(els.deleteBtn) els.deleteBtn.hidden = true;
    }
    if(els.dailyActiveWrap) els.dailyActiveWrap.hidden = !canPublish;
    if(els.dailyDate && !els.dailyDate.value) els.dailyDate.value = beijingToday();
    els.dailyEnabled?.addEventListener('change',updateDailyPanel);
    updateDailyPanel();

    const id = getId();
    if(id){
      setMsg('加载文章中…', 'muted');
      const a = await loadExisting(supabase, id);
      if(!a) throw new Error('文章不存在或已删除。');
      if(!canPublish && !['draft','in_review'].includes(String(a.status || ''))){
        throw new Error('内容编辑只能修改自己的草稿或待审内容。');
      }

      els.title.value = a.title || '';
      els.status.value = a.status || 'draft';
      els.pinned.checked = Boolean(a.pinned);
      els.summary.value = a.summary || '';
      els.cover.value = a.cover_url || '';
      els.tags.value = Array.isArray(a.tags) ? a.tags.join(', ') : '';
      els.authorName.value = a.author_name || '';
      els.content.value = a.content_md || '';

      try{
        await loadDailyMetadata(supabase,a.id);
      }catch(error){
        setDailyMsg('每日学习设置暂时无法读取，请先确认数据库迁移已完成。','err');
        console.warn('daily learning metadata load failed',error);
      }

      // Try to infer template selection from tags (no auto-apply on existing articles)
      try{
        const tagsCsv = Array.isArray(a.tags) ? a.tags.join(',') : String(els.tags?.value || '');
        const tplKey = getTemplateKeyFromTags(tagsCsv);
        if(tplKey && els.tplSelect) els.tplSelect.value = tplKey;
      }catch(_e){}

      setMsg('已载入，可编辑。', 'muted');
      preview();
    }else{
      // New article defaults
      els.status.value = 'draft';
      els.pinned.checked = false;
      els.authorName.value = profile?.full_name || '';

      // Prefill tags if caller provides ?tag=xxx (e.g. notes page)
      try{
        const preset = getPresetTagsFromUrl();
        if(preset.length && !String(els.tags?.value || '').trim()){
          els.tags.value = preset.join(', ');
        }

        // If it's a themed entry point (e.g. notes page), preselect template and auto-insert skeleton.
        const tplKey = getTemplateKeyFromTags(preset);
        if(tplKey && els.tplSelect) els.tplSelect.value = tplKey;
        if(tplKey && !String(els.content?.value || '').trim()){
          els.content.value = ARTICLE_TEMPLATES[tplKey]?.md || '';
        }
      }catch(_e){}

      setMsg('新文章（未保存）。', 'muted');
    }

    const updateDailyActivationState = ()=>{
      if(!els.dailyActive) return;
      const published = String(els.status?.value || '') === 'published';
      els.dailyActive.disabled = !currentCanPublish || !published;
      if(!published) els.dailyActive.checked = false;
      if(currentCanPublish && els.dailyEnabled?.checked && !published){
        setDailyMsg('先保存草稿或提交审核；文章由管理员发布后，学习卡才能上线。');
      }
    };
    els.status?.addEventListener('change',updateDailyActivationState);
    els.dailyEnabled?.addEventListener('change',updateDailyActivationState);
    updateDailyActivationState();

    // Mount the Word-like rich editor over the content textarea.
    // - Existing articles: prefer `content_html`, otherwise migrate from legacy markdown.
    // - New articles: if textarea was prefilled with a template, migrate it into the editor.
    if(!rtEditor && els.content){
      rtEditor = mountKSEditor(els.content, {
        mode: 'article',
        placeholder: '在这里写正文…',
        syncToTextarea: false,
      });
    }
    if(rtEditor){
      const html = String(loadedArticle?.content_html || '').trim();
      if(html){
        rtEditor.setHtml(html);
      }else{
        const legacy = String(els.content?.value || '');
        rtEditor.setHtml(legacy ? mdToHtml(legacy) : '');
      }

      // Keep Save/Preview/Delete visible while scrolling long articles.
      try{ dockArticleActionsIntoToolbar(); }catch(_e){}
      try{ preview(); }catch(_e){}
    }

    // Template & auto-format actions
    els.tplApplyBtn?.addEventListener('click', ()=>{
      try{ applySelectedTemplate(); }catch(e){ setMsg(e?.message || String(e), 'err'); }
    });
    els.autoFormatBtn?.addEventListener('click', ()=>{
      try{
        if(rtEditor){
          rtEditor.clean();
          setMsg('已完成排版。', 'muted');
          preview();
          return;
        }
        const cur = String(els.content?.value || '');
        const next = formatMarkdown(cur);
        els.content.value = next;
        setMsg('已完成排版。', 'muted');
        preview();
      }catch(e){
        setMsg(e?.message || String(e), 'err');
      }
    });

    // Keyboard shortcut: Ctrl/⌘ + Shift + F to format / clean
    document.addEventListener('keydown', (e)=>{
      if(!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
      if(String(e.key || '').toLowerCase() !== 'f') return;
      if(rtEditor){
        if(document.activeElement && document.activeElement !== rtEditor.surface) return;
      }else{
        if(document.activeElement && document.activeElement !== els.content) return;
      }
      e.preventDefault();
      try{
        if(rtEditor){
          rtEditor.clean();
          setMsg('已完成排版。', 'muted');
          preview();
          return;
        }
        const cur = String(els.content?.value || '');
        const next = formatMarkdown(cur);
        els.content.value = next;
        setMsg('已完成排版。', 'muted');
        preview();
      }catch(_err){}
    });

    els.saveBtn?.addEventListener('click', async ()=>{
      try{
        setMsg('保存中…', 'muted');
        await saveArticle();
        setMsg('保存成功。', 'muted');
      }catch(e){
        setMsg(e?.message || String(e), 'err');
      }
    });

    els.previewBtn?.addEventListener('click', preview);

    // Media uploader actions
    els.uploadInsertBtn?.addEventListener('click', async ()=>{
      try{
        const file = els.mediaFile?.files?.[0];
        if(!file){ setUploadMsg('请先选择一个图片 / MP4 / PDF / Word 文件。', 'err'); return; }
        setUploadMsg('上传中…', 'muted');
        const url = await uploadArticleMedia(file);
        // Insert into rich editor if available; otherwise fall back to legacy Markdown snippets.
        if(rtEditor){
          let html = '';
          const safe = esc(url);
          if(isMp4(file)){
            html = `<div class="article-video"><video controls src="${safe}"></video></div>`;
          }else if(isPdf(file)){
            html = `<p><a class="file-chip" data-act="article-download" target="_blank" rel="noopener noreferrer" href="${safe}">📄 打开 PDF</a></p>`;
          }else if(isDoc(file)){
            const name = esc(file.name || 'Word 附件');
            html = `<p><a class="file-chip" data-act="article-download" target="_blank" rel="noopener noreferrer" href="${safe}">📎 下载 Word：${name}</a></p>`;
          }else{
            html = `<figure class="ks-figure"><img src="${safe}" alt="图片"/></figure>`;
          }
          rtEditor.insertHtml(html);
        }else{
          let snippet;
          if(isMp4(file)){
            snippet = `\n{{video:${url}}}\n`;
          }else if(isPdf(file)){
            snippet = `\n{{pdf:${url}}}\n`;
          }else if(isDoc(file)){
            const name = safeAlt(file.name || 'Word 附件');
            snippet = `\n[附件：${name}](${url})\n`;
          }else{
            snippet = `\n![图片](${url})\n`;
          }
          insertAtCursor(els.content, snippet);
        }
        els.mediaFile.value = '';
        setUploadMsg('已上传并插入正文。', 'muted');
        preview();
      }catch(e){
        setUploadMsg(e?.message || String(e), 'err');
      }
    });

    els.uploadCoverBtn?.addEventListener('click', async ()=>{
      try{
        const file = els.mediaFile?.files?.[0];
        if(!file){ setUploadMsg('请先选择一张图片。', 'err'); return; }
        if(isMp4(file)){ setUploadMsg('封面仅支持图片，请选择图片文件。', 'err'); return; }
        setUploadMsg('上传中…', 'muted');
        const url = await uploadArticleMedia(file);
        els.cover.value = url;
        els.mediaFile.value = '';
        setUploadMsg('封面已更新。别忘了点击"保存"。', 'muted');
      }catch(e){
        setUploadMsg(e?.message || String(e), 'err');
      }
    });

    // Paste / drag&drop upload (图片 / MP4)
    // - 粘贴截图到「正文」会自动上传并插入：![图片](url)
    // - 拖拽图片/MP4 到「正文」同上（MP4 插入 {{video:url}}）
    // - 粘贴/拖拽图片到「封面 URL」会自动上传并回填 URL
    bindPasteAndDrop();

    function bindPasteAndDrop(){
      const isImageFile = (file)=>{
        const t = (file?.type || '').toLowerCase();
        if(t.startsWith('image/')) return true;
        const name = (file?.name || '').toLowerCase();
        return /\.(png|jpe?g|webp|gif|svg)$/.test(name);
      };

      const isSupportedForContent = (file)=> isImageFile(file) || isMp4(file) || isPdf(file) || isDoc(file);

      const handleFile = async (file, target)=>{
        if(!file || !(file instanceof File) || file.size <= 0) return;
        if(target === 'cover'){
          if(!isImageFile(file)){
            setUploadMsg('封面仅支持图片（png/jpg/webp/gif/svg）。', 'err');
            return;
          }
        }else{
          if(!isSupportedForContent(file)) return;
        }

        try{
          setUploadMsg('上传中…', 'muted');
          const url = await uploadArticleMedia(file);
          if(target === 'cover'){
            els.cover.value = url;
            setUploadMsg('封面已更新。别忘了点击"保存"。', 'muted');
            return;
          }
          if(rtEditor){
            const safe = esc(url);
            let html = '';
            if(isMp4(file)){
              html = `<div class="article-video"><video controls src="${safe}"></video></div>`;
            }else if(isPdf(file)){
              html = `<p><a class="file-chip" data-act="article-download" target="_blank" rel="noopener noreferrer" href="${safe}">📄 打开 PDF</a></p>`;
            }else if(isDoc(file)){
              const name = esc(file.name || 'Word 附件');
              html = `<p><a class="file-chip" data-act="article-download" target="_blank" rel="noopener noreferrer" href="${safe}">📎 下载 Word：${name}</a></p>`;
            }else{
              html = `<figure class="ks-figure"><img src="${safe}" alt="图片"/></figure>`;
            }
            rtEditor.insertHtml(html);
          }else{
            let snippet;
            if(isMp4(file)){
              snippet = `\n{{video:${url}}}\n`;
            }else if(isPdf(file)){
              snippet = `\n{{pdf:${url}}}\n`;
            }else if(isDoc(file)){
              const name = safeAlt(file.name || 'Word 附件');
              snippet = `\n[附件：${name}](${url})\n`;
            }else{
              snippet = `\n![图片](${url})\n`;
            }
            insertAtCursor(els.content, snippet);
          }
          preview();
          setUploadMsg('已上传并插入正文。', 'muted');
        }catch(e){
          setUploadMsg(e?.message || String(e), 'err');
        }
      };

      const bindTarget = (el, target, hoverEl = el)=>{
        if(!el) return;

        // Paste
        el.addEventListener('paste', (e)=>{
          const items = e.clipboardData?.items;
          if(!items) return;
          const item = Array.from(items).find(it=> it.kind === 'file');
          if(!item) return;
          const file = item.getAsFile();
          if(!file) return;
          const ok = (target === 'cover') ? isImageFile(file) : isSupportedForContent(file);
          if(!ok) return;
          e.preventDefault();
          handleFile(file, target);
        });

        // Drag & drop
        el.addEventListener('dragover', (e)=>{ e.preventDefault(); hoverEl.classList.add('drop-hover'); });
        el.addEventListener('dragleave', ()=> hoverEl.classList.remove('drop-hover'));
        el.addEventListener('drop', (e)=>{
          e.preventDefault();
          hoverEl.classList.remove('drop-hover');
          const file = e.dataTransfer?.files?.[0];
          if(!file) return;
          const ok = (target === 'cover') ? isImageFile(file) : isSupportedForContent(file);
          if(!ok) return;
          handleFile(file, target);
        });
      };

      // Rich editor: bind to surface but show hover state on the editor root.
      const contentPasteEl = rtEditor ? rtEditor.surface : els.content;
      const contentHoverEl = rtEditor ? rtEditor.root : els.content;
      bindTarget(contentPasteEl, 'content', contentHoverEl);
      bindTarget(els.cover, 'cover');
    }

    els.deleteBtn?.addEventListener('click', async ()=>{
      try{
        await deleteArticle();
      }catch(e){
        setMsg(e?.message || String(e), 'err');
      }
    });

  }catch(e){
    location.replace('login.html?next=article-editor.html');
  }
}

main();
