-- =============================================================
-- PR-6 Issue/Query 质控闭环系统
-- 目的：把"质控警告"变成"可追踪的任务"，直到问题解决才关闭
--
-- 类比：这是数据版的"Bug 跟踪系统"
--   ● 数据写入时自动检测问题 → 生成 Issue（OPEN）
--   ● 研究者修正数据 → Issue 自动关闭（RESOLVED）
--   ● 无法修正但有理由 → 手动标记 WONT_FIX（必须填理由）
--   ● 仪表盘展示：哪些患者还有未解决的数据质量问题
-- =============================================================

-- ─── 1. Issue 主表：data_issues ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS data_issues (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  center_code     text,                 -- 来自项目的中心编码，方便按中心筛查
  patient_code    text NOT NULL,        -- 问题关联的患者
  record_type     text NOT NULL,        -- 问题关联的记录类型：visit/lab/baseline/event
  record_id       uuid,                 -- 问题记录的 ID（可 NULL，如缺失数据没有ID）
  rule_code       text NOT NULL,        -- 触发的规则编码（见下方说明）
  severity        text NOT NULL DEFAULT 'warning',  -- critical/warning/info
  status          text NOT NULL DEFAULT 'OPEN',     -- OPEN/IN_PROGRESS/RESOLVED/WONT_FIX
  assigned_to     uuid REFERENCES auth.users(id),   -- 指派给哪位研究者处理
  message         text NOT NULL,        -- 问题描述（面向研究者的中文说明）
  resolution_note text,                 -- 解决说明（RESOLVED 或 WONT_FIX 时必填）
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  resolved_at     timestamptz,          -- 自动解决时间
  created_by      uuid REFERENCES auth.users(id),   -- 系统自动创建或人工创建

  CONSTRAINT data_issues_severity_check
    CHECK (severity IN ('critical', 'warning', 'info')),
  CONSTRAINT data_issues_status_check
    CHECK (status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'WONT_FIX')),
  CONSTRAINT data_issues_record_type_check
    CHECK (record_type IN ('visit', 'lab', 'baseline', 'event', 'medication'))
);

-- 去重索引：同一规则+同一记录只生成一个 Issue
CREATE UNIQUE INDEX IF NOT EXISTS data_issues_dedup
  ON data_issues(project_id, patient_code, record_type, COALESCE(record_id::text,'NULL'), rule_code)
  WHERE status NOT IN ('RESOLVED', 'WONT_FIX');

CREATE INDEX IF NOT EXISTS data_issues_project_status
  ON data_issues(project_id, status, severity);

CREATE INDEX IF NOT EXISTS data_issues_patient
  ON data_issues(project_id, patient_code, status);

COMMENT ON TABLE data_issues IS
  'Issue质控系统：记录每条数据的质量问题，跟踪解决状态。
  类似GitHub Issues，每个数据问题是一个Issue，修复后自动关闭。';

COMMENT ON COLUMN data_issues.rule_code IS
  '触发规则编码，可选值：
  MISSING_CORE_FIELD   - 缺失核心字段（必填项为空）
  OUT_OF_RANGE         - 超出合理范围
  UNIT_NOT_ALLOWED     - 化验单位不在允许列表中
  DATE_CONFLICT        - 日期链冲突（如随访早于基线）
  DUPLICATE_SAME_DAY   - 同日重复录入
  JUMP_SPIKE           - 数值异常跳变
  MISSING_EGFR_INPUTS  - 缺性别/出生年导致无法计算eGFR
  PII_SUSPECTED        - 疑似含个人身份信息（严重）';

COMMENT ON COLUMN data_issues.severity IS
  'critical=数据无法用于分析（如日期冲突）；
  warning=数据可疑需确认（如跳变）；
  info=建议补充（如eGFR无法计算）';

-- ─── 2. Issue 评论表：data_issue_comments ────────────────────────────────────
CREATE TABLE IF NOT EXISTS data_issue_comments (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  issue_id   uuid NOT NULL REFERENCES data_issues(id) ON DELETE CASCADE,
  comment    text NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS data_issue_comments_issue
  ON data_issue_comments(issue_id, created_at);

COMMENT ON TABLE data_issue_comments IS
  'Issue 讨论记录：研究者可以在Issue下留言，说明情况、协商处理方案';

-- ─── 3. RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE data_issues         ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_issue_comments ENABLE ROW LEVEL SECURITY;

-- 项目成员可以查看/操作自己项目的 Issue
DROP POLICY IF EXISTS "issues_project_owner" ON data_issues;
CREATE POLICY "issues_project_owner"
  ON data_issues FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = data_issues.project_id
      AND p.created_by = auth.uid()
  ));

DROP POLICY IF EXISTS "comments_issue_owner" ON data_issue_comments;
CREATE POLICY "comments_issue_owner"
  ON data_issue_comments FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM data_issues i
    JOIN projects p ON p.id = i.project_id
    WHERE i.id = data_issue_comments.issue_id
      AND p.created_by = auth.uid()
  ));

-- ─── 4. 自动生成/更新 Issue 的函数：raise_or_update_issue() ──────────────────
-- 每次数据写入后由触发器调用
-- 去重逻辑：同一规则+同一记录，只有一个 OPEN/IN_PROGRESS Issue
CREATE OR REPLACE FUNCTION raise_or_update_issue(
  p_project_id   uuid,
  p_patient_code text,
  p_record_type  text,
  p_record_id    uuid,
  p_rule_code    text,
  p_severity     text,
  p_message      text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_issue_id   uuid;
  v_center     text;
BEGIN
  SELECT center_code INTO v_center FROM projects WHERE id = p_project_id;

  -- 尝试找已有的 OPEN 或 IN_PROGRESS Issue（去重）
  SELECT id INTO v_issue_id
  FROM data_issues
  WHERE project_id   = p_project_id
    AND patient_code = p_patient_code
    AND record_type  = p_record_type
    AND (record_id = p_record_id OR (record_id IS NULL AND p_record_id IS NULL))
    AND rule_code    = p_rule_code
    AND status NOT IN ('RESOLVED', 'WONT_FIX')
  LIMIT 1;

  IF FOUND THEN
    -- 更新已有 Issue（信息可能有变化）
    UPDATE data_issues SET
      message    = p_message,
      severity   = p_severity,
      updated_at = now()
    WHERE id = v_issue_id;
  ELSE
    -- 新建 Issue
    INSERT INTO data_issues(
      project_id, center_code, patient_code,
      record_type, record_id, rule_code,
      severity, status, message
    ) VALUES (
      p_project_id, v_center, p_patient_code,
      p_record_type, p_record_id, p_rule_code,
      p_severity, 'OPEN', p_message
    )
    RETURNING id INTO v_issue_id;
  END IF;

  RETURN v_issue_id;
END;
$$;

-- ─── 5. 自动关闭 Issue 的函数：resolve_issue_if_exists() ─────────────────────
-- 数据修正后调用，自动把对应 Issue 改为 RESOLVED
CREATE OR REPLACE FUNCTION resolve_issue_if_exists(
  p_project_id   uuid,
  p_patient_code text,
  p_record_type  text,
  p_record_id    uuid,
  p_rule_code    text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE data_issues SET
    status       = 'RESOLVED',
    resolved_at  = now(),
    resolution_note = '数据已修正，系统自动关闭',
    updated_at   = now()
  WHERE project_id   = p_project_id
    AND patient_code = p_patient_code
    AND record_type  = p_record_type
    AND (record_id = p_record_id OR (record_id IS NULL AND p_record_id IS NULL))
    AND rule_code    = p_rule_code
    AND status NOT IN ('RESOLVED', 'WONT_FIX');
END;
$$;

-- ─── 6. 手动关闭 Issue（WONT_FIX）：close_issue_wont_fix() ─────────────────
CREATE OR REPLACE FUNCTION close_issue_wont_fix(
  p_issue_id      uuid,
  p_resolution    text  -- 必填！说明为什么不修复
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  IF p_resolution IS NULL OR trim(p_resolution) = '' THEN
    RAISE EXCEPTION 'resolution_required'
      USING HINT = '标记为"不修复"时必须填写原因，例："该患者是历史数据导入，日期无法追溯"';
  END IF;

  UPDATE data_issues SET
    status          = 'WONT_FIX',
    resolution_note = p_resolution,
    resolved_at     = now(),
    updated_at      = now()
  WHERE id = p_issue_id
    AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = data_issues.project_id
        AND p.created_by = auth.uid()
    );

  IF NOT FOUND THEN
    RAISE EXCEPTION 'issue_not_found' USING HINT = 'Issue不存在或无权操作';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION close_issue_wont_fix  TO authenticated;
GRANT EXECUTE ON FUNCTION raise_or_update_issue TO authenticated;
GRANT EXECUTE ON FUNCTION resolve_issue_if_exists TO authenticated;

-- ─── 7. QC 规则触发器：visits_long ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION _qc_check_visit()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_baseline patients_baseline%ROWTYPE;
BEGIN
  SELECT * INTO v_baseline
  FROM patients_baseline
  WHERE project_id = NEW.project_id AND patient_code = NEW.patient_code;

  -- 规则①：随访日期早于基线 → critical
  IF FOUND AND v_baseline.baseline_date IS NOT NULL
     AND NEW.visit_date < v_baseline.baseline_date THEN
    PERFORM raise_or_update_issue(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id,
      'DATE_CONFLICT', 'critical',
      '随访日期（' || NEW.visit_date || '）早于基线日期（'
      || v_baseline.baseline_date || '），数据无法用于时序分析'
    );
  ELSE
    PERFORM resolve_issue_if_exists(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id, 'DATE_CONFLICT'
    );
  END IF;

  -- 规则②：缺核心字段（scr 或 upcr）→ warning
  IF NEW.scr_umol_l IS NULL AND NEW.upcr IS NULL THEN
    PERFORM raise_or_update_issue(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id,
      'MISSING_CORE_FIELD', 'warning',
      '随访记录（' || NEW.visit_date || '）缺少血肌酐和UPCR，eGFR及蛋白尿无法分析'
    );
  ELSE
    PERFORM resolve_issue_if_exists(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id, 'MISSING_CORE_FIELD'
    );
  END IF;

  -- 规则③：eGFR 因缺输入无法计算 → info
  IF NEW.egfr IS NULL AND NEW.scr_umol_l IS NOT NULL THEN
    PERFORM raise_or_update_issue(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id,
      'MISSING_EGFR_INPUTS', 'info',
      '有血肌酐数据，但缺少患者性别或出生年，无法自动计算eGFR。请完善基线信息。'
    );
  ELSE
    PERFORM resolve_issue_if_exists(
      NEW.project_id, NEW.patient_code, 'visit', NEW.id, 'MISSING_EGFR_INPUTS'
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_qc_visit ON visits_long;
CREATE TRIGGER trg_qc_visit
  AFTER INSERT OR UPDATE ON visits_long
  FOR EACH ROW EXECUTE FUNCTION _qc_check_visit();

-- ─── 8. QC 规则触发器：labs_long ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _qc_check_lab()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- 规则：单位不在允许列表 → warning
  IF NEW.lab_test_code IS NOT NULL AND NEW.unit_symbol IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM lab_test_unit_map
      WHERE lab_test_code = NEW.lab_test_code
        AND unit_symbol   = NEW.unit_symbol
    ) THEN
      PERFORM raise_or_update_issue(
        NEW.project_id, NEW.patient_code, 'lab', NEW.id,
        'UNIT_NOT_ALLOWED', 'warning',
        '化验项目 ' || NEW.lab_test_code || ' 使用了不允许的单位 "'
        || NEW.unit_symbol || '"，标准化换算失败，无法合并分析'
      );
    ELSE
      PERFORM resolve_issue_if_exists(
        NEW.project_id, NEW.patient_code, 'lab', NEW.id, 'UNIT_NOT_ALLOWED'
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_qc_lab ON labs_long;
CREATE TRIGGER trg_qc_lab
  AFTER INSERT OR UPDATE ON labs_long
  FOR EACH ROW EXECUTE FUNCTION _qc_check_lab();

-- ─── 9. 查询 Issue 统计的 RPC（仪表盘用） ───────────────────────────────────
CREATE OR REPLACE FUNCTION get_issue_summary(p_project_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'total_open',    COUNT(*) FILTER (WHERE status = 'OPEN'),
    'total_in_prog', COUNT(*) FILTER (WHERE status = 'IN_PROGRESS'),
    'total_resolved',COUNT(*) FILTER (WHERE status = 'RESOLVED'),
    'total_wontfix', COUNT(*) FILTER (WHERE status = 'WONT_FIX'),
    'by_severity', jsonb_build_object(
      'critical', COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','WONT_FIX') AND severity='critical'),
      'warning',  COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','WONT_FIX') AND severity='warning'),
      'info',     COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','WONT_FIX') AND severity='info')
    ),
    'close_rate_pct', ROUND(
      100.0 * COUNT(*) FILTER (WHERE status IN ('RESOLVED','WONT_FIX'))
      / NULLIF(COUNT(*), 0)
    , 1)
  )
  INTO v_result
  FROM data_issues
  WHERE project_id = p_project_id
    AND EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = p_project_id AND p.created_by = auth.uid()
    );

  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION get_issue_summary TO authenticated;
-- =============================================================
-- PR-7 字段级审计日志
-- 目的：记录"谁在什么时候把哪个字段从X改成了Y，为什么改"
--       做到每一次改动都可追溯、可还原
--
-- 使用场景举例：
--   研究员发现某患者基线 Scr 从 120 变成了 95 μmol/L
--   通过 field_audit_log 可以查到：
--     "2024-03-15 09:32, 张医生, 原因：录入时誊写错误，已核对原始化验单"
-- =============================================================

-- ─── 1. 字段级审计表：field_audit_log ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS field_audit_log (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  table_name    text NOT NULL,       -- 被修改的表名，例：visits_long
  record_id     uuid NOT NULL,       -- 被修改记录的 ID
  project_id    uuid,                -- 所属项目（冗余存储，方便查询）
  patient_code  text,                -- 所属患者（冗余存储）
  field_name    text NOT NULL,       -- 被修改的字段名，例：scr_umol_l
  old_value     text,                -- 修改前的值（统一转为文本存储）
  new_value     text,                -- 修改后的值
  changed_by    uuid REFERENCES auth.users(id),  -- 操作人 UUID
  changed_at    timestamptz DEFAULT now(),
  change_reason text,                -- 修改原因（应用层传入）
  ip_hint       text                 -- 可选：IP 地址或来源标识
);

CREATE INDEX IF NOT EXISTS field_audit_record
  ON field_audit_log(table_name, record_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS field_audit_project
  ON field_audit_log(project_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS field_audit_patient
  ON field_audit_log(project_id, patient_code, changed_at DESC);

COMMENT ON TABLE field_audit_log IS
  '字段级审计：记录关键字段的每次修改（谁、何时、改了什么、为什么）。
  任何用户不可删除（通过RLS保证），平台管理员也不应随意删除。';

COMMENT ON COLUMN field_audit_log.old_value IS
  '修改前的值，统一存为文本。NULL表示该字段之前为空。';
COMMENT ON COLUMN field_audit_log.change_reason IS
  '修改原因，由前端要求用户填写。例："原始化验单复核后发现录入有误"';

-- ─── 2. RLS：只读，不允许 DELETE/UPDATE ─────────────────────────────────────
ALTER TABLE field_audit_log ENABLE ROW LEVEL SECURITY;

-- 项目成员可以查看自己项目的审计记录
DROP POLICY IF EXISTS "field_audit_select" ON field_audit_log;
CREATE POLICY "field_audit_select"
  ON field_audit_log FOR SELECT TO authenticated
  USING (
    project_id IS NULL
    OR EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = field_audit_log.project_id
        AND p.created_by = auth.uid()
    )
  );

-- 审计记录只能由系统自动写入（通过 SECURITY DEFINER 函数），不允许用户直接 INSERT
-- 不设置 INSERT policy → 用户无法直接插入，只能通过 log_field_change() 函数

-- ─── 3. 写入审计记录的函数：log_field_change() ──────────────────────────────
-- 应用层在修改关键字段前调用此函数记录变更
CREATE OR REPLACE FUNCTION log_field_change(
  p_table_name   text,
  p_record_id    uuid,
  p_project_id   uuid,
  p_patient_code text,
  p_field_name   text,
  p_old_value    text,
  p_new_value    text,
  p_reason       text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- 值没变就不记录（防止噪音）
  IF p_old_value IS NOT DISTINCT FROM p_new_value THEN
    RETURN;
  END IF;

  INSERT INTO field_audit_log(
    table_name, record_id, project_id, patient_code,
    field_name, old_value, new_value,
    changed_by, change_reason
  ) VALUES (
    p_table_name, p_record_id, p_project_id, p_patient_code,
    p_field_name, p_old_value, p_new_value,
    auth.uid(), p_reason
  );
END;
$$;

GRANT EXECUTE ON FUNCTION log_field_change TO authenticated;

-- ─── 4. 自动捕获 visits_long 关键字段变更的触发器 ──────────────────────────
-- 监控字段：visit_date / sbp / dbp / scr_umol_l / upcr / egfr / notes
-- 触发器把 old/new 变化写入 field_audit_log
CREATE OR REPLACE FUNCTION _audit_visit_fields()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_reason text;
BEGIN
  -- 从 new row 读取 qc_reason 作为修改原因（研究者在前端填写的）
  v_reason := NEW.qc_reason;

  -- 逐字段比较，有变化则写审计
  IF OLD.visit_date IS DISTINCT FROM NEW.visit_date THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'visit_date', OLD.visit_date::text, NEW.visit_date::text, v_reason);
  END IF;
  IF OLD.sbp IS DISTINCT FROM NEW.sbp THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'sbp', OLD.sbp::text, NEW.sbp::text, v_reason);
  END IF;
  IF OLD.dbp IS DISTINCT FROM NEW.dbp THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'dbp', OLD.dbp::text, NEW.dbp::text, v_reason);
  END IF;
  IF OLD.scr_umol_l IS DISTINCT FROM NEW.scr_umol_l THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'scr_umol_l', OLD.scr_umol_l::text, NEW.scr_umol_l::text, v_reason);
  END IF;
  IF OLD.upcr IS DISTINCT FROM NEW.upcr THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'upcr', OLD.upcr::text, NEW.upcr::text, v_reason);
  END IF;
  IF OLD.egfr IS DISTINCT FROM NEW.egfr THEN
    PERFORM log_field_change('visits_long', NEW.id, NEW.project_id, NEW.patient_code,
      'egfr', OLD.egfr::text, NEW.egfr::text, v_reason);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_visit_fields ON visits_long;
CREATE TRIGGER trg_audit_visit_fields
  AFTER UPDATE ON visits_long
  FOR EACH ROW EXECUTE FUNCTION _audit_visit_fields();

-- ─── 5. 自动捕获 patients_baseline 关键字段变更 ─────────────────────────────
CREATE OR REPLACE FUNCTION _audit_baseline_fields()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  IF OLD.baseline_date IS DISTINCT FROM NEW.baseline_date THEN
    PERFORM log_field_change('patients_baseline', NEW.id, NEW.project_id, NEW.patient_code,
      'baseline_date', OLD.baseline_date::text, NEW.baseline_date::text, NULL);
  END IF;
  IF OLD.baseline_scr IS DISTINCT FROM NEW.baseline_scr THEN
    PERFORM log_field_change('patients_baseline', NEW.id, NEW.project_id, NEW.patient_code,
      'baseline_scr', OLD.baseline_scr::text, NEW.baseline_scr::text, NULL);
  END IF;
  IF OLD.baseline_upcr IS DISTINCT FROM NEW.baseline_upcr THEN
    PERFORM log_field_change('patients_baseline', NEW.id, NEW.project_id, NEW.patient_code,
      'baseline_upcr', OLD.baseline_upcr::text, NEW.baseline_upcr::text, NULL);
  END IF;
  IF OLD.sex IS DISTINCT FROM NEW.sex THEN
    PERFORM log_field_change('patients_baseline', NEW.id, NEW.project_id, NEW.patient_code,
      'sex', OLD.sex, NEW.sex, NULL);
  END IF;
  IF OLD.birth_year IS DISTINCT FROM NEW.birth_year THEN
    PERFORM log_field_change('patients_baseline', NEW.id, NEW.project_id, NEW.patient_code,
      'birth_year', OLD.birth_year::text, NEW.birth_year::text, NULL);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_baseline_fields ON patients_baseline;
CREATE TRIGGER trg_audit_baseline_fields
  AFTER UPDATE ON patients_baseline
  FOR EACH ROW EXECUTE FUNCTION _audit_baseline_fields();

-- ─── 6. 查询某记录审计历史的 RPC ────────────────────────────────────────────
DROP FUNCTION IF EXISTS get_field_audit(text, uuid);
CREATE OR REPLACE FUNCTION get_field_audit(
  p_table_name text,
  p_record_id  uuid
)
RETURNS TABLE(
  changed_at    timestamptz,
  field_name    text,
  old_value     text,
  new_value     text,
  changed_by    uuid,
  change_reason text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.changed_at,
    a.field_name,
    a.old_value,
    a.new_value,
    a.changed_by,
    a.change_reason
  FROM field_audit_log a
  WHERE a.table_name = p_table_name
    AND a.record_id  = p_record_id
    AND (
      a.project_id IS NULL
      OR EXISTS (
        SELECT 1 FROM projects p
        WHERE p.id = a.project_id AND p.created_by = auth.uid()
      )
    )
  ORDER BY a.changed_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION get_field_audit TO authenticated;

COMMENT ON FUNCTION get_field_audit IS
  '查询某记录的字段修改历史。
  例：SELECT * FROM get_field_audit(''visits_long'', ''uuid-of-visit'')
  返回：哪些字段被修改、修改前后的值、谁修改的、修改原因';
-- LN（狼疮性肾炎）病理分型字段
-- 依据 ISN/RPS 2003 分类标准（2018修订版）
-- 对 IgAN 项目无影响；所有新字段默认 NULL，无破坏性变更。

alter table public.patients_baseline
  add column if not exists ln_biopsy_date       date,
  add column if not exists ln_class             text,
  add column if not exists ln_activity_index    smallint,
  add column if not exists ln_chronicity_index  smallint,
  add column if not exists ln_podocytopathy     boolean;

-- ISN/RPS 分型约束：I / II / III-A / III-A/C / III-C /
--   IV-S(A) / IV-G(A) / IV-S(A/C) / IV-G(A/C) / IV-S(C) / IV-G(C) / V / VI
alter table public.patients_baseline
  add constraint ln_class_check check (
    ln_class is null or ln_class in (
      'I','II',
      'III-A','III-A/C','III-C',
      'IV-S(A)','IV-G(A)','IV-S(A/C)','IV-G(A/C)','IV-S(C)','IV-G(C)',
      'V','VI'
    )
  );

-- NIH 活动指数 0-24
alter table public.patients_baseline
  add constraint ln_activity_index_check check (
    ln_activity_index is null or (ln_activity_index >= 0 and ln_activity_index <= 24)
  );

-- NIH 慢性化指数 0-12
alter table public.patients_baseline
  add constraint ln_chronicity_index_check check (
    ln_chronicity_index is null or (ln_chronicity_index >= 0 and ln_chronicity_index <= 12)
  );

comment on column public.patients_baseline.ln_biopsy_date      is '狼疮肾肾穿日期';
comment on column public.patients_baseline.ln_class            is 'ISN/RPS 2003/2018 分型：I II III-A III-A/C III-C IV-S(A) IV-G(A) IV-S(A/C) IV-G(A/C) IV-S(C) IV-G(C) V VI';
comment on column public.patients_baseline.ln_activity_index   is 'NIH 活动指数（AI），0–24';
comment on column public.patients_baseline.ln_chronicity_index is 'NIH 慢性化指数（CI），0–12';
comment on column public.patients_baseline.ln_podocytopathy    is '是否合并足细胞病变（2018 修订版新增）';
-- =============================================================
-- PR-8 中文友好层（面向中国医生）
-- 目标：保留内部英文编码稳定性，同时提供中文优先展示与搜索能力
-- =============================================================

-- 1) 通用概念字典（内部 code + 中文展示元数据）
CREATE TABLE IF NOT EXISTS concept_dictionary (
  code                  text PRIMARY KEY,
  domain                text NOT NULL DEFAULT 'GENERAL',
  display_name_cn       text NOT NULL,
  short_name_cn         text NOT NULL,
  help_text_cn          text,
  when_to_fill_cn       text,
  example_value_cn      text,
  unit_cn               text,
  common_mistakes_cn    text,
  patient_friendly_cn   text,
  doctor_note_cn        text,
  is_required           boolean NOT NULL DEFAULT false,
  affects_export        boolean NOT NULL DEFAULT true,
  affects_qc            boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE concept_dictionary IS '中文展示层概念字典：前台默认读中文名，内部仍可用英文 code。';
COMMENT ON COLUMN concept_dictionary.code IS '内部稳定英文编码，例如 dd_cfdna_fraction_pct。';
COMMENT ON COLUMN concept_dictionary.display_name_cn IS '面向临床一线的完整中文显示名（可含缩写）。';
COMMENT ON COLUMN concept_dictionary.short_name_cn IS '适合列表/表头的中文短名。';

CREATE INDEX IF NOT EXISTS idx_concept_dictionary_domain ON concept_dictionary(domain);
CREATE INDEX IF NOT EXISTS idx_concept_dictionary_display_name_cn ON concept_dictionary USING gin (to_tsvector('simple', coalesce(display_name_cn, '')));

CREATE OR REPLACE FUNCTION set_concept_dictionary_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_concept_dictionary_updated_at ON concept_dictionary;
CREATE TRIGGER trg_concept_dictionary_updated_at
BEFORE UPDATE ON concept_dictionary
FOR EACH ROW EXECUTE FUNCTION set_concept_dictionary_updated_at();

-- 2) 核心缩写词典（首次出现需中文解释）
CREATE TABLE IF NOT EXISTS abbreviation_dictionary (
  abbr               text PRIMARY KEY,
  full_name_cn       text NOT NULL,
  category_cn        text NOT NULL,
  first_use_note_cn  text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE abbreviation_dictionary IS '肾内科研究常见缩写词典，用于首次出现自动解释。';

INSERT INTO abbreviation_dictionary (abbr, full_name_cn, category_cn, first_use_note_cn) VALUES
  ('KDPI', '肾供体概况指数', '移植相关', '首次显示建议：肾供体概况指数（KDPI）'),
  ('KDRI', '肾供体风险指数', '移植相关', '首次显示建议：肾供体风险指数（KDRI）'),
  ('DSA', '供者特异性抗体', '移植相关', '首次显示建议：供者特异性抗体（DSA）'),
  ('dnDSA', '新生供者特异性抗体', '移植相关', '首次显示建议：新生供者特异性抗体（dnDSA）'),
  ('dd-cfDNA', '供体来源细胞游离 DNA', '移植相关', '首次显示建议：供体来源细胞游离 DNA（dd-cfDNA）'),
  ('BK', 'BK 病毒', '感染监测', '首次显示建议：BK 病毒（BK）'),
  ('CMV', '巨细胞病毒', '感染监测', '首次显示建议：巨细胞病毒（CMV）'),
  ('EBV', 'EB 病毒', '感染监测', '首次显示建议：EB 病毒（EBV）'),
  ('Banff', '肾移植病理 Banff 分类', '病理相关', '首次显示建议：肾移植病理 Banff 分类（Banff）'),
  ('CNI', '钙调神经磷酸酶抑制剂', '免疫抑制', '首次显示建议：钙调神经磷酸酶抑制剂（CNI）'),
  ('mTORi', 'mTOR 抑制剂', '免疫抑制', '首次显示建议：mTOR 抑制剂（mTORi）'),
  ('UPCR', '尿蛋白/肌酐比', '肾功能与尿检', '首次显示建议：尿蛋白/肌酐比（UPCR）'),
  ('UACR', '尿白蛋白/肌酐比', '肾功能与尿检', '首次显示建议：尿白蛋白/肌酐比（UACR）'),
  ('eGFR', '估算肾小球滤过率', '肾功能与尿检', '首次显示建议：估算肾小球滤过率（eGFR）'),
  ('MCD', '微小病变病', '病种相关', '首次显示建议：微小病变病（MCD）'),
  ('MN', '膜性肾病', '病种相关', '首次显示建议：膜性肾病（MN）'),
  ('MGRS', '单克隆免疫球蛋白相关肾损害', '血液学与免疫相关', '首次显示建议：单克隆免疫球蛋白相关肾损害（MGRS）'),
  ('C3G', 'C3 肾小球病', '病种相关', '首次显示建议：C3 肾小球病（C3G）')
ON CONFLICT (abbr) DO UPDATE SET
  full_name_cn = EXCLUDED.full_name_cn,
  category_cn = EXCLUDED.category_cn,
  first_use_note_cn = EXCLUDED.first_use_note_cn;

-- 3) 中文别名检索表（支持“肌酐/尿蛋白/排斥/BK病毒”等中文搜索）
CREATE TABLE IF NOT EXISTS concept_alias_dictionary (
  concept_code   text NOT NULL REFERENCES concept_dictionary(code) ON DELETE CASCADE,
  alias_cn       text NOT NULL,
  alias_en       text,
  priority       integer NOT NULL DEFAULT 100,
  PRIMARY KEY (concept_code, alias_cn)
);

CREATE INDEX IF NOT EXISTS idx_concept_alias_cn_tsv
  ON concept_alias_dictionary USING gin (to_tsvector('simple', coalesce(alias_cn,'')));

-- 4) 兼容 lab_test_catalog：补充中文展示字段（如果已存在则跳过）
ALTER TABLE lab_test_catalog
  ADD COLUMN IF NOT EXISTS display_name_cn     text,
  ADD COLUMN IF NOT EXISTS short_name_cn       text,
  ADD COLUMN IF NOT EXISTS help_text_cn        text,
  ADD COLUMN IF NOT EXISTS when_to_fill_cn     text,
  ADD COLUMN IF NOT EXISTS example_value_cn    text,
  ADD COLUMN IF NOT EXISTS unit_cn             text,
  ADD COLUMN IF NOT EXISTS common_mistakes_cn  text,
  ADD COLUMN IF NOT EXISTS patient_friendly_cn text,
  ADD COLUMN IF NOT EXISTS doctor_note_cn      text;

UPDATE lab_test_catalog
SET
  display_name_cn = COALESCE(display_name_cn, name_cn),
  short_name_cn   = COALESCE(short_name_cn, name_cn),
  help_text_cn    = COALESCE(help_text_cn, display_note),
  unit_cn         = COALESCE(unit_cn, standard_unit)
WHERE display_name_cn IS NULL
   OR short_name_cn IS NULL
   OR help_text_cn IS NULL
   OR unit_cn IS NULL;

-- 5) KTX 常用字段预置（来自中文友好化规范）
INSERT INTO concept_dictionary(
  code, domain, display_name_cn, short_name_cn, help_text_cn, when_to_fill_cn, unit_cn,
  affects_export, affects_qc
) VALUES
  ('donor_type', 'KTX', '供体类型', '供体类型', '区分活体供者与尸体供者。', '创建移植基线时填写。', NULL, true, true),
  ('kdpi', 'KTX', '肾供体概况指数（KDPI）', 'KDPI', '评估尸体供肾质量。', '有尸体供者资料时填写。', NULL, true, false),
  ('kdri', 'KTX', '肾供体风险指数（KDRI）', 'KDRI', '用于供体风险分层。', '有供体风险评估时填写。', NULL, true, false),
  ('tacrolimus_c0', 'KTX', '他克莫司谷浓度（C0）', '他克莫司 C0', '下一次服药前测得的最低血药浓度。', '术后随访监测免疫抑制时填写。', 'ng/mL（纳克/毫升）', true, true),
  ('dd_cfdna_fraction_pct', 'KTX', '供体来源细胞游离 DNA（dd-cfDNA，百分比）', 'dd-cfDNA%', '建议明确是百分比结果。', '移植后生物标志物监测时填写。', '%（百分比）', true, false),
  ('bk_plasma_pcr', 'KTX', 'BK 病毒血浆核酸定量', 'BK 病毒 PCR', 'BK 病毒监测核心字段。', '术后病毒监测时填写。', 'copies/mL（拷贝/毫升）', true, true),
  ('cmv_pcr', 'KTX', '巨细胞病毒核酸定量', 'CMV PCR', 'CMV 复制监测字段。', '术后病毒监测时填写。', 'IU/mL（国际单位/毫升）', true, true),
  ('banff_diagnosis', 'KTX', 'Banff 病理诊断', 'Banff 诊断', '请记录 Banff 版本和分级。', '活检结果回报后填写。', NULL, true, true),
  ('abmr_event', 'KTX', '抗体介导排斥事件', 'ABMR 事件', '记录是否发生 ABMR 及日期。', '发生排斥事件时填写。', NULL, true, true),
  ('tcmr_event', 'KTX', 'T 细胞介导排斥事件', 'TCMR 事件', '记录是否发生 TCMR 及日期。', '发生排斥事件时填写。', NULL, true, true)
ON CONFLICT (code) DO UPDATE SET
  domain = EXCLUDED.domain,
  display_name_cn = EXCLUDED.display_name_cn,
  short_name_cn = EXCLUDED.short_name_cn,
  help_text_cn = EXCLUDED.help_text_cn,
  when_to_fill_cn = EXCLUDED.when_to_fill_cn,
  unit_cn = EXCLUDED.unit_cn,
  affects_export = EXCLUDED.affects_export,
  affects_qc = EXCLUDED.affects_qc;

INSERT INTO concept_alias_dictionary(concept_code, alias_cn, alias_en, priority) VALUES
  ('tacrolimus_c0', '谷浓度', 'tacrolimus_c0', 10),
  ('dd_cfdna_fraction_pct', 'dd-cfDNA', 'dd-cfDNA', 20),
  ('bk_plasma_pcr', 'BK 病毒', 'BK', 10),
  ('banff_diagnosis', '排斥', 'Banff', 30)
ON CONFLICT (concept_code, alias_cn) DO UPDATE SET
  alias_en = EXCLUDED.alias_en,
  priority = EXCLUDED.priority;

-- 6) 中文搜索入口：支持 code / 中文显示名 / 中文别名
CREATE OR REPLACE FUNCTION search_concepts_cn(
  p_keyword text,
  p_domain  text DEFAULT NULL,
  p_limit   integer DEFAULT 30
)
RETURNS TABLE (
  code             text,
  domain           text,
  display_name_cn  text,
  short_name_cn    text,
  matched_by       text
)
LANGUAGE sql
STABLE
AS $$
  WITH kw AS (
    SELECT trim(coalesce(p_keyword, '')) AS q
  )
  SELECT DISTINCT
    c.code,
    c.domain,
    c.display_name_cn,
    c.short_name_cn,
    CASE
      WHEN c.code ILIKE '%' || kw.q || '%' THEN 'code'
      WHEN c.display_name_cn ILIKE '%' || kw.q || '%' THEN 'display_name_cn'
      WHEN a.alias_cn ILIKE '%' || kw.q || '%' THEN 'alias_cn'
      ELSE 'other'
    END AS matched_by
  FROM concept_dictionary c
  CROSS JOIN kw
  LEFT JOIN concept_alias_dictionary a ON a.concept_code = c.code
  WHERE kw.q <> ''
    AND (p_domain IS NULL OR c.domain = p_domain)
    AND (
      c.code ILIKE '%' || kw.q || '%'
      OR c.display_name_cn ILIKE '%' || kw.q || '%'
      OR c.short_name_cn ILIKE '%' || kw.q || '%'
      OR a.alias_cn ILIKE '%' || kw.q || '%'
      OR coalesce(a.alias_en, '') ILIKE '%' || kw.q || '%'
    )
  ORDER BY c.domain, c.code
  LIMIT GREATEST(1, LEAST(coalesce(p_limit, 30), 200));
$$;

GRANT EXECUTE ON FUNCTION search_concepts_cn(text, text, integer) TO authenticated;

-- 7) 导出映射：中文版列名 + 英文 code
CREATE OR REPLACE VIEW v_concept_export_mapping AS
SELECT
  code AS english_code,
  display_name_cn AS chinese_column_name,
  short_name_cn AS chinese_short_name,
  domain,
  affects_export
FROM concept_dictionary
WHERE affects_export = true;

COMMENT ON VIEW v_concept_export_mapping IS '导出时使用的中英文字段对照表（中文列名导出默认来源）。';
-- 修复：patient_submit_visit_v2 中 "column reference visit_id is ambiguous"
-- 原因：RETURNS TABLE(visit_id uuid,...) 将 visit_id 注册为函数输出变量，
--       导致 ON CONFLICT (visit_id) 里 PostgreSQL 无法区分列名与输出变量。
-- 修复：改用 ON CONFLICT ON CONSTRAINT visit_receipts_pkey，消除歧义。

DROP FUNCTION IF EXISTS public.patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text);

CREATE OR REPLACE FUNCTION public.patient_submit_visit_v2(
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
  visit_id           uuid,
  server_time        timestamptz,
  receipt_token      text,
  receipt_expires_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
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
  WHERE project_id  = v_token_row.project_id
    AND patient_code = v_token_row.patient_code
    AND created_at  > now() - interval '1 minute';

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
  WHERE project_id  = v_token_row.project_id
    AND patient_code = v_token_row.patient_code
    AND visit_date  = p_visit_date;

  IF v_same_day >= 6 THEN
    UPDATE patient_tokens SET active = false WHERE token = p_token;
    RAISE EXCEPTION 'same_day_limit_exceeded'
      USING HINT = '同一日期已提交 ' || v_same_day || ' 条记录，链接已被暂停，请联系管理员';
  END IF;

  -- ⑫ 写入随访记录
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
  -- 使用 ON CONFLICT ON CONSTRAINT 而非 ON CONFLICT (visit_id)
  -- 避免与 RETURNS TABLE 中同名输出列产生歧义（PostgreSQL ambiguous 错误）
  v_receipt := encode(gen_random_bytes(16), 'hex');
  v_expires  := now() + interval '24 hours';
  INSERT INTO visit_receipts(visit_id, receipt_token, expires_at)
  VALUES (v_visit_id, v_receipt, v_expires)
  ON CONFLICT ON CONSTRAINT visit_receipts_pkey DO UPDATE
    SET receipt_token = v_receipt,
        expires_at    = v_expires;

  -- ⑮ 审计日志
  INSERT INTO security_audit_logs(
    project_id, patient_code, token_hash, event_type, severity, details
  ) VALUES (
    v_token_row.project_id, v_token_row.patient_code,
    encode(digest(p_token,'sha256'),'hex'),
    'visit_submitted', 'INFO',
    jsonb_build_object(
      'visit_id',   v_visit_id,
      'visit_date', p_visit_date,
      'single_use', v_token_row.single_use
    )
  );

  RETURN QUERY SELECT v_visit_id, now(), v_receipt, v_expires;
END;
$$;

GRANT EXECUTE ON FUNCTION public.patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text) TO anon, authenticated;
