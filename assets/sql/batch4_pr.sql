-- =============================================================
-- PR-1 基础列扩展
-- 目的：为后续所有 PR 打好地基，纯加列，不改现有逻辑，零风险
-- =============================================================

-- ─── 1. visits_long：补 eGFR 公式版本列 ─────────────────────────────────────
-- 记录这条 eGFR 是用哪个公式算出来的，让别人拿到数据也能复现
-- 取值说明：
--   'CKD-EPI-2021-Cr'  正式公式（无种族项，国际主流）
--   'manual'           研究者手动填写（不走公式）
--   'missing_inputs'   缺性别或出生年，无法计算
ALTER TABLE visits_long
  ADD COLUMN IF NOT EXISTS egfr_formula_version text;

COMMENT ON COLUMN visits_long.egfr_formula_version IS
  'eGFR计算公式版本：CKD-EPI-2021-Cr | manual | missing_inputs';

-- ─── 2. patient_tokens：token v2 扩展列 ─────────────────────────────────────
-- 原有 token 只有 active/expires_at，新增单次使用与撤销追踪

-- single_use：是否设置为"只能用一次"
--   true  → 患者提交随访后自动失效，下次需重新生成
--   false → 可多次提交（适合长期随访追踪）
ALTER TABLE patient_tokens
  ADD COLUMN IF NOT EXISTS single_use boolean NOT NULL DEFAULT false;

-- used_at：首次提交随访的时间，NULL 表示还没用过
ALTER TABLE patient_tokens
  ADD COLUMN IF NOT EXISTS used_at timestamptz;

-- revoked_at：管理员手动撤销的时间，NULL 表示未撤销
ALTER TABLE patient_tokens
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- revoke_reason：撤销原因（例："患者填错项目，重新生成"）
ALTER TABLE patient_tokens
  ADD COLUMN IF NOT EXISTS revoke_reason text;

COMMENT ON COLUMN patient_tokens.single_use IS
  '是否单次使用：true=提交一次后自动失效；false=可反复提交';
COMMENT ON COLUMN patient_tokens.used_at IS
  '首次提交随访的时间戳，用于单次token失效判断与追溯';
COMMENT ON COLUMN patient_tokens.revoked_at IS
  '管理员撤销此token的时间，不为NULL则表示已撤销';
COMMENT ON COLUMN patient_tokens.revoke_reason IS
  '撤销原因，例：患者填错信息，重新生成';

-- ─── 3. 更新 patient_submit_visit_v2：支持 single_use 逻辑 ──────────────────
DROP FUNCTION IF EXISTS patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text);
CREATE OR REPLACE FUNCTION patient_submit_visit_v2(
  p_token       text,
  p_visit_date  date,
  p_sbp         numeric DEFAULT NULL,
  p_dbp         numeric DEFAULT NULL,
  p_scr_umol_l  numeric DEFAULT NULL,
  p_upcr        numeric DEFAULT NULL,
  p_egfr        numeric DEFAULT NULL,
  p_notes       text    DEFAULT NULL
)
RETURNS TABLE(
  visit_id          uuid,
  server_time       timestamptz,
  receipt_token     text,
  receipt_expires_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_token_row    patient_tokens%ROWTYPE;
  v_project_row  projects%ROWTYPE;
  v_visit_id     uuid;
  v_receipt      text;
  v_expires      timestamptz;
  v_recent_count int;
  v_same_day     int;
BEGIN
  -- ① 查 token，验证有效性
  SELECT * INTO v_token_row
  FROM patient_tokens t
  WHERE t.token = p_token;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'token_not_found' USING HINT = 'token无效，请确认链接正确';
  END IF;

  -- ② token 是否已撤销
  IF v_token_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'token_revoked'
      USING HINT = '该随访链接已被管理员撤销：' || COALESCE(v_token_row.revoke_reason, '无原因说明');
  END IF;

  -- ③ token 是否已过期
  IF v_token_row.expires_at IS NOT NULL AND v_token_row.expires_at < now() THEN
    RAISE EXCEPTION 'token_expired' USING HINT = '随访链接已过期，请联系管理员重新生成';
  END IF;

  -- ④ token 是否仍激活
  IF NOT v_token_row.active THEN
    RAISE EXCEPTION 'token_inactive' USING HINT = '随访链接已停用';
  END IF;

  -- ⑤ 单次 token：已用过则拒绝
  IF v_token_row.single_use AND v_token_row.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'token_already_used'
      USING HINT = '该单次链接已于 ' || v_token_row.used_at::text || ' 提交过，如需重填请联系管理员';
  END IF;

  -- ⑥ 查项目
  SELECT * INTO v_project_row FROM projects WHERE id = v_token_row.project_id;

  -- ⑦ 检查写入权限（订阅/试用状态）
  PERFORM assert_project_write_allowed(v_token_row.project_id);

  -- ⑧ 核心字段校验
  IF p_visit_date IS NULL THEN
    RAISE EXCEPTION 'missing_visit_date' USING HINT = '随访日期必填';
  END IF;
  IF p_sbp IS NULL AND p_dbp IS NULL AND p_scr_umol_l IS NULL AND p_upcr IS NULL THEN
    RAISE EXCEPTION 'missing_core_fields'
      USING HINT = '至少填写一项核心指标（血压、血肌酐或尿蛋白/肌酐比）';
  END IF;

  -- ⑨ PII 检测
  IF _contains_pii(COALESCE(p_notes, '')) THEN
    RAISE EXCEPTION 'pii_detected_blocked'
      USING HINT = '备注中疑似包含个人身份信息（手机号/身份证/住院号等），请删除后重新提交';
  END IF;

  -- ⑩ 频率限制：每分钟不超过 12 次
  SELECT COUNT(*) INTO v_recent_count
  FROM visits_long
  WHERE project_id = v_token_row.project_id
    AND patient_code = v_token_row.patient_code
    AND created_at > now() - interval '1 minute';

  IF v_recent_count >= 12 THEN
    UPDATE patient_tokens SET active = false WHERE token = p_token;
    INSERT INTO security_audit_logs(project_id, patient_code, token_hash, event_type, severity, details)
    VALUES (v_token_row.project_id, v_token_row.patient_code,
            encode(digest(p_token,'sha256'),'hex'),
            'rate_limit_exceeded', 'HIGH',
            jsonb_build_object('recent_count', v_recent_count, 'window', '1min'));
    RAISE EXCEPTION 'rate_limit_exceeded' USING HINT = '提交过于频繁，链接已被暂停';
  END IF;

  -- ⑪ 同日重复检测：每日不超过 6 次
  SELECT COUNT(*) INTO v_same_day
  FROM visits_long
  WHERE project_id = v_token_row.project_id
    AND patient_code = v_token_row.patient_code
    AND visit_date = p_visit_date;

  IF v_same_day >= 6 THEN
    UPDATE patient_tokens SET active = false WHERE token = p_token;
    RAISE EXCEPTION 'same_day_limit_exceeded'
      USING HINT = '同一日期已提交 ' || v_same_day || ' 条记录，链接已被暂停，请联系管理员';
  END IF;

  -- ⑫ 写入随访记录（事务原子性保证）
  INSERT INTO visits_long(
    project_id, patient_code, visit_date,
    sbp, dbp, scr_umol_l, upcr, egfr,
    egfr_formula_version,
    notes
  ) VALUES (
    v_token_row.project_id,
    v_token_row.patient_code,
    p_visit_date,
    p_sbp, p_dbp, p_scr_umol_l, p_upcr, p_egfr,
    CASE
      WHEN p_egfr IS NULL THEN NULL
      WHEN p_scr_umol_l IS NULL THEN 'missing_inputs'
      ELSE 'CKD-EPI-2021-Cr'
    END,
    LEFT(COALESCE(p_notes, ''), 500)
  )
  RETURNING id INTO v_visit_id;

  -- ⑬ 若 single_use，标记已使用
  IF v_token_row.single_use THEN
    UPDATE patient_tokens SET used_at = now() WHERE token = p_token;
  END IF;

  -- ⑭ 生成回执 token（24 小时有效）
  v_receipt := encode(gen_random_bytes(16), 'hex');
  v_expires  := now() + interval '24 hours';
  INSERT INTO visit_receipts(visit_id, receipt_token, expires_at)
  VALUES (v_visit_id, v_receipt, v_expires)
  ON CONFLICT (visit_id) DO UPDATE
    SET receipt_token = v_receipt, expires_at = v_expires;

  -- ⑮ 审计日志
  INSERT INTO security_audit_logs(
    project_id, patient_code, token_hash, event_type, severity, details
  ) VALUES (
    v_token_row.project_id, v_token_row.patient_code,
    encode(digest(p_token,'sha256'),'hex'),
    'visit_submitted', 'INFO',
    jsonb_build_object(
      'visit_id', v_visit_id,
      'visit_date', p_visit_date,
      'single_use', v_token_row.single_use
    )
  );

  RETURN QUERY SELECT v_visit_id, now(), v_receipt, v_expires;
END;
$$;

GRANT EXECUTE ON FUNCTION patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text) TO anon, authenticated;

-- ─── 4. 更新 revoke_patient_token：支持填写撤销原因 ────────────────────────
-- 先删除旧的单参数版本（0004 中创建），避免重名冲突
DROP FUNCTION IF EXISTS revoke_patient_token(text);

CREATE OR REPLACE FUNCTION revoke_patient_token(
  p_token        text,
  p_revoke_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE patient_tokens
  SET
    active        = false,
    revoked_at    = now(),
    revoke_reason = p_revoke_reason
  WHERE token = p_token
    AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = patient_tokens.project_id
        AND p.created_by = auth.uid()
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'token_not_found_or_not_owner'
      USING HINT = 'token不存在，或您不是该项目的所有者';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION revoke_patient_token(text, text) TO authenticated;
-- =============================================================
-- PR-2 化验项目字典 + 单位字典 + 自动换算
-- 目的：消灭"自由文本单位"乱象，让多中心数据可以直接合并分析
--
-- 背景举例：
--   A中心填 scr=1.2 mg/dL，B中心填 scr=106 μmol/L
--   过去合并时数据会乱掉；启用本 migration 后
--   两者都会自动换算为标准值，可直接比较
-- =============================================================

-- ─── 1. 化验项目字典：lab_test_catalog ─────────────────────────────────────
-- 每种化验项目在这里登记一次，防止"血肌酐"/"血清肌酐"/"Scr"各写各的
CREATE TABLE IF NOT EXISTS lab_test_catalog (
  code           text PRIMARY KEY,   -- 系统内部编码，例：CREAT
  name_cn        text NOT NULL,      -- 中文名，例：血肌酐
  name_en        text,               -- 英文名，例：Serum Creatinine
  module         text NOT NULL DEFAULT 'GENERAL',
                                     -- 适用模块：GENERAL/IGAN/LN/MN/KTX
  is_core        boolean NOT NULL DEFAULT false,
                                     -- 是否"核心指标"（缺失会触发质控警告）
  loinc_code     text,               -- LOINC 编码（选填，方便与国际数据库对接）
  standard_unit  text NOT NULL,      -- 标准单位，所有值都会换算到这个单位
  display_note   text,               -- 前端提示语，例：正常参考范围 0.6-1.2 mg/dL
  created_at     timestamptz DEFAULT now()
);

COMMENT ON TABLE lab_test_catalog IS
  '化验项目字典：统一编码，防止多中心录入时名称不一致导致合并失败';
COMMENT ON COLUMN lab_test_catalog.code IS
  '系统内部编码，建议全大写+下划线，例：CREAT、UPCR、HGB';
COMMENT ON COLUMN lab_test_catalog.standard_unit IS
  '所有中心的数据都换算到这个单位后存储，保证可直接合并分析';
COMMENT ON COLUMN lab_test_catalog.is_core IS
  '核心指标缺失会在质控系统中自动生成警告（Issue）';

-- ─── 2. 单位字典：unit_catalog ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS unit_catalog (
  symbol      text PRIMARY KEY,    -- 单位符号，例：mg/dL
  description text,                -- 说明，例：毫克每分升
  created_at  timestamptz DEFAULT now()
);

COMMENT ON TABLE unit_catalog IS
  '允许使用的单位列表，防止"mg/dl"/"mg/dL"/"MG/DL"写法混用';

-- ─── 3. 项目-单位对应表：lab_test_unit_map ──────────────────────────────────
-- 每个化验项目只允许特定几个单位，并记录如何换算到标准单位
-- 换算公式：value_standard = value_raw * multiplier + offset_val
-- 举例：血肌酐 μmol/L → mg/dL：multiplier=1/88.4≈0.01131，offset_val=0
CREATE TABLE IF NOT EXISTS lab_test_unit_map (
  lab_test_code  text NOT NULL REFERENCES lab_test_catalog(code),
  unit_symbol    text NOT NULL REFERENCES unit_catalog(symbol),
  multiplier     numeric NOT NULL DEFAULT 1,   -- 换算系数
  offset_val     numeric NOT NULL DEFAULT 0,   -- 换算偏移（温度转换用，肾病一般为0）
  is_standard    boolean NOT NULL DEFAULT false, -- 是否就是标准单位（换算系数=1）
  PRIMARY KEY (lab_test_code, unit_symbol)
);

COMMENT ON TABLE lab_test_unit_map IS
  '每个化验项目允许哪些单位输入，以及如何换算到标准单位';
COMMENT ON COLUMN lab_test_unit_map.multiplier IS
  '换算系数：value_standard = value_raw × multiplier + offset_val。
  例：μmol/L→mg/dL，multiplier=0.01131（即1/88.4）';

-- ─── 4. labs_long 扩展列（向后兼容，原有列保留） ────────────────────────────
-- 原有列：lab_name / lab_value / lab_unit（自由文本，旧数据继续可读）
-- 新增列：结构化层，新录入必填，旧数据可为 NULL
ALTER TABLE labs_long
  ADD COLUMN IF NOT EXISTS lab_test_code     text REFERENCES lab_test_catalog(code),
  ADD COLUMN IF NOT EXISTS value_raw         numeric,
  ADD COLUMN IF NOT EXISTS unit_symbol       text REFERENCES unit_catalog(symbol),
  ADD COLUMN IF NOT EXISTS value_standard    numeric,
  ADD COLUMN IF NOT EXISTS standard_unit     text,
  ADD COLUMN IF NOT EXISTS measured_at       timestamptz;
  -- measured_at：精确到分钟的采集时间（比 lab_date 更精准）

COMMENT ON COLUMN labs_long.lab_test_code    IS '化验项目编码，对应 lab_test_catalog.code';
COMMENT ON COLUMN labs_long.value_raw        IS '原始值（录入时的数字，保持用户输入不变）';
COMMENT ON COLUMN labs_long.unit_symbol      IS '录入时使用的单位，对应 unit_catalog.symbol';
COMMENT ON COLUMN labs_long.value_standard   IS '已换算到标准单位的值，可直接用于多中心合并分析';
COMMENT ON COLUMN labs_long.standard_unit    IS '标准单位符号，来自 lab_test_catalog.standard_unit';

-- ─── 5. 化验值标准化函数：normalize_lab_value() ──────────────────────────────
-- 输入：化验编码、原始值、录入单位
-- 输出：标准值（已换算）
-- 举例：normalize_lab_value('CREAT', 88.4, 'μmol/L') → 1.00
--       normalize_lab_value('UPCR', 2000, 'mg/g')    → 2.00
CREATE OR REPLACE FUNCTION normalize_lab_value(
  p_code    text,
  p_value   numeric,
  p_unit    text
)
RETURNS numeric
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_multi numeric;
  v_off   numeric;
BEGIN
  SELECT multiplier, offset_val
    INTO v_multi, v_off
  FROM lab_test_unit_map
  WHERE lab_test_code = p_code
    AND unit_symbol   = p_unit;

  IF NOT FOUND THEN
    -- 单位不在允许列表中，返回 NULL，触发质控 Issue
    RETURN NULL;
  END IF;

  RETURN ROUND(p_value * v_multi + v_off, 4);
END;
$$;

COMMENT ON FUNCTION normalize_lab_value IS
  '将化验原始值换算到标准单位。例：normalize_lab_value(''CREAT'',88.4,''μmol/L'')=1.00';

-- ─── 6. 校验并写入化验记录的 RPC：upsert_lab_record() ────────────────────────
-- 这是前端保存化验记录时调用的函数
-- 步骤：① 校验项目存在 ② 校验单位允许 ③ 自动换算 ④ 写入
CREATE OR REPLACE FUNCTION upsert_lab_record(
  p_project_id   uuid,
  p_patient_code text,
  p_lab_date     date,
  p_lab_test_code text,
  p_value_raw    numeric,
  p_unit_symbol  text,
  p_measured_at  timestamptz DEFAULT NULL,
  p_lab_id       uuid        DEFAULT NULL  -- NULL=新增，有值=更新
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_standard      numeric;
  v_std_unit      text;
  v_result_id     uuid;
  v_map_exists    boolean;
BEGIN
  -- ① 校验项目存在
  IF NOT EXISTS(SELECT 1 FROM lab_test_catalog WHERE code = p_lab_test_code) THEN
    RAISE EXCEPTION 'lab_test_code_not_found'
      USING HINT = '化验项目编码 "' || p_lab_test_code || '" 不在字典中，请从下拉列表选择';
  END IF;

  -- ② 校验单位被允许
  SELECT EXISTS(
    SELECT 1 FROM lab_test_unit_map
    WHERE lab_test_code = p_lab_test_code AND unit_symbol = p_unit_symbol
  ) INTO v_map_exists;

  IF NOT v_map_exists THEN
    RAISE EXCEPTION 'unit_not_allowed'
      USING HINT = '单位 "' || p_unit_symbol || '" 不是 "' || p_lab_test_code
                 || '" 的允许单位，请从下拉列表选择';
  END IF;

  -- ③ 自动换算标准值
  v_standard := normalize_lab_value(p_lab_test_code, p_value_raw, p_unit_symbol);
  SELECT standard_unit INTO v_std_unit FROM lab_test_catalog WHERE code = p_lab_test_code;

  -- ④ 检查项目写入权限
  PERFORM assert_project_write_allowed(p_project_id);

  -- ⑤ 新增或更新
  IF p_lab_id IS NULL THEN
    INSERT INTO labs_long(
      project_id, patient_code, lab_date,
      lab_name,   lab_value,    lab_unit,        -- 保持向后兼容列
      lab_test_code, value_raw, unit_symbol,
      value_standard, standard_unit, measured_at
    ) VALUES (
      p_project_id, p_patient_code, p_lab_date,
      p_lab_test_code, p_value_raw, p_unit_symbol,
      p_lab_test_code, p_value_raw, p_unit_symbol,
      v_standard, v_std_unit, p_measured_at
    )
    RETURNING id INTO v_result_id;
  ELSE
    UPDATE labs_long SET
      lab_date       = p_lab_date,
      lab_name       = p_lab_test_code,
      lab_value      = p_value_raw,
      lab_unit       = p_unit_symbol,
      lab_test_code  = p_lab_test_code,
      value_raw      = p_value_raw,
      unit_symbol    = p_unit_symbol,
      value_standard = v_standard,
      standard_unit  = v_std_unit,
      measured_at    = p_measured_at,
      updated_at     = now(),
      updated_by     = auth.uid()
    WHERE id = p_lab_id
      AND project_id = p_project_id
    RETURNING id INTO v_result_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'lab_not_found' USING HINT = '化验记录不存在或无权修改';
    END IF;
  END IF;

  RETURN v_result_id;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_lab_record TO authenticated;

-- ─── 7. Seed 数据：常用肾病科化验项目 ─────────────────────────────────────
-- 项目字典
INSERT INTO lab_test_catalog(code, name_cn, name_en, module, is_core, loinc_code, standard_unit, display_note)
VALUES
  -- 核心肾功能
  ('CREAT',  '血肌酐',             'Serum Creatinine',      'GENERAL', true,  '2160-0', 'mg/dL',
   '正常参考范围（成人）：男 0.7-1.2 mg/dL，女 0.5-1.0 mg/dL'),
  ('UPCR',   '尿蛋白/肌酐比',      'Urine PCR',             'GENERAL', true,  '13705-9','g/g',
   '正常 <0.15 g/g；IgAN缓解目标 <0.3 g/g；大量蛋白尿 >3.5 g/g'),
  ('EGFR',   'eGFR（实验室报告）', 'eGFR (lab report)',     'GENERAL', false, '62238-1','mL/min/1.73m²',
   '若有实验室报告的eGFR可录入；系统也会自动用CKD-EPI公式计算'),

  -- 血常规
  ('HGB',    '血红蛋白',           'Hemoglobin',            'GENERAL', false, '718-7',  'g/dL',
   '正常参考范围：男 13.5-17.5 g/dL，女 12-16 g/dL'),
  ('WBC',    '白细胞计数',         'WBC',                   'GENERAL', false, '6690-2', '10^9/L',
   '正常 4-10×10⁹/L'),
  ('PLT',    '血小板',             'Platelet',              'GENERAL', false, '777-3',  '10^9/L',
   '正常 100-300×10⁹/L'),

  -- 肝功能
  ('ALT',    '谷丙转氨酶',         'ALT',                   'GENERAL', false, '1742-6', 'U/L',
   '正常 <40 U/L'),
  ('AST',    '谷草转氨酶',         'AST',                   'GENERAL', false, '1920-8', 'U/L',
   '正常 <40 U/L'),
  ('ALB',    '血清白蛋白',         'Albumin',               'GENERAL', false, '1751-7', 'g/dL',
   '正常 3.5-5.0 g/dL；低于3.5提示低蛋白血症'),

  -- 电解质与代谢
  ('K',      '血钾',               'Potassium',             'GENERAL', false, '2823-3', 'mmol/L',
   '正常 3.5-5.0 mmol/L；>5.5为高钾，<3.5为低钾'),
  ('NA',     '血钠',               'Sodium',                'GENERAL', false, '2951-2', 'mmol/L',
   '正常 135-145 mmol/L'),
  ('CA',     '血钙',               'Calcium',               'GENERAL', false, '17861-6','mmol/L',
   '正常 2.1-2.6 mmol/L'),
  ('PHOS',   '血磷',               'Phosphorus',            'GENERAL', false, '2777-1', 'mmol/L',
   '正常 0.8-1.5 mmol/L'),
  ('UA',     '血尿酸',             'Uric Acid',             'GENERAL', false, '3084-1', 'μmol/L',
   '正常：男 <420 μmol/L，女 <360 μmol/L'),
  ('CO2',    '碳酸氢根（HCO3）',   'Bicarbonate',           'GENERAL', false, '1963-8', 'mmol/L',
   '正常 22-29 mmol/L；低于22提示代谢性酸中毒'),

  -- 血脂
  ('TCHOL',  '总胆固醇',           'Total Cholesterol',     'GENERAL', false, '2093-3', 'mmol/L',
   '正常 <5.2 mmol/L'),
  ('TG',     '甘油三酯',           'Triglycerides',         'GENERAL', false, '2571-8', 'mmol/L',
   '正常 <1.7 mmol/L'),
  ('LDL',    '低密度脂蛋白',       'LDL-C',                 'GENERAL', false, '13457-7','mmol/L',
   '心肾保护目标 <1.8 mmol/L（高危患者）'),
  ('HDL',    '高密度脂蛋白',       'HDL-C',                 'GENERAL', false, '2085-9', 'mmol/L',
   '越高越好，男>1.0，女>1.3 mmol/L'),

  -- 炎症指标
  ('CRP',    'C反应蛋白',          'CRP',                   'GENERAL', false, '1988-5', 'mg/L',
   '正常 <5 mg/L'),

  -- IgA 肾病专项
  ('IGA',    '血清IgA',            'Serum IgA',             'IGAN',    false, '1746-7', 'g/L',
   '正常成人 0.7-4.0 g/L；IgAN患者常偏高'),
  ('IGAG',   'IgA/IgG比值',        'IgA/IgG Ratio',         'IGAN',    false, NULL,     'ratio',
   'IgAN辅助诊断指标'),

  -- 狼疮性肾炎专项
  ('C3',     '补体C3',             'Complement C3',         'LN',      false, '4532-9', 'g/L',
   '正常 0.9-1.8 g/L；LN活动期常降低'),
  ('C4',     '补体C4',             'Complement C4',         'LN',      false, '4533-7', 'g/L',
   '正常 0.1-0.4 g/L'),
  ('DSDNA',  '抗dsDNA抗体',        'Anti-dsDNA',            'LN',      false, '11065-0','IU/mL',
   '<10 IU/mL为阴性；升高提示LN活动'),

  -- 移植专项
  ('TACRO',  '他克莫司血药浓度',   'Tacrolimus Trough',     'KTX',     false, '35151-0','ng/mL',
   '目标谷浓度因时期而异，通常术后1-3月：8-12 ng/mL，稳定期：5-8 ng/mL'),
  ('CSA',    '环孢素血药浓度',      'Cyclosporine Trough',   'KTX',     false, '34533-0','ng/mL',
   '目标因中心和时期不同，参考各中心方案')

ON CONFLICT (code) DO NOTHING;

-- 单位字典
INSERT INTO unit_catalog(symbol, description) VALUES
  ('mg/dL',       '毫克每分升'),
  ('μmol/L',       '微摩尔每升'),
  ('umol/L',       '微摩尔每升（ASCII写法）'),
  ('g/g',          '克每克（尿蛋白/肌酐比）'),
  ('mg/g',         '毫克每克（尿蛋白/肌酐比）'),
  ('mg/mmol',      '毫克每毫摩尔（尿蛋白/肌酐比，欧洲常用）'),
  ('g/L',          '克每升'),
  ('g/dL',         '克每分升'),
  ('mmol/L',       '毫摩尔每升'),
  ('U/L',          '单位每升（酶活性）'),
  ('mL/min/1.73m²','毫升/分钟/1.73平方米（eGFR标准单位）'),
  ('10^9/L',       '10的9次方每升（血细胞计数）'),
  ('mg/L',         '毫克每升'),
  ('IU/mL',        '国际单位每毫升'),
  ('ng/mL',        '纳克每毫升（药物浓度）'),
  ('ratio',        '比值（无量纲）')
ON CONFLICT (symbol) DO NOTHING;

-- 项目-单位对应（换算表）
-- 格式说明：value_standard = value_raw × multiplier
INSERT INTO lab_test_unit_map(lab_test_code, unit_symbol, multiplier, offset_val, is_standard)
VALUES
  -- 血肌酐
  ('CREAT', 'mg/dL',  1,          0, true ),  -- 标准单位，直接用
  ('CREAT', 'μmol/L', 0.01130996, 0, false),  -- ÷88.4
  ('CREAT', 'umol/L', 0.01130996, 0, false),  -- 同上，ASCII写法

  -- 尿蛋白/肌酐比
  ('UPCR',  'g/g',    1,          0, true ),  -- 标准单位
  ('UPCR',  'mg/g',   0.001,      0, false),  -- ÷1000
  ('UPCR',  'mg/mmol',0.1130996,  0, false),  -- 1 mg/mmol = 0.113 g/g（近似）

  -- eGFR（实验室报告，单位一致，直接用）
  ('EGFR',  'mL/min/1.73m²', 1,  0, true ),

  -- 血红蛋白
  ('HGB',   'g/dL',   1,          0, true ),
  ('HGB',   'g/L',    0.1,        0, false),  -- ÷10

  -- 白细胞/血小板（10^9/L 是标准）
  ('WBC',   '10^9/L', 1,          0, true ),
  ('PLT',   '10^9/L', 1,          0, true ),

  -- 肝功能
  ('ALT',   'U/L',    1,          0, true ),
  ('AST',   'U/L',    1,          0, true ),

  -- 白蛋白
  ('ALB',   'g/dL',   1,          0, true ),
  ('ALB',   'g/L',    0.1,        0, false),

  -- 电解质（mmol/L 标准）
  ('K',     'mmol/L', 1,          0, true ),
  ('NA',    'mmol/L', 1,          0, true ),
  ('CA',    'mmol/L', 1,          0, true ),
  ('PHOS',  'mmol/L', 1,          0, true ),
  ('CO2',   'mmol/L', 1,          0, true ),

  -- 血尿酸（μmol/L 标准）
  ('UA',    'μmol/L', 1,          0, true ),
  ('UA',    'umol/L', 1,          0, false), -- ASCII 写法
  ('UA',    'mg/dL',  59.485,     0, false), -- ×59.485 → μmol/L

  -- 血脂（mmol/L 标准）
  ('TCHOL', 'mmol/L', 1,          0, true ),
  ('TCHOL', 'mg/dL',  0.02586,    0, false),
  ('TG',    'mmol/L', 1,          0, true ),
  ('TG',    'mg/dL',  0.01129,    0, false),
  ('LDL',   'mmol/L', 1,          0, true ),
  ('LDL',   'mg/dL',  0.02586,    0, false),
  ('HDL',   'mmol/L', 1,          0, true ),
  ('HDL',   'mg/dL',  0.02586,    0, false),

  -- 炎症
  ('CRP',   'mg/L',   1,          0, true ),

  -- IgAN 专项
  ('IGA',   'g/L',    1,          0, true ),
  ('IGAG',  'ratio',  1,          0, true ),

  -- LN 专项
  ('C3',    'g/L',    1,          0, true ),
  ('C4',    'g/L',    1,          0, true ),
  ('DSDNA', 'IU/mL',  1,          0, true ),

  -- KTX 专项
  ('TACRO', 'ng/mL',  1,          0, true ),
  ('CSA',   'ng/mL',  1,          0, true )

ON CONFLICT (lab_test_code, unit_symbol) DO NOTHING;

-- ─── 8. RLS：字典表只读（所有已登录用户可读，不可修改） ─────────────────────
ALTER TABLE lab_test_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_catalog      ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_test_unit_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "catalog_select" ON lab_test_catalog;
CREATE POLICY "catalog_select" ON lab_test_catalog FOR SELECT TO authenticated, anon USING (true);
DROP POLICY IF EXISTS "unit_select" ON unit_catalog;
CREATE POLICY "unit_select"    ON unit_catalog      FOR SELECT TO authenticated, anon USING (true);
DROP POLICY IF EXISTS "map_select" ON lab_test_unit_map;
CREATE POLICY "map_select"     ON lab_test_unit_map FOR SELECT TO authenticated, anon USING (true);
-- =============================================================
-- PR-3 核心校验器：日期链 / 重复 / 跳变 / eGFR 版本化
-- 目的：在数据写入时自动拦截明显错误，同时保留"留痕后保存"通道
--
-- 三种处理级别：
--   ERROR   → 直接拒绝，返回 HTTP 400，必须改正
--   WARNING → 弹窗提示 + 必填 reason 后才能保存
--   INFO    → 前端提示，不阻止保存
-- =============================================================

-- ─── 1. 给需要留痕 reason 的表加 qc_reason 列 ─────────────────────────────
-- visits_long：随访记录留痕原因
ALTER TABLE visits_long
  ADD COLUMN IF NOT EXISTS qc_reason text;

-- labs_long：化验记录留痕原因
ALTER TABLE labs_long
  ADD COLUMN IF NOT EXISTS qc_reason text;

COMMENT ON COLUMN visits_long.qc_reason IS
  '质控留痕原因。当数据触发跳变警告或同日重复时，必须填写原因才能保存。
  例："患者住院期间急性肾损伤，Scr快速升高，已与主治医生确认"';

COMMENT ON COLUMN labs_long.qc_reason IS
  '质控留痕原因。例："同日两次检测，第一次采血失误，本次为复查确认值"';

-- ─── 2. 硬范围限制更新（visits_long）────────────────────────────────────────
-- 原有约束已有 sbp/dbp/scr 范围，补充更明确的说明
-- upcr 单位为 g/g 时最大 50；为 mg/g 时最大 50000（历史数据兼容）
-- 这里先更新 upcr 上限（原来只有 >=0）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'visits_long_upcr_range'
      AND table_name = 'visits_long'
  ) THEN
    ALTER TABLE visits_long
      ADD CONSTRAINT visits_long_upcr_range CHECK (upcr IS NULL OR (upcr >= 0 AND upcr <= 50000));
  END IF;
END $$;

-- ─── 3. 日期链校验函数：validate_date_chain() ───────────────────────────────
-- 验证：biopsy_date ≤ baseline_date ≤ visit_date ≤ event_date
-- 返回：错误信息 text，NULL 表示通过
CREATE OR REPLACE FUNCTION validate_date_chain(
  p_project_id   uuid,
  p_patient_code text,
  p_visit_date   date  DEFAULT NULL,
  p_event_date   date  DEFAULT NULL
)
RETURNS text   -- NULL=通过；非NULL=错误原因
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_baseline patients_baseline%ROWTYPE;
BEGIN
  SELECT * INTO v_baseline
  FROM patients_baseline
  WHERE project_id  = p_project_id
    AND patient_code = p_patient_code;

  -- 没有基线数据，无法校验，放行
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- 随访日期必须 ≥ 基线日期
  IF p_visit_date IS NOT NULL AND v_baseline.baseline_date IS NOT NULL THEN
    IF p_visit_date < v_baseline.baseline_date THEN
      RETURN '随访日期（' || p_visit_date || '）早于基线日期（'
           || v_baseline.baseline_date || '），请检查。'
           || '如是基线前检查，请改录入基线数据。';
    END IF;
  END IF;

  -- 终点日期必须 ≥ 基线日期
  IF p_event_date IS NOT NULL AND v_baseline.baseline_date IS NOT NULL THEN
    IF p_event_date < v_baseline.baseline_date THEN
      RETURN '终点日期（' || p_event_date || '）早于基线日期（'
           || v_baseline.baseline_date || '），请检查。';
    END IF;
  END IF;

  RETURN NULL;  -- 通过
END;
$$;

COMMENT ON FUNCTION validate_date_chain IS
  '校验日期链：随访/终点日期必须不早于基线日期。返回NULL表示通过，非NULL为错误说明。';

-- ─── 4. 重复录入检测：check_duplicate_lab() ─────────────────────────────────
-- 同一患者、同一日期、同一化验项目已有记录时返回提示
-- 返回：NULL=无重复；非NULL=已有记录信息
CREATE OR REPLACE FUNCTION check_duplicate_lab(
  p_project_id    uuid,
  p_patient_code  text,
  p_lab_date      date,
  p_lab_test_code text,
  p_exclude_id    uuid DEFAULT NULL  -- 编辑时排除自身
)
RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_existing labs_long%ROWTYPE;
BEGIN
  SELECT * INTO v_existing
  FROM labs_long
  WHERE project_id    = p_project_id
    AND patient_code  = p_patient_code
    AND lab_date      = p_lab_date
    AND lab_test_code = p_lab_test_code
    AND (p_exclude_id IS NULL OR id <> p_exclude_id)
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN '该患者在 ' || p_lab_date || ' 已有一条 '
         || p_lab_test_code || ' 记录（值：'
         || COALESCE(v_existing.value_raw::text, v_existing.lab_value::text, '?')
         || ' ' || COALESCE(v_existing.unit_symbol, v_existing.lab_unit, '')
         || '）。如确需保存，请在"留痕原因"中说明（如：复查确认值）。';
  END IF;

  RETURN NULL;
END;
$$;

-- ─── 5. 跳变检测：check_jump_spike() ────────────────────────────────────────
-- 与同患者上一次同化验项目的标准值相比，变化超过阈值则提示
-- 返回：NULL=正常；非NULL=跳变说明
CREATE OR REPLACE FUNCTION check_jump_spike(
  p_project_id    uuid,
  p_patient_code  text,
  p_lab_test_code text,
  p_value_std     numeric,  -- 本次标准值
  p_lab_date      date,
  p_exclude_id    uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_prev_value numeric;
  v_prev_date  date;
  v_ratio      numeric;
  v_threshold  numeric;
BEGIN
  -- 找最近一次同项目记录
  SELECT value_standard, lab_date INTO v_prev_value, v_prev_date
  FROM labs_long
  WHERE project_id    = p_project_id
    AND patient_code  = p_patient_code
    AND lab_test_code = p_lab_test_code
    AND value_standard IS NOT NULL
    AND lab_date < p_lab_date          -- 只和更早的比
    AND (p_exclude_id IS NULL OR id <> p_exclude_id)
  ORDER BY lab_date DESC
  LIMIT 1;

  IF NOT FOUND OR v_prev_value IS NULL OR v_prev_value = 0 THEN
    RETURN NULL;  -- 没有历史值或历史值为0，无法判断跳变
  END IF;

  v_ratio := p_value_std / v_prev_value;

  -- 不同项目用不同阈值（倍数）
  v_threshold := CASE p_lab_test_code
    WHEN 'CREAT' THEN 3.0   -- 血肌酐：涨3倍触发（AKI可能）
    WHEN 'UPCR'  THEN 5.0   -- 尿蛋白：涨5倍触发（波动本身大）
    WHEN 'K'     THEN 2.0   -- 血钾：涨2倍触发（高钾危险）
    ELSE 4.0                 -- 其他指标默认4倍
  END;

  IF v_ratio > v_threshold OR v_ratio < (1.0 / v_threshold) THEN
    RETURN p_lab_test_code || ' 本次值（' || p_value_std || '）与上次（'
         || v_prev_date || '，' || v_prev_value || '）相差超过 '
         || ROUND((v_ratio - 1) * 100) || '%，存在异常跳变。'
         || '如确认无误，请在"留痕原因"中说明（如：患者住院期间AKI，已与上级确认）。';
  END IF;

  RETURN NULL;
END;
$$;

-- ─── 6. 随访记录综合校验：validate_visit_record() ──────────────────────────
-- 前端和 RPC 都调用这个函数，返回 errors + warnings
-- errors   → 必须修正，无法保存
-- warnings → 需要填 reason，填完才能保存
CREATE OR REPLACE FUNCTION validate_visit_record(
  p_project_id   uuid,
  p_patient_code text,
  p_visit_date   date,
  p_sbp          numeric DEFAULT NULL,
  p_dbp          numeric DEFAULT NULL,
  p_scr_umol_l   numeric DEFAULT NULL,
  p_upcr         numeric DEFAULT NULL,
  p_egfr         numeric DEFAULT NULL,
  p_notes        text    DEFAULT NULL,
  p_exclude_id   uuid    DEFAULT NULL
)
RETURNS jsonb   -- { "errors": [...], "warnings": [...] }
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
  v_errors   text[] := '{}';
  v_warnings text[] := '{}';
  v_date_err text;
  v_prev_scr numeric;
  v_prev_date date;
  v_ratio    numeric;
  v_dup_cnt  int;
BEGIN
  -- ① 日期链校验（ERROR）
  v_date_err := validate_date_chain(p_project_id, p_patient_code, p_visit_date, NULL);
  IF v_date_err IS NOT NULL THEN
    v_errors := array_append(v_errors, v_date_err);
  END IF;

  -- ② 血压范围（ERROR）
  IF p_sbp IS NOT NULL AND (p_sbp < 30 OR p_sbp > 300) THEN
    v_errors := array_append(v_errors,
      '收缩压（SBP）' || p_sbp || ' mmHg 超出合理范围 30–300 mmHg，请检查是否录入有误');
  END IF;
  IF p_dbp IS NOT NULL AND (p_dbp < 30 OR p_dbp > 300) THEN
    v_errors := array_append(v_errors,
      '舒张压（DBP）' || p_dbp || ' mmHg 超出合理范围 30–300 mmHg');
  END IF;
  IF p_sbp IS NOT NULL AND p_dbp IS NOT NULL AND p_dbp >= p_sbp THEN
    v_errors := array_append(v_errors,
      '舒张压（' || p_dbp || '）≥ 收缩压（' || p_sbp || '），请检查血压录入顺序');
  END IF;

  -- ③ 血肌酐范围（单位 μmol/L）（ERROR）
  IF p_scr_umol_l IS NOT NULL AND (p_scr_umol_l < 10 OR p_scr_umol_l > 5000) THEN
    v_errors := array_append(v_errors,
      '血肌酐 ' || p_scr_umol_l || ' μmol/L 超出合理范围 10–5000 μmol/L');
  END IF;

  -- ④ UPCR 范围（单位 g/g 标准化后；visits_long 存的是原始值，以 mg/g 为主）
  IF p_upcr IS NOT NULL AND p_upcr < 0 THEN
    v_errors := array_append(v_errors, 'UPCR 不能为负数');
  END IF;

  -- ⑤ PII 检测（ERROR）
  IF _contains_pii(COALESCE(p_notes, '')) THEN
    v_errors := array_append(v_errors,
      '备注疑似包含个人身份信息（手机号/身份证/住院号等）。'
      || '请删除后重新保存，系统拒绝存储任何可识别个人信息（PII）。');
  END IF;

  -- ⑥ 同日重复随访（WARNING，允许填 reason 后保存）
  SELECT COUNT(*) INTO v_dup_cnt
  FROM visits_long
  WHERE project_id   = p_project_id
    AND patient_code = p_patient_code
    AND visit_date   = p_visit_date
    AND (p_exclude_id IS NULL OR id <> p_exclude_id);

  IF v_dup_cnt > 0 THEN
    v_warnings := array_append(v_warnings,
      '该患者在 ' || p_visit_date || ' 已有 ' || v_dup_cnt
      || ' 条随访记录，请确认是否为重复录入。如为同日多次测量，请在"留痕原因"中说明。');
  END IF;

  -- ⑦ 血肌酐跳变检测（WARNING）
  IF p_scr_umol_l IS NOT NULL THEN
    SELECT v.scr_umol_l, v.visit_date INTO v_prev_scr, v_prev_date
    FROM visits_long v
    WHERE v.project_id   = p_project_id
      AND v.patient_code = p_patient_code
      AND v.scr_umol_l  IS NOT NULL
      AND v.visit_date   < p_visit_date
      AND (p_exclude_id IS NULL OR v.id <> p_exclude_id)
    ORDER BY v.visit_date DESC
    LIMIT 1;

    IF FOUND AND v_prev_scr > 0 THEN
      v_ratio := p_scr_umol_l / v_prev_scr;
      IF v_ratio > 3.0 OR v_ratio < (1.0/3.0) THEN
        v_warnings := array_append(v_warnings,
          '血肌酐本次（' || p_scr_umol_l || ' μmol/L）与上次（'
          || v_prev_date || '，' || v_prev_scr
          || ' μmol/L）相差超过 3 倍，请确认是否为急性肾损伤或测量误差。'
          || '如确认无误，请填写"留痕原因"。');
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'errors',   to_jsonb(v_errors),
    'warnings', to_jsonb(v_warnings)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION validate_visit_record    TO authenticated, anon;
GRANT EXECUTE ON FUNCTION validate_date_chain      TO authenticated;
GRANT EXECUTE ON FUNCTION check_duplicate_lab      TO authenticated;
GRANT EXECUTE ON FUNCTION check_jump_spike         TO authenticated;

COMMENT ON FUNCTION validate_visit_record IS
  '随访记录综合校验。返回 {errors:[...], warnings:[...]}。
  errors 必须修正才能保存；warnings 需要填写 qc_reason 才能保存。
  例：validate_visit_record(pid, ''P001'', ''2024-01-15'', 160, 95, 150, 1.2)';

-- ─── 7. eGFR 计算函数：ckd_epi_2021() ──────────────────────────────────────
-- 公式：CKD-EPI 2021（无种族项，国际主流，可直接引用）
-- 输入：血肌酐（mg/dL）、性别（M/F）、年龄（岁）
-- 输出：eGFR（mL/min/1.73m²）
-- 论文引用：Inker et al., NEJM 2021;385:1737–1749
CREATE OR REPLACE FUNCTION ckd_epi_2021(
  p_scr_mg_dl numeric,   -- 血肌酐，单位必须是 mg/dL
  p_sex       text,      -- 'M' 或 'F'
  p_age_years numeric    -- 年龄（岁）
)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_kappa    numeric;
  v_alpha    numeric;
  v_sex_mult numeric;
  v_scr_k    numeric;
BEGIN
  IF p_scr_mg_dl IS NULL OR p_sex IS NULL OR p_age_years IS NULL THEN
    RETURN NULL;
  END IF;

  -- 按性别设定参数（CKD-EPI 2021 原文参数）
  IF upper(p_sex) = 'F' THEN
    v_kappa    := 0.7;
    v_alpha    := -0.241;
    v_sex_mult := 1.012;
  ELSE
    v_kappa    := 0.9;
    v_alpha    := -0.302;
    v_sex_mult := 1.0;
  END IF;

  v_scr_k := p_scr_mg_dl / v_kappa;

  RETURN ROUND(
    142.0
    * POWER(LEAST(v_scr_k, 1.0), v_alpha)
    * POWER(GREATEST(v_scr_k, 1.0), -1.200)
    * POWER(0.9938, p_age_years)
    * v_sex_mult
  , 1);
END;
$$;

COMMENT ON FUNCTION ckd_epi_2021 IS
  'CKD-EPI 2021 公式计算eGFR（无种族项）。
  输入：血肌酐mg/dL、性别(M/F)、年龄（岁）。
  论文：Inker et al., NEJM 2021;385:1737-1749。
  例：ckd_epi_2021(1.0, ''M'', 50) → 约87 mL/min/1.73m²';

-- ─── 8. 自动计算 eGFR 的触发器（visits_long） ────────────────────────────
-- 每次写入/更新 scr_umol_l 时，若有患者年龄和性别，自动计算 eGFR
CREATE OR REPLACE FUNCTION _auto_compute_egfr()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_baseline patients_baseline%ROWTYPE;
  v_age      numeric;
  v_scr_mgdl numeric;
BEGIN
  -- 只在有 scr_umol_l 时才计算
  IF NEW.scr_umol_l IS NULL THEN
    NEW.egfr_formula_version := 'missing_inputs';
    RETURN NEW;
  END IF;

  -- 查基线（获取性别和出生年）
  SELECT * INTO v_baseline
  FROM patients_baseline
  WHERE project_id  = NEW.project_id
    AND patient_code = NEW.patient_code;

  IF NOT FOUND OR v_baseline.sex IS NULL OR v_baseline.birth_year IS NULL THEN
    -- 缺性别或出生年，无法计算
    NEW.egfr_formula_version := 'missing_inputs';
    RETURN NEW;
  END IF;

  -- 从 μmol/L 换算 mg/dL
  v_scr_mgdl := NEW.scr_umol_l * 0.01130996;

  -- 计算年龄
  v_age := EXTRACT(YEAR FROM NEW.visit_date) - v_baseline.birth_year;
  IF v_age < 18 OR v_age > 120 THEN
    NEW.egfr_formula_version := 'missing_inputs';
    RETURN NEW;
  END IF;

  -- 仅当用户没有手动填 egfr 时，才用公式覆盖
  -- 若用户手填了 egfr，则 formula_version='manual'
  IF NEW.egfr IS NOT NULL AND (TG_OP = 'UPDATE' AND OLD.egfr IS NOT NULL AND NEW.egfr = OLD.egfr)
     OR (TG_OP = 'INSERT' AND NEW.egfr_formula_version = 'manual') THEN
    -- 手动填写，保留
    RETURN NEW;
  END IF;

  NEW.egfr := ckd_epi_2021(v_scr_mgdl, v_baseline.sex, v_age);
  NEW.egfr_formula_version := 'CKD-EPI-2021-Cr';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_egfr ON visits_long;
CREATE TRIGGER trg_auto_egfr
  BEFORE INSERT OR UPDATE OF scr_umol_l ON visits_long
  FOR EACH ROW EXECUTE FUNCTION _auto_compute_egfr();

COMMENT ON TRIGGER trg_auto_egfr ON visits_long IS
  '每次录入/更新血肌酐时，自动用 CKD-EPI 2021 公式计算 eGFR 并记录公式版本';

GRANT EXECUTE ON FUNCTION ckd_epi_2021 TO authenticated;
-- =============================================================
-- PR-5 PII 全路径拦截：数据库触发器层
-- 目的：无论从哪个入口（staff录入/patient录入/直接API）写入数据
--       只要包含个人身份信息，数据库就拒绝保存
--
-- 什么是 PII（个人可识别信息）？
-- ─────────────────────────────
-- 本系统是科研数据库，严禁录入以下信息：
--   ✗ 手机号：如 13812345678
--   ✗ 身份证号：如 110101199001011234
--   ✗ 住院号/病案号/门诊号：如 住院号:123456、MRN: 789
--   ✗ 姓名：如 患者:张三、姓名:李四
--   ✗ 8位以上连续数字（可能是各种编号）
--
-- 正确做法：
--   ✓ 用中心分配的患者编码，如 BJ01-2024-001
--   ✓ 备注只写临床事实，如 "血压控制良好，依从性好"
-- =============================================================

-- ─── 1. 通用 PII 拦截触发器函数 ─────────────────────────────────────────────
-- 本函数被注册到所有含自由文本字段的表上
-- 检查的字段通过 TG_ARGV 传入
CREATE OR REPLACE FUNCTION _pii_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_field text;
  v_value text;
BEGIN
  -- 遍历需要检查的字段列表（由触发器注册时通过参数指定）
  FOREACH v_field IN ARRAY TG_ARGV LOOP
    EXECUTE format('SELECT ($1).%I::text', v_field) INTO v_value USING NEW;
    IF v_value IS NOT NULL AND _contains_pii(v_value) THEN
      RAISE EXCEPTION 'pii_detected_blocked'
        USING HINT = format(
          '字段 "%s" 中检测到疑似个人身份信息（PII）。'
          '本系统为科研数据库，禁止录入手机号、身份证、住院号、姓名等可识别信息。'
          '请检查并修改后重新保存。问题内容片段：%s',
          v_field,
          left(v_value, 30) || CASE WHEN length(v_value) > 30 THEN '...' ELSE '' END
        );
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION _pii_guard IS
  'PII拦截触发器。检测自由文本字段中的个人身份信息并拒绝写入。
  触发时抛出异常 pii_detected_blocked，前端可捕获并显示友好提示。';

-- ─── 2. 注册触发器到各个表 ──────────────────────────────────────────────────

-- visits_long.notes（随访备注）
DROP TRIGGER IF EXISTS trg_pii_guard_visits ON visits_long;
CREATE TRIGGER trg_pii_guard_visits
  BEFORE INSERT OR UPDATE ON visits_long
  FOR EACH ROW EXECUTE FUNCTION _pii_guard('notes');

-- labs_long.qc_reason（化验留痕原因）
DROP TRIGGER IF EXISTS trg_pii_guard_labs ON labs_long;
CREATE TRIGGER trg_pii_guard_labs
  BEFORE INSERT OR UPDATE ON labs_long
  FOR EACH ROW EXECUTE FUNCTION _pii_guard('qc_reason');

-- meds_long（用药记录：drug_name / drug_class / dose 一般不含PII，但 dose 字段可能有备注）
-- 暂不加 trigger，在前端校验即可（drug 字段结构化，PII风险低）

-- variants_long.notes（基因变异备注）
DROP TRIGGER IF EXISTS trg_pii_guard_variants ON variants_long;
CREATE TRIGGER trg_pii_guard_variants
  BEFORE INSERT OR UPDATE ON variants_long
  FOR EACH ROW EXECUTE FUNCTION _pii_guard('notes');

-- events_long.notes（终点事件备注）
DROP TRIGGER IF EXISTS trg_pii_guard_events ON events_long;
CREATE TRIGGER trg_pii_guard_events
  BEFORE INSERT OR UPDATE ON events_long
  FOR EACH ROW EXECUTE FUNCTION _pii_guard('notes');

-- ─── 3. 增强 _contains_pii 函数（补充更多模式） ─────────────────────────────
-- 原函数已有基础 regex，这里覆盖并补充更多模式
CREATE OR REPLACE FUNCTION _contains_pii(p_text text)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  IF p_text IS NULL OR length(trim(p_text)) = 0 THEN
    RETURN false;
  END IF;

  RETURN (
    -- 中国大陆手机号（1[3-9] 开头，11位）
    p_text ~ '1[3-9][0-9]{9}'

    -- 中国身份证（18位，包含校验位X）
    OR p_text ~ '[1-9][0-9]{5}(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx]'

    -- 住院相关关键词 + 数字（如 住院号:123456、MRN: 789、病案号123）
    OR p_text ~* '(住院号|病案号|门诊号|病历号|床号|mrn|admiss)[^a-z0-9]{0,3}[0-9]{3,}'

    -- 姓名关键词（如 患者:张三、姓名：李四、病人 王五）
    OR p_text ~* '(姓名|患者姓名|病人|name\s*[:：])\s*[\u4e00-\u9fa5]{2,4}'

    -- 8位以上连续数字（各类编号风险）
    OR p_text ~ '[0-9]{8,}'

    -- 邮箱（含 @ 符号，且 @ 前后都有字符）
    OR p_text ~ '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'

    -- 身份证关键词
    OR p_text ~* '(身份证|id\s*card|身份号)[^a-z]{0,5}[0-9]'
  );
END;
$$;

-- ─── 4. 测试用例（注释说明，实际验证时可执行） ─────────────────────────────
-- 以下 SELECT 均应返回 true（表示检测到PII，会被拦截）：
-- SELECT _contains_pii('患者手机：13812345678');             → true（手机号）
-- SELECT _contains_pii('住院号:20240012345');               → true（住院号）
-- SELECT _contains_pii('身份证：110101199001011234');        → true（身份证）
-- SELECT _contains_pii('患者：张三，血压控制良好');           → true（姓名关键词）
-- SELECT _contains_pii('MRN: 789456，复查正常');             → true（MRN）
-- SELECT _contains_pii('creatinine 1.2 mg/dL, stable');   → false（正常临床描述）
-- SELECT _contains_pii('血压控制良好，依从性佳');             → false（正常中文描述）
-- SELECT _contains_pii('UPCR 1.5 g/g 较前下降');            → false（正常化验描述）
