-- ============================================================
-- migration_20260323_add_patho_and_early_bird.sql
--
-- 1. 给 products 加 early_bird_deadline 字段
-- 2. 给所有现有产品设置早鸟截止日（2026-05-30）
-- 3. 新增肾脏病理专科 + 3 个商品 + 1 个培训项目
-- 4. 为三个专科各创建 2026 年 8 月首期班
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1. 给 products 表加 early_bird_deadline（幂等，已有则跳过）
-- ──────────────────────────────────────────────────────────────
alter table public.products
  add column if not exists early_bird_deadline timestamptz default null;

-- ──────────────────────────────────────────────────────────────
-- 2. 所有现有产品统一设为 2026-05-30 23:59:59 CST
-- ──────────────────────────────────────────────────────────────
update public.products
set early_bird_deadline = '2026-05-30 23:59:59+08:00'
where early_bird_deadline is null
  and is_active = true;

-- ──────────────────────────────────────────────────────────────
-- 3. 新增肾脏病理专科 + 商品
-- ──────────────────────────────────────────────────────────────
do $$
declare
  _patho_id        uuid;
  _patho_bundle_id uuid;
  _patho_full_id   uuid;
  _patho_video_id  uuid;
begin

  -- 3a. 专科
  insert into public.specialties (code, name, intro, is_active, sort_order)
  values (
    'patho',
    '肾脏病理',
    '系统讲授肾活检病理诊断思路与常见肾小球、小管间质、血管性疾病的病理特征，' ||
    '结合临床与影像，培养规范的病理报告解读能力。',
    true, 3
  )
  on conflict (code) do update set
    name       = excluded.name,
    intro      = excluded.intro,
    is_active  = excluded.is_active,
    sort_order = excluded.sort_order;

  select id into _patho_id from public.specialties where code = 'patho';

  -- 3b. 专科整套课（正价 ¥1200，早鸟 ¥980）
  insert into public.products (
    product_code, product_type, title, subtitle, description,
    price_cny, list_price_cny, duration_days,
    specialty_id, recommended, requires_review, is_active, sort_order,
    early_bird_deadline
  ) values (
    'PATHO-BUNDLE-2026',
    'specialty_bundle',
    '肾脏病理 · 专科整套课',
    '全部视频课永久回放（含新增内容）',
    '覆盖肾小球病理、小管间质疾病、血管性病变等核心专题。' ||
    '购买后永久有效，持续更新。早鸟价截止 2026年5月30日。',
    980, 1200, 36500,
    _patho_id, false, true, true, 30,
    '2026-05-30 23:59:59+08:00'
  )
  on conflict (product_code) do update set
    price_cny          = excluded.price_cny,
    list_price_cny     = excluded.list_price_cny,
    title              = excluded.title,
    subtitle           = excluded.subtitle,
    description        = excluded.description,
    early_bird_deadline = excluded.early_bird_deadline;

  -- 3c. 报名版 完整版（正价 ¥1580，早鸟 ¥1280）
  insert into public.products (
    product_code, product_type, title, subtitle, description,
    price_cny, list_price_cny, duration_days,
    specialty_id, recommended, requires_review, is_active, sort_order,
    early_bird_deadline
  ) values (
    'PATHO-REG-FULL-2026',
    'project_registration',
    '肾脏病理培训项目 · 报名版（完整版）',
    '直播 + 互动 + 微信群 + 视频回放',
    '含全程直播互动、专属学员微信群、课后视频永久回放。' ||
    '早鸟价 ¥1,280 截止 2026年5月30日，正式价 ¥1,580。',
    1280, 1580, 36500,
    _patho_id, true, true, true, 31,
    '2026-05-30 23:59:59+08:00'
  )
  on conflict (product_code) do update set
    price_cny          = excluded.price_cny,
    list_price_cny     = excluded.list_price_cny,
    title              = excluded.title,
    subtitle           = excluded.subtitle,
    description        = excluded.description,
    early_bird_deadline = excluded.early_bird_deadline;

  -- 3d. 视频版 回放版（正价 ¥980，早鸟 ¥780）
  insert into public.products (
    product_code, product_type, title, subtitle, description,
    price_cny, list_price_cny, duration_days,
    specialty_id, recommended, requires_review, is_active, sort_order,
    early_bird_deadline
  ) values (
    'PATHO-REG-VIDEO-2026',
    'project_registration',
    '肾脏病理培训项目 · 视频版（回放版）',
    '仅视频回放，不含直播/群',
    '购买后解锁该期所有视频回放，永久有效。' ||
    '早鸟价 ¥780 截止 2026年5月30日，正式价 ¥980。',
    780, 980, 36500,
    _patho_id, false, true, true, 32,
    '2026-05-30 23:59:59+08:00'
  )
  on conflict (product_code) do update set
    price_cny          = excluded.price_cny,
    list_price_cny     = excluded.list_price_cny,
    title              = excluded.title,
    subtitle           = excluded.subtitle,
    description        = excluded.description,
    early_bird_deadline = excluded.early_bird_deadline;

  -- 3e. 关联 bundle_product_id
  select id into _patho_bundle_id from public.products where product_code = 'PATHO-BUNDLE-2026';
  update public.specialties set bundle_product_id = _patho_bundle_id where code = 'patho';

  -- ──────────────────────────────────────────────────────────────
  -- 4. 学习项目（PROJ-PATHO-2026）
  -- ──────────────────────────────────────────────────────────────
  select id into _patho_full_id  from public.products where product_code = 'PATHO-REG-FULL-2026';
  select id into _patho_bundle_id from public.products where product_code = 'PATHO-BUNDLE-2026';

  insert into public.learning_projects (
    project_code, title, intro,
    registration_fee_cny, requires_review,
    includes_bundle_product_id,
    refund_policy_text, is_active, status, sort_order
  ) values (
    'PROJ-PATHO-2026',
    '肾脏病理规范化培训项目 · 2026',
    '系统学习肾活检病理诊断思路与常见肾脏疾病病理特征，结合临床与影像进行解读。' ||
    '由国内多位肾脏病理专家联合授课，兼顾理论规范与实操指导。',
    1280, true,
    _patho_bundle_id,
    '开课前7天以上申请全额退款；开课后不支持退款。',
    true, 'enrollment', 3
  )
  on conflict (project_code) do update set
    title                      = excluded.title,
    intro                      = excluded.intro,
    includes_bundle_product_id = excluded.includes_bundle_product_id,
    status                     = excluded.status;

end $$;

-- ──────────────────────────────────────────────────────────────
-- 5. 三个专科 2026 年 8 月首期班（cohorts）
-- ──────────────────────────────────────────────────────────────
do $$
declare
  _proj_icu_id   uuid;
  _proj_tx_id    uuid;
  _proj_patho_id uuid;
begin
  select id into _proj_icu_id   from public.learning_projects where project_code = 'PROJ-ICU-2026';
  select id into _proj_tx_id    from public.learning_projects where project_code = 'PROJ-TX-2026';
  select id into _proj_patho_id from public.learning_projects where project_code = 'PROJ-PATHO-2026';

  -- 重症肾内科 · 2026 年 8 月首期班
  insert into public.cohorts (
    project_id, title, start_date, enrollment_deadline, status, sort_order
  ) values (
    _proj_icu_id,
    '重症肾内科 · 2026 年 8 月首期班',
    '2026-08-01',
    '2026-05-30',
    'enrollment',
    1
  )
  on conflict do nothing;

  -- 肾移植内科 · 2026 年 8 月首期班
  insert into public.cohorts (
    project_id, title, start_date, enrollment_deadline, status, sort_order
  ) values (
    _proj_tx_id,
    '肾移植内科 · 2026 年 8 月首期班',
    '2026-08-01',
    '2026-05-30',
    'enrollment',
    1
  )
  on conflict do nothing;

  -- 肾脏病理 · 2026 年 8 月首期班
  insert into public.cohorts (
    project_id, title, start_date, enrollment_deadline, status, sort_order
  ) values (
    _proj_patho_id,
    '肾脏病理 · 2026 年 8 月首期班',
    '2026-08-01',
    '2026-05-30',
    'enrollment',
    1
  )
  on conflict do nothing;

  -- 同步更新三个项目状态为 live（招募中）
  update public.learning_projects
  set status = 'live'
  where project_code in ('PROJ-ICU-2026', 'PROJ-TX-2026', 'PROJ-PATHO-2026');

end $$;

-- ──────────────────────────────────────────────────────────────
-- 6. 同步 system_config 价格说明
-- ──────────────────────────────────────────────────────────────
insert into public.system_config (key, value, description)
values (
  'pricing_early_bird_deadline',
  '"2026-05-30T23:59:59+08:00"',
  '全平台早鸟价截止时间（ISO 8601）'
)
on conflict (key) do update set
  value       = excluded.value,
  description = excluded.description;

insert into public.system_config (key, value, description)
values (
  'pricing_cohort_start_note',
  '"三个培训项目均计划 2026 年 8 月开课，早鸟价截止 5 月 30 日。"',
  '价格页说明文字'
)
on conflict (key) do update set
  value       = excluded.value,
  description = excluded.description;
