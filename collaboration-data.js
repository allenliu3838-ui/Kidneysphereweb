window.CollabData = {
  collaborationPaths: [
    {
      id: 'pilot',
      title: '试点课题',
      who: '适合谁：单中心 PI / 科研小组，准备先跑通一轮完整流程。',
      cycle: '典型周期：4–8 周',
      scenario: '推荐场景：新队列启动、科室数据库规范化、课题预实验。',
      ctaLabel: '加入试点路径',
      ctaHref: '/demo'
    },
    {
      id: 'joint',
      title: '联合项目',
      who: '适合谁：2–5 中心协作团队，已有明确研究问题。',
      cycle: '典型周期：2–4 个月',
      scenario: '推荐场景：统一字段、统一导出、按月合并复盘。',
      ctaLabel: '加入联合项目',
      ctaHref: '/demo'
    },
    {
      id: 'lead',
      title: '牵头联盟项目',
      who: '适合谁：牵头中心 / 区域联盟，需共建 CRF 与分析框架。',
      cycle: '典型周期：3–6 个月（按阶段推进）',
      scenario: '推荐场景：多中心项目合作、阶段汇报、联盟数据治理。',
      ctaLabel: '发起牵头项目',
      ctaHref: '/demo'
    }
  ],

  projectCards: [
    {
      slug: 'igan-cohort',
      name: 'IgAN 动态风险重分层多中心双向队列',
      shortTitle: 'IgAN 双向队列',
      status: '招募中',
      statusClass: 'ok',
      category: '肾小球疾病',
      summary: '活检后 6/12 个月的动态反应——蛋白尿达标、血尿缓解、eGFR 轨迹——能否比活检时基线资料更准确地预测 3–5 年肾脏结局？',
      suitableFor: ['单中心 IgAN 专科门诊或活检随访队列', '有 6 / 12 月复诊记录的肾脏专科中心'],
      keyFields: ['基线 + 6/12 月时间窗：日期 / BP / Scr / UPCR / eGFR / 用药', 'Oxford MEST-C 病理（增强分析用，非必须）'],
      support: ['标准化 eCRF 与数据字典', '核心字段完整率检查与补录建议', '首版 Table 1 / QC / 可复现导出'],
      detailHighlights: ['双层设计：核心数据集即可入组；病理 / 血尿 / 治疗序贯完整者进增强分析', '目标 10–20 家中心，总样本 800–1500 例，结局事件 ≥200'],
      emailSubject: '加入项目：IgAN 动态风险重分层多中心双向队列'
    },
    {
      slug: 'speed-igan',
      name: 'SPEED-IgAN · 靶向布地奈德 vs 口服甲泼尼龙 RCT',
      shortTitle: 'SPEED-IgAN RCT',
      status: '招募中',
      statusClass: 'ok',
      category: '肾小球疾病',
      summary: '在有进展风险的原发性 IgAN 中，靶向释放布地奈德与口服甲泼尼龙相比，12 个月蛋白尿缓解率和安全性的差异。',
      suitableFor: ['具备 RCT 执行能力的肾内科中心', '有完整入排筛选与随机分配流程的中心'],
      keyFields: ['随机分组信息 + 基线资料', '随访核心四项：日期 / BP / Scr / UPCR', '不良事件记录'],
      support: ['入排标准核查与随机化支持', '按月随访节点提醒与字段完整率追踪', '安全性与蛋白尿全程追踪导出'],
      detailHighlights: ['以参与中心身份加入，提供符合入排标准的患者随机化与随访数据', '主要终点 12 个月，可延伸至 24 个月'],
      emailSubject: '加入项目：SPEED-IgAN RCT'
    },
    {
      slug: 'c3g-cohort',
      name: 'C3G 多中心前瞻性队列',
      shortTitle: 'C3G 队列',
      status: '招募中',
      statusClass: 'ok',
      category: '罕见病/高壁垒',
      summary: 'C3 肾小球病（C3GN / DDD）的临床病理特征、补体谱、治疗实践与长期肾脏结局——真实世界多中心描述与预后分析。',
      suitableFor: ['有 C3G / DDD 诊断能力的病理科或肾内科中心', 'DDD 等罕见表型中心尤为欢迎'],
      keyFields: ['基线：年龄 / Scr / UPCR / C3/C4 / 病理分型', '随访核心四项（随访 12–36 个月）'],
      support: ['数据字典与补体亚组分析模板', '罕见表型中心专项支持与子分析设计'],
      detailHighlights: ['考虑到 C3G 相对罕见，多中心汇聚必要，目标 ≥150 例', '可加入或申请牵头；补体亚组可独立成分稿'],
      emailSubject: '加入项目：C3G 多中心前瞻性队列'
    },
    {
      slug: 'mgrs-registry',
      name: 'MGRS 单克隆免疫球蛋白相关肾损害多中心前瞻性登记',
      shortTitle: 'MGRS 登记',
      status: '招募中',
      statusClass: 'ok',
      category: '罕见病/高壁垒',
      summary: 'MGRS 的临床谱、病理类型、治疗选择（克隆靶向 vs 肾脏保护）与肾脏结局——建立多中心真实世界数据库。',
      suitableFor: ['有血液科-肾内科联合诊治能力的医疗中心', '已开展克隆靶向治疗的参与中心优先'],
      keyFields: ['单克隆免疫球蛋白类型 / 浓度 + 病理分型', '基线 Scr / UPCR + 治疗方案'],
      support: ['前瞻性登记 eCRF 与数据字典', '克隆治疗反应随访模板', '亚组分析与分稿支持'],
      detailHighlights: ['目标 ≥200 例，各病理亚型分层分析', '有血液科合作资源的中心优先；克隆治疗反应亚组可独立发表'],
      emailSubject: '加入项目：MGRS 多中心前瞻性登记'
    },
    {
      slug: 'mn-rtx-obi',
      name: '高危膜性肾病 RTX vs OBI 多中心观察性比较研究',
      shortTitle: 'MN RTX vs OBI',
      status: '招募中',
      statusClass: 'ok',
      category: '肾小球疾病',
      summary: '在高危原发性膜性肾病中，首次 anti-CD20 治疗选择利妥昔单抗（RTX）还是奥比妥珠单抗（OBI），谁的缓解率更高、复发更少、安全性更好？',
      suitableFor: ['有膜性肾病规范随访能力的肾内科中心', '0 / 3 / 6 / 12 月有时间点数据的中心'],
      keyFields: ['核心四项：0/3/6/12 月时间点的日期 / BP / Scr / UPCR', 'anti-PLA2R / 白蛋白 / CD19 可选（增强分析）'],
      support: ['零门槛入组：核心四项即进主分析', 'PLA2R 动态 / 免疫学 / 安全性子分析支持'],
      detailHighlights: ['零门槛设计：核心四项即可入主分析', '多中心汇聚；免疫学（PLA2R 动态）/ 安全性 / 再治疗可独立成分稿'],
      emailSubject: '加入项目：高危膜性肾病 RTX vs OBI 多中心观察性比较研究'
    },
    {
      slug: 'hd-registry',
      name: 'HD 透析起始频次真实世界登记',
      shortTitle: 'HD 起始频次',
      status: '招募中',
      statusClass: 'ok',
      category: '透析/康复',
      summary: '血液透析起始阶段透析频次的选择（每周 2 次 vs 3 次）对患者短中期临床结局、生活质量与院内资源利用的影响。',
      suitableFor: ['有透析中心的肾内科或血液净化科', '覆盖不同透析频次实践模式的中心'],
      keyFields: ['HD 起始日期 / 起始频次 / 基线 Scr', '主要临床结局（随访 12–24 个月）'],
      support: ['登记式 eCRF 与数据字典', '资源利用与生活质量子分析模板'],
      detailHighlights: ['目标 ≥300 例；多中心以覆盖不同实践模式', '可延伸至生活质量与院内经济性子分析'],
      emailSubject: '加入项目：HD 透析起始频次真实世界登记'
    },
    {
      slug: 'regain-pa',
      name: 'REGAIN-PA · CKD / 透析患者体力活动干预实施研究',
      shortTitle: 'REGAIN-PA',
      status: '招募中',
      statusClass: 'ok',
      category: '透析/康复',
      summary: '在 CKD 及透析患者中实施结构化体力活动干预的真实世界可行性、依从性及对临床指标（eGFR / 生活质量 / 肌力）的影响。',
      suitableFor: ['具备运动康复或肾脏康复专病门诊资源的中心', '有透析患者规律随访体系的中心'],
      keyFields: ['CKD 分期 / 透析方式 + 体力活动基线评估', '干预方案 + 随访核心四项（6–12 个月）'],
      support: ['实施型研究 eCRF 与干预方案模板', '依从性追踪与长期透析结局子分析'],
      detailHighlights: ['以实施型研究设计为主，目标 ≥150 例', '可延伸至长期透析结局子分析'],
      emailSubject: '加入项目：REGAIN-PA CKD/透析患者体力活动干预实施研究'
    },
    {
      slug: 'dkd-access',
      name: 'DKD-ACCESS 糖尿病合并 CKD 平台队列',
      shortTitle: 'DKD-ACCESS',
      status: '牵头招募',
      statusClass: 'lead',
      category: '糖尿病/代谢肾病',
      summary: '面向成人糖尿病合并 CKD 的多中心、分层准入、前瞻-回顾结合平台队列，聚焦器官保护治疗落实度、竞争风险与硬结局，支持不同数据能力层级的中心共同参与。',
      suitableFor: [
        'A 类站点：可提供 eGFR、UACR 或 dipstick protein、基础用药和转诊信息的筛查链条站点',
        'B 类站点：可提供重复 Scr/eGFR，最好有重复 UACR 的标准随访站点',
        'C 类站点：可提供眼底/视网膜病变、PROMs、样本库、超声或 cystatin C 等增强模块的站点'
      ],
      keyFields: [
        '年龄、性别、糖尿病类型与病程',
        'SBP / DBP、HbA1c',
        'Scr / eGFR、UACR（无 UACR 时可先记录 dipstick protein）',
        '血钾、白蛋白、血红蛋白',
        '视网膜病变有/无、ASCVD / HF 有/无',
        '现用药：ACEi/ARB、SGLT2i、GLP-1RA、finerenone/ns-MRA、statin、diuretics'
      ],
      support: [
        '分层准入的 eCRF 与 data dictionary',
        '关键字段完整率检查与补录建议',
        'KDIGO G/A 风险分层与基础分析模板',
        '首版 care cascade / Table 1 / 可复现导出支持',
        '支持后续嵌套子研究与增强模块扩展'
      ],
      detailHighlights: [
        '主队列定义：成人糖尿病合并 CKD 平台队列，支持从回顾性数据快速起步并承接后续前瞻随访',
        '适合开展筛查-监测-转诊 care cascade、治疗落实度与硬结局研究',
        '支持后续 target trial emulation、表型分层与风险模型嵌套子研究'
      ],
      emailSubject: '加入项目：DKD-ACCESS 糖尿病合并 CKD 平台队列'
    },
    {
      slug: 'ktr-care-china',
      name: 'KTR-CARE China · 肾移植受者多中心真实世界长期随访队列',
      shortTitle: 'KTR-CARE China',
      status: '招募中',
      statusClass: 'ok',
      category: '肾移植',
      summary: '建立低门槛、标准化、可扩展的中国肾移植长期管理数据库，识别移植物功能下降、严重感染与住院的关键可干预因素，并构建门诊可用的动态风险分层工具。同一母队列支持 7 个预设子课题连续产出。',
      suitableFor: [
        '有肾移植患者长期随访基础的肾移植内科 / 肾内科',
        '协作随访中心（不要求本中心开展移植手术）',
        '无需具备 DSA、dd-cfDNA、protocol biopsy 等高端检测能力'
      ],
      keyFields: [
        'Scr / eGFR、蛋白尿（每次随访）',
        '免疫抑制方案：Tac/CsA/belatacept/mTORi；MPA/AZA；激素',
        'Tac / CsA trough 水平',
        '病史：排斥、BK、CMV、糖尿病、高血压、CVD',
        '门诊血压、感染、住院、是否 biopsy-proven 排斥'
      ],
      support: [
        '统一 CRF 与数据字典，最低变量集对应常规门诊记录',
        '7 个预设子课题方向（移植物下降模型、蛋白尿、Tac 变异性、感染、代谢等）',
        '方法学与统计支持（Cox / 竞争风险 / 时间依赖分析）',
        '子课题 concept sheet 机制，青年医生可申请牵头',
        '建议每 3–6 个月门诊节奏更新，回顾+前瞻结合'
      ],
      detailHighlights: [
        '不统一免疫方案，不要求 protocol biopsy，协作随访中心均可加入',
        '预设子课题：移植物功能下降风险模型、蛋白尿与结局、Tac trough 变异性、感染负担、代谢并发症、中心管理差异、低资源场景风险分层',
        '目标期刊：AJT / CJASN / KI；支持 AST/ATC 相关会议摘要'
      ],
      emailSubject: '加入项目：KTR-CARE China 肾移植受者多中心长期随访队列'
    },
    {
      slug: 'pd-open-china',
      name: 'PD-OPEN China · 中国腹膜透析开放协作平台研究',
      shortTitle: 'PD-OPEN China',
      status: '牵头招募',
      statusClass: 'lead',
      category: '腹膜透析',
      summary: '构建全国多中心、低门槛、可扩展的腹透平台队列，研究中心实践差异与患者结局（12 个月永久转 HD）的关系，并持续孵化感染 benchmark、增量腹透、急诊起始等嵌套子研究。',
      suitableFor: [
        'A 类（核心队列）：有稳定 PD 门诊或住院管理团队，能判断主要结局',
        'B 类（中心年度调查）：每年完成 1 次 10–15 分钟的中心实践调查',
        'C 类（增强模块）：可提供 PROM、PET/RKF、容量管理、远程管理数据的中心'
      ],
      keyFields: [
        'PD 起始日期、planned vs urgent 起始、既往 HD 暴露',
        '处方类型：CAPD / APD；增量 vs 标准 PD',
        'Hb、白蛋白、钾、磷、Scr；24 小时尿量或无尿状态',
        '腹膜炎事件（日期、病原、是否拔管）、出口/隧道感染',
        '转 HD 日期与原因、住院、死亡、移植'
      ],
      support: [
        '分层准入 eCRF 与统一数据字典（支持 Excel / REDCap / 本地系统导出映射）',
        '每季度反馈各中心缺失率、逻辑冲突与事件定义核查清单',
        '8 篇预设论文矩阵（NDT / KI / CKJ / KI Reports / PDI 等）',
        '子课题 concept sheet 机制，青年医生优先申请牵头',
        '建议核心变量完整率 ≥85%，主要终点缺失率 <5%'
      ],
      detailHighlights: [
        '主终点：12 个月永久转 HD（连续转 HD >90 天），记录原因',
        '腹膜炎与出口感染 benchmark 对标 ISPD 2022/2023 标准（≤0.40 次/人年）',
        '支持增量起始 vs 标准起始、急诊起始、低钾、残余肾功能等嵌套子研究',
        '目标期刊：NDT / KI 主论文；子论文可至 CKJ / KI Reports / PDI / Kidney Medicine'
      ],
      emailSubject: '加入项目：PD-OPEN China 腹膜透析开放协作平台研究'
    }
  ],

  filterTabs: [
    { id: 'all', label: '全部' },
    { id: '肾小球疾病', label: '肾小球疾病' },
    { id: '糖尿病/代谢肾病', label: '糖尿病 / 代谢肾病' },
    { id: '罕见病/高壁垒', label: '罕见病 / 高壁垒' },
    { id: '透析/康复', label: '透析 / 康复' },
    { id: '肾移植', label: '肾移植' },
    { id: '腹膜透析', label: '腹膜透析' }
  ],

  caseCards: [
    {
      title: '某中心试点路径（脱敏示例）',
      text: '某中心在 1 个月内完成首轮 QC，并拿到首版 Table 1 用于内部汇报；随后按缺口清单补齐关键字段。'
    },
    {
      title: '某多中心联合路径（脱敏示例）',
      text: '某多中心项目完成第一次合并导出后，开始按月跟踪核心字段完整率，并在固定节奏复跑导出包。'
    },
    {
      title: '某牵头联盟路径（脱敏示例）',
      text: '某牵头单位先完成 CRF 与数据字典对齐，再组织多中心试运行，逐步建立阶段性统计简报。'
    }
  ],

  faqList: [
    {
      q: '我们只有部分字段，能不能先加入？',
      a: '可以。大多数项目采用分层准入设计：核心四项（日期 / BP / Scr / UPCR）完整即可进主分析；增强字段进阶分析。先加入，再逐步补齐。'
    },
    {
      q: '加入后多久能拿到首版结果？',
      a: '通常在字段完整率达标后 2–4 周内输出首版 Table 1 / QC / 图表 / 可复现导出包；具体时间按项目节点协商。'
    },
    {
      q: '如果想牵头新项目，最少需要准备什么？',
      a: '明确的研究问题、≥30 例初步队列或明确的招募预期、基本的字段准备意愿。其余 CRF / 数据字典 / 统计方案由系统与团队协同完成。'
    },
    {
      q: '我们只有筛查数据，没有完整随访，能参加哪个层级？',
      a: '对于 DKD-ACCESS 等平台队列，A 类站点（筛查链条）即可参与，提供 eGFR / UACR / 基础用药信息即可进入主队列分析。'
    },
    {
      q: '项目是否支持后续嵌套子研究？',
      a: '支持。多个项目明确支持增强模块与嵌套子研究扩展，后续可按需加入表型分层、风险模型、干预评估等方向。'
    },
    {
      q: '参与项目需要先买系统吗？',
      a: '不一定。可先通过"加入现有项目/机构合作咨询"确认路径与字段准备度，再决定试用或合作方案。'
    },
    {
      q: '一个中心能否同时加入多个项目？',
      a: '可以。建议按项目分别管理字段与导出节奏，避免分析口径混淆。'
    },
    {
      q: '如何确认自己符合某个项目的纳入标准？',
      a: '每个项目均列出了最低必填字段和适合中心描述，可直接对照；如有疑问，欢迎发邮件 china@kidneysphere.com 进一步确认。'
    }
  ]
};
