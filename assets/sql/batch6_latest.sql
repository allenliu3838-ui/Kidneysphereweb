-- =============================================================
-- 0020 化验目录扩展：MN / KTX / DKD 专项化验项
--
-- 补充：
--   MN 模块   → PLA2R（抗PLA2R抗体）、CD19（CD19+ B细胞计数）
--   KTX 模块  → BKV（BK病毒载量）、CMV（巨细胞病毒载量）
--   GENERAL   → HBA1C（糖化血红蛋白）、UACR（尿白蛋白/肌酐比）
--
-- 依赖：0013_pr2_lab_catalog.sql（表结构已存在）
-- 所有 INSERT 均使用 ON CONFLICT DO NOTHING，可安全重跑
-- =============================================================

-- ─── 1. 单位字典扩展 ───────────────────────────────────────────────────────────
INSERT INTO unit_catalog(symbol, description) VALUES
  ('RU/mL',     '反应单位每毫升（PLA2R 抗体常用单位）'),
  ('cells/μL',  '细胞数每微升（B 细胞绝对计数）'),
  ('%',         '百分比（CD19% 或 HbA1c NGSP%）'),
  ('copies/mL', '拷贝数每毫升（病毒载量）'),
  ('mmol/mol',  '毫摩尔每摩尔（HbA1c IFCC 国际标准单位）')
ON CONFLICT (symbol) DO NOTHING;

-- ─── 2. 化验项目字典扩展 ───────────────────────────────────────────────────────
INSERT INTO lab_test_catalog(code, name_cn, name_en, module, is_core, loinc_code, standard_unit, display_note)
VALUES
  -- MN 专项：靶抗原抗体 + B 细胞监测
  ('PLA2R',  '抗PLA2R抗体',
             'Anti-PLA2R Antibody',
             'MN',      false, '56741-0', 'RU/mL',
             '<14 RU/mL 为阴性；≥14 RU/mL 阳性。滴度与疾病活动度相关，可预测缓解与复发。RTX/OBI 治疗后监测滴度下降。'),

  ('CD19',   'CD19+ B细胞计数',
             'CD19+ B-cell Count',
             'MN',      false, '8122-7',  'cells/μL',
             '正常成人约 100–500 cells/μL。RTX/OBI 治疗后 B 细胞耗竭监测，清除标准通常 <5 cells/μL，可用百分比（%）替代。'),

  -- KTX 专项：BK 病毒 + CMV 病毒载量
  ('BKV',    'BK病毒载量',
             'BK Virus DNA',
             'KTX',     false, '72495-5', 'copies/mL',
             '移植后常规筛查（术后 3 个月内每月 1 次，之后每 3 个月 1 次）。'
             '≥10,000 copies/mL 考虑减少免疫抑制剂；≥100,000 copies/mL 为高载量，需积极处理。'),

  ('CMV',    '巨细胞病毒载量',
             'CMV DNA',
             'KTX',     false, '72493-0', 'IU/mL',
             'WHO 国际标准单位 IU/mL。各中心治疗阈值不同，通常 >1000 IU/mL 考虑抗病毒治疗。'
             '高危受者（D+/R-）建议前 3–6 个月预防或监测。'),

  -- DKD / GENERAL 专项：血糖控制 + 尿白蛋白
  ('HBA1C',  '糖化血红蛋白',
             'Hemoglobin A1c',
             'GENERAL', false, '4548-4',  '%',
             'DKD 血糖控制目标：一般 <7.0%（<53 mmol/mol）；高龄/低血糖风险者可放宽至 <8.0%。'
             '反映过去 2–3 个月平均血糖水平。'),

  ('UACR',   '尿白蛋白/肌酐比',
             'Urine Albumin-Creatinine Ratio',
             'GENERAL', false, '9318-7',  'mg/g',
             '正常 <30 mg/g；微量白蛋白尿 30–300 mg/g；大量白蛋白尿 >300 mg/g。'
             '注意：UACR（测白蛋白）与 UPCR（测总蛋白）不同，DKD 研究优先用 UACR。')

ON CONFLICT (code) DO NOTHING;

-- ─── 3. 项目-单位换算表扩展 ───────────────────────────────────────────────────
-- 格式：value_standard = value_raw × multiplier + offset_val
INSERT INTO lab_test_unit_map(lab_test_code, unit_symbol, multiplier, offset_val, is_standard)
VALUES
  -- PLA2R：仅 RU/mL 一种常用单位
  ('PLA2R', 'RU/mL',     1,       0,    true),

  -- CD19：绝对计数为标准；百分比原值存储（无绝对数无法换算）
  ('CD19',  'cells/μL',  1,       0,    true),
  ('CD19',  '%',         1,       0,    false),  -- 存原始%，不换算

  -- BKV：copies/mL 为标准；IU/mL 与 copies/mL 近似 1:1（WHO 标准差异 <5%，直接存）
  ('BKV',   'copies/mL', 1,       0,    true),
  ('BKV',   'IU/mL',     1,       0,    false),

  -- CMV：IU/mL 为 WHO 标准；copies/mL 与 IU/mL 近似等价直接记录
  ('CMV',   'IU/mL',     1,       0,    true),
  ('CMV',   'copies/mL', 1,       0,    false),

  -- HbA1c：% (NGSP) 为标准；mmol/mol (IFCC) 换算公式 % = mmol/mol × 0.0915 + 2.15
  ('HBA1C', '%',         1,       0,    true),
  ('HBA1C', 'mmol/mol',  0.0915,  2.15, false),  -- IFCC → NGSP%

  -- UACR：mg/g 为标准；mg/mmol (欧洲) 换算：1 mg/mmol × 8.842 = mg/g
  --        (肌酐分子量 113.12 g/mol，∴ 1 mmol = 113.12 mg，1 mg/mmol = 1000/113.12 mg/g ≈ 8.84)
  ('UACR',  'mg/g',      1,       0,    true),
  ('UACR',  'mg/mmol',   8.842,   0,    false)   -- 欧洲单位 → mg/g

ON CONFLICT (lab_test_code, unit_symbol) DO NOTHING;
-- =============================================================
-- 0021 项目自定义化验目录
--
-- 每个研究项目可维护自己的化验目录（不在全局 lab_test_catalog 中的项目）。
-- 首次添加自定义化验时自动保存到本表，后续所有患者可直接从下拉中选用，
-- 保证同项目多患者、多中心录入时化验名称/单位一致。
-- =============================================================

CREATE TABLE IF NOT EXISTS project_custom_labs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,          -- 化验名，例如：补体因子H
  unit        text NOT NULL DEFAULT '',  -- 单位，例如：mg/L
  sort_order  int  NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, name)            -- 同一项目化验名不重复
);

COMMENT ON TABLE project_custom_labs IS
  '研究项目自定义化验目录；用户首次录入自定义化验时自动保存，后续同项目可直接选用。';

-- RLS：只有项目创建者可以读写
ALTER TABLE project_custom_labs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pcl_select" ON project_custom_labs;
CREATE POLICY "pcl_select" ON project_custom_labs
  FOR SELECT TO authenticated
  USING (project_id IN (
    SELECT id FROM projects WHERE created_by = auth.uid()
  ));

DROP POLICY IF EXISTS "pcl_insert" ON project_custom_labs;
CREATE POLICY "pcl_insert" ON project_custom_labs
  FOR INSERT TO authenticated
  WITH CHECK (project_id IN (
    SELECT id FROM projects WHERE created_by = auth.uid()
  ));

DROP POLICY IF EXISTS "pcl_update" ON project_custom_labs;
CREATE POLICY "pcl_update" ON project_custom_labs
  FOR UPDATE TO authenticated
  USING (project_id IN (
    SELECT id FROM projects WHERE created_by = auth.uid()
  ));

DROP POLICY IF EXISTS "pcl_delete" ON project_custom_labs;
CREATE POLICY "pcl_delete" ON project_custom_labs
  FOR DELETE TO authenticated
  USING (project_id IN (
    SELECT id FROM projects WHERE created_by = auth.uid()
  ));
-- ============================================================
-- 0022_admin_status_permissions.sql
-- 管理员状态权限增强
--
-- 新增：
--   1. 管理员永久写入豁免 — assert_project_write_allowed 检查创建者是否为管理员
--   2. admin_cancel_contract()   — 取消已批准/待审的合同
--   3. admin_update_contract()   — 修改合同字段（付款状态、到期时间、套餐等）
--   4. admin_set_expiry()        — 直接设定项目到期日期
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. 更新 assert_project_write_allowed：管理员项目永久放行
-- ──────────────────────────────────────────────────────────
create or replace function public.assert_project_write_allowed(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trial_enabled  boolean;
  v_trial_expires  timestamptz;
  v_plan           text;
  v_sub_until      timestamptz;
  v_created_by     uuid;
begin
  select trial_enabled, trial_expires_at, subscription_plan, subscription_active_until, created_by
  into   v_trial_enabled, v_trial_expires, v_plan, v_sub_until, v_created_by
  from   public.projects
  where  id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;

  -- Rule 0: 项目创建者是平台管理员 → 永久放行
  if exists (
    select 1 from public.platform_admins pa
    join auth.users u on u.email = pa.email
    where u.id = v_created_by
  ) then
    return;
  end if;

  -- Rule A: 管理员已关闭试用限制
  if not v_trial_enabled then
    return;
  end if;

  -- Rule B: 付费订阅或合作伙伴计划有效
  if v_plan in ('pro', 'institution', 'partner') and
     (v_sub_until is null or now() <= v_sub_until) then
    return;
  end if;

  -- Rule C: 在试用期内
  if v_trial_expires is not null and now() <= v_trial_expires then
    return;
  end if;

  -- 以上均不满足 → 拒绝写入
  raise exception 'subscription_required';
end;
$$;

-- ──────────────────────────────────────────────────────────
-- 2. admin_cancel_contract() — 取消合同（pending/approved → cancelled）
--    同时撤销该用户项目的订阅（如果已激活过）
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_cancel_contract(
  p_contract_id uuid,
  p_admin_note  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_status  text;
  v_payment text;
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  select user_id, status, payment_status
  into   v_user_id, v_status, v_payment
  from   public.partner_contracts
  where  id = p_contract_id;

  if not found then
    raise exception 'contract_not_found';
  end if;

  if v_status not in ('pending', 'approved') then
    raise exception 'only_pending_or_approved_can_cancel';
  end if;

  -- 取消合同
  update public.partner_contracts
  set
    status         = 'cancelled',
    admin_note     = coalesce(p_admin_note, admin_note),
    updated_at     = now()
  where id = p_contract_id;

  -- 如果已经付款激活过，撤销该用户所有项目的订阅 → 回到试用
  if v_payment = 'paid' then
    update public.projects
    set
      subscription_plan         = 'trial',
      subscription_active_until = null,
      trial_expires_at          = now() + interval '30 days',
      trial_grace_until         = now() + interval '37 days'
    where created_by = v_user_id;
  end if;
end;
$$;

grant execute on function public.admin_cancel_contract(uuid, text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 3. admin_update_contract() — 通用合同更新
--    可修改：付款状态、到期时间、套餐、年费、折扣、备注
--    同时同步更新该用户的项目订阅
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_update_contract(
  p_contract_id      uuid,
  p_payment_status   text         default null,   -- 'unpaid'/'paid'/'overdue'
  p_expires_at       timestamptz  default null,
  p_plan             text         default null,   -- 'pro'/'institution'/'partner'
  p_annual_price     numeric      default null,
  p_discount_pct     int          default null,
  p_admin_note       text         default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid;
  v_plan     text;
  v_expires  timestamptz;
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  -- 更新合同字段（只更新传入的非 null 参数）
  update public.partner_contracts
  set
    payment_status   = coalesce(p_payment_status, payment_status),
    expires_at       = coalesce(p_expires_at, expires_at),
    plan             = coalesce(p_plan, plan),
    annual_price_cny = coalesce(p_annual_price, annual_price_cny),
    discount_pct     = coalesce(p_discount_pct, discount_pct),
    admin_note       = coalesce(p_admin_note, admin_note),
    paid_at          = case
                         when p_payment_status = 'paid' and paid_at is null then now()
                         else paid_at
                       end,
    activated_at     = case
                         when p_payment_status = 'paid' and activated_at is null then now()
                         else activated_at
                       end,
    updated_at       = now()
  where id = p_contract_id
    and status in ('pending', 'approved');

  if not found then
    raise exception 'contract_not_found_or_not_editable';
  end if;

  -- 读取更新后的合同数据，同步到用户项目
  select user_id, coalesce(plan, apply_plan), expires_at
  into   v_user_id, v_plan, v_expires
  from   public.partner_contracts
  where  id = p_contract_id;

  -- 如果付款状态为 paid，同步更新项目订阅
  if coalesce(p_payment_status, (select payment_status from public.partner_contracts where id = p_contract_id)) = 'paid' then
    update public.projects
    set
      subscription_plan         = v_plan,
      subscription_active_until = v_expires
    where created_by = v_user_id;
  end if;
end;
$$;

grant execute on function public.admin_update_contract(uuid, text, timestamptz, text, numeric, int, text) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 4. admin_set_expiry() — 直接设定项目到期日期
--    可以同时修改 subscription_plan
-- ──────────────────────────────────────────────────────────
create or replace function public.admin_set_expiry(
  p_project_id   uuid,
  p_expires_at   timestamptz,
  p_plan         text default null  -- 可选：同时修改计划
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_plan text;
begin
  if not public.is_platform_admin() then
    raise exception 'platform_admin_only';
  end if;

  select subscription_plan into v_current_plan
  from public.projects where id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;

  -- 根据当前计划更新对应字段
  if coalesce(p_plan, v_current_plan) = 'trial' then
    update public.projects
    set
      subscription_plan = 'trial',
      trial_expires_at  = p_expires_at,
      trial_grace_until = p_expires_at + interval '7 days'
    where id = p_project_id;
  else
    update public.projects
    set
      subscription_plan         = coalesce(p_plan, v_current_plan),
      subscription_active_until = p_expires_at
    where id = p_project_id;
  end if;
end;
$$;

grant execute on function public.admin_set_expiry(uuid, timestamptz, text) to authenticated;
