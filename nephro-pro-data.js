/**
 * nephro-pro-data.js — 肾域 Pro 六大模块的展示数据
 *
 * ============================================================
 *   编辑指南（你打开 / 增加内容时看这里）
 * ============================================================
 *
 *   一、加一条内容
 *   ---------------------------------------
 *   找到对应模块的 items 数组，加一条形如：
 *
 *     {
 *       id: '唯一英文短 ID',
 *       title: '中文标题',
 *       summary: '一两句话简介',
 *       cover_url: 'https://你的图床/缩略图.jpg',   // 必填, 免费用户也看
 *       hd_image_url: 'https://你的图床/高清.jpg',  // 选填, 付费才看
 *       external_link: 'https://pubmed...',          // 选填, 期刊/PDF 外链
 *       contentType: 'series',                        // 见下方枚举
 *       evidenceLevel: '指南',                        // 见下方枚举
 *       reviewStatus: 'reviewed',                     // reviewed | pending
 *       updatedAt: '2026-05-15',
 *       licenseStatus: 'original',                    // original | licensed | public_domain
 *     }
 *
 *   图床建议：Supabase Storage 公开 bucket / 七牛 / 腾讯 COS / Cloudflare R2 都行，
 *   只要返回 https URL 能直接 <img> 就行。
 *
 *   二、开放 / 关闭一个模块
 *   ---------------------------------------
 *   把模块的 status 在 'coming_soon' 与 'live' 之间切换。
 *   coming_soon: 落地页显示"敬请期待"，没有跳转链接
 *   live:        落地页显示"进入"按钮，跳到 nephro-pro-module.html?id=xxx
 *
 *   三、字段语义参考
 *   ---------------------------------------
 *   contentType: series | paper-digest | guideline-update | pathway | case | download
 *   accessLevel: free | preview | pro
 *   requiredEntitlement: nephro_pro | membership | project_access
 *   evidenceLevel:  指南 | 系统综述 | RCT | 队列 | 病例 | 专家共识 | 教学素材
 *   reviewStatus: reviewed | pending | needs_review
 *   licenseStatus: original | licensed | public_domain | needs_review
 *
 *   四、付费 / 免费控制
 *   ---------------------------------------
 *   有 hd_image_url 且当前用户未付费 → 卡片只显示 cover_url + "高清待解锁"徽章
 *   有 hd_image_url 且当前用户已付费 → 卡片直接显示 hd_image_url
 *   没有 hd_image_url                  → 完全免费, cover_url 即最终图
 *   只有 external_link 没有图          → 卡片只是文本卡 + "查看原文 ↗" 按钮
 */

export const NEPHRO_PRO_MODULES = [
  {
    id: 'atlas',
    title: '证据图谱库',
    summary: '肾内科机制、病理与治疗决策的可视化图谱合集，包含 GlomCon 系列与原创重绘图。',
    icon: '🗺️',
    href: 'atlas.html',
    status: 'live',
    items: [
      {
        id: 'atlas-iga-mechanism',
        title: 'IgA 肾病：从机制到治疗决策',
        summary: '系膜增生、补体激活、四重打击假说与现代治疗路径。',
        contentType: 'series',
        accessLevel: 'mixed',
        requiredEntitlement: 'nephro_pro',
        evidenceLevel: '指南/系统综述',
        reviewStatus: 'reviewed',
        updatedAt: '2026-05-15',
        licenseStatus: 'original',
      },
      {
        id: 'atlas-mn-antigen',
        title: '膜性肾病：抗原、病理与风险分层',
        summary: 'PLA2R、THSD7A、NELL-1、Sema3B 等抗原靶点与对应病理特征。',
        contentType: 'series',
        accessLevel: 'pro',
        requiredEntitlement: 'nephro_pro',
        evidenceLevel: '系统综述',
        reviewStatus: 'reviewed',
        updatedAt: '2026-05-12',
        licenseStatus: 'original',
      },
      {
        id: 'atlas-sepsis-perfusion',
        title: '脓毒症中的肾灌注：从宏循环到微循环',
        summary: '休克分型、灌注压、自我调节与AKI风险窗口。',
        contentType: 'series',
        accessLevel: 'free',
        requiredEntitlement: null,
        evidenceLevel: '专家共识',
        reviewStatus: 'reviewed',
        updatedAt: '2026-05-10',
        licenseStatus: 'original',
      },
    ],
  },
  {
    id: 'literature-digest',
    title: '最新文献图解',
    summary: '每周精选高影响因子肾内科论文，用图解方式拆解研究问题、设计与结论。',
    icon: '📄',
    href: 'nephro-pro-module.html?id=literature-digest',
    status: 'coming_soon',
    items: [
      // ↓ 示范条目（含图 URL）—— 替换 cover_url / hd_image_url 即可
      {
        id: 'lit-2026-05-empa-ckd',
        title: 'EMPA-KIDNEY 长期随访：心肾终点的持续获益',
        summary: 'SGLT2i 在非糖尿病 CKD 中的 30 个月随访数据图解。',
        cover_url: '',     // 填你的缩略图 URL
        hd_image_url: '',  // 选填高清图 URL（付费用户看）
        external_link: 'https://pubmed.ncbi.nlm.nih.gov/',  // 选填原文链接
        contentType: 'paper-digest',
        accessLevel: 'pro',
        requiredEntitlement: 'nephro_pro',
        evidenceLevel: 'RCT',
        reviewStatus: 'pending',
        updatedAt: '2026-05-14',
        licenseStatus: 'original',
      },
      {
        id: 'lit-2026-05-finerenone-meta',
        title: 'Finerenone 在 CKD-T2D 的合并分析',
        summary: 'FIDELIO + FIGARO 个体患者数据 meta 的图谱化结论。',
        contentType: 'paper-digest',
        accessLevel: 'pro',
        requiredEntitlement: 'nephro_pro',
        evidenceLevel: '系统综述',
        reviewStatus: 'pending',
        updatedAt: '2026-05-11',
        licenseStatus: 'original',
      },
    ],
  },
  {
    id: 'guideline-watch',
    title: '指南更新雷达',
    summary: 'KDIGO、ERA、ASN、中国指南更新追踪 + 关键差异点的图解对照。',
    icon: '📡',
    href: 'nephro-pro-module.html?id=guideline-watch',
    status: 'coming_soon',
    items: [
      {
        id: 'gl-kdigo-2025-aki',
        title: 'KDIGO 2025 AKI 指南更新要点',
        summary: 'biomarker、early discontinuation、CRRT 剂量等新增推荐图解。',
        contentType: 'guideline-update',
        accessLevel: 'pro',
        requiredEntitlement: 'nephro_pro',
        evidenceLevel: '指南',
        reviewStatus: 'pending',
        updatedAt: '2026-04-30',
        licenseStatus: 'original',
      },
      {
        id: 'gl-cn-2026-gn',
        title: '中国成人肾小球疾病诊疗指南 2026',
        summary: '与 KDIGO 2021 的诊断阈值与一线方案对比。',
        contentType: 'guideline-update',
        accessLevel: 'pro',
        requiredEntitlement: 'nephro_pro',
        evidenceLevel: '指南',
        reviewStatus: 'pending',
        updatedAt: '2026-04-22',
        licenseStatus: 'original',
      },
    ],
  },
  {
    id: 'clinical-pathways',
    title: '临床路径图谱',
    summary: '从急诊接诊到病理穿刺到 follow-up 的全流程图谱，覆盖常见与疑难场景。',
    icon: '🧭',
    href: 'nephro-pro-module.html?id=clinical-pathways',
    status: 'coming_soon',
    items: [
      {
        id: 'cp-aki-icu-evaluation',
        title: 'ICU AKI 急诊评估路径',
        summary: '从液体反应性、肌酐曲线到 CRRT 启动节点的决策图。',
        contentType: 'pathway',
        accessLevel: 'pro',
        requiredEntitlement: 'nephro_pro',
        evidenceLevel: '专家共识',
        reviewStatus: 'pending',
        updatedAt: '2026-05-08',
        licenseStatus: 'original',
      },
      {
        id: 'cp-iga-treat-decision',
        title: 'IgA 肾病分层治疗决策路径',
        summary: '蛋白尿、eGFR、MEST-C 分层下的免疫抑制 vs 支持治疗节点图。',
        contentType: 'pathway',
        accessLevel: 'pro',
        requiredEntitlement: 'nephro_pro',
        evidenceLevel: '指南/RCT',
        reviewStatus: 'pending',
        updatedAt: '2026-05-05',
        licenseStatus: 'original',
      },
    ],
  },
  {
    id: 'case-learning',
    title: '病例学习',
    summary: '真实病例去标识化后改编，配套学习问题、关键鉴别与教学要点。',
    icon: '🧪',
    href: 'nephro-pro-module.html?id=case-learning',
    status: 'coming_soon',
    items: [
      {
        id: 'case-anca-iga-overlap',
        title: '案例 · IgA 肾病合并新月体形成',
        summary: '从尿沉渣、补体到 ANCA 阴性新月体性 GN 的鉴别思路。',
        contentType: 'case',
        accessLevel: 'pro',
        requiredEntitlement: 'nephro_pro',
        evidenceLevel: '病例',
        reviewStatus: 'pending',
        updatedAt: '2026-05-09',
        licenseStatus: 'original',
      },
      {
        id: 'case-tx-rejection',
        title: '案例 · 肾移植术后 TCMR 与 ABMR 鉴别',
        summary: '从穿刺时间窗、DSA、组织学到治疗反应。',
        contentType: 'case',
        accessLevel: 'pro',
        requiredEntitlement: 'nephro_pro',
        evidenceLevel: '病例',
        reviewStatus: 'pending',
        updatedAt: '2026-05-03',
        licenseStatus: 'original',
      },
    ],
  },
  {
    id: 'download-center',
    title: '教学下载中心',
    summary: '高清图谱原图、PPT 模板、教学讲义和病例打印版，可用于授课与查房。',
    icon: '⬇️',
    href: 'nephro-pro-module.html?id=download-center',
    status: 'coming_soon',
    items: [
      {
        id: 'dl-iga-ppt',
        title: 'IgA 肾病教学 PPT（高清版）',
        summary: '住院医师 / 进修医师讲课模板，含动画版与静态版。',
        contentType: 'download',
        accessLevel: 'pro',
        requiredEntitlement: 'nephro_pro',
        evidenceLevel: '教学素材',
        reviewStatus: 'pending',
        updatedAt: '2026-05-14',
        licenseStatus: 'original',
      },
      {
        id: 'dl-mn-handout',
        title: '膜性肾病住院手册',
        summary: '抗原检测路径 + 治疗选择速查 + 患者教育页。',
        contentType: 'download',
        accessLevel: 'pro',
        requiredEntitlement: 'nephro_pro',
        evidenceLevel: '教学素材',
        reviewStatus: 'pending',
        updatedAt: '2026-05-06',
        licenseStatus: 'original',
      },
    ],
  },
];

export const NEPHRO_PRO_BENEFITS = [
  '完整证据图谱',
  '最新文献图解',
  '指南更新解读',
  '临床路径图',
  '病例解析',
  '高清图谱与 PPT 下载',
];
