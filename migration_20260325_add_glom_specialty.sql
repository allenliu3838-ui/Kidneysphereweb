-- ============================================================
-- migration_20260325_add_glom_specialty.sql
--
-- 新增肾小球病培训专科 + 3 个商品 + 学习项目
-- product_code 前缀：GLOM
-- ============================================================

do $$
declare
  _glom_id        uuid;
  _glom_bundle_id uuid;
  _glom_full_id   uuid;
  _glom_video_id  uuid;
begin

  -- 1. 专科
  insert into public.specialties (code, name, intro, is_active, sort_order)
  values (
    'glom',
    '肾小球病',
    '覆盖 IgA 肾病、膜性肾病、FSGS、MCD、狼疮性肾炎、ANCA 相关肾炎等核心病种，' ||
    '系统讲授发病机制、病理解读与临床诊疗策略。',
    true, 0
  )
  on conflict (code) do update set
    name       = excluded.name,
    intro      = excluded.intro,
    is_active  = excluded.is_active,
    sort_order = excluded.sort_order;

  select id into _glom_id from public.specialties where code = 'glom';

  -- 2. 专科整套课（正价 ¥1200，早鸟 ¥980）
  insert into public.products (
    product_code, product_type, title, subtitle, description,
    price_cny, list_price_cny, duration_days,
    specialty_id, recommended, requires_review, is_active, sort_order,
    early_bird_deadline
  ) values (
    'GLOM-BUNDLE-2026',
    'specialty_bundle',
    '肾小球病 · 专科整套课',
    '全部视频课永久回放（含新增内容）',
    '覆盖 IgA 肾病、膜性肾病、FSGS、MCD、狼疮性肾炎、ANCA 相关肾炎等核心病种。' ||
    '一次购买，永久解锁全部课程视频。适合无法跟班期或希望反复回顾的医生。',
    980, 1200, 36500,
    _glom_id, false, true, true, 0,
    '2026-05-30 23:59:59+08:00'
  )
  on conflict (product_code) do update set
    price_cny          = excluded.price_cny,
    list_price_cny     = excluded.list_price_cny,
    title              = excluded.title,
    subtitle           = excluded.subtitle,
    description        = excluded.description,
    early_bird_deadline = excluded.early_bird_deadline;

  -- 3. 报名版 完整版（正价 ¥1580，早鸟 ¥1280）
  insert into public.products (
    product_code, product_type, title, subtitle, description,
    price_cny, list_price_cny, duration_days,
    specialty_id, recommended, requires_review, is_active, sort_order,
    early_bird_deadline
  ) values (
    'GLOM-REG-FULL-2026',
    'project_registration',
    '肾小球病培训项目 · 报名版（完整版）',
    '直播 + 互动 + 微信群 + 视频回放',
    '含全程直播互动、专属学员微信群、课后视频永久回放。' ||
    '早鸟价 ¥1,280，截止 2026-05-30 后恢复正式价 ¥1,580。',
    1280, 1580, 36500,
    _glom_id, true, true, true, 1,
    '2026-05-30 23:59:59+08:00'
  )
  on conflict (product_code) do update set
    price_cny          = excluded.price_cny,
    list_price_cny     = excluded.list_price_cny,
    title              = excluded.title,
    subtitle           = excluded.subtitle,
    description        = excluded.description,
    early_bird_deadline = excluded.early_bird_deadline;

  -- 4. 视频版 回放版（正价 ¥980，早鸟 ¥780）
  insert into public.products (
    product_code, product_type, title, subtitle, description,
    price_cny, list_price_cny, duration_days,
    specialty_id, recommended, requires_review, is_active, sort_order,
    early_bird_deadline
  ) values (
    'GLOM-REG-VIDEO-2026',
    'project_registration',
    '肾小球病培训项目 · 视频版（回放版）',
    '仅视频回放，不含直播/群',
    '购买后解锁该期所有视频回放，永久有效。' ||
    '早鸟价 ¥780，截止 2026-05-30 后恢复正式价 ¥980。',
    780, 980, 36500,
    _glom_id, false, true, true, 2,
    '2026-05-30 23:59:59+08:00'
  )
  on conflict (product_code) do update set
    price_cny          = excluded.price_cny,
    list_price_cny     = excluded.list_price_cny,
    title              = excluded.title,
    subtitle           = excluded.subtitle,
    description        = excluded.description,
    early_bird_deadline = excluded.early_bird_deadline;

  -- 5. 关联 bundle_product_id
  select id into _glom_bundle_id from public.products where product_code = 'GLOM-BUNDLE-2026';
  update public.specialties set bundle_product_id = _glom_bundle_id where code = 'glom';

end $$;

-- 6. 学习项目（进行中）
do $$
declare
  _glom_bundle_id uuid;
begin
  select id into _glom_bundle_id from public.products where product_code = 'GLOM-BUNDLE-2026';

  insert into public.learning_projects (
    project_code, title, intro,
    registration_fee_cny, requires_review,
    includes_bundle_product_id,
    refund_policy_text, is_active, status, sort_order
  ) values (
    'PROJ-GLOM-2026',
    '肾小球病培训项目 · 2026',
    '由国内外肾小球病专家联合授课，系统覆盖 IgA 肾病、膜性肾病、FSGS、MCD、' ||
    '狼疮性肾炎、ANCA 相关肾炎等核心病种的发病机制、病理解读与临床诊疗策略。',
    1280, true,
    _glom_bundle_id,
    '开课前7天以上申请全额退款；开课后不支持退款。',
    true, 'active', 0
  )
  on conflict (project_code) do update set
    title                      = excluded.title,
    intro                      = excluded.intro,
    includes_bundle_product_id = excluded.includes_bundle_product_id,
    status                     = excluded.status;
end $$;
