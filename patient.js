import { supabase } from "/lib/supabase-client.js";
import { qs, toast, fmtDate, daysLeft, escapeHtml } from "/lib/utils.js";

// Patient page never needs Supabase auth session detection —
// disabling it prevents Supabase from misreading ?pt= as an auth token
// and redirecting to the site root.
const sb = supabase({ detectSessionInUrl: false, persistSession: false, autoRefreshToken: false });

const el = {
  ctxSub: qs("#ctxSub"),
  ctxBox: qs("#ctxBox"),
  visitDate: qs("#visitDate"),
  sbp: qs("#sbp"),
  dbp: qs("#dbp"),
  scr: qs("#scr"),
  scrUnit: qs("#scrUnit"),
  upcr: qs("#upcr"),
  upcrUnit: qs("#upcrUnit"),
  egfr: qs("#egfr"),
  notes: qs("#notes"),
  btnSubmit: qs("#btnSubmit"),
  btnRefresh: qs("#btnRefresh"),
  submitHint: qs("#submitHint"),
  qcBox: qs("#qcBox"),
  receiptBox: qs("#receiptBox"),
  visitsBox: qs("#visitsBox"),
};

let token = null;
let ctx = null;

function getToken(){
  // Hash-based: /followup#TOKEN — token never touches server or Supabase auth
  const h = window.location.hash;
  if (h && h.length > 1) {
    const tok = decodeURIComponent(h.slice(1));
    if (tok) return tok;
  }
  // Path-based fallback: /p/TOKEN
  const path = window.location.pathname || "";
  const m = path.match(/\/p\/([^\/]+)$/);
  if (m && m[1]) return m[1];
  // Query param fallbacks (?pt= new, ?token= legacy)
  const q = new URLSearchParams(window.location.search);
  return q.get("pt") || q.get("token");
}

function ckdepi2021(scr_mg_dl, age, sex){
  if (!scr_mg_dl || !age || !sex) return null;
  const isF = String(sex).toUpperCase() === "F";
  const k = isF ? 0.7 : 0.9;
  const alpha = isF ? -0.241 : -0.302;
  const min = Math.min(scr_mg_dl / k, 1);
  const max = Math.max(scr_mg_dl / k, 1);
  let egfr = 142 * Math.pow(min, alpha) * Math.pow(max, -1.200) * Math.pow(0.9938, age);
  if (isF) egfr *= 1.012;
  return egfr;
}

function toInternalScrUmol(){
  const raw = el.scr.value ? Number(el.scr.value) : null;
  if (raw === null || Number.isNaN(raw)) return null;
  return el.scrUnit.value === "mgdl" ? raw * 88.4 : raw;
}

function toInternalUpcrMgG(){
  const raw = el.upcr.value ? Number(el.upcr.value) : null;
  if (raw === null || Number.isNaN(raw)) return null;
  return el.upcrUnit.value === "gg" ? raw * 1000 : raw;
}

function detectPII(s){
  if (!s) return false;
  const v = String(s).trim();
  if (!v) return false;
  const rules = [
    /(?:^|\D)1[3-9][0-9]{9}(?:\D|$)/, // CN mobile
    /(?:^|\D)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9xX](?:\D|$)/, // CN ID
    /(MRN|病案号|住院号|门诊号|姓名|身份证|手机号|电话)/i,
    /\d{8,}/,
  ];
  return rules.some((r) => r.test(v));
}

function computeEgfr(){
  if (!ctx) return;
  const scr_umol = toInternalScrUmol();
  if (!scr_umol) { el.egfr.value = ""; return; }
  const scr_mg = scr_umol / 88.4;
  const year = Number(ctx.birth_year);
  const vdate = el.visitDate.value ? new Date(el.visitDate.value) : null;
  const age = (vdate && year) ? (vdate.getFullYear() - year) : null;
  const egfr = ckdepi2021(scr_mg, age, ctx.sex);
  if (!egfr || Number.isNaN(egfr)) { el.egfr.value = ""; return; }
  el.egfr.value = egfr.toFixed(1);
}

function getQcState(){
  const visitDate = el.visitDate.value;
  const sbp = el.sbp.value ? Number(el.sbp.value) : null;
  const dbp = el.dbp.value ? Number(el.dbp.value) : null;
  const scr_umol = toInternalScrUmol();
  const upcr_mgg = toInternalUpcrMgG();
  const notes = el.notes.value || "";

  const missing = [];
  if (!visitDate) missing.push("日期");
  if (sbp === null || Number.isNaN(sbp)) missing.push("SBP");
  if (dbp === null || Number.isNaN(dbp)) missing.push("DBP");
  if (scr_umol === null || Number.isNaN(scr_umol)) missing.push("Scr");
  if (upcr_mgg === null || Number.isNaN(upcr_mgg)) missing.push("UPCR");

  const warnings = [];
  if (sbp !== null && (sbp < 70 || sbp > 220)) warnings.push(`SBP=${sbp} 超出常见范围(70-220)`);
  if (dbp !== null && (dbp < 40 || dbp > 130)) warnings.push(`DBP=${dbp} 超出常见范围(40-130)`);
  if (scr_umol !== null && (scr_umol < 20 || scr_umol > 2000)) warnings.push(`Scr=${scr_umol.toFixed(1)} μmol/L 超出常见范围(20-2000)`);
  if (upcr_mgg !== null && (upcr_mgg < 0 || upcr_mgg > 10000)) warnings.push(`UPCR=${upcr_mgg.toFixed(2)} mg/g 超出常见范围(0-10000)`);

  const piiHit = detectPII(ctx?.patient_code || "") || detectPII(notes);
  const status = (missing.length === 0 && !piiHit) ? "达标" : "未达标";

  return { visitDate, sbp, dbp, scr_umol, upcr_mgg, notes, missing, warnings, piiHit, status };
}

function renderQc(){
  const q = getQcState();
  let html = `<b>本次随访：${q.status}</b>`;
  if (q.missing.length) html += `<div style="margin-top:6px;color:#b91c1c">缺失：${escapeHtml(q.missing.join(" / "))}</div>`;
  if (q.piiHit) html += `<div style="margin-top:6px;color:#b91c1c">检测到疑似 PII（patient_code 或备注），已禁止提交。</div>`;
  if (q.warnings.length) html += `<div style="margin-top:6px;color:#92400e">QC 警告：${escapeHtml(q.warnings.join("；"))}</div>`;
  if (!q.missing.length && !q.piiHit && !q.warnings.length) html += `<div style="margin-top:6px;color:#166534">核心四项完整，未见明显异常。</div>`;
  el.qcBox.innerHTML = html;
}

function renderReceipt(row, qcWarnings){
  if (!row) return;
  const payload = JSON.stringify({ rid: row.visit_id, t: row.receipt_token, exp: row.receipt_expires_at });
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(payload)}`;
  el.receiptBox.style.display = "block";
  el.receiptBox.innerHTML = `
    <div><b>提交回执</b></div>
    <div class="small" style="margin-top:6px">record_id：<code>${escapeHtml(row.visit_id)}</code></div>
    <div class="small">服务器时间：${escapeHtml(fmtDate(row.server_time))}</div>
    <div class="small">摘要：${escapeHtml(el.visitDate.value)} · BP ${escapeHtml(el.sbp.value)}/${escapeHtml(el.dbp.value)} · Scr ${escapeHtml((toInternalScrUmol()||"").toString())} μmol/L · UPCR ${escapeHtml((toInternalUpcrMgG()||"").toString())} mg/g</div>
    <div class="small">QC：${qcWarnings.length ? `<span style="color:#92400e">${escapeHtml(qcWarnings.join('；'))}</span>` : `<span style="color:#166534">无警告</span>`}</div>
    <div class="small">校验 token 有效期：至 ${escapeHtml(fmtDate(row.receipt_expires_at))}</div>
    <img src="${qr}" alt="receipt qr" style="margin-top:8px;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#fff"/>
    <div class="small muted">二维码仅包含 record_id + 短期校验 token，不含医学值和身份信息。</div>
  `;
}

async function loadContext(){
  el.ctxSub.textContent = "加载中…";
  const { data, error } = await sb.rpc("patient_get_context", { p_token: token });
  if (error){
    console.error("patient_get_context error:", error);
    el.ctxSub.textContent = "链接验证失败";
    el.ctxBox.innerHTML = `<div class='muted small' style='color:#dc2626'>错误：${escapeHtml(error.message || JSON.stringify(error))}。<br>请联系中心研究人员重新生成随访链接。</div>`;
    el.btnSubmit.disabled = true;
    return;
  }
  ctx = data?.[0] || null;
  if (!ctx){
    el.ctxSub.textContent = "链接无效或已过期";
    el.ctxBox.innerHTML = "<div class='muted small'>该链接已失效（可能已被撤销或过期）。请联系中心研究人员获取新的随访链接。</div>";
    el.btnSubmit.disabled = true;
    return;
  }

  const left = ctx.trial_expires_at ? daysLeft(ctx.trial_expires_at) : null;
  let trialTxt = "未配置";
  let trialBadge = "";
  if (left !== null){
    if (left >= 0){
      trialTxt = `试用中：剩余 ${left} 天（到期 ${fmtDate(ctx.trial_expires_at)}）`;
      trialBadge = "<span class='badge ok'>可录入</span>";
    } else {
      trialTxt = `已到期：项目只读（${fmtDate(ctx.trial_expires_at)}）`;
      trialBadge = "<span class='badge bad'>只读</span>";
      el.btnSubmit.disabled = true;
      el.submitHint.textContent = "提示：项目试用已到期，当前为只读。";
    }
  }

  el.ctxSub.textContent = `${ctx.project_name} · 中心=${ctx.center_code} · 模块=${ctx.module}`;
  el.ctxBox.innerHTML = `
    <div>项目</div><div><b>${escapeHtml(ctx.project_name)}</b></div>
    <div>中心</div><div><code>${escapeHtml(ctx.center_code)}</code></div>
    <div>模块</div><div><code>${escapeHtml(ctx.module)}</code></div>
    <div>研究编号</div><div><b>${escapeHtml(ctx.patient_code)}</b></div>
    <div>试用状态</div><div>${trialBadge} <span class="muted small">${escapeHtml(trialTxt)}</span></div>
  `;

  if (!el.visitDate.value){
    el.visitDate.value = new Date().toISOString().slice(0,10);
  }
  computeEgfr();
  renderQc();
}

async function submitVisit(){
  if (!ctx) return;
  const q = getQcState();

  if (q.missing.length){
    toast(`核心四项缺失：${q.missing.join('/')}`);
    renderQc();
    return;
  }
  if (q.piiHit){
    toast("检测到疑似 PII，已禁止提交");
    renderQc();
    return;
  }

  if (q.warnings.length){
    const ok = window.confirm(`检测到数值异常：\n- ${q.warnings.join("\n- ")}\n\n确认仍要提交吗？`);
    if (!ok) return;
  }

  const payload = {
    p_token: token,
    p_visit_date: q.visitDate,
    p_sbp: q.sbp,
    p_dbp: q.dbp,
    p_scr_umol_l: q.scr_umol,
    p_upcr: q.upcr_mgg,
    p_egfr: el.egfr.value ? Number(el.egfr.value) : null,
    p_notes: q.notes ? q.notes.slice(0, 500) : null,
  };

  el.btnSubmit.disabled = true;
  try{
    const { data, error } = await sb.rpc("patient_submit_visit_v2", payload);
    if (error) throw error;
    const row = data?.[0];
    toast("已提交随访");
    el.notes.value = "";
    renderReceipt(row, q.warnings);
    renderQc();
    await loadVisits();
  }catch(e){
    console.error(e);
    const msg = e?.message || String(e);
    if (msg.includes("pii_detected_blocked")){
      toast("疑似 PII，提交已被系统阻止");
    }else if (msg.includes("missing_core_fields")){
      toast("核心四项缺失，提交已被系统阻止");
    }else if (msg.includes("rate_limited") || msg.includes("frozen")){
      toast("提交过于频繁，token 已自动冻结，请联系管理员");
    }else{
      toast("提交失败：" + msg);
    }
  }finally{
    el.btnSubmit.disabled = false;
  }
}

async function loadVisits(){
  el.visitsBox.innerHTML = "<div class='muted small'>加载中…</div>";
  const { data, error } = await sb.rpc("patient_list_visits", { p_token: token, p_limit: 30 });
  if (error){
    console.error(error);
    el.visitsBox.innerHTML = "<div class='muted small'>读取失败</div>";
    return;
  }
  const rows = data || [];
  if (!rows.length){
    el.visitsBox.innerHTML = "<div class='muted small'>暂无随访记录</div>";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td>${escapeHtml(r.visit_date||"")}</td>
      <td>${escapeHtml(r.sbp||"")}/${escapeHtml(r.dbp||"")}</td>
      <td>${escapeHtml(r.scr_umol_l||"")}</td>
      <td>${escapeHtml(r.upcr||"")}</td>
      <td>${escapeHtml(r.egfr||"")}</td>
      <td class="muted small">${escapeHtml((r.notes||"").slice(0,60))}</td>
    </tr>
  `).join("");
  el.visitsBox.innerHTML = `
    <table class="table">
      <thead><tr><th>日期</th><th>BP</th><th>Scr(μmol/L)</th><th>UPCR(mg/g)</th><th>eGFR</th><th>备注</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
}

function bind(){
  el.btnSubmit.addEventListener("click", submitVisit);
  el.btnRefresh.addEventListener("click", loadVisits);
  [el.scr, el.scrUnit, el.upcr, el.upcrUnit, el.sbp, el.dbp, el.visitDate, el.notes].forEach((n)=>{
    n.addEventListener("input", ()=>{ computeEgfr(); renderQc(); });
    n.addEventListener("change", ()=>{ computeEgfr(); renderQc(); });
  });
}

async function main(){
  token = getToken();
  if (!token){
    el.ctxSub.textContent = "缺少 token";
    el.ctxBox.innerHTML = "<div class='muted small'>请使用中心提供的随访链接打开本页。</div>";
    el.btnSubmit.disabled = true;
    return;
  }
  bind();
  await loadContext();
  await loadVisits();
}

main();
