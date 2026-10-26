import { supabase } from "/lib/supabase-client.js";
import { qs, qsa, toast, toCsv, downloadCsvUtf8Bom, escapeCsv, fmtDate, daysLeft, humanNumber, escapeHtml } from "/lib/utils.js";
import { throttle } from "/lib/rate-limit.js";
import { validatePassword } from "/lib/password-strength.js";

const sb = supabase();

const rlLogin    = throttle("login",    { maxAttempts: 10, windowMs: 15 * 60_000, message: "登录尝试过于频繁" });
const rlRegister = throttle("register", { maxAttempts: 5,  windowMs: 15 * 60_000, message: "注册请求过于频繁" });
const rlReset    = throttle("reset",    { maxAttempts: 5,  windowMs: 15 * 60_000, message: "密码重置请求过于频繁" });

const el = {
  loginCard: qs("#loginCard"),
  appCard: qs("#appCard"),
  email: qs("#email"),
  password: qs("#password"),
  confirmPwdLabel: qs("#confirmPwdLabel"),
  confirmPwd: qs("#confirmPwd"),
  btnSendLink: qs("#btnSendLink"),
  btnRegister: qs("#btnRegister"),
  emailLabel: qs("#emailLabel"),
  btnResetPwd: qs("#btnResetPwd"),
  btnSetNewPwd: qs("#btnSetNewPwd"),
  btnSignOut: qs("#btnSignOut"),
  loginHint: qs("#loginHint"),

  projName: qs("#projName"),
  projCenter: qs("#projCenter"),
  projModule: qs("#projModule"),
  projDesc: qs("#projDesc"),
  btnCreateProject: qs("#btnCreateProject"),
  projectsList: qs("#projectsList"),
  projectMeta: qs("#projectMeta"),
  trialBadge:  qs("#trialBadge"),
  upgradeBtn:  qs("#upgradeBtn"),

  patCode: qs("#patCode"),
  patSex: qs("#patSex"),
  patBirthYear: qs("#patBirthYear"),
  patBaselineDate: qs("#patBaselineDate"),
  patBaselineScr: qs("#patBaselineScr"),
  patBaselineUpcr: qs("#patBaselineUpcr"),
  iganPathBox: qs("#iganPathBox"),
  biopsyDate: qs("#biopsyDate"),
  mestM: qs("#mestM"),
  mestE: qs("#mestE"),
  mestS: qs("#mestS"),
  mestT: qs("#mestT"),
  mestC: qs("#mestC"),
  lnPathBox: qs("#lnPathBox"),
  lnBiopsyDate: qs("#lnBiopsyDate"),
  lnClass: qs("#lnClass"),
  lnAI: qs("#lnAI"),
  lnCI: qs("#lnCI"),
  lnPodocytopathy: qs("#lnPodocytopathy"),
  rctArm: qs("#rctArm"),
  rctRandomId: qs("#rctRandomId"),
  rctDate: qs("#rctDate"),
  btnCreatePatient: qs("#btnCreatePatient"),
  patientsList: qs("#patientsList"),

  tokenPatientCode: qs("#tokenPatientCode"),
  tokenDays: qs("#tokenDays"),
  tokenSingleUse: qs("#tokenSingleUse"),
  btnGenToken: qs("#btnGenToken"),
  tokenOut: qs("#tokenOut"),
  issuePanel: qs("#issuePanel"),
  issueSummary: qs("#issueSummary"),
  issueList: qs("#issueList"),
  btnLoadIssues: qs("#btnLoadIssues"),


  // Optional extra data entry
  varPatientCode: qs("#varPatientCode"),
  varTestDate: qs("#varTestDate"),
  varTestName: qs("#varTestName"),
  varGene: qs("#varGene"),
  varVariant: qs("#varVariant"),
  varHgvsC: qs("#varHgvsC"),
  varHgvsP: qs("#varHgvsP"),
  varZygosity: qs("#varZygosity"),
  varClass: qs("#varClass"),
  varLabName: qs("#varLabName"),
  varNotes: qs("#varNotes"),
  btnAddVariant: qs("#btnAddVariant"),
  variantsPreview: qs("#variantsPreview"),

  labPatientCode: qs("#labPatientCode"),
  labDate: qs("#labDate"),
  labTestCode: qs("#labTestCode"),
  labName: qs("#labName"),
  labCustomName: qs("#labCustomName"),
  labCustomUnit: qs("#labCustomUnit"),
  labValue: qs("#labValue"),
  labUnit: qs("#labUnit"),
  labStdValue: qs("#labStdValue"),
  labQcReasonCol: qs("#labQcReasonCol"),
  labQcReason: qs("#labQcReason"),
  labHint: qs("#labHint"),
  btnAddLab: qs("#btnAddLab"),
  labsPreview: qs("#labsPreview"),
  projCustomLabsPanel: qs("#projCustomLabsPanel"),
  projCustomLabsList: qs("#projCustomLabsList"),

  medPatientCode: qs("#medPatientCode"),
  medName: qs("#medName"),
  medClass: qs("#medClass"),
  medDose: qs("#medDose"),
  medStart: qs("#medStart"),
  medEnd: qs("#medEnd"),
  btnAddMed: qs("#btnAddMed"),
  medsPreview: qs("#medsPreview"),

  // Events
  evtPatientCode: qs("#evtPatientCode"),
  evtType: qs("#evtType"),
  evtDate: qs("#evtDate"),
  evtNotes: qs("#evtNotes"),
  btnAddEvent: qs("#btnAddEvent"),
  eventsPreview: qs("#eventsPreview"),

  btnExportBaseline: qs("#btnExportBaseline"),
  btnExportVisits: qs("#btnExportVisits"),
  btnExportLabs: qs("#btnExportLabs"),
  btnExportMeds: qs("#btnExportMeds"),
  btnExportVariants: qs("#btnExportVariants"),
  btnExportEvents: qs("#btnExportEvents"),

  btnPaperPack: qs("#btnPaperPack"),
  btnCreateSnapshot: qs("#btnCreateSnapshot"),
  btnPaperPackWithSnapshot: qs("#btnPaperPackWithSnapshot"),
  btnRefreshSnapshots: qs("#btnRefreshSnapshots"),
  snapshotOut: qs("#snapshotOut"),
  snapshotsList: qs("#snapshotsList"),

  // Import
  importType: qs("#importType"),
  btnDownloadTemplate: qs("#btnDownloadTemplate"),
  importFile: qs("#importFile"),
  importPreview: qs("#importPreview"),
  importSummary: qs("#importSummary"),
  importTable: qs("#importTable"),
  btnConfirmImport: qs("#btnConfirmImport"),
  btnCancelImport: qs("#btnCancelImport"),
  importProgress: qs("#importProgress"),

  // Header auth controls
  headerUserEmail: qs("#headerUserEmail"),
  btnHeaderSignOut: qs("#btnHeaderSignOut"),

  // Profile
  profileCard: qs("#profileCard"),
  profileStatus: qs("#profileStatus"),
  profName: qs("#profName"),
  profHospital: qs("#profHospital"),
  profDept: qs("#profDept"),
  profPlan: qs("#profPlan"),
  profContact: qs("#profContact"),
  profNotes: qs("#profNotes"),
  btnSaveProfile: qs("#btnSaveProfile"),

  // Contract apply (user side)
  contractStatus: qs("#contractStatus"),
  contractApplyForm: qs("#contractApplyForm"),
  contractPlan: qs("#contractPlan"),
  contractWechat: qs("#contractWechat"),
  contractNote: qs("#contractNote"),
  btnApplyContract: qs("#btnApplyContract"),

  // Admin panel
  adminCard: qs("#adminCard"),
  adminContractsBadge: qs("#adminContractsBadge"),
  adminContracts: qs("#adminContracts"),
  btnAdminLoadContracts: qs("#btnAdminLoadContracts"),
  adminOrdersBadge: qs("#adminOrdersBadge"),
  adminOrders: qs("#adminOrders"),
  btnAdminLoadOrders: qs("#btnAdminLoadOrders"),
  adminSearchEmail: qs("#adminSearchEmail"),
  btnAdminSearch: qs("#btnAdminSearch"),
  adminResults: qs("#adminResults"),
};

let session = null;
let user = null;
let isPlatformAdmin = false;

let projects = [];
let selectedProject = null;
let patients = [];
let labCatalog = [];         // [{code, name_cn, module, is_core, standard_unit, display_note}]
let unitMap = {};            // { code: [{unit_symbol, is_standard, multiplier}] }
let projectCustomLabs = [];  // [{id, name, unit}] — per-project custom lab catalog

// ── PII 检测（前端层，与后端 _contains_pii 逻辑保持同步） ────────────────────
function containsPII(text) {
  if (!text) return false;
  return (
    /1[3-9][0-9]{9}/.test(text)                             // 手机号
    || /[1-9][0-9]{5}(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx]/.test(text) // 身份证
    || /(住院号|病案号|门诊号|病历号|床号|mrn|admiss)[^a-z0-9]{0,3}[0-9]{3,}/i.test(text)
    || /(姓名|患者姓名|病人|name\s*[:：])\s*[\u4e00-\u9fa5]{2,4}/.test(text)
    || /[0-9]{8,}/.test(text)
    || /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)
  );
}

function assertNoPII(text, fieldLabel) {
  if (containsPII(text)) {
    throw new Error(
      `「${fieldLabel}」中检测到疑似个人身份信息（手机号/身份证/住院号等）。\n`
      + `请删除后重新保存。系统禁止录入任何可识别个人信息（PII）。`
    );
  }
}

function setLoginHint(msg){ el.loginHint.textContent = msg || ""; }

function setBusy(btn, busy){
  if (!btn) return;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.disabled = !!busy;
  btn.textContent = busy ? "处理中…" : btn.dataset.label;
}

function getInputEmail(){
  return (el.email?.value || "").trim().toLowerCase();
}

function renderTrialBadge(p){
  const hide = () => {
    el.trialBadge.style.display = "none";
    if (el.upgradeBtn) el.upgradeBtn.style.display = "none";
  };

  // ── 管理员永久使用（优先于项目检查）──────────────────────────────
  if (isPlatformAdmin) {
    el.trialBadge.className = "badge ok";
    el.trialBadge.textContent = "管理员（永久）";
    el.trialBadge.style.display = "inline-flex";
    if (el.upgradeBtn) el.upgradeBtn.style.display = "none";
    return;
  }

  if (!p){ hide(); return; }

  const exp          = p.trial_expires_at;
  const grace        = p.trial_grace_until;
  const subPlan      = p.subscription_plan || "trial";
  const subUntil     = p.subscription_active_until;
  const WARN_DAYS    = 14;   // show upgrade CTA this many days before trial end

  // Build upgrade href from CONFIG
  const upgradeHref =
    (window.CONFIG?.UPGRADE_URL) ||
    (window.CONFIG?.UPGRADE_EMAIL ? `mailto:${window.CONFIG.UPGRADE_EMAIL}?subject=KidneySphere升级订阅` : null);

  const showUpgrade = (label = "立即升级") => {
    if (!el.upgradeBtn) return;
    if (upgradeHref){
      el.upgradeBtn.href = upgradeHref;
      el.upgradeBtn.textContent = label;
      el.upgradeBtn.style.display = "inline-flex";
    } else {
      // No link configured — show a subtle hint inside the badge instead
      el.upgradeBtn.style.display = "none";
    }
  };

  let cls = "badge";
  let txt = "试用未配置";
  if (el.upgradeBtn) el.upgradeBtn.style.display = "none";

  // ── 状态 1：付费订阅 / 合作伙伴有效 ──────────────────────────────────────
  if (subPlan !== "trial") {
    const paidActive = !subUntil || new Date(subUntil) > new Date();
    if (paidActive) {
      const planLabel = subPlan === "institution" ? "机构版"
                      : subPlan === "partner"      ? "合作伙伴"
                      : "Pro";
      const isPermanent = subPlan === "partner" && subUntil &&
                          new Date(subUntil).getFullYear() >= 2099;
      cls = "badge ok";
      txt = isPermanent
        ? `${planLabel}（长期免费）`
        : subUntil
          ? `${planLabel} 已订阅（到期 ${fmtDate(subUntil)}）`
          : `${planLabel} 已订阅`;
      el.trialBadge.className = cls;
      el.trialBadge.textContent = txt;
      el.trialBadge.style.display = "inline-flex";
      return;
    }
    // Paid plan expired — fall through to trial check
  }

  if (!exp){ hide(); return; }

  const left      = daysLeft(exp);
  const graceLeft = grace ? daysLeft(grace) : null;

  // ── 状态 2：试用中（剩余 > 14 天）──────────────────────────────────────
  if (left > WARN_DAYS){
    cls = "badge ok";
    txt = `试用中：剩余 ${left} 天（到期 ${fmtDate(exp)}）`;

  // ── 状态 3：试用即将到期（0–14 天）─────────────────────────────────────
  } else if (left >= 0){
    cls = "badge warn";
    txt = `试用将到期：剩余 ${left} 天`;
    showUpgrade("升级继续使用");

  // ── 状态 4：宽限期（试用到期，宽限未结束，只读）──────────────────────
  } else if (graceLeft !== null && graceLeft >= 0){
    cls = "badge warn";
    txt = `试用已到期（只读）：宽限剩余 ${graceLeft} 天`;
    showUpgrade("升级恢复写入");

  // ── 状态 5：完全到期，无订阅（只读）──────────────────────────────────
  } else {
    cls = "badge bad";
    txt = `试用已结束（只读）`;
    showUpgrade("订阅以恢复使用");
  }

  el.trialBadge.className = cls;
  el.trialBadge.textContent = txt;
  el.trialBadge.style.display = "inline-flex";
}

function showIganPathBox(){
  const mod = (selectedProject?.module || "").toUpperCase();
  el.iganPathBox.style.display = (mod === "IGAN") ? "block" : "none";
  el.lnPathBox.style.display   = (mod === "LN")   ? "block" : "none";
}

async function init(){
  // Show friendly message for Supabase auth errors forwarded from index.html
  const hashParams = new URLSearchParams(location.hash.slice(1));
  if (hashParams.get("error")) {
    const code = hashParams.get("error_code") || hashParams.get("error");
    const msg = code === "otp_expired"
      ? "重置链接已过期，请重新点击「忘记密码」发送新的链接。"
      : (hashParams.get("error_description") || "认证失败，请重试。").replace(/\+/g, " ");
    setLoginHint(msg);
    history.replaceState(null, "", location.pathname);
  }

  // Register BEFORE getSession so PASSWORD_RECOVERY event is never missed
  let stateHandled = false;
  sb.auth.onAuthStateChange((_event, s2)=>{
    session = s2;
    user = s2?.user || null;
    stateHandled = true;
    if (_event === "PASSWORD_RECOVERY"){
      showNewPasswordMode();
      return;
    }
    // Token refresh just updates the session in memory — no need to reload all data
    if (_event === "TOKEN_REFRESHED") return;
    // Clear selection state on sign out
    if (_event === "SIGNED_OUT"){ selectedProject = null; patients = []; }
    renderAuthState();
  });

  // getSession triggers PKCE code exchange; the listener above handles the result
  const { data: { session: s } } = await sb.auth.getSession();
  if (!stateHandled){
    // onAuthStateChange hasn't fired yet — render with whatever getSession returned
    session = s;
    user = s?.user || null;
    renderAuthState();
  }

  el.btnSendLink.addEventListener("click", sendMagicLink);
  el.btnRegister.addEventListener("click", registerAccount);
  el.btnResetPwd.addEventListener("click", resetPassword);
  el.btnSetNewPwd?.addEventListener("click", setNewPassword);
  el.btnSignOut.addEventListener("click", async ()=>{
    await sb.auth.signOut();
    toast("已退出登录");
  });
  el.btnHeaderSignOut?.addEventListener("click", async ()=>{
    await sb.auth.signOut();
    toast("已退出登录");
  });

  el.btnCreateProject.addEventListener("click", createProject);
  el.btnCreatePatient.addEventListener("click", createPatientBaseline);
  el.btnGenToken.addEventListener("click", genToken);

  // optional extra data entry
  el.btnAddVariant?.addEventListener("click", addVariant);
  el.btnAddLab?.addEventListener("click", addLab);
  el.btnAddMed?.addEventListener("click", addMed);
  el.btnAddEvent?.addEventListener("click", addEvent);

  el.btnExportBaseline.addEventListener("click", ()=>exportTable("baseline"));
  el.btnExportVisits.addEventListener("click", ()=>exportTable("visits"));
  el.btnExportLabs.addEventListener("click", ()=>exportTable("labs"));
  el.btnExportMeds.addEventListener("click", ()=>exportTable("meds"));
  el.btnExportVariants.addEventListener("click", ()=>exportTable("variants"));
  el.btnExportEvents?.addEventListener("click", ()=>exportTable("events"));

  el.btnPaperPack.addEventListener("click", ()=>generatePaperPack({withSnapshot:false}));
  el.btnCreateSnapshot?.addEventListener("click", createSnapshotOnly);
  el.btnPaperPackWithSnapshot?.addEventListener("click", ()=>generatePaperPack({withSnapshot:true}));
  el.btnRefreshSnapshots?.addEventListener("click", loadSnapshots);

  // Import
  el.btnDownloadTemplate?.addEventListener("click", downloadImportTemplate);
  el.importFile?.addEventListener("change", handleImportFile);
  el.btnConfirmImport?.addEventListener("click", confirmImport);
  el.btnCancelImport?.addEventListener("click", ()=>{
    el.importPreview.style.display = "none";
    el.importFile.value = "";
    el.importProgress.style.display = "none";
    _importParsed = null;
  });

  el.btnSaveProfile?.addEventListener("click", saveProfile);
  el.btnApplyContract?.addEventListener("click", applyContract);

  // Account settings
  qs("#btnExportAccount")?.addEventListener("click", async () => {
    toast("正在准备导出…");
    // Trigger all table exports
    try {
      await exportTable("baseline");
      await exportTable("visits");
      await exportTable("labs");
      await exportTable("meds");
      await exportTable("variants");
      toast("数据已导出为 CSV 文件");
    } catch (e) { toast("导出失败：" + (e?.message || e)); }
  });
  qs("#btnDeleteAccount")?.addEventListener("click", async () => {
    const confirmed = confirm("确认注销账户？此操作不可撤销，所有数据将在 30 天内被删除。建议先导出数据。");
    if (!confirmed) return;
    const doubleConfirm = prompt("请输入您的邮箱以确认注销：");
    if (doubleConfirm !== user?.email) { toast("邮箱不匹配，操作取消"); return; }
    toast("账户注销请求已提交，请联系 china@kidneysphere.com 完成注销流程。");
    const hint = qs("#accountSettingsHint");
    if (hint) hint.textContent = "注销请求已记录。平台将在确认后 30 天内删除您的数据。如有疑问请联系客服。";
  });

  // Admin event listeners are now bound dynamically in checkPlatformAdmin()

  // Lab catalog wiring
  el.labTestCode?.addEventListener("change", updateLabUnits);
  el.labValue?.addEventListener("input", updateLabStdValue);
  el.labUnit?.addEventListener("change", updateLabStdValue);

  // Issue panel
  el.btnLoadIssues?.addEventListener("click", loadIssues);

  // PII real-time detection on notes fields
  [
    { el: el.evtNotes,  label: "事件备注" },
    { el: el.varNotes,  label: "基因备注" },
    { el: el.labQcReason, label: "留痕原因" },
  ].forEach(({ el: inp, label }) => {
    inp?.addEventListener("input", () => {
      if (containsPII(inp.value)) {
        inp.style.borderColor = "#dc2626";
        inp.title = `⚠ 检测到疑似PII，请删除个人信息（手机号/身份证/住院号/姓名等）`;
      } else {
        inp.style.borderColor = "";
        inp.title = "";
      }
    });
  });

  renderAuthState();
}

function renderAuthState(){
  const container = document.querySelector(".container");

  const authGated = document.getElementById("authGated");
  if (!user){
    // Anonymous: only show login card, hide everything else
    if (authGated) authGated.hidden = true;
    el.loginCard.style.display = "block";
    el.appCard.style.display = "none";
    if (el.profileCard) el.profileCard.style.display = "none";
    if (el.adminCard) el.adminCard.style.display = "none";
    if (el.issuePanel) el.issuePanel.style.display = "none";
    el.btnSignOut.style.display = "none";
    if (el.btnHeaderSignOut) el.btnHeaderSignOut.style.display = "none";
    if (el.headerUserEmail) el.headerUserEmail.style.display = "none";
    el.btnSendLink.style.display = "";
    el.btnRegister.style.display = "";
    el.btnResetPwd.style.display = "";
    isPlatformAdmin = false;
    setLoginHint("提示：首次使用请先点击「注册账号」创建账号，之后再登录。");
    return;
  }
  // Logged in: unhide auth-gated wrapper, then show workspace
  if (authGated) authGated.hidden = false;
  el.loginCard.style.display = "none";
  el.appCard.style.display = "block";
  if (el.profileCard) el.profileCard.style.display = "block";
  if (el.issuePanel) el.issuePanel.style.display = "block";
  // Admin card stays hidden until checkPlatformAdmin confirms via server RPC
  if (el.adminCard) el.adminCard.style.display = "none";
  el.btnSignOut.style.display = "inline-flex";
  if (el.btnHeaderSignOut) el.btnHeaderSignOut.style.display = "inline-flex";
  if (el.headerUserEmail) {
    el.headerUserEmail.textContent = user.email;
    el.headerUserEmail.style.display = "inline";
  }
  setLoginHint(`已登录：${user.email}`);
  loadLabCatalog();
  loadAll();
  loadProfile();
  loadMyContract();
  checkPlatformAdmin();
}

async function checkPlatformAdmin(){
  const { data, error } = await sb.rpc("is_platform_admin");
  isPlatformAdmin = !error && data === true;
  if (!isPlatformAdmin) {
    // Ensure admin panel is empty and hidden for non-admins
    if (el.adminCard) { el.adminCard.innerHTML = ""; el.adminCard.style.display = "none"; }
    return;
  }
  // Dynamically inject admin panel HTML only after server confirms admin role
  if (el.adminCard) {
    el.adminCard.className = "card";
    el.adminCard.innerHTML = buildAdminPanelHtml();
    el.adminCard.style.display = "block";
    // Re-bind admin element references after injection
    el.adminContractsBadge = qs("#adminContractsBadge");
    el.adminContracts = qs("#adminContracts");
    el.btnAdminLoadContracts = qs("#btnAdminLoadContracts");
    el.adminOrdersBadge = qs("#adminOrdersBadge");
    el.adminOrders = qs("#adminOrders");
    el.btnAdminLoadOrders = qs("#btnAdminLoadOrders");
    el.adminSearchEmail = qs("#adminSearchEmail");
    el.btnAdminSearch = qs("#btnAdminSearch");
    el.adminResults = qs("#adminResults");
    // Bind admin event listeners
    el.btnAdminLoadContracts?.addEventListener("click", adminLoadContracts);
    el.btnAdminLoadOrders?.addEventListener("click", adminLoadOrders);
    el.btnAdminSearch?.addEventListener("click", adminSearch);
    el.adminSearchEmail?.addEventListener("keydown", e=>{ if(e.key==="Enter") adminSearch(); });
  }
  adminLoadContracts();
  adminLoadOrders();
  // Re-render trial badge now that admin status is confirmed
  renderTrialBadge(selectedProject);
}

function buildAdminPanelHtml(){
  return `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <h2 style="margin:0">平台管理员</h2>
      <span class="badge ok" style="font-size:11px">仅你可见</span>
    </div>
    <div class="muted small">通过邮箱搜索用户及其项目，管理试用期与权益。</div>
    <div class="hr"></div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <h3 style="margin:0;font-size:15px">合作申请</h3>
      <span id="adminContractsBadge" class="badge warn" style="display:none;font-size:11px"></span>
      <button class="btn small" id="btnAdminLoadContracts" style="margin-left:auto">刷新</button>
    </div>
    <div id="adminContracts" class="muted small">加载中…</div>
    <div class="hr"></div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <h3 style="margin:0;font-size:15px">支付订单</h3>
      <span id="adminOrdersBadge" class="badge warn" style="display:none;font-size:11px"></span>
      <button class="btn small" id="btnAdminLoadOrders" style="margin-left:auto">刷新</button>
    </div>
    <div id="adminOrders" class="muted small">加载中…</div>
    <div class="hr"></div>
    <h3 style="margin:0 0 8px 0;font-size:15px">用户 & 项目搜索</h3>
    <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
      <div style="flex:1;min-width:220px">
        <label>用户邮箱（支持模糊搜索）</label>
        <input id="adminSearchEmail" type="text" placeholder="例如：researcher@hospital.com"/>
      </div>
      <button class="btn primary" id="btnAdminSearch" style="margin-top:4px">搜索</button>
    </div>
    <div id="adminResults" style="margin-top:14px"></div>`;
}

async function sendMagicLink(){
  if (!rlLogin.allow()) { toast(rlLogin.message); return; }
  const email = getInputEmail();
  const password = el.password?.value || "";
  if (!email){ toast("请输入邮箱"); return; }
  if (!password){ toast("请输入密码"); return; }
  const btn = el.btnSendLink;
  setBusy(btn, true);
  try{
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    toast("登录成功");
  }catch(e){
    console.error(e);
    if (window.ErrorLogger) ErrorLogger.log("staff.login", e);
    toast("登录失败：" + (e?.message || e));
  }finally{
    setBusy(btn, false);
  }
}

async function registerAccount(){
  if (!rlRegister.allow()) { toast(rlRegister.message); return; }
  const email = getInputEmail();
  const password = el.password?.value || "";
  if (!email){ toast("请输入邮箱"); return; }
  const pwCheck = validatePassword(password);
  if (!pwCheck.valid){ toast(pwCheck.message); return; }
  // Show consent box on first register attempt
  const consentBox = qs("#registerConsentBox");
  if (consentBox) consentBox.style.display = "block";
  const agreeBox = qs("#agreeTermsStaff");
  if (agreeBox && !agreeBox.checked){ toast("请先勾选同意用户协议和隐私政策"); return; }
  const btn = el.btnRegister;
  setBusy(btn, true);
  try{
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${location.origin}/staff` }
    });
    if (error) throw error;
    // Log consent after successful registration
    try {
      await sb.rpc("log_consent", {
        p_action: "register",
        p_policy_type: "both",
        p_policy_version: "v1.0",
        p_user_agent: navigator.userAgent || null,
      });
    } catch (_) { /* consent logging is best-effort */ }
    if (data?.session) {
      toast("注册成功，已自动登录");
    } else {
      toast("注册成功，请先查收验证邮件并完成激活");
      setLoginHint("我们已发送验证邮件，激活账号后再回来登录。");
    }
  }catch(e){
    console.error(e);
    toast("注册失败：" + (e?.message || e));
  }finally{
    setBusy(btn, false);
  }
}

async function resetPassword(){
  if (!rlReset.allow()) { toast(rlReset.message); return; }
  const email = getInputEmail();
  if (!email){ toast("请先输入您的注册邮箱"); return; }
  const btn = el.btnResetPwd;
  setBusy(btn, true);
  try{
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}/staff`
    });
    if (error) throw error;
    toast("重置邮件已发送，请查收邮件");
    setLoginHint("已发送密码重置邮件，请点击邮件中的链接完成重置。");
  }catch(e){
    console.error(e);
    toast("发送失败：" + (e?.message || e));
  }finally{
    setBusy(btn, false);
  }
}

function showNewPasswordMode(){
  el.emailLabel.style.display = "none";
  el.email.style.display = "none";
  el.password.placeholder = "输入新密码（至少8位）";
  el.password.value = "";
  el.confirmPwdLabel.style.display = "";
  el.confirmPwd.style.display = "";
  el.confirmPwd.value = "";
  el.btnSendLink.style.display = "none";
  el.btnRegister.style.display = "none";
  el.btnResetPwd.style.display = "none";
  if (el.btnSetNewPwd) el.btnSetNewPwd.style.display = "inline-flex";
  setLoginHint("请输入新密码并确认，然后点击「确认修改密码」。");
}

async function setNewPassword(){
  const newPwd = el.password?.value || "";
  const confirmPwd = el.confirmPwd?.value || "";
  const pwCheck = validatePassword(newPwd);
  if (!pwCheck.valid){ toast(pwCheck.message); return; }
  if (newPwd !== confirmPwd){ toast("两次输入的密码不一致，请重新输入"); el.confirmPwd.value = ""; el.confirmPwd.focus(); return; }
  const btn = el.btnSetNewPwd;
  setBusy(btn, true);
  try{
    const { error } = await sb.auth.updateUser({ password: newPwd });
    if (error) throw error;
    toast("密码修改成功，已自动登录");
    // Restore normal login UI
    el.emailLabel.style.display = "";
    el.email.style.display = "";
    el.password.placeholder = "请输入密码";
    el.password.value = "";
    el.confirmPwdLabel.style.display = "none";
    el.confirmPwd.style.display = "none";
    el.confirmPwd.value = "";
    el.btnSendLink.style.display = "";
    el.btnRegister.style.display = "";
    el.btnResetPwd.style.display = "";
    if (el.btnSetNewPwd) el.btnSetNewPwd.style.display = "none";
    renderAuthState();
  }catch(e){
    console.error(e);
    toast("修改失败：" + (e?.message || e));
  }finally{
    setBusy(btn, false);
  }
}

async function loadLabCatalog(){
  const { data, error } = await sb.from("lab_test_catalog")
    .select("code,name_cn,module,is_core,standard_unit,display_note")
    .order("module").order("name_cn");
  if (error || !data) return;
  labCatalog = data;

  // Build unit map: { code: [{unit_symbol, is_standard, multiplier}] }
  const { data: mapRows } = await sb.from("lab_test_unit_map")
    .select("lab_test_code,unit_symbol,is_standard,multiplier");
  unitMap = {};
  (mapRows || []).forEach(r => {
    if (!unitMap[r.lab_test_code]) unitMap[r.lab_test_code] = [];
    unitMap[r.lab_test_code].push(r);
  });

  rebuildLabDropdown();
}

function rebuildLabDropdown(){
  if (!el.labTestCode) return;
  const grouped = {};
  labCatalog.forEach(c => {
    if (!grouped[c.module]) grouped[c.module] = [];
    grouped[c.module].push(c);
  });
  el.labTestCode.innerHTML = '<option value="">-- 选择化验项目 --</option>';
  Object.entries(grouped).forEach(([mod, items]) => {
    const grp = document.createElement("optgroup");
    grp.label = mod;
    items.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c.code;
      opt.textContent = `${c.name_cn}（${c.code}）`;
      grp.appendChild(opt);
    });
    el.labTestCode.appendChild(grp);
  });
  // Project-level custom labs
  if (projectCustomLabs.length) {
    const grp = document.createElement("optgroup");
    grp.label = "本项目自定义";
    projectCustomLabs.forEach(cl => {
      const opt = document.createElement("option");
      opt.value = "PROJ:" + cl.id;
      opt.textContent = `${cl.name}（${cl.unit || "无单位"}）`;
      grp.appendChild(opt);
    });
    el.labTestCode.appendChild(grp);
  }
  // Free custom entry option — always last
  const customOpt = document.createElement("option");
  customOpt.value = "CUSTOM";
  customOpt.textContent = "＋ 新增自定义化验（保存到本项目目录）";
  el.labTestCode.appendChild(customOpt);
}

async function loadProjectCustomLabs(){
  projectCustomLabs = [];
  if (!selectedProject) {
    rebuildLabDropdown();
    renderProjectCustomLabsPanel();
    return;
  }
  const { data } = await sb.from("project_custom_labs")
    .select("id,name,unit,sort_order")
    .eq("project_id", selectedProject.id)
    .order("sort_order").order("name");
  projectCustomLabs = data || [];
  rebuildLabDropdown();
  renderProjectCustomLabsPanel();
}

function renderProjectCustomLabsPanel(){
  if (!el.projCustomLabsPanel) return;
  if (!selectedProject || projectCustomLabs.length === 0){
    el.projCustomLabsPanel.style.display = "none";
    return;
  }
  el.projCustomLabsPanel.style.display = "";
  if (!el.projCustomLabsList) return;
  el.projCustomLabsList.innerHTML = projectCustomLabs.map(cl => `
    <div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid rgba(0,0,0,.06)">
      <span style="flex:1">${escapeHtml(cl.name)}${cl.unit ? " <span style='color:var(--muted)'>" + escapeHtml(cl.unit) + "</span>" : ""}</span>
      <button class="btn small" style="font-size:11px;padding:2px 7px;background:#fee2e2;color:#b91c1c;border:none"
        onclick="window._deleteProjectCustomLab('${cl.id}')">删除</button>
    </div>`).join("");
}

async function deleteProjectCustomLab(id){
  if (!confirm("确认从本项目目录中删除此自定义化验？已录入的历史记录不受影响。")) return;
  const { error } = await sb.from("project_custom_labs").delete().eq("id", id);
  if (error){ toast("删除失败：" + error.message); return; }
  toast("已删除");
  await loadProjectCustomLabs();
}
window._deleteProjectCustomLab = deleteProjectCustomLab;

function updateLabUnits(){
  const code = el.labTestCode?.value;
  if (!el.labUnit) return;

  const isCustom = code === "CUSTOM";
  const isProjCustom = code?.startsWith("PROJ:");

  // Toggle custom inputs
  const showCustomInputs = isCustom;
  if (el.labCustomName) el.labCustomName.style.display = showCustomInputs ? "" : "none";
  if (el.labCustomUnit) el.labCustomUnit.style.display = showCustomInputs ? "" : "none";
  if (el.labUnit) el.labUnit.style.display = (showCustomInputs || isProjCustom) ? "none" : "";
  if (el.labStdValue) el.labStdValue.closest(".col").style.display = (showCustomInputs || isProjCustom) ? "none" : "";

  if (!code){
    el.labUnit.innerHTML = '<option value="">-- 先选化验项目 --</option>';
    if (el.labStdValue) el.labStdValue.value = "";
    if (el.labHint) el.labHint.textContent = "";
    return;
  }
  if (isCustom){
    if (el.labHint) el.labHint.textContent = "新自定义化验：录入后自动保存到本项目目录，同项目后续患者可直接选用。";
    return;
  }
  if (isProjCustom){
    const clId = code.slice(5);
    const cl = projectCustomLabs.find(c => c.id === clId);
    if (el.labHint) el.labHint.textContent = cl ? `项目自定义化验：${cl.name}，单位：${cl.unit || "无"}` : "";
    if (el.labName) el.labName.value = cl?.name || "";
    return;
  }
  const units = unitMap[code] || [];
  el.labUnit.innerHTML = units.map(u =>
    `<option value="${u.unit_symbol}" ${u.is_standard ? "selected" : ""}>${u.unit_symbol}${u.is_standard ? "（标准单位）" : ""}</option>`
  ).join("");

  // Show catalog display note as hint
  const cat = labCatalog.find(c => c.code === code);
  if (el.labHint && cat?.display_note) el.labHint.textContent = cat.display_note;
  if (el.labName) el.labName.value = code;
  updateLabStdValue();
}

function updateLabStdValue(){
  const code = el.labTestCode?.value;
  const rawVal = parseFloat(el.labValue?.value);
  const unit = el.labUnit?.value;
  if (!el.labStdValue) return;
  if (!code || isNaN(rawVal) || !unit){
    el.labStdValue.value = "";
    return;
  }
  const unitRow = (unitMap[code] || []).find(u => u.unit_symbol === unit);
  if (!unitRow){ el.labStdValue.value = "单位不支持"; return; }
  const cat = labCatalog.find(c => c.code === code);
  const std = (rawVal * unitRow.multiplier).toFixed(4);
  el.labStdValue.value = `${std} ${cat?.standard_unit || ""}`;
}

async function loadAll(){
  await loadProjects();
  // auto select first project
  if (!selectedProject && projects.length){
    selectProject(projects[0].id);
  } else if (selectedProject){
    await loadPatients();
  }
}

async function loadProjects(){
  const { data, error } = await sb.from("projects").select("*").order("created_at", {ascending:false});
  if (error){ toast("读取项目失败：" + error.message); return; }
  projects = data || [];
  renderProjects();
}

function renderProjects(){
  el.projectsList.innerHTML = "";

  if (projects.length === 0){
    // Empty state — invite user to seed demo data
    const hint = document.createElement("div");
    hint.style.cssText = "margin-top:10px;padding:14px;border:1.5px dashed rgba(37,99,235,.3);border-radius:14px;background:rgba(37,99,235,.04);";
    hint.innerHTML = `
      <div style="font-weight:700;font-size:14px;margin-bottom:6px;">还没有项目</div>
      <div class="muted small" style="margin-bottom:10px;">
        可以先创建空项目（填写上方表单），也可以一键加载演示数据，立刻看到完整系统效果。
      </div>
      <button class="btn primary small" id="btnSeedDemo">⚡ 一键加载 IgAN 演示数据（8 患者）</button>`;
    el.projectsList.appendChild(hint);
    hint.querySelector("#btnSeedDemo").addEventListener("click", seedDemoData);
  } else {
    projects.forEach(p=>{
      const b = document.createElement("button");
      b.className = "pill" + (selectedProject?.id === p.id ? " active" : "");
      b.textContent = `${p.center_code} · ${p.name}`;
      b.addEventListener("click", ()=>selectProject(p.id));
      el.projectsList.appendChild(b);
    });
  }

  renderProjectMeta();
}

function renderProjectMeta(){
  if (!selectedProject){
    el.projectMeta.innerHTML = "<div class='muted small'>尚未选择项目</div>";
    renderTrialBadge(null);
    showIganPathBox();
    return;
  }
  const p = selectedProject;
  const left = p.trial_expires_at ? daysLeft(p.trial_expires_at) : null;

  el.projectMeta.innerHTML = `
    <div>项目</div><div><b>${escapeHtml(p.name)}</b></div>
    <div>中心代码</div><div><code>${escapeHtml(p.center_code)}</code></div>
    <div>模块</div><div><code>${escapeHtml(p.module)}</code></div>
    <div>试用到期</div><div>${p.trial_expires_at ? fmtDate(p.trial_expires_at) : "未设置"} ${left!==null?`（剩余 ${left} 天）`:""}</div>
    <div>订阅方案</div><div>${
      p.subscription_plan && p.subscription_plan !== "trial"
        ? `<b>${p.subscription_plan === "institution" ? "机构版" : "Pro"}</b>，有效至 ${p.subscription_active_until ? fmtDate(p.subscription_active_until) : "永久"}`
        : "免费试用"
    }</div>
  `;
  renderTrialBadge(p);
  showIganPathBox();
}

async function selectProject(projectId){
  selectedProject = projects.find(p=>p.id===projectId) || null;
  renderProjects();
  await Promise.all([loadPatients(), loadProjectCustomLabs()]);
  await loadExtras();
  await loadSnapshots();
  loadIssueSummary();
}

async function createProject(){
  const name = el.projName.value.trim();
  const center_code = el.projCenter.value.trim();
  const module = el.projModule.value;
  const description = el.projDesc.value.trim() || null;

  if (!name) return toast("请输入项目名称");
  if (!center_code) return toast("请输入 center_code");

  const btn = el.btnCreateProject;
  btn.dataset.label = "创建项目";
  setBusy(btn, true);
  try{
    const registry_type = module.toLowerCase();
    const { error } = await sb.from("projects").insert({ name, center_code, module, registry_type, description });
    if (error) throw error;
    toast("项目已创建");
    el.projName.value = "";
    el.projDesc.value = "";
    await loadProjects();
    // select newest
    if (projects.length) selectProject(projects[0].id);
  }catch(e){
    console.error(e);
    toast("创建失败：" + (e?.message || e));
  }finally{
    setBusy(btn,false);
  }
}

// ─── Demo data seeder ─────────────────────────────────────────────────────────
async function seedDemoData(){
  const btn = document.getElementById("btnSeedDemo");
  if (btn) { btn.disabled = true; btn.textContent = "加载中…"; }

  try{
    // 1. Create demo project
    const { data: proj, error: pe } = await sb.from("projects")
      .insert({
        name: "IgAN 多中心演示项目（DEMO）",
        center_code: "DEMO01",
        module: "IGAN",
        registry_type: "igan",
        description: "自动生成的演示数据集，含8位去标识化患者与随访记录，展示MEST-C、趋势图、QC报告等功能。"
      })
      .select()
      .single();
    if (pe) throw pe;
    const pid = proj.id;

    // 2. Patient baselines (realistic IgAN cohort, mix of stable/progressive)
    const patients = [
      { patient_code:"P001", sex:"M", birth_year:1978, baseline_date:"2023-01-15", baseline_scr:105, baseline_upcr:2.1,
        biopsy_date:"2022-12-10", oxford_m:1, oxford_e:0, oxford_s:1, oxford_t:0, oxford_c:0 },
      { patient_code:"P002", sex:"F", birth_year:1985, baseline_date:"2023-01-20", baseline_scr:82,  baseline_upcr:1.2,
        biopsy_date:"2023-01-05", oxford_m:0, oxford_e:0, oxford_s:0, oxford_t:0, oxford_c:0 },
      { patient_code:"P003", sex:"M", birth_year:1972, baseline_date:"2023-02-01", baseline_scr:145, baseline_upcr:3.5,
        biopsy_date:"2023-01-18", oxford_m:1, oxford_e:1, oxford_s:1, oxford_t:1, oxford_c:0 },
      { patient_code:"P004", sex:"F", birth_year:1990, baseline_date:"2023-02-08", baseline_scr:95,  baseline_upcr:2.8,
        biopsy_date:"2023-01-25", oxford_m:1, oxford_e:0, oxford_s:1, oxford_t:0, oxford_c:0 },
      { patient_code:"P005", sex:"M", birth_year:1968, baseline_date:"2023-02-15", baseline_scr:178, baseline_upcr:5.2,
        biopsy_date:"2023-02-01", oxford_m:1, oxford_e:1, oxford_s:1, oxford_t:2, oxford_c:1 },
      { patient_code:"P006", sex:"F", birth_year:1982, baseline_date:"2023-03-01", baseline_scr:88,  baseline_upcr:1.8,
        biopsy_date:"2023-02-15", oxford_m:0, oxford_e:0, oxford_s:1, oxford_t:0, oxford_c:0 },
      { patient_code:"P007", sex:"M", birth_year:1975, baseline_date:"2023-03-10", baseline_scr:132, baseline_upcr:2.5,
        biopsy_date:"2023-02-28", oxford_m:1, oxford_e:0, oxford_s:0, oxford_t:1, oxford_c:0 },
      { patient_code:"P008", sex:"F", birth_year:1993, baseline_date:"2023-03-15", baseline_scr:75,  baseline_upcr:1.5,
        biopsy_date:"2023-03-01", oxford_m:1, oxford_e:1, oxford_s:0, oxford_t:0, oxford_c:0 },
    ].map(p => ({ ...p, project_id: pid }));

    const { error: bpe } = await sb.from("patients_baseline").insert(patients);
    if (bpe) throw bpe;

    // 3. Visits (4 per patient; P007 missing last visit, P008 missing Scr at visit2 — to demo QC report)
    const visits = [
      // P001 – stable, responds to treatment
      { patient_code:"P001", visit_date:"2023-01-15", sbp:138, dbp:88, scr_umol_l:105, upcr:2.1 },
      { patient_code:"P001", visit_date:"2023-04-15", sbp:135, dbp:85, scr_umol_l:103, upcr:1.8 },
      { patient_code:"P001", visit_date:"2023-07-15", sbp:128, dbp:82, scr_umol_l:98,  upcr:0.9 },
      { patient_code:"P001", visit_date:"2024-01-15", sbp:125, dbp:80, scr_umol_l:96,  upcr:0.5 },
      // P002 – mild, full remission
      { patient_code:"P002", visit_date:"2023-01-20", sbp:120, dbp:76, scr_umol_l:82,  upcr:1.2 },
      { patient_code:"P002", visit_date:"2023-04-20", sbp:118, dbp:74, scr_umol_l:80,  upcr:0.8 },
      { patient_code:"P002", visit_date:"2023-07-20", sbp:116, dbp:73, scr_umol_l:78,  upcr:0.5 },
      { patient_code:"P002", visit_date:"2024-01-20", sbp:115, dbp:72, scr_umol_l:79,  upcr:0.4 },
      // P003 – progressive, eGFR declining (QC注意：此类患者需密切随访)
      { patient_code:"P003", visit_date:"2023-02-01", sbp:155, dbp:98, scr_umol_l:145, upcr:3.5 },
      { patient_code:"P003", visit_date:"2023-05-01", sbp:158, dbp:100, scr_umol_l:162, upcr:4.2 },
      { patient_code:"P003", visit_date:"2023-08-01", sbp:162, dbp:102, scr_umol_l:198, upcr:5.8 },
      { patient_code:"P003", visit_date:"2024-02-01", sbp:165, dbp:104, scr_umol_l:234, upcr:7.6 },
      // P004 – partial response
      { patient_code:"P004", visit_date:"2023-02-08", sbp:132, dbp:84, scr_umol_l:95,  upcr:2.8 },
      { patient_code:"P004", visit_date:"2023-05-08", sbp:128, dbp:82, scr_umol_l:92,  upcr:2.0 },
      { patient_code:"P004", visit_date:"2023-08-08", sbp:124, dbp:80, scr_umol_l:90,  upcr:1.5 },
      { patient_code:"P004", visit_date:"2024-02-08", sbp:122, dbp:78, scr_umol_l:88,  upcr:1.2 },
      // P005 – rapid progressive (high risk: M1E1S1T2C1)
      { patient_code:"P005", visit_date:"2023-02-15", sbp:162, dbp:104, scr_umol_l:178, upcr:5.2 },
      { patient_code:"P005", visit_date:"2023-05-15", sbp:165, dbp:106, scr_umol_l:210, upcr:6.8 },
      { patient_code:"P005", visit_date:"2023-08-15", sbp:168, dbp:108, scr_umol_l:265, upcr:9.2 },
      { patient_code:"P005", visit_date:"2024-02-15", sbp:170, dbp:110, scr_umol_l:342, upcr:12.5 },
      // P006 – good response, near complete remission
      { patient_code:"P006", visit_date:"2023-03-01", sbp:125, dbp:80, scr_umol_l:88,  upcr:1.8 },
      { patient_code:"P006", visit_date:"2023-06-01", sbp:120, dbp:78, scr_umol_l:86,  upcr:0.9 },
      { patient_code:"P006", visit_date:"2023-09-01", sbp:118, dbp:76, scr_umol_l:84,  upcr:0.5 },
      { patient_code:"P006", visit_date:"2024-03-01", sbp:116, dbp:74, scr_umol_l:83,  upcr:0.4 },
      // P007 – moderate, missing last visit (QC will flag incomplete follow-up)
      { patient_code:"P007", visit_date:"2023-03-10", sbp:142, dbp:90, scr_umol_l:132, upcr:2.5 },
      { patient_code:"P007", visit_date:"2023-06-10", sbp:140, dbp:88, scr_umol_l:130, upcr:2.2 },
      { patient_code:"P007", visit_date:"2023-09-10", sbp:138, dbp:86, scr_umol_l:128, upcr:2.0 },
      // P008 – missing Scr at visit 2 (QC will flag missing core field)
      { patient_code:"P008", visit_date:"2023-03-15", sbp:118, dbp:74, scr_umol_l:75,  upcr:1.5 },
      { patient_code:"P008", visit_date:"2023-06-15", sbp:116, dbp:72, scr_umol_l:null, upcr:1.2 },  // missing Scr
      { patient_code:"P008", visit_date:"2023-09-15", sbp:115, dbp:71, scr_umol_l:74,  upcr:0.8 },
      { patient_code:"P008", visit_date:"2024-03-15", sbp:114, dbp:70, scr_umol_l:73,  upcr:0.6 },
    ].map(v => ({ ...v, project_id: pid }));

    const { error: ve } = await sb.from("visits_long").insert(visits);
    if (ve) throw ve;

    toast("✅ 演示数据加载完成！已创建 8 名患者 + 31 次随访（含QC测试项）");
    await loadProjects();
    if (projects.length) selectProject(projects[0].id);

  }catch(e){
    console.error(e);
    toast("演示数据加载失败：" + (e?.message || e));
    if (btn){ btn.disabled = false; btn.textContent = "⚡ 一键加载 IgAN 演示数据（8 患者）"; }
  }
}
// ──────────────────────────────────────────────────────────────────────────────

async function loadPatients(){
  if (!selectedProject){ patients = []; renderPatients(); return; }
  const projectId = selectedProject.id; // capture before async
  const { data, error } = await sb.from("patients_baseline")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", {ascending:false});
  // Discard if user switched project while this was loading
  if (selectedProject?.id !== projectId) return;
  if (error){ toast("读取患者失败：" + error.message); patients = []; renderPatients(); return; }
  patients = data || [];
  renderPatients();
}


async function loadExtras(){
  if (!selectedProject){
    if (el.variantsPreview) el.variantsPreview.textContent = "";
    if (el.labsPreview) el.labsPreview.textContent = "";
    if (el.medsPreview) el.medsPreview.textContent = "";
    if (el.eventsPreview) el.eventsPreview.textContent = "暂无记录";
    return;
  }
  const pid = selectedProject.id;
  try{
    const [varsRes, labsRes, medsRes, evtsRes] = await Promise.all([
      sb.from("variants_long").select("*").eq("project_id", pid).order("created_at", {ascending:false}).limit(10),
      sb.from("labs_long").select("*").eq("project_id", pid).order("created_at", {ascending:false}).limit(10),
      sb.from("meds_long").select("*").eq("project_id", pid).order("created_at", {ascending:false}).limit(10),
      sb.from("events_long").select("*").eq("project_id", pid).order("created_at", {ascending:false}).limit(20),
    ]);
    if (varsRes.error) throw varsRes.error;
    if (labsRes.error) throw labsRes.error;
    if (medsRes.error) throw medsRes.error;
    // Discard if user switched project while loading
    if (selectedProject?.id !== pid) return;
    // events_long may not exist yet — ignore error gracefully
    renderVariantsPreview(varsRes.data || []);
    renderLabsPreview(labsRes.data || []);
    renderMedsPreview(medsRes.data || []);
    renderEventsPreview(evtsRes.error ? [] : (evtsRes.data || []));
  }catch(e){
    console.error(e);
    // do not spam toasts here
  }
}

// ── 通用删除函数（化验 / 用药 / 基因 / 事件）────────────────────────────────
async function deleteRecord(table, id){
  if (!confirm("确认删除这条记录？操作不可撤销。")) return;
  const { error } = await sb.from(table).delete().eq("id", id);
  if (error){ toast("删除失败：" + error.message); return; }
  toast("已删除");
  await loadExtras();
}
window._deleteRecord = deleteRecord;

function renderVariantsPreview(rows){
  if (!el.variantsPreview) return;
  if (!rows.length){
    el.variantsPreview.innerHTML = "暂无记录（仅影响科研分析时的基因分层/描述）";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td><b>${escapeHtml(r.patient_code||"")}</b></td>
      <td>${escapeHtml(r.test_date||"")}</td>
      <td>${escapeHtml(r.gene||"")}</td>
      <td class="muted small">${escapeHtml((r.variant||r.hgvs_c||"").slice(0,28))}</td>
      <td>${escapeHtml(r.classification||"")}</td>
      <td><button class="btn small" style="color:#b91c1c" onclick="window._deleteRecord('variants_long','${escapeHtml(r.id||"")}')">删除</button></td>
    </tr>
  `).join("");
  el.variantsPreview.innerHTML = `
    <div class="muted small">最近 10 条：</div>
    <table class="table">
      <thead><tr><th>研究编号</th><th>日期</th><th>基因</th><th>变异</th><th>ACMG分级</th><th></th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
}

function renderLabsPreview(rows){
  if (!el.labsPreview) return;
  if (!rows.length){
    el.labsPreview.innerHTML = "暂无记录";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td><b>${escapeHtml(r.patient_code||"")}</b></td>
      <td>${escapeHtml(r.lab_date||"")}</td>
      <td>${escapeHtml(r.lab_name||r.lab_test_code||"")}</td>
      <td>${escapeHtml(r.lab_value!=null ? String(r.lab_value) : (r.value_raw!=null ? String(r.value_raw) : ""))}</td>
      <td>${escapeHtml(r.lab_unit||r.unit_symbol||"")}</td>
      <td><button class="btn small" style="color:#b91c1c" onclick="window._deleteRecord('labs_long','${escapeHtml(r.id||"")}')">删除</button></td>
    </tr>
  `).join("");
  el.labsPreview.innerHTML = `
    <div class="muted small">最近 10 条：</div>
    <table class="table">
      <thead><tr><th>研究编号</th><th>日期</th><th>项目</th><th>数值</th><th>单位</th><th></th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
}

function renderMedsPreview(rows){
  if (!el.medsPreview) return;
  if (!rows.length){
    el.medsPreview.innerHTML = "暂无记录";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td><b>${escapeHtml(r.patient_code||"")}</b></td>
      <td>${escapeHtml(r.drug_name||"")}</td>
      <td class="muted small">${escapeHtml((r.dose||"").slice(0,18))}</td>
      <td>${escapeHtml(r.start_date||"")}</td>
      <td>${escapeHtml(r.end_date||"")}</td>
      <td><button class="btn small" style="color:#b91c1c" onclick="window._deleteRecord('meds_long','${escapeHtml(r.id||"")}')">删除</button></td>
    </tr>
  `).join("");
  el.medsPreview.innerHTML = `
    <div class="muted small">最近 10 条：</div>
    <table class="table">
      <thead><tr><th>研究编号</th><th>药品</th><th>剂量</th><th>开始</th><th>结束</th><th></th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
}


function renderEventsPreview(rows){
  if (!el.eventsPreview) return;
  if (!rows.length){
    el.eventsPreview.innerHTML = "暂无记录";
    return;
  }
  const trs = rows.map(r=>`
    <tr>
      <td><b>${escapeHtml(r.patient_code||"")}</b></td>
      <td>${escapeHtml(r.event_type||"")}</td>
      <td>${escapeHtml(r.event_date||"")}</td>
      <td>${escapeHtml(r.source||"manual")}</td>
      <td class="muted small">${escapeHtml((r.notes||"").slice(0,30))}</td>
      <td><button class="btn small" style="color:#b91c1c" onclick="window._deleteRecord('events_long','${escapeHtml(r.id||"")}')">删除</button></td>
    </tr>
  `).join("");
  el.eventsPreview.innerHTML = `
    <div class="muted small">最近 20 条：</div>
    <table class="table">
      <thead><tr><th>研究编号</th><th>事件类型</th><th>日期</th><th>来源</th><th>备注</th><th></th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
}

function renderPatients(){
  if (!selectedProject){
    el.patientsList.innerHTML = "<div class='muted small'>请先选择/创建项目</div>";
    return;
  }
  if (!patients.length){
    el.patientsList.innerHTML = "<div class='muted small'>暂无患者</div>";
    return;
  }
  const rows = patients.map(p=>{
    const mest = (selectedProject.module==="IGAN" && (p.oxford_m!==null || p.oxford_e!==null || p.oxford_s!==null || p.oxford_t!==null || p.oxford_c!==null))
      ? `M${v(p.oxford_m)} E${v(p.oxford_e)} S${v(p.oxford_s)} T${v(p.oxford_t)} C${v(p.oxford_c)}`
      : "";
    const lnSummary = (selectedProject.module==="LN" && p.ln_class)
      ? `${p.ln_class}${p.ln_activity_index!=null ? ` AI:${p.ln_activity_index}` : ""}${p.ln_chronicity_index!=null ? ` CI:${p.ln_chronicity_index}` : ""}`
      : "";
    const pathSummary = mest || lnSummary;
    return `
      <tr data-pcode="${escapeHtml(p.patient_code)}">
        <td><b>${escapeHtml(p.patient_code)}</b></td>
        <td>${escapeHtml(p.sex||"")}</td>
        <td>${escapeHtml(p.birth_year||"")}</td>
        <td>${escapeHtml(p.baseline_date||"")}</td>
        <td>${escapeHtml(p.baseline_scr||"")}</td>
        <td>${escapeHtml(p.baseline_upcr||"")}</td>
        <td class="muted small">${escapeHtml(pathSummary)}</td>
        <td><button class="btn small" data-act="token">生成随访链接</button></td>
      </tr>
    `;
  }).join("");

  el.patientsList.innerHTML = `
    <table class="table">
      <thead><tr>
        <th>研究编号</th><th>性别</th><th>出生年</th><th>基线日期</th><th>Scr</th><th>UPCR</th><th>IgAN MEST‑C</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  // bind row actions
  qsa("button[data-act='token']", el.patientsList).forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      const tr = e.target.closest("tr");
      const pcode = tr?.getAttribute("data-pcode");
      if (pcode){
        el.tokenPatientCode.value = pcode;
        if (el.varPatientCode) el.varPatientCode.value = pcode;
        if (el.labPatientCode) el.labPatientCode.value = pcode;
        if (el.medPatientCode) el.medPatientCode.value = pcode;
        if (el.evtPatientCode) el.evtPatientCode.value = pcode;
        toast("已填入研究编号（链接/基因/化验/用药/事件各栏）");
        el.tokenOut.style.display = "none";
      }
    });
  });
}

function v(x){
  if (x === null || x === undefined || x === "") return "";
  return String(x);
}

async function createPatientBaseline(){
  if (!selectedProject) return toast("请先选择项目");
  const patient_code = el.patCode.value.trim();
  if (!patient_code) return toast("请输入 patient_code");

  const birth_year = el.patBirthYear.value ? Number(el.patBirthYear.value) : null;
  if (birth_year !== null){
    const thisYear = new Date().getFullYear();
    if (!Number.isInteger(birth_year) || birth_year < 1900 || birth_year > thisYear){
      return toast(`出生年份无效（应为 1900–${thisYear}）`);
    }
  }

  const payload = {
    project_id: selectedProject.id,
    patient_code,
    sex: el.patSex.value || null,
    birth_year,
    baseline_date: el.patBaselineDate.value || null,
    baseline_scr: el.patBaselineScr.value ? Number(el.patBaselineScr.value) : null,
    baseline_upcr: el.patBaselineUpcr.value ? Number(el.patBaselineUpcr.value) : null,
    treatment_arm: el.rctArm?.value || null,
    randomization_id: el.rctRandomId?.value.trim() || null,
    randomization_date: el.rctDate?.value || null,
  };

  // IgAN MEST-C
  if ((selectedProject.module || "").toUpperCase() === "IGAN"){
    payload.biopsy_date = el.biopsyDate.value || null;
    payload.oxford_m = el.mestM.value !== "" ? Number(el.mestM.value) : null;
    payload.oxford_e = el.mestE.value !== "" ? Number(el.mestE.value) : null;
    payload.oxford_s = el.mestS.value !== "" ? Number(el.mestS.value) : null;
    payload.oxford_t = el.mestT.value !== "" ? Number(el.mestT.value) : null;
    payload.oxford_c = el.mestC.value !== "" ? Number(el.mestC.value) : null;
  }

  // LN ISN/RPS 分型
  if ((selectedProject.module || "").toUpperCase() === "LN"){
    payload.ln_biopsy_date      = el.lnBiopsyDate.value || null;
    payload.ln_class            = el.lnClass.value || null;
    payload.ln_activity_index   = el.lnAI.value !== "" ? Number(el.lnAI.value) : null;
    payload.ln_chronicity_index = el.lnCI.value !== "" ? Number(el.lnCI.value) : null;
    payload.ln_podocytopathy    = el.lnPodocytopathy.value === "true" ? true
                                : el.lnPodocytopathy.value === "false" ? false : null;
  }

  const btn = el.btnCreatePatient;
  btn.dataset.label = "保存基线";
  setBusy(btn,true);
  try{
    const { error } = await sb.from("patients_baseline").insert(payload);
    if (error) throw error;
    toast("已保存患者基线");
    el.patCode.value = "";
    await loadPatients();
  }catch(e){
    console.error(e);
    toast("保存失败：" + (e?.message || e));
  }finally{
    setBusy(btn,false);
  }
}

// Token 状态标签渲染
// 四种状态：有效（绿）/ 已使用（蓝）/ 已撤销（红）/ 已过期（灰）
function tokenStatusBadge(t){
  const now = new Date();
  if (t.revoked_at) return `<span class="issue-badge issue-critical">已撤销</span>`;
  if (t.expires_at && new Date(t.expires_at) < now) return `<span class="issue-badge" style="background:#e2e8f0;color:#475569">已过期</span>`;
  if (t.single_use && t.used_at) return `<span class="issue-badge issue-info">已使用</span>`;
  return `<span class="issue-badge issue-resolved">有效</span>`;
}

function resolveAppBasePath(){
  const p = window.location.pathname || "/";
  // keep links stable when mounted under sub-paths like /c/, /app/, etc.
  const knownEntry = ["/staff", "/staff.html", "/patient.html", "/guide", "/guide.html"];
  for (const entry of knownEntry){
    if (p === entry || p.endsWith(entry)){
      const base = p.slice(0, -entry.length);
      return base || "";
    }
  }
  // default: directory of current page
  const idx = p.lastIndexOf("/");
  return idx > 0 ? p.slice(0, idx) : "";
}

function buildFollowupLinks(token){
  const origin = window.location.origin;
  const base = resolveAppBasePath();
  const encoded = encodeURIComponent(token);
  return {
    // rewrite-friendly short path (requires host rewrites to be configured)
    shortLink: `${origin}${base}/p/${encoded}`,
    // hash-based link: token is in the URL fragment (#), never sent to server,
    // invisible to Netlify routing and Supabase auth detection
    directLink: `${origin}${base}/followup#${encoded}`,
  };
}

async function genToken(){
  if (!selectedProject) return toast("请先选择项目");
  const pcode = el.tokenPatientCode.value.trim();
  if (!pcode) return toast("请输入患者研究编号");
  const days = el.tokenDays.value ? Number(el.tokenDays.value) : 365;
  const singleUse = el.tokenSingleUse?.checked || false;

  const btn = el.btnGenToken;
  btn.dataset.label = "生成随访链接";
  setBusy(btn, true);
  try{
    // Step 1: create token (existing RPC)
    const { data, error } = await sb.rpc("create_patient_token", {
      p_project_id: selectedProject.id,
      p_patient_code: pcode,
      p_expires_in_days: days
    });
    if (error) throw error;
    const token = data;

    // Step 2: if single_use, set the flag on the record
    if (singleUse){
      await sb.from("patient_tokens")
        .update({ single_use: true })
        .eq("token", token);
    }

    const { shortLink, directLink } = buildFollowupLinks(token);
    const expiryStr = days >= 3650 ? "长期有效" : `${days}天后过期`;
    const suStr = singleUse ? "（单次使用）" : "（可多次使用）";

    el.tokenOut.style.display = "block";
    el.tokenOut.innerHTML = `
      <div><b>随访链接已生成</b> ${tokenStatusBadge({revoked_at:null,expires_at:null,single_use:singleUse,used_at:null})}</div>
      <div class="small muted" style="margin-top:4px">
        有效期：${expiryStr} · ${suStr}<br>
        <b>Token</b>（令牌）是这串随机码的简称，患者或护士用下面的链接填随访，<b>无需登录账号</b>。
      </div>
      <div style="margin-top:8px;background:#f1f5f9;padding:8px;border-radius:6px;word-break:break-all;font-size:13px">
        <code>${escapeHtml(directLink)}</code>
      </div>
      <div class="small muted" style="margin-top:6px;word-break:break-all">
        短链接（需服务器支持重写）：<code>${escapeHtml(shortLink)}</code>
      </div>
      <div class="btnbar" style="margin-top:8px">
        <button class="btn small primary" id="btnCopyLink">复制链接</button>
        <button class="btn small" id="btnOpenPreview">打开随访页预览</button>
        <button class="btn small" style="border-color:#dc2626;color:#dc2626" id="btnRevokeToken">立即撤销此 token</button>
      </div>
      <div class="muted small" style="margin-top:6px">
        提示：链接泄露或发错患者时可点「立即撤销」，已提交的数据不受影响。
      </div>
    `;
    qs("#btnCopyLink", el.tokenOut).addEventListener("click", async ()=>{
      await navigator.clipboard.writeText(directLink);
      toast("已复制随访链接");
    });
    qs("#btnOpenPreview", el.tokenOut).addEventListener("click", ()=>{
      const win = window.open(directLink, "_blank", "noopener,noreferrer");
      if (!win) window.location.href = directLink;
    });
    qs("#btnRevokeToken", el.tokenOut).addEventListener("click", async ()=>{
      const reason = window.prompt("请填写撤销原因（必填，如：发错患者，重新生成）：");
      if (reason === null) return;  // 取消
      if (!reason.trim()) return toast("撤销原因不能为空");
      const { error: re } = await sb.rpc("revoke_patient_token", {
        p_token: token,
        p_revoke_reason: reason.trim()
      });
      if (re){ toast("撤销失败：" + re.message); return; }
      toast("已撤销此 token，链接立即失效");
      el.tokenOut.querySelector("div > b").nextSibling?.replaceWith?.("");
      el.tokenOut.querySelector(".issue-resolved, .issue-info")?.outerHTML;
      // re-render badge
      const badge = el.tokenOut.querySelector("[class*='issue-badge']");
      if (badge) badge.outerHTML = `<span class="issue-badge issue-critical">已撤销</span>`;
    });
  }catch(e){
    console.error(e);
    toast("生成失败：" + (e?.message || e));
  }finally{
    setBusy(btn, false);
  }
}


async function addVariant(){
  if (!selectedProject) return toast("请先选择项目");
  const patient_code = el.varPatientCode?.value.trim();
  if (!patient_code) return toast("请填写基因记录的 patient_code");
  const payload = {
    project_id: selectedProject.id,
    patient_code,
    test_date: el.varTestDate?.value || null,
    test_name: el.varTestName?.value.trim() || null,
    gene: el.varGene?.value.trim() || null,
    variant: el.varVariant?.value.trim() || null,
    hgvs_c: el.varHgvsC?.value.trim() || null,
    hgvs_p: el.varHgvsP?.value.trim() || null,
    transcript: null,
    zygosity: el.varZygosity?.value.trim() || null,
    classification: el.varClass?.value.trim() || null,
    lab_name: el.varLabName?.value.trim() || null,
    notes: el.varNotes?.value ? el.varNotes.value.slice(0,500) : null
  };
  const btn = el.btnAddVariant;
  btn.dataset.label = "添加基因记录";
  setBusy(btn,true);
  try{
    const { error } = await sb.from("variants_long").insert(payload);
    if (error) throw error;
    toast("已添加基因记录");
    if (el.varGene) el.varGene.value = "";
    if (el.varVariant) el.varVariant.value = "";
    if (el.varHgvsC) el.varHgvsC.value = "";
    if (el.varHgvsP) el.varHgvsP.value = "";
    if (el.varNotes) el.varNotes.value = "";
    await loadExtras();
  await loadSnapshots();
  }catch(e){
    console.error(e);
    toast("添加失败：" + (e?.message || e));
  }finally{
    setBusy(btn,false);
  }
}

async function addLab(){
  if (!selectedProject) return toast("请先选择项目");
  const patient_code = el.labPatientCode?.value.trim();
  if (!patient_code) return toast("请填写患者研究编号");
  const lab_test_code = el.labTestCode?.value;
  if (!lab_test_code) return toast("请从下拉列表选择化验项目");
  const rawVal = el.labValue?.value !== "" ? Number(el.labValue?.value) : null;
  if (rawVal === null || isNaN(rawVal)) return toast("请填写化验数值");

  const isCustom = lab_test_code === "CUSTOM";
  const isProjCustom = lab_test_code?.startsWith("PROJ:");

  const customName = el.labCustomName?.value.trim();
  const customUnit = el.labCustomUnit?.value.trim();
  if (isCustom && !customName) return toast("请填写化验名称");
  if (isCustom && !customUnit) return toast("请填写化验单位");

  const unit = isCustom ? customUnit : el.labUnit?.value;
  if (!isCustom && !isProjCustom && !unit) return toast("请选择单位");

  // 前端 PII 检测
  try { assertNoPII(el.labQcReason?.value || "", "留痕原因"); } catch(e){ return toast(e.message); }

  const btn = el.btnAddLab;
  btn.dataset.label = "添加化验记录";
  setBusy(btn, true);
  try{
    if (isCustom){
      // Save to project_custom_labs catalog first (upsert by name)
      const { error: clErr } = await sb.from("project_custom_labs").upsert({
        project_id: selectedProject.id,
        name:       customName,
        unit:       customUnit
      }, { onConflict: "project_id,name", ignoreDuplicates: false });
      // Non-fatal if catalog save fails (RLS or duplicate)
      if (clErr) console.warn("project_custom_labs upsert:", clErr.message);

      // Direct insert to labs_long bypassing catalog
      const { error } = await sb.from("labs_long").insert({
        project_id:   selectedProject.id,
        patient_code: patient_code,
        lab_date:     el.labDate?.value || null,
        lab_name:     customName,
        lab_value:    String(rawVal),
        lab_unit:     customUnit
      });
      if (error) throw error;
      toast(`已添加自定义化验：${customName} ${rawVal} ${customUnit}`);
      if (el.labCustomName) el.labCustomName.value = "";
      if (el.labCustomUnit) el.labCustomUnit.value = "";
      await loadProjectCustomLabs();
    } else if (isProjCustom){
      // Project custom lab from dropdown
      const clId = lab_test_code.slice(5);
      const cl = projectCustomLabs.find(c => c.id === clId);
      if (!cl) throw new Error("找不到所选自定义化验，请刷新页面重试");
      const { error } = await sb.from("labs_long").insert({
        project_id:   selectedProject.id,
        patient_code: patient_code,
        lab_date:     el.labDate?.value || null,
        lab_name:     cl.name,
        lab_value:    String(rawVal),
        lab_unit:     cl.unit
      });
      if (error) throw error;
      toast(`已添加化验：${cl.name} ${rawVal} ${cl.unit}`);
    } else {
      const { data, error } = await sb.rpc("upsert_lab_record", {
        p_project_id:    selectedProject.id,
        p_patient_code:  patient_code,
        p_lab_date:      el.labDate?.value || null,
        p_lab_test_code: lab_test_code,
        p_value_raw:     rawVal,
        p_unit_symbol:   unit,
        p_measured_at:   null,
        p_lab_id:        null
      });
      if (error) throw error;

      // If qc_reason was filled, update it on the record
      const reason = el.labQcReason?.value.trim();
      if (reason && data) {
        await sb.from("labs_long").update({ qc_reason: reason }).eq("id", data);
      }

      const cat = labCatalog.find(c => c.code === lab_test_code);
      toast(`已添加化验记录：${cat?.name_cn || lab_test_code} ${rawVal} ${unit}`);
    }

    el.labTestCode.value = "";
    el.labValue.value = "";
    el.labUnit.innerHTML = '<option value="">-- 先选化验项目 --</option>';
    if (el.labStdValue) el.labStdValue.value = "";
    if (el.labQcReason) el.labQcReason.value = "";
    if (el.labQcReasonCol) el.labQcReasonCol.style.display = "none";
    if (el.labHint) el.labHint.textContent = "";
    updateLabUnits(); // reset custom field visibility
    await loadExtras();
    await loadSnapshots();
    loadIssueSummary();
  }catch(e){
    console.error(e);
    const hint = e?.message || String(e);
    // If duplicate warning from DB, show qc_reason field
    if (!isCustom && (hint.includes("duplicate") || hint.includes("重复") || hint.includes("unit_not_allowed") || hint.includes("单位"))) {
      if (el.labQcReasonCol) el.labQcReasonCol.style.display = "";
    }
    toast("添加失败：" + hint);
  }finally{
    setBusy(btn, false);
  }
}

async function addMed(){
  if (!selectedProject) return toast("请先选择项目");
  const patient_code = el.medPatientCode?.value.trim();
  if (!patient_code) return toast("请填写用药记录的 patient_code");
  const drug_name = el.medName?.value.trim();
  if (!drug_name) return toast("请填写 drug_name");
  const payload = {
    project_id: selectedProject.id,
    patient_code,
    drug_name,
    drug_class: el.medClass?.value.trim() || null,
    dose: el.medDose?.value.trim() || null,
    start_date: el.medStart?.value || null,
    end_date: el.medEnd?.value || null
  };
  const btn = el.btnAddMed;
  btn.dataset.label = "添加用药记录";
  setBusy(btn,true);
  try{
    const { error } = await sb.from("meds_long").insert(payload);
    if (error) throw error;
    toast("已添加用药记录");
    if (el.medName) el.medName.value = "";
    if (el.medDose) el.medDose.value = "";
    await loadExtras();
  await loadSnapshots();
  }catch(e){
    console.error(e);
    toast("添加失败：" + (e?.message || e));
  }finally{
    setBusy(btn,false);
  }
}


async function addEvent(){
  if (!selectedProject) return toast("请先选择项目");
  const patient_code = el.evtPatientCode?.value.trim();
  if (!patient_code) return toast("请填写 patient_code");
  const event_type = el.evtType?.value;
  if (!event_type) return toast("请选择事件类型");
  const payload = {
    project_id: selectedProject.id,
    patient_code,
    event_type,
    event_date: el.evtDate?.value || null,
    confirmed: true,
    source: "manual",
    notes: el.evtNotes?.value.trim().slice(0, 500) || null,
  };
  const btn = el.btnAddEvent;
  btn.dataset.label = "录入终点事件";
  setBusy(btn, true);
  try{
    const { error } = await sb.from("events_long").insert(payload);
    if (error) throw error;
    toast("已录入终点事件");
    if (el.evtDate) el.evtDate.value = "";
    if (el.evtNotes) el.evtNotes.value = "";
    await loadExtras();
  await loadSnapshots();
  }catch(e){
    console.error(e);
    toast("录入失败：" + (e?.message || e));
  }finally{
    setBusy(btn, false);
  }
}


async function exportTable(kind){
  if (!selectedProject) return toast("请先选择项目");
  const pid = selectedProject.id;
  const center_code = selectedProject.center_code;
  const module = selectedProject.module;

  let table = "";
  let columns = [];
  let filename = "";

  if (kind === "baseline"){
    table = "patients_baseline";
    columns = [
      "center_code","module","patient_code","sex","birth_year","baseline_date","baseline_scr","baseline_upcr",
      "biopsy_date","oxford_m","oxford_e","oxford_s","oxford_t","oxford_c",
      "ln_biopsy_date","ln_class","ln_activity_index","ln_chronicity_index","ln_podocytopathy",
      "treatment_arm","randomization_id","randomization_date",
      "created_at"
    ];
    filename = `patients_baseline_${center_code}_${fmtDate(new Date())}.csv`;
  } else if (kind === "visits"){
    table = "visits_long";
    columns = ["center_code","module","patient_code","visit_date","sbp","dbp","scr_umol_l","upcr","egfr","notes","created_at"];
    filename = `visits_long_${center_code}_${fmtDate(new Date())}.csv`;
  } else if (kind === "labs"){
    table = "labs_long";
    columns = ["center_code","module","patient_code","lab_date","lab_name","lab_value","lab_unit","created_at"];
    filename = `labs_long_${center_code}_${fmtDate(new Date())}.csv`;
  } else if (kind === "meds"){
    table = "meds_long";
    columns = ["center_code","module","patient_code","drug_name","drug_class","dose","start_date","end_date","created_at"];
    filename = `meds_long_${center_code}_${fmtDate(new Date())}.csv`;
  } else if (kind === "variants"){
    table = "variants_long";
    columns = ["center_code","module","patient_code","test_date","test_name","gene","variant","hgvs_c","hgvs_p","transcript","zygosity","classification","lab_name","notes","created_at"];
    filename = `variants_long_${center_code}_${fmtDate(new Date())}.csv`;
  } else if (kind === "events"){
    table = "events_long";
    columns = ["center_code","module","patient_code","event_type","event_date","confirmed","source","notes","created_at"];
    filename = `events_long_${center_code}_${fmtDate(new Date())}.csv`;
  }

  try{
    const { data, error } = await sb.from(table).select("*").eq("project_id", pid).order("created_at", {ascending:true});
    if (error) throw error;
    const rows = (data||[]).map(r=>({
      center_code,
      module,
      ...r
    }));
    const csv = toCsv(rows, columns);
    downloadCsvUtf8Bom(filename, csv);
    await sb.rpc("log_project_audit", {
      p_project_id: pid,
      p_action: "export_csv",
      p_snapshot_id: null,
      p_details: { kind, filename, rows: rows.length }
    });
    toast("已导出：" + filename);
  }catch(e){
    console.error(e);
    toast("导出失败：" + (e?.message || e));
  }
}


async function fetchProjectRows(pid, center_code, module){
  const [baseline, visits, labs, meds, vars, evts] = await Promise.all([
    sb.from("patients_baseline").select("*").eq("project_id", pid),
    sb.from("visits_long").select("*").eq("project_id", pid),
    sb.from("labs_long").select("*").eq("project_id", pid),
    sb.from("meds_long").select("*").eq("project_id", pid),
    sb.from("variants_long").select("*").eq("project_id", pid),
    sb.from("events_long").select("*").eq("project_id", pid),
  ]);
  const check = [baseline, visits, labs, meds, vars].find(x=>x.error);
  if (check) throw check.error;
  return {
    bRows: (baseline.data||[]).map(r=>({center_code, module, ...r})),
    vRows: (visits.data||[]).map(r=>({center_code, module, ...r})),
    lRows: (labs.data||[]).map(r=>({center_code, module, ...r})),
    mRows: (meds.data||[]).map(r=>({center_code, module, ...r})),
    gRows: (vars.data||[]).map(r=>({center_code, module, ...r})),
    eRows: (evts.error ? [] : (evts.data||[])).map(r=>({center_code, module, ...r})),
  };
}

function calcQcSummary(vRows){
  const n = vRows.length || 0;
  const miss = (k)=>vRows.filter(r=>r[k]===null || r[k]===undefined || r[k]==="").length;
  return {
    n_visits: n,
    missing: {
      sbp: miss("sbp"), dbp: miss("dbp"), scr_umol_l: miss("scr_umol_l"), upcr: miss("upcr")
    },
    missing_rate_pct: n ? Number(((vRows.filter(r=>r.sbp==null||r.dbp==null||r.scr_umol_l==null||r.upcr==null).length / n) * 100).toFixed(2)) : 0
  };
}

async function createSnapshot(kind = "snapshot"){
  if (!selectedProject) return null;
  const { data, error } = await sb.rpc("create_project_snapshot", {
    p_project_id: selectedProject.id,
    p_kind: kind,
    p_filter_summary: { module: selectedProject.module, center_code: selectedProject.center_code },
    p_schema_version: "core_v2"
  });
  if (error) throw error;
  return data?.[0] || null;
}

async function createSnapshotOnly(){
  if (!selectedProject) return toast("请先选择项目");
  const btn = el.btnCreateSnapshot;
  btn.dataset.label = "生成数据快照（Snapshot）";
  setBusy(btn, true);
  try{
    const snap = await createSnapshot("snapshot");
    if (snap){
      el.snapshotOut.style.display = "block";
      el.snapshotOut.innerHTML = `<div><b>已创建 Snapshot：</b><code>${escapeHtml(snap.snapshot_id)}</code></div>`;
      await loadSnapshots();
      toast("Snapshot 已创建");
    }
  }catch(e){
    console.error(e);
    toast("创建 Snapshot 失败：" + (e?.message || e));
  }finally{ setBusy(btn,false); }
}

function citationText(snapshotId, createdAt){
  const d = createdAt ? String(createdAt).slice(0,10) : fmtDate(new Date());
  return `Data snapshot v3.0 (Snapshot ID: ${snapshotId}) exported on ${d}.`;
}

async function lockSnapshot(rowId){
  const ok = window.confirm("锁定后不可覆盖；如需更新请新建快照。确认锁定？");
  if (!ok) return;
  const { error } = await sb.rpc("lock_project_snapshot", { p_snapshot_id: rowId });
  if (error){ toast("锁定失败：" + error.message); return; }
  toast("已锁定快照");
  await loadSnapshots();
}

async function loadSnapshots(){
  if (!selectedProject || !el.snapshotsList) return;
  const { data, error } = await sb.rpc("list_project_snapshots", { p_project_id: selectedProject.id });
  if (error){
    el.snapshotsList.innerHTML = `<div class='muted small'>读取 snapshots 失败：${escapeHtml(error.message)}</div>`;
    return;
  }
  const rows = data || [];
  if (!rows.length){
    el.snapshotsList.innerHTML = "<div class='muted small'>暂无 Snapshot。</div>";
    return;
  }
  const trs = rows.map(r=>`<tr>
    <td><code>${escapeHtml(r.snapshot_id)}</code></td>
    <td>${escapeHtml(fmtDate(r.created_at))}</td>
    <td>${escapeHtml(r.status)}</td>
    <td>${escapeHtml(r.n_patients ?? "")}</td>
    <td>${escapeHtml(r.n_visits ?? "")}</td>
    <td>${escapeHtml(r.missing_rate ?? "")}%</td>
    <td>
      <button class='btn small' data-act='copy' data-id='${escapeHtml(r.snapshot_id)}' data-at='${escapeHtml(r.created_at)}'>复制引用</button>
      ${r.status !== 'locked' ? `<button class='btn small danger' data-act='lock' data-row='${escapeHtml(r.id)}'>锁定</button>` : ""}
    </td>
  </tr>`).join("");
  el.snapshotsList.innerHTML = `<table class='table'><thead><tr><th>快照编号</th><th>创建时间</th><th>状态</th><th>患者数</th><th>随访次数</th><th>缺失率</th><th>操作</th></tr></thead><tbody>${trs}</tbody></table>`;
  qsa("button[data-act='copy']", el.snapshotsList).forEach(b=>b.addEventListener("click", async ()=>{
    const txt = citationText(b.dataset.id, b.dataset.at);
    await navigator.clipboard.writeText(txt);
    toast("已复制论文引用语句");
  }));
  qsa("button[data-act='lock']", el.snapshotsList).forEach(b=>b.addEventListener("click", ()=>lockSnapshot(b.dataset.row)));
}

// Issue 严重度中文标签
const SEVERITY_LABEL = { critical:"严重", warning:"警告", info:"提示" };
const SEVERITY_CSS   = { critical:"issue-critical", warning:"issue-warning", info:"issue-info" };

async function loadIssueSummary(){
  if (!selectedProject || !el.issueSummary) return;
  const { data, error } = await sb.rpc("get_issue_summary", { p_project_id: selectedProject.id });
  if (error || !data){ el.issueSummary.textContent = "暂无质控数据"; return; }
  const total = (data.total_open || 0) + (data.total_in_prog || 0);
  const by = data.by_severity || {};
  el.issueSummary.innerHTML =
    total === 0
      ? `<span class="issue-badge issue-resolved">✓ 无未解决 Issue</span>　关闭率 ${data.close_rate_pct ?? 0}%`
      : `未解决：
         ${by.critical ? `<span class='issue-badge issue-critical'>${by.critical} 严重</span> ` : ""}
         ${by.warning  ? `<span class='issue-badge issue-warning'>${by.warning} 警告</span> ` : ""}
         ${by.info     ? `<span class='issue-badge issue-info'>${by.info} 提示</span>` : ""}
         　已关闭 ${data.total_resolved + data.total_wontfix || 0} 条，关闭率 ${data.close_rate_pct ?? 0}%`;
}

async function loadIssues(){
  if (!selectedProject || !el.issueList) return;
  const { data, error } = await sb.from("data_issues")
    .select("id,patient_code,record_type,rule_code,severity,status,message,created_at")
    .eq("project_id", selectedProject.id)
    .not("status", "in", '("RESOLVED","WONT_FIX")')
    .order("severity")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error){ el.issueList.innerHTML = `<div class='muted small'>加载失败：${escapeHtml(error.message)}</div>`; return; }
  const rows = data || [];
  if (!rows.length){ el.issueList.innerHTML = "<div class='muted small'>太好了！暂无未解决的质控 Issue。</div>"; return; }
  el.issueList.innerHTML = `
    <table class='table' style='font-size:13px'>
      <thead><tr><th>严重度</th><th>患者编号</th><th>记录类型</th><th>规则</th><th>说明</th><th>操作</th></tr></thead>
      <tbody>
      ${rows.map(r => `<tr>
        <td><span class='issue-badge ${SEVERITY_CSS[r.severity]}'>${SEVERITY_LABEL[r.severity]}</span></td>
        <td>${escapeHtml(r.patient_code)}</td>
        <td>${escapeHtml(r.record_type)}</td>
        <td><code>${escapeHtml(r.rule_code)}</code></td>
        <td>${escapeHtml(r.message.slice(0,60))}${r.message.length > 60 ? "…" : ""}</td>
        <td>
          <button class='btn small' data-issue-id='${r.id}' data-act='wontfix'>标记不修复</button>
        </td>
      </tr>`).join("")}
      </tbody>
    </table>`;
  qsa("button[data-act='wontfix']", el.issueList).forEach(btn => {
    btn.addEventListener("click", async () => {
      const reason = window.prompt("请说明为何不修复此 Issue（必填）：");
      if (!reason?.trim()) return toast("原因不能为空");
      const { error: e2 } = await sb.rpc("close_issue_wont_fix", {
        p_issue_id: btn.dataset.issueId, p_resolution: reason.trim()
      });
      if (e2){ toast("操作失败：" + e2.message); return; }
      toast("已标记为不修复");
      loadIssues();
      loadIssueSummary();
    });
  });
}

async function generatePaperPack({ withSnapshot = false } = {}){
  if (!selectedProject) return toast("请先选择项目");
  if (typeof JSZip === "undefined") return toast("JSZip 未加载，无法打包");

  const btn = el.btnPaperPack;
  btn.dataset.label = "一键生成论文包（zip）";
  setBusy(btn,true);

  try{
    const pid = selectedProject.id;
    const center_code = selectedProject.center_code;
    const module = selectedProject.module;
    const project_name = selectedProject.name;

    const { bRows, vRows, lRows, mRows, gRows, eRows } = await fetchProjectRows(pid, center_code, module);
    const qcSummary = calcQcSummary(vRows);
    const snapshot = withSnapshot ? await createSnapshot("paper_package") : null;
    const snapshotId = snapshot?.snapshot_id || `TEMP-${Date.now()}`;

    const today = new Date().toISOString().slice(0,10);
    const meta = {
      export_version: "core_v2",
      exported_at: new Date().toISOString(),
      project_id: pid,
      project_name,
      center_code,
      module,
      counts: {
        patients: bRows.length,
        visits: vRows.length,
        labs: lRows.length,
        meds: mRows.length,
        variants: gRows.length,
        events: eRows.length
      },
      merge_key: "center_code + patient_code",
      pii_policy: "No PII allowed in this system."
    };

    // columns fixed
    const csvBaseline = toCsv(bRows, ["center_code","module","patient_code","sex","birth_year","baseline_date","baseline_scr","baseline_upcr","biopsy_date","oxford_m","oxford_e","oxford_s","oxford_t","oxford_c","ln_biopsy_date","ln_class","ln_activity_index","ln_chronicity_index","ln_podocytopathy","treatment_arm","randomization_id","randomization_date","created_at"]);
    const csvVisits = toCsv(vRows, ["center_code","module","patient_code","visit_date","sbp","dbp","scr_umol_l","upcr","egfr","egfr_formula_version","notes","created_at"]);
    const csvLabs = toCsv(lRows, ["center_code","module","patient_code","lab_date","lab_test_code","lab_name","value_raw","unit_symbol","value_standard","standard_unit","lab_value","lab_unit","created_at"]);
    const csvMeds = toCsv(mRows, ["center_code","module","patient_code","drug_name","drug_class","dose","start_date","end_date","created_at"]);
    const csvVars = toCsv(gRows, ["center_code","module","patient_code","test_date","test_name","gene","variant","hgvs_c","hgvs_p","transcript","zygosity","classification","lab_name","notes","created_at"]);
    const csvEvents = toCsv(eRows, ["center_code","module","patient_code","event_type","event_date","confirmed","source","notes","created_at"]);

    // fetch template files (served as static assets)
    const [runPy, reqTxt, methodsTpl, readmeTpl] = await Promise.all([
      fetch("/assets/template/run_analysis.py").then(r=>r.text()),
      fetch("/assets/template/requirements.txt").then(r=>r.text()),
      fetch("/assets/template/METHODS_TEMPLATE_EN.md").then(r=>r.text()),
      fetch("/assets/template/README_PACK.md").then(r=>r.text())
    ]);

    const methods = methodsTpl
      .replaceAll("{{PROJECT_NAME}}", project_name)
      .replaceAll("{{CENTER_CODE}}", center_code)
      .replaceAll("{{MODULE}}", module)
      .replaceAll("{{EXPORT_DATE}}", today)
      .replaceAll("{{N_PATIENTS}}", String(bRows.length))
      .replaceAll("{{N_VISITS}}", String(vRows.length));

    const readme = readmeTpl
      .replaceAll("{{PROJECT_NAME}}", project_name)
      .replaceAll("{{EXPORT_DATE}}", today);

    const zip = new JSZip();
    zip.file("EXPORT_METADATA.json", JSON.stringify(meta, null, 2));

    const analysisFolder = zip.folder("analysis");
    analysisFolder.file("run_analysis.py", runPy);
    analysisFolder.file("requirements.txt", reqTxt);

    const dataFolder = analysisFolder.folder("data");
    // add BOM to CSV inside zip as well for Excel friendliness
    const BOM = "\ufeff";
    dataFolder.file("patients_baseline.csv", BOM + csvBaseline);
    dataFolder.file("visits_long.csv", BOM + csvVisits);
    dataFolder.file("labs_long.csv", BOM + csvLabs);
    dataFolder.file("meds_long.csv", BOM + csvMeds);
    dataFolder.file("variants_long.csv", BOM + csvVars);
    dataFolder.file("events_long.csv", BOM + csvEvents);
    analysisFolder.folder("outputs").file(".keep","");

    const ms = zip.folder("manuscript");
    ms.file("METHODS_AUTO_EN.md", methods);
    ms.file("README.md", readme);

    // ── PR-9 顶刊必备三件套 ─────────────────────────────────────────────────

    // 1. data_dictionary.json — 字段定义、单位、换算规则、eGFR 公式版本
    const dataDictionary = {
      schema_version: "core_v2",
      generated_at: new Date().toISOString(),
      egfr_formula: "CKD-EPI-2021-Cr",
      egfr_reference: "Inker et al., NEJM 2021;385:1737-1749",
      missing_value_convention: "empty cell = not measured (not zero)",
      merge_key: "center_code + patient_code",
      pii_policy: "No PII stored. All records use center-assigned research codes only.",
      tables: {
        patients_baseline: {
          patient_code: "Center-assigned research ID (NOT name/MRN). Format: centerId-year-seq, e.g. BJ01-2024-001",
          sex: "M=Male, F=Female",
          birth_year: "Year of birth (integer)",
          baseline_scr: "Serum creatinine at baseline, unit: μmol/L",
          baseline_upcr: "Urine PCR at baseline, unit: mg/g",
          oxford_m: "Oxford-MEST M score: 0 or 1",
          oxford_e: "Oxford-MEST E score: 0 or 1",
          oxford_s: "Oxford-MEST S score: 0 or 1",
          oxford_t: "Oxford-MEST T score: 0, 1 or 2",
          oxford_c: "Oxford-MEST C score: 0, 1 or 2",
          ln_biopsy_date: "Date of kidney biopsy for lupus nephritis (YYYY-MM-DD)",
          ln_class: "ISN/RPS 2003/2018 lupus nephritis class: I II III-A III-A/C III-C IV-S(A) IV-G(A) IV-S(A/C) IV-G(A/C) IV-S(C) IV-G(C) V VI",
          ln_activity_index: "NIH Activity Index (AI), range 0–24",
          ln_chronicity_index: "NIH Chronicity Index (CI), range 0–12",
          ln_podocytopathy: "Podocytopathy (2018 ISN/RPS revision): true / false / null (not assessed)"
        },
        visits_long: {
          visit_date: "Date of this follow-up visit (YYYY-MM-DD)",
          sbp: "Systolic BP (mmHg)",
          dbp: "Diastolic BP (mmHg)",
          scr_umol_l: "Serum creatinine (μmol/L). Multiply by 0.01131 to convert to mg/dL",
          upcr: "Urine PCR (mg/g). Divide by 1000 to convert to g/g",
          egfr: "eGFR (mL/min/1.73m²), see egfr_formula_version for calculation method",
          egfr_formula_version: "CKD-EPI-2021-Cr = computed by system; manual = user-entered; missing_inputs = sex/age missing"
        },
        labs_long: {
          lab_test_code: "Standardized test code from lab_test_catalog (e.g. CREAT, UPCR, HGB)",
          value_raw: "Original value as entered by the user",
          unit_symbol: "Unit as entered",
          value_standard: "Value converted to standard unit (see standard_unit column)",
          standard_unit: "Standard unit for this test; all centers use this for merged analysis"
        }
      },
      lab_catalog_summary: labCatalog.map(c => ({
        code: c.code, name_cn: c.name_cn, standard_unit: c.standard_unit,
        is_core: c.is_core, module: c.module
      })),
      unit_conversion_examples: [
        { from: "CREAT 88.4 μmol/L", to: "1.00 mg/dL", formula: "÷88.4" },
        { from: "UPCR 2000 mg/g",    to: "2.00 g/g",   formula: "÷1000" },
        { from: "HGB 120 g/L",       to: "12.0 g/dL",  formula: "÷10"   }
      ]
    };
    zip.file("data_dictionary.json", JSON.stringify(dataDictionary, null, 2));

    // 2. qc_report.csv — 核心字段缺失率 + Issue 统计（按中心）
    const { data: issueRows } = await sb
      .from("data_issues")
      .select("severity,status")
      .eq("project_id", pid);
    const openIssues = (issueRows || []).filter(i => !["RESOLVED","WONT_FIX"].includes(i.status));
    const closedIssues = (issueRows || []).filter(i => ["RESOLVED","WONT_FIX"].includes(i.status));
    const qcReportRows = [{
      center_code,
      n_patients: bRows.length,
      n_visits: vRows.length,
      missing_sbp_pct: qcSummary.missing?.sbp > 0 ? ((qcSummary.missing.sbp / vRows.length * 100).toFixed(1) + "%") : "0%",
      missing_scr_pct: qcSummary.missing?.scr_umol_l > 0 ? ((qcSummary.missing.scr_umol_l / vRows.length * 100).toFixed(1) + "%") : "0%",
      missing_upcr_pct: qcSummary.missing?.upcr > 0 ? ((qcSummary.missing.upcr / vRows.length * 100).toFixed(1) + "%") : "0%",
      open_issues_critical: openIssues.filter(i=>i.severity==="critical").length,
      open_issues_warning: openIssues.filter(i=>i.severity==="warning").length,
      open_issues_info: openIssues.filter(i=>i.severity==="info").length,
      issue_close_rate: issueRows?.length > 0
        ? (closedIssues.length / issueRows.length * 100).toFixed(1) + "%" : "N/A",
      generated_at: new Date().toISOString()
    }];
    zip.file("qc_report.csv", "\ufeff" + toCsv(qcReportRows, Object.keys(qcReportRows[0])));

    // 3. snapshot_manifest.json — 快照宣言（可复现性关键文件）
    const snapshotManifest = {
      snapshot_id: snapshotId,
      generated_at: new Date().toISOString(),
      schema_version: "core_v2",
      egfr_formula: "CKD-EPI-2021-Cr",
      project_id: pid,
      project_name,
      center_code,
      module,
      row_counts: {
        patients: bRows.length,
        visits: vRows.length,
        labs: lRows.length,
        medications: mRows.length,
        genetics: gRows.length,
        events: eRows.length
      },
      qc_summary: {
        open_issues: openIssues.length,
        closed_issues: closedIssues.length,
        missing_rate_pct: qcSummary.missing_rate_pct
      },
      usage_note: "Cite this snapshot_id in your Methods section to ensure reproducibility. Share with co-authors to verify identical dataset version."
    };
    zip.file("snapshot_manifest.json", JSON.stringify(snapshotManifest, null, 2));

    zip.file("qc_summary.json", JSON.stringify(qcSummary, null, 2));

    if ((module || "").toUpperCase() === "LN"){
      zip.file("LN_FIELD_DICTIONARY.md", [
        "LN Biopsy (ISN/RPS 2003/2018 Classification):",
        "  ln_class: I | II | III-A | III-A/C | III-C | IV-S(A) | IV-G(A) | IV-S(A/C) | IV-G(A/C) | IV-S(C) | IV-G(C) | V | VI",
        "  ln_activity_index: NIH Activity Index, 0–24",
        "  ln_chronicity_index: NIH Chronicity Index, 0–12",
        "  ln_podocytopathy: true/false/null (2018 ISN/RPS revision)",
        "",
        "References:",
        "  Weening JJ et al. J Am Soc Nephrol 2004;15:241-250 (ISN/RPS 2003)",
        "  Bajema IM et al. Kidney Int 2018;93:789-796 (2018 revision)"
      ].join("\n"));
    }

    if ((module || "").toUpperCase() === "KTX"){
      zip.file("KTX_FIELD_DICTIONARY.md", [
        "KTx Baseline: transplant_date, donor_type, induction_therapy, maintenance_immuno, HLA_mismatch_count, PRA/DSA, baseline_creatinine, baseline_eGFR",
        "KTx Follow-up: Scr/eGFR, urine protein, tac/csa trough, BP, weight, infection, rejection, Banff biopsy, graft_failure_date, death_date, return_to_dialysis"
      ].join("\n"));
      zip.file("ktx_summary.json", JSON.stringify({
        n_bk_or_cmv_events: eRows.filter(r=>/BK|CMV/i.test(String(r.event_type||""))).length,
        n_rejection_events: eRows.filter(r=>/rejection|排斥/i.test(String(r.event_type||""))).length
      }, null, 2));
    }

    const table1 = toCsv(bRows, ["center_code","module","patient_code","sex","birth_year","baseline_date","baseline_scr","baseline_upcr","ln_class","ln_activity_index","ln_chronicity_index","ln_podocytopathy","treatment_arm","randomization_id"]);
    dataFolder.file("table1_baseline.csv", BOM + table1);
    analysisFolder.folder("outputs").file("trend_egfr_placeholder.txt", "Run analysis/run_analysis.py for rendered trajectory plots.");
    analysisFolder.folder("outputs").file("trend_proteinuria_placeholder.txt", "Run analysis/run_analysis.py for rendered trajectory plots.");
    analysisFolder.folder("outputs").file("endpoint_12m_summary.json", JSON.stringify({ n_patients: bRows.length, n_visits: vRows.length }, null, 2));

    const fnameSafe = project_name.replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0,40);
    const zipName = `paper_pack_${fnameSafe}_${today}.zip`;

    const blob = await zip.generateAsync({type:"blob"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 400);
    if (snapshot){
      el.snapshotOut.style.display = "block";
      el.snapshotOut.innerHTML = `<div><b>Snapshot ID：</b><code>${escapeHtml(snapshot.snapshot_id)}</code></div><div class="small" style="margin-top:6px">${escapeHtml(citationText(snapshot.snapshot_id, snapshot.created_at))}</div>`;
      await loadSnapshots();
    }
    await sb.rpc("log_project_audit", {
      p_project_id: pid,
      p_action: "paper_package",
      p_snapshot_id: snapshot?.snapshot_id || null,
      p_details: { zip_name: zipName, with_snapshot: !!snapshot }
    });
    toast("论文包已生成：" + zipName);
  }catch(e){
    console.error(e);
    toast("生成失败：" + (e?.message || e));
  }finally{
    setBusy(btn,false);
  }
}

// ═══════════════════════════════════════════════════════════
// 研究者资料
// ═══════════════════════════════════════════════════════════

async function loadProfile(){
  const { data } = await sb.from("user_profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!data) {
    // 新用户，提示引导
    if (el.profileStatus){
      el.profileStatus.textContent = "请完善资料";
      el.profileStatus.className = "badge warn";
      el.profileStatus.style.display = "inline-flex";
    }
    return;
  }

  // 回填表单
  if (el.profName)     el.profName.value     = data.real_name       || "";
  if (el.profHospital) el.profHospital.value  = data.hospital        || "";
  if (el.profDept)     el.profDept.value      = data.department      || "";
  if (el.profPlan)     el.profPlan.value      = data.interested_plan || "";
  if (el.profContact)  el.profContact.value   = data.contact         || "";
  if (el.profNotes)    el.profNotes.value     = data.notes           || "";

  const hasCore = data.real_name && data.hospital;
  if (el.profileStatus){
    el.profileStatus.textContent = hasCore ? "已填写" : "资料不完整";
    el.profileStatus.className   = `badge ${hasCore ? "ok" : "warn"}`;
    el.profileStatus.style.display = "inline-flex";
  }
}

async function saveProfile(){
  const btn = el.btnSaveProfile;
  btn.dataset.label = "保存资料";
  setBusy(btn, true);
  try {
    const { error } = await sb.rpc("upsert_my_profile", {
      p_real_name:       el.profName?.value.trim()    || null,
      p_hospital:        el.profHospital?.value.trim()|| null,
      p_department:      el.profDept?.value.trim()    || null,
      p_interested_plan: el.profPlan?.value           || null,
      p_contact:         el.profContact?.value.trim() || null,
      p_notes:           el.profNotes?.value.trim()   || null,
    });
    if (error) throw error;
    toast("资料已保存");
    await loadProfile();
  } catch(e) {
    toast("保存失败：" + (e?.message || e));
  } finally {
    setBusy(btn, false);
  }
}

// ═══════════════════════════════════════════════════════════
// 平台管理员功能
// ═══════════════════════════════════════════════════════════

async function adminSearch(){
  if (!isPlatformAdmin){ toast("无管理员权限"); return; }
  const email = el.adminSearchEmail.value.trim();
  if (!email){ toast("请输入邮箱关键词"); return; }
  const btn = el.btnAdminSearch;
  setBusy(btn, true);
  try {
    const { data, error } = await sb.rpc("admin_list_projects", { p_email: email });
    if (error) throw error;
    renderAdminResults(data || []);
  } catch(e) {
    toast("搜索失败：" + (e?.message || e));
  } finally {
    setBusy(btn, false);
  }
}

function planBadgeHtml(plan){
  const map = { partner:"合作伙伴", pro:"Pro", institution:"机构版" };
  const label = map[plan] || "试用";
  const cls   = plan && plan !== "trial" ? "badge ok" : "badge";
  return `<span class="${cls}" style="font-size:11px">${label}</span>`;
}

function renderAdminResults(rows){
  const c = el.adminResults;
  if (!rows.length){
    c.innerHTML = `<div class="muted small">未找到项目。请检查邮箱是否正确。</div>`;
    return;
  }

  // 所有行属于同一用户，资料取第一行
  const first = rows[0];
  const na = v => escapeHtml(v || "—");

  // ── 用户资料区块 ────────────────────────────────────────────
  const profileFilled = first.real_name || first.hospital;
  const profileHtml = `
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <b style="font-size:14px">用户资料</b>
        <span class="badge ${profileFilled?"ok":"warn"}" style="font-size:11px">
          ${profileFilled?"已填写":"未填写"}
        </span>
        <span class="muted small" style="margin-left:auto">${na(first.owner_email)}</span>
      </div>
      <div class="kv" style="grid-template-columns:max-content 1fr max-content 1fr;gap:4px 16px">
        <div class="muted small">姓名</div>      <div>${na(first.real_name)}</div>
        <div class="muted small">医院/单位</div>  <div>${na(first.hospital)}</div>
        <div class="muted small">科室</div>       <div>${na(first.department)}</div>
        <div class="muted small">意向套餐</div>   <div>${na(first.interested_plan)}</div>
        <div class="muted small">联系方式</div>   <div>${na(first.contact)}</div>
        <div class="muted small">备注</div>       <div>${na(first.profile_notes)}</div>
      </div>
      ${first.profile_updated_at
        ? `<div class="muted small" style="margin-top:8px">资料更新：${fmtDate(first.profile_updated_at)}</div>`
        : ""}
    </div>`;

  // ── 项目列表表格 ─────────────────────────────────────────────
  const thead = `<thead><tr>
    <th>项目名称</th><th>中心</th><th>模块</th>
    <th>当前计划</th><th>到期时间</th><th>设定到期</th><th>操作</th>
  </tr></thead>`;

  const rows_html = rows.map(r => {
    const pid = escapeHtml(r.project_id);
    const plan = r.subscription_plan || "trial";
    // 显示当前到期时间（付费用 subscription_active_until，试用用 trial_expires_at）
    const currentExpiry = plan !== "trial" && r.subscription_active_until
      ? fmtDate(r.subscription_active_until)
      : r.trial_expires_at ? fmtDate(r.trial_expires_at) : "—";
    // 日期选择器默认值
    const expiryDefault = plan !== "trial" && r.subscription_active_until
      ? r.subscription_active_until.slice(0,10)
      : r.trial_expires_at ? r.trial_expires_at.slice(0,10) : "";

    return `<tr>
      <td>${escapeHtml(r.project_name)}</td>
      <td>${escapeHtml(r.center_code||"—")}</td>
      <td>${escapeHtml(r.module||"—")}</td>
      <td>${planBadgeHtml(plan)}</td>
      <td style="font-size:12px">${currentExpiry}</td>
      <td>
        <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
          <select id="pplan_${pid}" style="width:90px;font-size:12px">
            <option value="trial"${plan==="trial"?" selected":""}>试用</option>
            <option value="pro"${plan==="pro"?" selected":""}>Pro</option>
            <option value="institution"${plan==="institution"?" selected":""}>机构版</option>
            <option value="partner"${plan==="partner"?" selected":""}>合作伙伴</option>
          </select>
          <input id="pexp_${pid}" type="date" value="${expiryDefault}" style="width:130px;font-size:12px"/>
          <button class="btn small" onclick="adminSetExpiry('${pid}')">设定</button>
        </div>
      </td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn small" onclick="adminExtend('${pid}',30)">+30天</button>
          <button class="btn small" onclick="adminExtend('${pid}',90)">+90天</button>
          <button class="btn small primary" onclick="adminPartner('${pid}')">合作伙伴</button>
          <button class="btn small" style="color:#c0392b" onclick="adminReset('${pid}')">撤回</button>
        </div>
      </td>
    </tr>`;
  }).join("");

  c.innerHTML = profileHtml +
    `<b style="font-size:13px">项目列表（${rows.length} 个）</b>
     <table class="table" style="font-size:13px;margin-top:6px">${thead}<tbody>${rows_html}</tbody></table>`;
}

async function adminExtend(projectId, days){
  if (!confirm(`延长试用 ${days} 天？`)) return;
  const { error } = await sb.rpc("admin_adjust_trial", {
    p_project_id: projectId, p_extra_days: days
  });
  if (error){ toast("操作失败：" + error.message); return; }
  toast(`已延长 ${days} 天`);
  adminSearch();
}

async function adminPartner(projectId){
  if (!confirm("设为合作伙伴（长期免费）？")) return;
  const { error } = await sb.rpc("admin_set_partner", { p_project_id: projectId });
  if (error){ toast("操作失败：" + error.message); return; }
  toast("已设为合作伙伴");
  adminSearch();
}

async function adminReset(projectId){
  if (!confirm("撤回为普通试用（30天，从今天计算）？")) return;
  const { error } = await sb.rpc("admin_reset_to_trial", { p_project_id: projectId });
  if (error){ toast("操作失败：" + error.message); return; }
  toast("已重置为普通试用");
  adminSearch();
}

// ═══════════════════════════════════════════════════════════
// 合作申请（用户侧）
// ═══════════════════════════════════════════════════════════

const CONTRACT_STATUS_LABEL = {
  pending:  { text:"审批中",   cls:"badge warn" },
  approved: { text:"已批准",   cls:"badge ok"   },
  rejected: { text:"未通过",   cls:"badge bad"  },
  cancelled:{ text:"已取消",   cls:"badge"      },
};

async function loadMyContract(){
  const { data: rows } = await sb.rpc("get_my_contract");
  const c = el.contractStatus;
  const form = el.contractApplyForm;
  if (!c || !form) return;

  // get_my_contract returns a table → rows is an array
  const data = Array.isArray(rows) ? rows[0] : rows;

  if (!data) {
    // 没有申请记录 → 显示申请表单
    c.innerHTML = `<div class="muted small">暂无申请记录。如贵中心符合条件，请填写后提交。</div>`;
    form.style.display = "block";
    // 预填微信号（如果用户资料里已有联系方式）
    if (el.contractWechat && el.profContact?.value) {
      el.contractWechat.value = el.profContact.value;
    }
    return;
  }

  const s = CONTRACT_STATUS_LABEL[data.status] || { text: data.status, cls:"badge" };
  form.style.display = "none";

  let extra = "";
  if (data.status === "approved" && data.payment_status === "unpaid"){
    extra = `<div class="infobox" style="margin-top:8px">
      <b>审批已通过！</b> 平台将与您联系确认付款方式。付款完成后权益自动开通。<br/>
      套餐：<b>${data.plan || data.apply_plan}</b>
      ${data.annual_price_cny ? `· 协议价：<b>¥${data.annual_price_cny}/年</b>` : ""}
      ${data.admin_note ? `<br/>备注：${escapeHtml(data.admin_note)}` : ""}
    </div>`;
  } else if (data.status === "approved" && data.payment_status === "paid"){
    extra = `<div class="infobox" style="margin-top:8px">
      权益已激活，到期：<b>${data.expires_at ? fmtDate(data.expires_at) : "—"}</b>
    </div>`;
  } else if (data.status === "rejected"){
    extra = `<div class="warnbox" style="margin-top:8px">
      申请未通过。${data.admin_note ? `原因：${escapeHtml(data.admin_note)}` : ""}
      <br/><a href="#" onclick="resetContractForm(event)" style="color:inherit">重新申请</a>
    </div>`;
  }

  c.innerHTML = `<div style="display:flex;align-items:center;gap:8px">
    <span class="${s.cls}">${s.text}</span>
    <span class="muted small">申请套餐：${data.apply_plan}
      · 提交于 ${fmtDate(data.applied_at)}</span>
  </div>${extra}`;
}

function resetContractForm(e){
  e.preventDefault();
  if (el.contractStatus) el.contractStatus.innerHTML = "";
  if (el.contractApplyForm) el.contractApplyForm.style.display = "block";
}

async function applyContract(){
  const plan   = el.contractPlan?.value;
  const wechat = el.contractWechat?.value.trim() || "";
  const note   = el.contractNote?.value.trim() || null;

  if (!wechat) {
    toast("请填写微信号，方便平台联系您");
    el.contractWechat?.focus();
    return;
  }

  const btn  = el.btnApplyContract;
  btn.dataset.label = "提交申请";
  setBusy(btn, true);
  try {
    // 将微信号保存到用户资料的联系方式字段
    await sb.rpc("upsert_my_profile", {
      p_real_name:       el.profName?.value.trim()    || null,
      p_hospital:        el.profHospital?.value.trim()|| null,
      p_department:      el.profDept?.value.trim()    || null,
      p_interested_plan: el.profPlan?.value            || null,
      p_contact:         wechat,
      p_notes:           el.profNotes?.value.trim()   || null,
    });

    const { error } = await sb.rpc("apply_partner_contract", {
      p_plan: plan, p_note: note
    });
    if (error) throw error;
    toast("申请已提交，平台将在 1–2 个工作日内联系您");
    await loadMyContract();
  } catch(e) {
    toast("提交失败：" + (e?.message || e));
  } finally {
    setBusy(btn, false);
  }
}

// ═══════════════════════════════════════════════════════════
// 合同管理（管理员侧）
// ═══════════════════════════════════════════════════════════

async function adminLoadContracts(){
  if (!isPlatformAdmin) return;
  const { data, error } = await sb.rpc("admin_list_contracts");
  if (error){
    if(el.adminContracts) el.adminContracts.innerHTML =
      `<span class="muted small" style="color:#c0392b">加载失败：${escapeHtml(error.message)}</span>`;
    return;
  }
  renderAdminContracts(data || []);
}

function renderAdminContracts(rows){
  const c = el.adminContracts;
  if (!c) return;

  const pending = rows.filter(r => r.status === "pending");
  const approved = rows.filter(r => r.status === "approved");

  if (el.adminContractsBadge){
    if (pending.length){
      el.adminContractsBadge.textContent = `${pending.length} 待审批`;
      el.adminContractsBadge.style.display = "inline-flex";
    } else {
      el.adminContractsBadge.style.display = "none";
    }
  }

  if (!rows.length){
    c.innerHTML = `<div class="muted small">暂无申请记录。</div>`;
    return;
  }

  const cardHtml = rows.map(r => {
    const na = v => escapeHtml(v || "—");
    const s  = CONTRACT_STATUS_LABEL[r.status] || { text: r.status, cls:"badge" };
    const cid = escapeHtml(r.contract_id);

    // 待审批：显示审批表单
    const reviewForm = r.status === "pending" ? `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0">
        <div>
          <label style="font-size:12px">折扣（%优惠）</label>
          <input id="disc_${cid}" type="number" min="1" max="99" placeholder="如 40 = 6折"
                 style="width:90px" value="${r.discount_pct || ""}"/>
        </div>
        <div>
          <label style="font-size:12px">授予套餐</label>
          <select id="plan_${cid}" style="width:110px">
            <option value="institution" ${r.apply_plan==="institution"?"selected":""}>机构版</option>
            <option value="pro"         ${r.apply_plan==="pro"?"selected":""}>Pro</option>
            <option value="partner">合作伙伴</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px">协议年费（元）</label>
          <input id="price_${cid}" type="number" step="100" placeholder="如 6000"
                 style="width:100px" value="${r.annual_price_cny || ""}"/>
        </div>
        <div style="flex:1;min-width:120px">
          <label style="font-size:12px">备注</label>
          <input id="note_${cid}" placeholder="可选" value="${escapeHtml(r.admin_note||"")}"/>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn small primary" onclick="adminApproveContract('${cid}')">✅ 批准</button>
          <button class="btn small" style="color:#c0392b" onclick="adminRejectContractPrompt('${cid}')">❌ 拒绝</button>
          <button class="btn small" style="color:#888" onclick="adminCancelContract('${cid}')">取消</button>
        </div>
      </div>` : "";

    // 已批准：显示管理操作（付款状态、到期时间、取消）
    const approvedForm = r.status === "approved" ? `
      <div style="display:flex;gap:8px;align-items:flex-end;margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0;flex-wrap:wrap">
        <div>
          <label style="font-size:12px">付款状态</label>
          <select id="pay_${cid}" style="width:100px;font-size:12px">
            <option value="unpaid"${r.payment_status==="unpaid"?" selected":""}>未付款</option>
            <option value="paid"${r.payment_status==="paid"?" selected":""}>已付款</option>
            <option value="overdue"${r.payment_status==="overdue"?" selected":""}>逾期</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px">授予套餐</label>
          <select id="cplan_${cid}" style="width:100px;font-size:12px">
            <option value="pro"${(r.plan||r.apply_plan)==="pro"?" selected":""}>Pro</option>
            <option value="institution"${(r.plan||r.apply_plan)==="institution"?" selected":""}>机构版</option>
            <option value="partner"${(r.plan||r.apply_plan)==="partner"?" selected":""}>合作伙伴</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px">到期日</label>
          <input id="cexp_${cid}" type="date" value="${
            r.expires_at ? r.expires_at.slice(0,10) :
            new Date(Date.now()+365*864e5).toISOString().slice(0,10)
          }" style="width:130px;font-size:12px"/>
        </div>
        <div style="flex:1;min-width:100px">
          <label style="font-size:12px">备注</label>
          <input id="cnote_${cid}" placeholder="可选" value="${escapeHtml(r.admin_note||"")}" style="font-size:12px"/>
        </div>
        <div style="display:flex;gap:6px">
          ${r.payment_status !== "paid" ?
            `<button class="btn small primary" onclick="adminActivateContract('${cid}')">💳 确认收款</button>` : ""}
          <button class="btn small" onclick="adminUpdateContract('${cid}')">保存修改</button>
          <button class="btn small" style="color:#c0392b" onclick="adminCancelContract('${cid}')">取消合同</button>
        </div>
      </div>
      ${r.payment_status === "paid" ? `<div class="muted small" style="margin-top:6px">
        已激活 · 到期：${r.expires_at ? fmtDate(r.expires_at) : "—"}
        · 付款：${r.paid_at ? fmtDate(r.paid_at) : "—"}
      </div>` : ""}
    ` : "";

    const activateForm = "";
    const activeInfo = "";

    return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <span class="${s.cls}" style="font-size:11px">${s.text}</span>
        <b style="font-size:13px">${na(r.real_name)}</b>
        <span class="muted small">${na(r.owner_email)}</span>
        <span class="muted small">·</span>
        <span class="muted small">${na(r.hospital)} ${na(r.department)}</span>
        ${r.contact ? `<span class="muted small">· 微信: ${escapeHtml(r.contact)}</span>` : ""}
        <span class="muted small" style="margin-left:auto">${fmtDate(r.applied_at)}</span>
      </div>
      <div class="muted small">
        申请套餐：<b>${r.apply_plan}</b>
        ${r.discount_pct ? ` · 折扣：${100-r.discount_pct}折（优惠${r.discount_pct}%）` : ""}
        ${r.annual_price_cny ? ` · 协议价：¥${r.annual_price_cny}/年` : ""}
        ${r.apply_note ? `<br/>申请说明：${escapeHtml(r.apply_note)}` : ""}
      </div>
      ${activeInfo}${reviewForm}${activateForm}${approvedForm}
    </div>`;
  }).join("");

  c.innerHTML = cardHtml;
}

async function adminApproveContract(cid){
  const disc  = parseInt(qs(`#disc_${cid}`)?.value)  || null;
  const plan  = qs(`#plan_${cid}`)?.value             || null;
  const price = parseFloat(qs(`#price_${cid}`)?.value)|| null;
  const note  = qs(`#note_${cid}`)?.value.trim()      || null;
  const { error } = await sb.rpc("admin_review_contract", {
    p_contract_id: cid, p_discount_pct: disc,
    p_plan: plan, p_annual_price: price, p_admin_note: note
  });
  if (error){ toast("操作失败：" + error.message); return; }
  toast("已批准，等待用户付款");
  adminLoadContracts();
}

async function adminRejectContractPrompt(cid){
  const note = prompt("拒绝原因（可选，用户可见）：") ?? null;
  if (note === null) return; // cancelled
  const { error } = await sb.rpc("admin_reject_contract", {
    p_contract_id: cid, p_admin_note: note || null
  });
  if (error){ toast("操作失败：" + error.message); return; }
  toast("已拒绝申请");
  adminLoadContracts();
}

async function adminActivateContract(cid){
  const expInput = qs(`#exp_${cid}`)?.value;
  const expires  = expInput ? new Date(expInput).toISOString() : null;
  if (!confirm(`确认收款并激活？权益将开通至 ${expInput || "一年后"}，该用户所有项目自动升级。`)) return;
  const { error } = await sb.rpc("admin_activate_contract", {
    p_contract_id: cid, p_expires_at: expires
  });
  if (error){ toast("操作失败：" + error.message); return; }
  toast("✅ 已激活，权益已开通");
  adminLoadContracts();
}

// ── 管理员：取消合同 ──────────────────────────────────────────
async function adminCancelContract(cid){
  const note = prompt("取消原因（可选，用户可见）：") ?? null;
  if (note === null) return;
  if (!confirm("确认取消该合同？如已激活将撤销用户权益。")) return;
  const { error } = await sb.rpc("admin_cancel_contract", {
    p_contract_id: cid, p_admin_note: note || null
  });
  if (error){ toast("操作失败：" + error.message); return; }
  toast("已取消合同");
  adminLoadContracts();
}

// ── 管理员：修改合同（付款状态、到期时间、套餐等）──────────
async function adminUpdateContract(cid){
  const paymentEl = qs(`#pay_${cid}`);
  const expEl     = qs(`#cexp_${cid}`);
  const planEl    = qs(`#cplan_${cid}`);
  const noteEl    = qs(`#cnote_${cid}`);

  const params = { p_contract_id: cid };
  if (paymentEl) params.p_payment_status = paymentEl.value;
  if (expEl && expEl.value) params.p_expires_at = new Date(expEl.value).toISOString();
  if (planEl) params.p_plan = planEl.value;
  if (noteEl && noteEl.value.trim()) params.p_admin_note = noteEl.value.trim();

  const { error } = await sb.rpc("admin_update_contract", params);
  if (error){ toast("操作失败：" + error.message); return; }
  toast("合同已更新");
  adminLoadContracts();
}

// ── 管理员：直接设定项目到期日期 ──────────────────────────────
async function adminSetExpiry(projectId){
  const expEl  = qs(`#pexp_${projectId}`);
  const planEl = qs(`#pplan_${projectId}`);
  if (!expEl || !expEl.value){ toast("请选择到期日期"); return; }
  if (!confirm(`确认设定到期日期为 ${expEl.value}？`)) return;

  const params = {
    p_project_id: projectId,
    p_expires_at: new Date(expEl.value).toISOString()
  };
  if (planEl) params.p_plan = planEl.value;

  const { error } = await sb.rpc("admin_set_expiry", params);
  if (error){ toast("操作失败：" + error.message); return; }
  toast("到期时间已更新");
  adminSearch();
}

// ═══════════════════════════════════════════════════════════
// 订单管理（管理员侧）
// ═══════════════════════════════════════════════════════════

const ORDER_STATUS_LABEL = {
  unpaid:               { text:"待付款",   cls:"badge" },
  pending_verification: { text:"待核验",   cls:"badge warn" },
  paid:                 { text:"已到账",   cls:"badge ok" },
  activated:            { text:"已开通",   cls:"badge ok" },
  rejected:             { text:"已驳回",   cls:"badge bad" },
  cancelled:            { text:"已取消",   cls:"badge" },
  expired:              { text:"已过期",   cls:"badge" },
  refund_pending:       { text:"退款中",   cls:"badge warn" },
  refunded:             { text:"已退款",   cls:"badge" },
};

async function adminLoadOrders(){
  if (!isPlatformAdmin) return;
  const { data, error } = await sb.rpc("admin_list_orders");
  if (error){
    if(el.adminOrders) el.adminOrders.innerHTML =
      `<span class="muted small" style="color:#c0392b">加载失败：${escapeHtml(error.message)}</span>`;
    return;
  }
  renderAdminOrders(data || []);
}

function renderAdminOrders(rows){
  const c = el.adminOrders;
  if (!c) return;

  const pending = rows.filter(r => r.status === "pending_verification");
  if (el.adminOrdersBadge){
    if (pending.length){
      el.adminOrdersBadge.textContent = `${pending.length} 待核验`;
      el.adminOrdersBadge.style.display = "inline-flex";
    } else {
      el.adminOrdersBadge.style.display = "none";
    }
  }

  if (!rows.length){
    c.innerHTML = `<div class="muted small">暂无订单。</div>`;
    return;
  }

  const planMap = { pro:"Pro", institutional:"机构版" };
  const cycleMap = { monthly:"月付", yearly:"年付" };
  const methodMap = { wechat_qr:"微信", alipay_qr:"支付宝", bank_transfer:"转账" };

  const html = rows.map(r => {
    const na = v => escapeHtml(v || "—");
    const s = ORDER_STATUS_LABEL[r.status] || { text: r.status, cls:"badge" };
    const oid = escapeHtml(r.id);

    const actionHtml = r.status === "pending_verification" ? `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0">
        <div>
          <label style="font-size:12px">生效日</label>
          <input id="ostart_${oid}" type="date" value="${new Date().toISOString().slice(0,10)}" style="width:130px;font-size:12px"/>
        </div>
        <div>
          <label style="font-size:12px">到期日</label>
          <input id="oend_${oid}" type="date" value="${
            r.billing_cycle === "yearly"
              ? new Date(Date.now()+365*864e5).toISOString().slice(0,10)
              : new Date(Date.now()+30*864e5).toISOString().slice(0,10)
          }" style="width:130px;font-size:12px"/>
        </div>
        <div style="flex:1;min-width:100px">
          <label style="font-size:12px">管理员备注</label>
          <input id="onote_${oid}" placeholder="可选" style="font-size:12px"/>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn small primary" onclick="adminVerifyOrder('${oid}')">确认到账并开通</button>
          <button class="btn small" style="color:#c0392b" onclick="adminRejectOrder('${oid}')">驳回</button>
          ${r.proof_count > 0 ? `<button class="btn small" onclick="adminViewProofs('${oid}')">查看凭证(${r.proof_count})</button>` : ""}
        </div>
      </div>` : "";

    const activatedInfo = r.status === "activated" ? `
      <div class="muted small" style="margin-top:6px">
        已开通 · ${r.start_at ? fmtDate(r.start_at) : "—"} 至 ${r.end_at ? fmtDate(r.end_at) : "—"}
        · 配额 ${r.project_quota} 个项目
      </div>` : "";

    return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
        <span class="${s.cls}" style="font-size:11px">${s.text}</span>
        <code style="font-size:12px">${na(r.order_no)}</code>
        <span class="muted small">${na(r.owner_email)}</span>
        ${r.real_name ? `<b style="font-size:13px">${na(r.real_name)}</b>` : ""}
        ${r.hospital ? `<span class="muted small">${na(r.hospital)}</span>` : ""}
        <span class="muted small" style="margin-left:auto">${fmtDate(r.created_at)}</span>
      </div>
      <div class="small">
        ${planMap[r.plan_code]||r.plan_code} · ${cycleMap[r.billing_cycle]||r.billing_cycle}
        · ${r.project_quota} 个项目
        · 应付 ¥${r.amount_due}
        ${r.amount_paid ? ` · 实付 ¥${r.amount_paid}` : ""}
        · ${methodMap[r.payment_method]||r.payment_method||"未选"}
        ${r.invoice_needed ? " · 需要发票" : ""}
        ${r.payer_name ? ` · 付款人：${na(r.payer_name)}` : ""}
        ${r.notes ? `<br/>备注：${na(r.notes)}` : ""}
      </div>
      ${activatedInfo}${actionHtml}
    </div>`;
  }).join("");

  c.innerHTML = html;
}

let _adminOrderBusy = false;

async function adminVerifyOrder(orderId){
  if (_adminOrderBusy) return;
  const startEl = qs(`#ostart_${orderId}`);
  const endEl   = qs(`#oend_${orderId}`);
  const noteEl  = qs(`#onote_${orderId}`);

  // 日期校验
  if (startEl?.value && isNaN(new Date(startEl.value).getTime())) { toast("生效日期无效"); return; }
  if (endEl?.value && isNaN(new Date(endEl.value).getTime())) { toast("到期日期无效"); return; }

  if (!confirm(`确认到账并开通？用户所有项目将升级至到期日 ${endEl?.value || "（默认）"}`)) return;

  _adminOrderBusy = true;
  try {
    const params = { p_order_id: orderId };
    if (startEl?.value) params.p_start_at = new Date(startEl.value).toISOString();
    if (endEl?.value)   params.p_end_at   = new Date(endEl.value).toISOString();
    if (noteEl?.value?.trim()) params.p_admin_notes = noteEl.value.trim();

    const { error } = await sb.rpc("admin_verify_order", params);
    if (error){ toast("操作失败：" + error.message); return; }
    toast("已确认到账并开通权益");
    adminLoadOrders();
  } finally {
    _adminOrderBusy = false;
  }
}

async function adminRejectOrder(orderId){
  if (_adminOrderBusy) return;
  const reason = prompt("驳回原因（用户可见，必填）：");
  if (reason === null) return;
  if (!reason.trim()) { toast("驳回原因不能为空"); return; }

  _adminOrderBusy = true;
  try {
    const { error } = await sb.rpc("admin_reject_order", {
      p_order_id: orderId, p_reject_reason: reason.trim()
    });
    if (error){ toast("操作失败：" + error.message); return; }
    toast("已驳回");
    adminLoadOrders();
  } finally {
    _adminOrderBusy = false;
  }
}

async function adminViewProofs(orderId){
  const { data, error } = await sb.rpc("admin_get_order_proofs", { p_order_id: orderId });
  if (error){ toast("加载失败：" + error.message); return; }
  if (!data?.length){ toast("暂无凭证"); return; }

  const html = data.map(p =>
    `<div style="margin:6px 0">
      <a href="${escapeHtml(p.file_url)}" target="_blank">${escapeHtml(p.file_name || "凭证文件")}</a>
      <span class="muted small"> · ${fmtDate(p.created_at)}</span>
    </div>`
  ).join("");

  // Simple modal
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9000;display:flex;align-items:center;justify-content:center;";
  overlay.innerHTML = `<div style="background:#fff;border-radius:14px;padding:20px;max-width:500px;width:90%;max-height:80vh;overflow:auto">
    <h3 style="margin:0 0 10px">付款凭证</h3>
    ${html}
    <div class="btnbar"><button class="btn" onclick="this.closest('div[style]').parentElement.remove()">关闭</button></div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
}

// 挂载到 window，供 table inline onclick 调用
window.adminExtend  = adminExtend;
window.adminPartner = adminPartner;
window.adminReset   = adminReset;
window.adminApproveContract        = adminApproveContract;
window.adminRejectContractPrompt   = adminRejectContractPrompt;
window.adminActivateContract       = adminActivateContract;
window.adminCancelContract         = adminCancelContract;
window.adminUpdateContract         = adminUpdateContract;
window.adminSetExpiry              = adminSetExpiry;
window.resetContractForm           = resetContractForm;
window.adminVerifyOrder            = adminVerifyOrder;
window.adminRejectOrder            = adminRejectOrder;
window.adminViewProofs             = adminViewProofs;

// ============================================================
// 批量导入（CSV）
// ============================================================

// 模块级常量：避免在每次函数调用时重复分配
const IMPORT_CURRENT_YEAR = new Date().getFullYear();
const LN_CLASSES = Object.freeze(["I","II","III-A","III-A/C","III-C","IV-S(A)","IV-G(A)","IV-S(A/C)","IV-G(A/C)","IV-S(C)","IV-G(C)","V","VI"]);
const CSV_SEX_MAP = {"男":"M","女":"F","M":"M","F":"F"};

// 模块级字段转换工具（避免在每次 rowToBaseline/rowToVisit 调用时重复定义）
const _csvNum  = v => (v === "" || v === undefined) ? null : Number(v);
const _csvStr  = v => (v === "" || v === undefined) ? null : v;
const _csvDt   = v => (v === "" || v === undefined || isNaN(Date.parse(v))) ? null : v;
const _csvBool = v => (v === "true" || v === "是") ? true : (v === "false" || v === "否") ? false : null;

// 解析结果缓存（模块级，不挂到 window）
let _importParsed = null;

/** 健壮的 CSV 解析器：支持 UTF-8 BOM、引号字段、CRLF/LF */
function parseCsv(text){
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM
  const rows = [];
  let pos = 0;
  const len = text.length;

  function parseField(){
    const chars = []; // 用数组收集再 join，避免大文件下字符串拼接的二次分配
    if (text[pos] === '"'){
      pos++;
      while (pos < len){
        if (text[pos] === '"'){
          if (text[pos+1] === '"'){ chars.push('"'); pos += 2; }
          else { pos++; break; }
        } else { chars.push(text[pos++]); }
      }
    } else {
      while (pos < len && text[pos] !== ',' && text[pos] !== '\n' && text[pos] !== '\r'){
        chars.push(text[pos++]);
      }
    }
    return chars.join("");
  }

  while (pos < len){
    const row = [];
    while (pos < len){
      row.push(parseField());
      if (text[pos] === ',') { pos++; } else { break; }
    }
    if (text[pos] === '\r') pos++;
    if (text[pos] === '\n') pos++;
    rows.push(row);
  }
  while (rows.length && rows[rows.length-1].every(v=>v==="")){rows.pop();}

  if (rows.length < 2) return { headers:[], data:[] };
  const headers = rows[0].map(h=>h.trim().toLowerCase().replace(/\s+/g,"_"));
  const data = rows.slice(1).map(row=>{
    const obj = {};
    headers.forEach((h,i)=>{ obj[h] = row[i] !== undefined ? row[i].trim() : ""; });
    return obj;
  });
  return { headers, data };
}

/** 验证单行基线数据，返回 { ok, errors:[] } */
function validateBaselineRow(r){
  const errors = [];
  if (!r.patient_code) errors.push("patient_code 不能为空");
  if (r.sex && !["M","F","男","女"].includes(r.sex)) errors.push(`sex 无效（应为 M/F/男/女）`);
  if (r.birth_year){
    const y = Number(r.birth_year);
    if (!Number.isInteger(y) || y < 1900 || y > IMPORT_CURRENT_YEAR) errors.push(`birth_year 无效（${r.birth_year}）`);
  }
  if (r.baseline_date && isNaN(Date.parse(r.baseline_date))) errors.push(`baseline_date 格式错误（${r.baseline_date}）`);
  if (r.baseline_scr && isNaN(Number(r.baseline_scr))) errors.push(`baseline_scr 应为数字`);
  if (r.baseline_upcr && isNaN(Number(r.baseline_upcr))) errors.push(`baseline_upcr 应为数字`);
  for (const f of ["oxford_m","oxford_e","oxford_s"]){
    if (r[f] !== "" && r[f] !== undefined && !["0","1"].includes(r[f])) errors.push(`${f} 应为 0 或 1`);
  }
  for (const f of ["oxford_t","oxford_c"]){
    if (r[f] !== "" && r[f] !== undefined && !["0","1","2"].includes(r[f])) errors.push(`${f} 应为 0、1 或 2`);
  }
  if (r.ln_class && !LN_CLASSES.includes(r.ln_class)) errors.push(`ln_class 无效（${r.ln_class}）`);
  if (r.ln_activity_index){
    const ai = Number(r.ln_activity_index);
    if (isNaN(ai) || ai < 0 || ai > 24) errors.push(`ln_activity_index 应在 0–24`);
  }
  if (r.ln_chronicity_index){
    const ci = Number(r.ln_chronicity_index);
    if (isNaN(ci) || ci < 0 || ci > 12) errors.push(`ln_chronicity_index 应在 0–12`);
  }
  return { ok: errors.length === 0, errors };
}

/** 验证单行随访数据 */
function validateVisitRow(r){
  const errors = [];
  if (!r.patient_code) errors.push("patient_code 不能为空");
  if (!r.visit_date) errors.push("visit_date 不能为空");
  else if (isNaN(Date.parse(r.visit_date))) errors.push(`visit_date 格式错误（${r.visit_date}）`);
  for (const f of ["sbp","dbp","scr_umol_l","upcr","egfr"]){
    if (r[f] && isNaN(Number(r[f]))) errors.push(`${f} 应为数字`);
  }
  return { ok: errors.length === 0, errors };
}

/** 把 CSV 行转为 baseline 插入对象 */
function rowToBaseline(r, project_id){
  return {
    project_id,
    patient_code:         r.patient_code,
    sex:                  CSV_SEX_MAP[r.sex] ?? null,
    birth_year:           _csvNum(r.birth_year),
    baseline_date:        _csvDt(r.baseline_date),
    baseline_scr:         _csvNum(r.baseline_scr),
    baseline_upcr:        _csvNum(r.baseline_upcr),
    biopsy_date:          _csvDt(r.biopsy_date),
    oxford_m:             _csvNum(r.oxford_m),
    oxford_e:             _csvNum(r.oxford_e),
    oxford_s:             _csvNum(r.oxford_s),
    oxford_t:             _csvNum(r.oxford_t),
    oxford_c:             _csvNum(r.oxford_c),
    ln_biopsy_date:       _csvDt(r.ln_biopsy_date),
    ln_class:             _csvStr(r.ln_class),
    ln_activity_index:    _csvNum(r.ln_activity_index),
    ln_chronicity_index:  _csvNum(r.ln_chronicity_index),
    ln_podocytopathy:     _csvBool(r.ln_podocytopathy),
    treatment_arm:        _csvStr(r.treatment_arm),
    randomization_id:     _csvStr(r.randomization_id),
    randomization_date:   _csvDt(r.randomization_date),
  };
}

/** 把 CSV 行转为 visit 插入对象 */
function rowToVisit(r, project_id){
  return {
    project_id,
    patient_code:  r.patient_code,
    visit_date:    r.visit_date,
    sbp:           _csvNum(r.sbp),
    dbp:           _csvNum(r.dbp),
    scr_umol_l:    _csvNum(r.scr_umol_l),
    upcr:          _csvNum(r.upcr),
    egfr:          _csvNum(r.egfr),
    notes:         r.notes || null,
  };
}

/** 模板定义 */
const IMPORT_TEMPLATES = {
  baseline: {
    filename: "template_patients_baseline.csv",
    columns: ["patient_code","sex","birth_year","baseline_date","baseline_scr","baseline_upcr",
              "biopsy_date","oxford_m","oxford_e","oxford_s","oxford_t","oxford_c",
              "ln_biopsy_date","ln_class","ln_activity_index","ln_chronicity_index","ln_podocytopathy",
              "treatment_arm","randomization_id","randomization_date"],
    example: {
      patient_code:"0001", sex:"F", birth_year:"1985", baseline_date:"2023-03-01",
      baseline_scr:"88", baseline_upcr:"500",
      biopsy_date:"", oxford_m:"", oxford_e:"", oxford_s:"", oxford_t:"", oxford_c:"",
      ln_biopsy_date:"2023-03-01", ln_class:"IV-G(A)", ln_activity_index:"14",
      ln_chronicity_index:"3", ln_podocytopathy:"false",
      treatment_arm:"", randomization_id:"", randomization_date:""
    }
  },
  visits: {
    filename: "template_visits_long.csv",
    columns: ["patient_code","visit_date","sbp","dbp","scr_umol_l","upcr","egfr","notes"],
    example: {
      patient_code:"0001", visit_date:"2023-06-01", sbp:"128", dbp:"78",
      scr_umol_l:"92", upcr:"450", egfr:"", notes:""
    }
  }
};

function downloadImportTemplate(){
  const type = el.importType.value;
  const tmpl = IMPORT_TEMPLATES[type];
  if (!tmpl) return;
  const header = tmpl.columns.join(",");
  const exampleRow = tmpl.columns.map(c=>escapeCsv(tmpl.example[c] ?? "")).join(",");
  downloadCsvUtf8Bom(tmpl.filename, header + "\r\n" + exampleRow);
}

// 解析结果缓存
window._importParsed = null;

function handleImportFile(evt){
  const file = evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const text = e.target.result;
    const type = el.importType.value;
    const { headers, data } = parseCsv(text);

    if (!data.length){
      toast("CSV 为空或格式错误");
      return;
    }

    const validate = type === "baseline" ? validateBaselineRow : validateVisitRow;
    const results = data.map((r,i)=>({ row:i+2, data:r, ...validate(r) }));
    const errorCount = results.filter(r=>!r.ok).length;
    const validCount = results.length - errorCount;

    _importParsed = { type, results };

    // 摘要
    el.importSummary.innerHTML =
      `共 <b>${results.length}</b> 行数据，` +
      `<span style="color:#16a34a">✓ ${validCount} 行可导入</span>，` +
      (errorCount > 0 ? `<span style="color:#dc2626">✗ ${errorCount} 行有错误（将跳过）</span>。` : `无错误。`) +
      ` 预览前 10 行：`;

    // 预览表格
    const previewRows = results.slice(0, 10);
    const cols = previewRows[0]?.data ? Object.keys(previewRows[0].data).slice(0, 8) : [];
    const ths = ["状态","行号",...cols].map(c=>`<th style="padding:4px 8px;white-space:nowrap">${escapeHtml(c)}</th>`).join("");
    const trs = previewRows.map(r=>{
      const status = r.ok
        ? `<td style="color:#16a34a;padding:4px 8px">✓</td>`
        : `<td style="color:#dc2626;padding:4px 8px" title="${escapeHtml(r.errors.join('; '))}">✗ ${escapeHtml(r.errors[0])}</td>`;
      const cells = cols.map(c=>`<td style="padding:4px 8px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.data[c]??'')}</td>`).join("");
      return `<tr style="border-top:1px solid #f1f5f9">${status}<td style="padding:4px 8px">${r.row}</td>${cells}</tr>`;
    }).join("");
    el.importTable.innerHTML = `<table style="border-collapse:collapse;width:100%;background:#fff"><thead style="background:#f8fafc"><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;

    el.btnConfirmImport.disabled = (validCount === 0);
    el.importPreview.style.display = "block";
    el.importProgress.style.display = "none";
  };
  reader.readAsText(file, "utf-8");
}

async function confirmImport(){
  if (!selectedProject) return toast("请先选择项目");
  if (!_importParsed) return;

  const validRows = _importParsed.results.filter(r=>r.ok).map(r=>r.data);
  if (!validRows.length) return toast("没有可导入的有效行");

  const BATCH = 50;
  const pid = selectedProject.id;
  const type = _importParsed.type;
  const btn = el.btnConfirmImport;
  setBusy(btn, true);
  el.importProgress.style.display = "block";

  let inserted = 0;
  let failed = 0;
  const batchErrors = [];
  try{
    for (let i = 0; i < validRows.length; i += BATCH){
      const chunk = validRows.slice(i, i + BATCH);
      el.importProgress.textContent = `正在导入… ${Math.min(i+BATCH, validRows.length)} / ${validRows.length} 行`;

      let err;
      if (type === "baseline"){
        const payload = chunk.map(r=>rowToBaseline(r, pid));
        const res = await sb.from("patients_baseline").upsert(payload, { onConflict: "project_id,patient_code" });
        err = res.error;
      } else {
        const payload = chunk.map(r=>rowToVisit(r, pid));
        const res = await sb.from("visits_long").insert(payload);
        err = res.error;
      }

      if (err){ failed += chunk.length; batchErrors.push(err.message || String(err)); console.error(err); }
      else { inserted += chunk.length; }
    }

    let msg = `导入完成：成功 ${inserted} 行`;
    if (failed > 0) msg += `，失败 ${failed} 行（${batchErrors[0]}）`;
    el.importProgress.textContent = msg;
    toast(msg);

    if (type === "baseline") await loadPatients();

    // 重置
    el.importFile.value = "";
    el.importPreview.style.display = "none";
    _importParsed = null;
  }catch(e){
    console.error(e);
    const detail = e?.message || e;
    toast("导入出错：" + detail);
    el.importProgress.textContent = "导入出错：" + detail;
  }finally{
    setBusy(btn, false);
  }
}

init();
