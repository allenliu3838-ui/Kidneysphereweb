// Reviewed fallback cards keep the daily-learning module useful when the CMS/RPC
// has no scheduled item. CMS content still takes priority in daily-learning.js.
export const REVIEWED_DAILY_CARDS = [
  {
    article_id: 'reviewed-igan-supportive-care', specialty: 'glom', estimated_minutes: 4,
    title: 'IgA肾病：何时认为进展风险仍然较高？',
    learning_objective: '识别经过充分支持治疗后，仍需进一步评估疾病特异治疗的患者。',
    key_points: ['先确认诊断、依从性及支持治疗是否充分。', '持续蛋白尿是进展风险的重要标志，但必须结合eGFR趋势、血压和病理。', '单次尿蛋白结果不足以决定免疫抑制治疗。'],
    quiz_question: 'IgA肾病患者接受优化支持治疗后，以下哪项最提示仍有较高进展风险？',
    quiz_options: ['镜下血尿一次阳性', '持续蛋白尿并伴eGFR下降趋势', '血清IgA轻度升高', '补体C3正常'],
    correct_option: 1,
    quiz_explanation: '持续蛋白尿和eGFR下降趋势比单次血尿或血清IgA更能提示进展风险。后续治疗仍需结合病程、病理、禁忌证及患者偏好。',
    source_label: 'KDIGO IgA肾病指南', source_url: 'https://kdigo.org/guidelines/iga-nephropathy/',
  },
  {
    article_id: 'reviewed-mn-immunologic-response', specialty: 'glom', estimated_minutes: 4,
    title: '膜性肾病：免疫学缓解为什么常早于临床缓解？',
    learning_objective: '正确理解抗PLA2R抗体变化与蛋白尿改善之间的时间差。',
    key_points: ['抗PLA2R下降通常早于蛋白尿明显减少。', '早期仅凭蛋白尿未下降，不应立即判定治疗失败。', '趋势判断应同时观察抗体、蛋白尿、白蛋白和肾功能。'],
    quiz_question: '抗PLA2R阳性膜性肾病治疗后，抗体已明显下降但蛋白尿暂未改善，最合理的解释是？',
    quiz_options: ['治疗一定失败', '可能存在免疫学缓解与临床缓解的时间差', '必须立即联合环磷酰胺', '抗PLA2R没有监测价值'],
    correct_option: 1,
    quiz_explanation: '免疫活动减弱后，肾小球滤过屏障修复和蛋白尿消退可能需要更长时间。应动态评估，而不是仅凭早期蛋白尿决定追加治疗。',
    source_label: 'KDIGO肾小球疾病指南', source_url: 'https://kdigo.org/guidelines/gd/',
  },
  {
    article_id: 'reviewed-ckrt-stop', specialty: 'icu', estimated_minutes: 3,
    title: '停止CKRT：必须先恢复尿量吗？',
    learning_objective: '用整体肾脏清除能力和临床稳定性判断能否停机。',
    key_points: ['有尿有助于判断恢复，但不是唯一条件。', '评估容量、钾、酸碱、尿素氮和肌酐趋势。', '停机后需要密切监测，必要时可重新开始肾脏替代治疗。'],
    quiz_question: '以下哪项最适合作为停止CKRT的判断原则？',
    quiz_options: ['尿量必须超过2 L/日', '肌酐必须恢复正常', '原始指征已改善且自身肾功能足以维持内环境稳定', '滤器凝血后即永久停机'],
    correct_option: 2,
    quiz_explanation: '停止CKRT的核心是患者自身肾功能能否在停机后维持容量、电解质和酸碱稳定。尿量重要，但不存在适用于所有患者的单一尿量阈值。',
    source_label: 'KDIGO急性肾损伤指南', source_url: 'https://kdigo.org/guidelines/acute-kidney-injury/',
  },
  {
    article_id: 'reviewed-hyperkalemia-calcium', specialty: 'icu', estimated_minutes: 3,
    title: '严重高钾伴心电图改变：第一步保护心肌',
    learning_objective: '区分稳定心肌、转移血钾和清除血钾三类治疗目标。',
    key_points: ['静脉钙用于稳定心肌膜，并不降低血钾。', '胰岛素联合葡萄糖可暂时把钾转入细胞。', '透析、利尿或胃肠道排钾才是清除体内钾的措施。'],
    quiz_question: '血钾7.2 mmol/L并出现QRS增宽时，最需要立即采取哪项措施？',
    quiz_options: ['口服碳酸氢钠', '静脉给予钙剂稳定心肌', '等待复查血钾', '仅限制饮食钾'],
    correct_option: 1,
    quiz_explanation: '出现高钾相关心电图改变时，应立即静脉给予钙剂保护心肌，同时启动降低及清除血钾的治疗。',
    source_label: 'UK Kidney Association高钾指南', source_url: 'https://guidelines.ukkidney.org/hyperkalaemia/',
  },
  {
    article_id: 'reviewed-bk-viremia', specialty: 'tx', estimated_minutes: 4,
    title: '肾移植后BK病毒血症：先确认趋势，再调整免疫抑制',
    learning_objective: '理解BK病毒管理的核心是定量监测与分步降低免疫抑制。',
    key_points: ['血浆BK病毒定量比单次尿检更适合指导处置。', '持续或升高的病毒血症需要复核免疫抑制强度。', '降低免疫抑制时必须同时监测排斥风险和移植物功能。'],
    quiz_question: '肾移植受者血浆BK病毒载量持续升高，通常最合理的初始策略是？',
    quiz_options: ['立即移植肾切除', '分步降低免疫抑制并密切监测', '常规大剂量激素冲击', '不再复查病毒载量'],
    correct_option: 1,
    quiz_explanation: 'BK病毒血症的主要治疗是谨慎、分步降低免疫抑制，并连续监测病毒载量、肌酐及排斥风险。具体先减哪一种药应遵循移植中心方案。',
    source_label: '第二版国际BK多瘤病毒共识指南', source_url: 'https://pubmed.ncbi.nlm.nih.gov/38605438/',
  },
  {
    article_id: 'reviewed-dgf-dialysis', specialty: 'tx', estimated_minutes: 3,
    title: '移植肾功能延迟恢复：透析看指征，不看肌酐数字',
    learning_objective: '避免仅因肌酐下降缓慢而启动透析。',
    key_points: ['DGF常用定义与移植后一周内需要透析有关，但透析决定仍基于临床指征。', '高钾、严重酸中毒、肺水肿和尿毒症并发症是重要指征。', '同时排查血管、梗阻、排斥、药物毒性和容量问题。'],
    quiz_question: '移植后第4天肌酐仍高，但尿量尚可、血钾及酸碱稳定、无容量超负荷。下一步最合理的是？',
    quiz_options: ['仅因肌酐高立即透析', '继续评估DGF病因并密切监测透析指征', '立即拔除移植肾', '停止全部免疫抑制剂'],
    correct_option: 1,
    quiz_explanation: '透析依据临床指征，而不是单独依据肌酐。应继续监测并系统排查DGF原因；一旦出现危及生命的电解质、酸碱或容量问题则及时透析。',
    source_label: 'KDIGO移植受者管理指南', source_url: 'https://kdigo.org/guidelines/transplant-recipient/',
  },
  {
    article_id: 'reviewed-full-house', specialty: 'path', estimated_minutes: 4,
    title: '“Full-house”免疫荧光并不等于狼疮性肾炎',
    learning_objective: '把免疫荧光模式放回临床、光镜和电镜背景中解读。',
    key_points: ['Full-house通常指IgG、IgA、IgM、C3和C1q均染色。', '该模式支持狼疮性肾炎，但并非特异。', '诊断需要结合临床血清学、光镜及电镜表现。'],
    quiz_question: '肾活检出现full-house免疫荧光，以下判断最准确的是？',
    quiz_options: ['可单独确诊系统性红斑狼疮', '提示狼疮性肾炎，但需结合其他证据并排除替代诊断', '等同于抗GBM病', '说明样本一定污染'],
    correct_option: 1,
    quiz_explanation: 'Full-house是重要线索，但感染相关肾炎等情况也可能出现类似模式。不能脱离临床血清学和其他病理层面单独确诊。',
    source_label: 'KDIGO狼疮性肾炎指南', source_url: 'https://kdigo.org/guidelines/lupus-nephritis/',
  },
  {
    article_id: 'reviewed-amyloid-congo-red', specialty: 'path', estimated_minutes: 3,
    title: '刚果红阳性之后：淀粉样蛋白分型不能省略',
    learning_objective: '避免仅凭临床背景推测淀粉样变类型。',
    key_points: ['刚果红阳性及偏振光下苹果绿双折射支持淀粉样变。', '确诊后仍需进行可靠的蛋白分型。', '治疗取决于淀粉样蛋白类型，错误分型可能导致错误治疗。'],
    quiz_question: '肾活检刚果红阳性后，下一项关键工作是什么？',
    quiz_options: ['默认均为AL型', '结合可靠方法完成淀粉样蛋白分型', '不需要进一步检查', '直接开始大剂量激素'],
    correct_option: 1,
    quiz_explanation: 'AL、AA、ATTR等类型的治疗完全不同。应采用经验证的免疫组织化学/免疫荧光，必要时质谱分型，不能仅凭单克隆蛋白或年龄推断。',
    source_label: '国际肾脏与单克隆免疫球蛋白病研究组共识', source_url: 'https://pubmed.ncbi.nlm.nih.gov/30510265/',
  },
  {
    article_id: 'reviewed-access-steal', specialty: 'da', estimated_minutes: 3,
    title: '内瘘术后手痛发凉：不要漏掉通路相关缺血',
    learning_objective: '快速识别需要紧急血管评估的危险表现。',
    key_points: ['手部发凉、疼痛、麻木或组织损伤提示远端缺血。', '需要检查双侧脉搏、毛细血管再充盈及通路体征。', '进行性静息痛、运动障碍或组织损伤需要紧急处理。'],
    quiz_question: '血液透析患者内瘘侧手部出现静息痛、发凉并伴指端溃疡，最合理的处理是？',
    quiz_options: ['常规一年后复查', '尽快进行血管通路与远端灌注评估', '仅增加透析时间', '反复热敷后继续观察数月'],
    correct_option: 1,
    quiz_explanation: '静息痛和组织损伤提示严重通路相关肢体缺血，应尽快由血管通路团队评估；延误可能造成不可逆损伤。',
    source_label: 'KDOQI血管通路指南', source_url: 'https://www.kidney.org/professionals/kdoqi/guidelines-and-commentaries/vascular-access',
  },
  {
    article_id: 'reviewed-access-stenosis', specialty: 'da', estimated_minutes: 3,
    title: '透析通路狭窄：先找临床线索，再安排影像',
    learning_objective: '识别比单一监测数字更有意义的通路异常。',
    key_points: ['持续异常杂音或震颤、穿刺困难和止血时间延长均需重视。', '透析充分性下降或静脉压趋势异常可提供线索。', '临床监测异常应促使及时影像评估，而不是盲目预防性干预。'],
    quiz_question: '以下哪组表现最支持血液透析通路存在临床显著狭窄？',
    quiz_options: ['一次血压轻度升高', '新发穿刺困难、止血延长并伴通路体征改变', '透析前轻度口渴', '血红蛋白稳定'],
    correct_option: 1,
    quiz_explanation: '多项临床监测异常共同出现时，应尽快评估通路狭窄。指南强调以临床指标为基础，而非仅凭孤立的监测数值进行干预。',
    source_label: 'KDOQI血管通路指南', source_url: 'https://www.kidney.org/professionals/kdoqi/guidelines-and-commentaries/vascular-access',
  },
  {
    article_id: 'reviewed-child-nephrotic-edema', specialty: 'peds', estimated_minutes: 3,
    title: '儿童肾病综合征水肿：并非都代表血容量过多',
    learning_objective: '在利尿前评估有效循环容量，避免加重低容量。',
    key_points: ['水肿可与有效循环容量不足同时存在。', '心率、血压、末梢灌注、尿量和近期液体丢失都应评估。', '严重水肿的治疗应个体化，白蛋白和利尿剂均有风险。'],
    quiz_question: '肾病综合征患儿明显水肿，同时心动过速、四肢凉、毛细血管再充盈延长。首先应考虑什么？',
    quiz_options: ['单纯容量过多并立即大剂量利尿', '可能存在有效循环容量不足，需先评估与稳定循环', '一定是细菌性腹膜炎', '无需监测血压和尿量'],
    correct_option: 1,
    quiz_explanation: '外周水肿不能排除血管内容量不足。存在低灌注线索时，贸然强化利尿可能使循环进一步恶化，应先完成容量和感染等评估。',
    source_label: 'IPNA儿童激素敏感型肾病综合征建议', source_url: 'https://pubmed.ncbi.nlm.nih.gov/36370266/',
  },
  {
    article_id: 'reviewed-child-psgn-complement', specialty: 'peds', estimated_minutes: 3,
    title: '感染后肾小球肾炎：低C3应该恢复',
    learning_objective: '用补体恢复情况识别需要重新考虑诊断的患儿。',
    key_points: ['典型链球菌感染后肾小球肾炎常伴低C3。', 'C3通常在数周内恢复。', '低C3持续不恢复，应重新考虑C3肾小球病、狼疮等诊断。'],
    quiz_question: '患儿疑似链球菌感染后肾小球肾炎，8–12周后C3仍明显降低，最合理的做法是？',
    quiz_options: ['认为完全符合典型病程', '重新评估替代诊断，必要时考虑肾活检', '永久停止随访', '仅补充维生素C'],
    correct_option: 1,
    quiz_explanation: '典型感染后肾小球肾炎的低补体应恢复。持续低C3属于非典型病程，需要重新检查感染、免疫学和补体相关疾病。',
    source_label: 'KDIGO肾小球疾病指南', source_url: 'https://kdigo.org/guidelines/gd/',
  },
];

function utcDayNumber(date = new Date()) {
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86400000);
}

export function getReviewedDailyCard(specialties = [], date = new Date()) {
  const requested = Array.isArray(specialties) ? specialties.filter(Boolean) : [];
  const candidates = requested.length
    ? REVIEWED_DAILY_CARDS.filter(card => requested.includes(card.specialty))
    : REVIEWED_DAILY_CARDS;
  const pool = candidates.length ? candidates : REVIEWED_DAILY_CARDS;
  const card = pool[((utcDayNumber(date) % pool.length) + pool.length) % pool.length];
  return { ...card, structured: true, local_reviewed: true };
}
