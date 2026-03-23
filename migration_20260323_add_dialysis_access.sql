-- ============================================================
-- migration_20260323_add_dialysis_access.sql
--
-- 新增透析通路培训专科（筹备中）
-- product_code 前缀：DA（Dialysis Access）
-- ============================================================

do $$
declare
  _da_id        uuid;
  _da_bundle_id uuid;
begin

  -- 1. 专科
  insert into public.specialties (code, name, intro, is_active, sort_order)
  values (
    'da',
    '透析通路',
    '系统讲授血液透析通路（AVF/AVG/CVC）的建立、维护与并发症处理，' ||
    '兼顾腹膜透析置管技术与管理规范，适合肾内科医生与透析室医护人员。',
    true, 4
  )
  on conflict (code) do update set
    name       = excluded.name,
    intro      = excluded.intro,
    is_active  = excluded.is_active,
    sort_order = excluded.sort_order;

  select id into _da_id from public.specialties where code = 'da';

  -- 2. 专科整套课（正价 ¥1200，早鸟 ¥980；筹备中，暂不开售）
  insert into public.products (
    product_code, product_type, title, subtitle, description,
    price_cny, list_price_cny, duration_days,
    specialty_id, recommended, requires_review, is_active, sort_order,
    early_bird_deadline
  ) values (
    'DA-BUNDLE-2026',
    'specialty_bundle',
    '透析通路 · 专科整套课',
    '全部视频课永久回放（含新增内容）',
    '覆盖 AVF/AVG/CVC 建立与维护、通路并发症处理、腹膜透析置管等核心专题。' ||
    '课程筹备中，敬请期待。',
    980, 1200, 36500,
    _da_id, false, true, false, 40,
    null
  )
  on conflict (product_code) do update set
    price_cny      = excluded.price_cny,
    list_price_cny = excluded.list_price_cny,
    title          = excluded.title,
    subtitle       = excluded.subtitle,
    description    = excluded.description,
    is_active      = excluded.is_active;

  -- 3. 报名版 完整版（筹备中，暂不开售）
  insert into public.products (
    product_code, product_type, title, subtitle, description,
    price_cny, list_price_cny, duration_days,
    specialty_id, recommended, requires_review, is_active, sort_order,
    early_bird_deadline
  ) values (
    'DA-REG-FULL-2026',
    'project_registration',
    '透析通路培训项目 · 报名版（完整版）',
    '直播 + 互动 + 微信群 + 视频回放',
    '含全程直播互动、专属学员微信群、课后视频永久回放。课程筹备中，敬请期待。',
    1280, 1580, 36500,
    _da_id, true, true, false, 41,
    null
  )
  on conflict (product_code) do update set
    price_cny      = excluded.price_cny,
    list_price_cny = excluded.list_price_cny,
    title          = excluded.title,
    subtitle       = excluded.subtitle,
    description    = excluded.description,
    is_active      = excluded.is_active;

  -- 4. 视频版 回放版（筹备中，暂不开售）
  insert into public.products (
    product_code, product_type, title, subtitle, description,
    price_cny, list_price_cny, duration_days,
    specialty_id, recommended, requires_review, is_active, sort_order,
    early_bird_deadline
  ) values (
    'DA-REG-VIDEO-2026',
    'project_registration',
    '透析通路培训项目 · 视频版（回放版）',
    '仅视频回放，不含直播/群',
    '购买后解锁该期所有视频回放，永久有效。课程筹备中，敬请期待。',
    780, 980, 36500,
    _da_id, false, true, false, 42,
    null
  )
  on conflict (product_code) do update set
    price_cny      = excluded.price_cny,
    list_price_cny = excluded.list_price_cny,
    title          = excluded.title,
    subtitle       = excluded.subtitle,
    description    = excluded.description,
    is_active      = excluded.is_active;

  -- 5. 关联 bundle（产品未上线，关联留备用）
  select id into _da_bundle_id from public.products where product_code = 'DA-BUNDLE-2026';
  update public.specialties set bundle_product_id = _da_bundle_id where code = 'da';

end $$;

-- 6. 学习项目（筹备中，status = planning）
do $$
declare
  _da_bundle_id uuid;
begin
  select id into _da_bundle_id from public.products where product_code = 'DA-BUNDLE-2026';

  insert into public.learning_projects (
    project_code, title, intro,
    registration_fee_cny, requires_review,
    includes_bundle_product_id,
    refund_policy_text, is_active, status, sort_order
  ) values (
    'PROJ-DA-2026',
    '透析通路规范化培训项目 · 2026',
    '系统学习血液透析通路建立与维护、通路并发症诊治及腹膜透析置管技术。' ||
    '由肾内科与介入科专家联合授课，结合真实病例讨论。课程正在筹备中。',
    1280, true,
    _da_bundle_id,
    '开课前7天以上申请全额退款；开课后不支持退款。',
    true, 'planning', 4
  )
  on conflict (project_code) do update set
    title                      = excluded.title,
    intro                      = excluded.intro,
    includes_bundle_product_id = excluded.includes_bundle_product_id,
    status                     = excluded.status;
end $$;
