-- ============================================================
-- KidneySphere Paid System — Incremental Migration
-- 付费系统增量迁移：视频付费字段 + 权益 RPC + 种子数据
-- Run in Supabase SQL Editor. Idempotent (safe to re-run).
-- Date: 2026-03-23
-- ============================================================

-- ============================================================
-- 1. ALTER learning_videos — 新增付费字段
-- ============================================================
alter table public.learning_videos
  add column if not exists is_paid boolean not null default false,
  add column if not exists specialty_id uuid references public.specialties(id) on delete set null,
  add column if not exists product_id uuid references public.products(id) on delete set null;

create index if not exists idx_learning_videos_paid     on public.learning_videos(is_paid);
create index if not exists idx_learning_videos_specialty on public.learning_videos(specialty_id);

-- ============================================================
-- 2. RPC: get_my_entitlements()
-- 供用户端"我的学习"页调用，返回当前用户所有有效权益（含关联名称）
-- ============================================================
create or replace function public.get_my_entitlements()
returns table (
  id                uuid,
  entitlement_type  text,
  status            text,
  start_at          timestamptz,
  end_at            timestamptz,
  source_order_id   uuid,
  source_product_id uuid,
  specialty_id      uuid,
  video_id          uuid,
  project_id        uuid,
  cohort_id         uuid,
  grant_reason      text,
  created_at        timestamptz,
  -- joined fields
  product_title     text,
  product_type      text,
  specialty_name    text,
  project_title     text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    ue.id,
    ue.entitlement_type,
    ue.status,
    ue.start_at,
    ue.end_at,
    ue.source_order_id,
    ue.source_product_id,
    ue.specialty_id,
    ue.video_id,
    ue.project_id,
    ue.cohort_id,
    ue.grant_reason,
    ue.created_at,
    p.title                   as product_title,
    p.product_type            as product_type,
    s.name                    as specialty_name,
    lp.title                  as project_title
  from public.user_entitlements ue
  left join public.products        p  on p.id  = ue.source_product_id
  left join public.specialties     s  on s.id  = ue.specialty_id
  left join public.learning_projects lp on lp.id = ue.project_id
  where ue.user_id = auth.uid()
    and ue.status  = 'active'
    and (ue.end_at is null or ue.end_at > now())
  order by ue.created_at desc;
$$;

-- ============================================================
-- 3. RPC: check_project_access(p_project_id)
-- 供学习页/项目页判断用户是否有项目权限
-- ============================================================
create or replace function public.check_project_access(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_entitlements
    where user_id          = auth.uid()
      and entitlement_type = 'project_access'
      and project_id       = p_project_id
      and status           = 'active'
      and (end_at is null or end_at > now())
  );
$$;

-- ============================================================
-- 4. RPC: get_my_orders()
-- 供"我的订单"Tab 调用，含订单项
-- ============================================================
create or replace function public.get_my_orders()
returns table (
  id               uuid,
  order_no         text,
  total_amount_cny numeric,
  status           text,
  channel          text,
  remark           text,
  created_at       timestamptz,
  paid_at          timestamptz,
  approved_at      timestamptz,
  items            jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    o.id,
    o.order_no,
    o.total_amount_cny,
    o.status,
    o.channel,
    o.remark,
    o.created_at,
    o.paid_at,
    o.approved_at,
    coalesce(
      (select jsonb_agg(jsonb_build_object(
        'product_title', oi.product_title,
        'quantity',      oi.quantity,
        'amount_cny',    oi.amount_cny
      ))
      from public.order_items oi where oi.order_id = o.id),
      '[]'::jsonb
    ) as items
  from public.orders o
  where o.user_id = auth.uid()
  order by o.created_at desc
  limit 50;
$$;

-- ============================================================
-- 5. RPC: get_my_enrollments()
-- 供"已报名项目"Tab 调用
-- ============================================================
create or replace function public.get_my_enrollments()
returns table (
  id                uuid,
  project_id        uuid,
  cohort_id         uuid,
  enrollment_status text,
  approval_status   text,
  joined_group_status text,
  created_at        timestamptz,
  project_title     text,
  project_cover_url text,
  cohort_title      text,
  cohort_start_date date,
  cohort_end_date   date,
  group_qr_url      text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    pe.id,
    pe.project_id,
    pe.cohort_id,
    pe.enrollment_status,
    pe.approval_status,
    pe.joined_group_status,
    pe.created_at,
    lp.title       as project_title,
    lp.cover_url   as project_cover_url,
    c.title        as cohort_title,
    c.start_date   as cohort_start_date,
    c.end_date     as cohort_end_date,
    case
      when pe.enrollment_status = 'confirmed' and pe.approval_status = 'approved'
      then c.group_qr_url
      else null
    end            as group_qr_url
  from public.project_enrollments pe
  join public.learning_projects lp on lp.id = pe.project_id
  left join public.cohorts c on c.id = pe.cohort_id
  where pe.user_id = auth.uid()
  order by pe.created_at desc;
$$;

-- ============================================================
-- 6. SEED DATA — Specialties（重症肾内 + 肾移植内科）
-- ============================================================

-- Insert specialties (will be linked to bundle products below)
insert into public.specialties (code, name, intro, is_active, sort_order)
values
  ('icu', '重症肾内科',
   '围绕 AKI、电解质与酸碱紊乱、CRRT 等重症肾内核心主题，系统讲授危重症肾脏病的识别与处理。',
   true, 1),
  ('tx', '肾移植内科',
   '覆盖移植肾病理、免疫抑制方案、排斥反应诊治、移植后合并症等肾移植内科全程管理。',
   true, 2)
on conflict (code) do update set
  name       = excluded.name,
  intro      = excluded.intro,
  is_active  = excluded.is_active,
  sort_order = excluded.sort_order;

-- ============================================================
-- 7. SEED DATA — Products（两专科 × 4 个商品）
-- ============================================================

-- Helper: get specialty ids
do $$
declare
  _icu_id  uuid;
  _tx_id   uuid;
begin
  select id into _icu_id from public.specialties where code = 'icu';
  select id into _tx_id  from public.specialties where code = 'tx';

  -- ── 重症肾内科 ──────────────────────────────────────────

  -- Bundle 专科课（正价 ¥1200，早鸟 ¥980）
  insert into public.products (
    product_code, product_type, title, subtitle, description,
    price_cny, list_price_cny, duration_days,
    specialty_id, recommended, requires_review, is_active, sort_order
  ) values (
    'ICU-BUNDLE-2026',
    'specialty_bundle',
    '重症肾内科 · 专科整套课',
    '全部视频课永久回放（含新增内容）',
    '覆盖 AKI、电解质与酸碱紊乱、CRRT 实操、脓毒症相关 AKI 等核心专题。' ||
    '购买后永久有效，持续更新。早鸟价 ¥980，正式开售后恢复 ¥1,200。',
    980, 1200, 36500,
    _icu_id, false, true, true, 10
  )
  on conflict (product_code) do update set
    price_cny      = excluded.price_cny,
    list_price_cny = excluded.list_price_cny,
    title          = excluded.title,
    subtitle       = excluded.subtitle,
    description    = excluded.description;

  -- 报名版 完整版（正价 ¥1580，早鸟 ¥1280）
  insert into public.products (
    product_code, product_type, title, subtitle, description,
    price_cny, list_price_cny, duration_days,
    specialty_id, recommended, requires_review, is_active, sort_order
  ) values (
    'ICU-REG-FULL-2026',
    'project_registration',
    '重症肾内科培训项目 · 报名版（完整版）',
    '直播 + 互动 + 微信群 + 视频回放',
    '开课前14天内报名享早鸟价 ¥1,280，正式价 ¥1,580。' ||
    '含全程直播互动、专属学员微信群、课后视频永久回放。',
    1280, 1580, 36500,
    _icu_id, true, true, true, 11
  )
  on conflict (product_code) do update set
    price_cny      = excluded.price_cny,
    list_price_cny = excluded.list_price_cny,
    title          = excluded.title,
    subtitle       = excluded.subtitle,
    description    = excluded.description;

  -- 视频版 回放版（正价 ¥980，早鸟 ¥780）
  insert into public.products (
    product_code, product_type, title, subtitle, description,
    price_cny, list_price_cny, duration_days,
    specialty_id, recommended, requires_review, is_active, sort_order
  ) values (
    'ICU-REG-VIDEO-2026',
    'project_registration',
    '重症肾内科培训项目 · 视频版（回放版）',
    '仅视频回放，不含直播/群',
    '开课前7天内报名享早鸟价 ¥780，正式价 ¥980。' ||
    '购买后解锁该期所有视频回放，永久有效。',
    780, 980, 36500,
    _icu_id, false, true, true, 12
  )
  on conflict (product_code) do update set
    price_cny      = excluded.price_cny,
    list_price_cny = excluded.list_price_cny,
    title          = excluded.title,
    subtitle       = excluded.subtitle,
    description    = excluded.description;

  -- ── 肾移植内科 ──────────────────────────────────────────

  -- Bundle 专科课（正价 ¥1200，早鸟 ¥980）
  insert into public.products (
    product_code, product_type, title, subtitle, description,
    price_cny, list_price_cny, duration_days,
    specialty_id, recommended, requires_review, is_active, sort_order
  ) values (
    'TX-BUNDLE-2026',
    'specialty_bundle',
    '肾移植内科 · 专科整套课',
    '全部视频课永久回放（含新增内容）',
    '覆盖移植肾病理、免疫抑制方案、急慢性排斥诊治、移植后感染与肿瘤等全程管理专题。' ||
    '购买后永久有效，持续更新。早鸟价 ¥980，正式开售后恢复 ¥1,200。',
    980, 1200, 36500,
    _tx_id, false, true, true, 20
  )
  on conflict (product_code) do update set
    price_cny      = excluded.price_cny,
    list_price_cny = excluded.list_price_cny,
    title          = excluded.title,
    subtitle       = excluded.subtitle,
    description    = excluded.description;

  -- 报名版 完整版（正价 ¥1580，早鸟 ¥1280）
  insert into public.products (
    product_code, product_type, title, subtitle, description,
    price_cny, list_price_cny, duration_days,
    specialty_id, recommended, requires_review, is_active, sort_order
  ) values (
    'TX-REG-FULL-2026',
    'project_registration',
    '肾移植内科培训项目 · 报名版（完整版）',
    '直播 + 互动 + 微信群 + 视频回放',
    '开课前14天内报名享早鸟价 ¥1,280，正式价 ¥1,580。' ||
    '含全程直播互动、专属学员微信群、课后视频永久回放。',
    1280, 1580, 36500,
    _tx_id, true, true, true, 21
  )
  on conflict (product_code) do update set
    price_cny      = excluded.price_cny,
    list_price_cny = excluded.list_price_cny,
    title          = excluded.title,
    subtitle       = excluded.subtitle,
    description    = excluded.description;

  -- 视频版 回放版（正价 ¥980，早鸟 ¥780）
  insert into public.products (
    product_code, product_type, title, subtitle, description,
    price_cny, list_price_cny, duration_days,
    specialty_id, recommended, requires_review, is_active, sort_order
  ) values (
    'TX-REG-VIDEO-2026',
    'project_registration',
    '肾移植内科培训项目 · 视频版（回放版）',
    '仅视频回放，不含直播/群',
    '开课前7天内报名享早鸟价 ¥780，正式价 ¥980。' ||
    '购买后解锁该期所有视频回放，永久有效。',
    780, 980, 36500,
    _tx_id, false, true, true, 22
  )
  on conflict (product_code) do update set
    price_cny      = excluded.price_cny,
    list_price_cny = excluded.list_price_cny,
    title          = excluded.title,
    subtitle       = excluded.subtitle,
    description    = excluded.description;

  -- Link bundle products back to specialties
  update public.specialties set bundle_product_id = (
    select id from public.products where product_code = 'ICU-BUNDLE-2026'
  ) where code = 'icu';

  update public.specialties set bundle_product_id = (
    select id from public.products where product_code = 'TX-BUNDLE-2026'
  ) where code = 'tx';

end $$;

-- ============================================================
-- 8. SEED DATA — Learning Projects（两个筹备项目）
-- ============================================================
do $$
declare
  _icu_bundle_id  uuid;
  _icu_full_id    uuid;
  _icu_video_id   uuid;
  _tx_bundle_id   uuid;
  _tx_full_id     uuid;
  _tx_video_id    uuid;
begin
  select id into _icu_bundle_id from public.products where product_code = 'ICU-BUNDLE-2026';
  select id into _icu_full_id   from public.products where product_code = 'ICU-REG-FULL-2026';
  select id into _icu_video_id  from public.products where product_code = 'ICU-REG-VIDEO-2026';
  select id into _tx_bundle_id  from public.products where product_code = 'TX-BUNDLE-2026';
  select id into _tx_full_id    from public.products where product_code = 'TX-REG-FULL-2026';
  select id into _tx_video_id   from public.products where product_code = 'TX-REG-VIDEO-2026';

  insert into public.learning_projects (
    project_code, title, intro,
    registration_fee_cny, requires_review,
    includes_bundle_product_id,
    refund_policy_text, is_active, status, sort_order
  ) values (
    'PROJ-ICU-2026',
    '重症肾内科规范化培训项目 · 2026',
    '系统学习 AKI、电解质与酸碱紊乱、CRRT、脓毒症相关 AKI 等重症肾内核心专题。' ||
    '由国内多位重症肾内科专家主讲，兼顾指南解读与临床实战。',
    1280, true,
    _icu_bundle_id,
    '开课前7天以上申请全额退款；开课后不支持退款。',
    true, 'draft', 1
  )
  on conflict (project_code) do update set
    title                      = excluded.title,
    intro                      = excluded.intro,
    includes_bundle_product_id = excluded.includes_bundle_product_id,
    status                     = excluded.status;

  insert into public.learning_projects (
    project_code, title, intro,
    registration_fee_cny, requires_review,
    includes_bundle_product_id,
    refund_policy_text, is_active, status, sort_order
  ) values (
    'PROJ-TX-2026',
    '肾移植内科规范化培训项目 · 2026',
    '系统学习移植肾病理、免疫抑制方案优化、急慢性排斥诊治、移植后合并症管理等核心模块。' ||
    '由国内顶级移植中心专家团队联合授课。',
    1280, true,
    _tx_bundle_id,
    '开课前7天以上申请全额退款；开课后不支持退款。',
    true, 'draft', 2
  )
  on conflict (project_code) do update set
    title                      = excluded.title,
    intro                      = excluded.intro,
    includes_bundle_product_id = excluded.includes_bundle_product_id,
    status                     = excluded.status;

end $$;

-- ============================================================
-- 9. Update system_config — 补充默认定价说明
-- ============================================================
insert into public.system_config (key, value, description) values
  ('specialty_bundle_early_price',    '980',  '专科整套课早鸟价(元)'),
  ('specialty_bundle_regular_price',  '1200', '专科整套课正价(元)'),
  ('project_full_early_price',        '1280', '培训项目报名版早鸟价(元)'),
  ('project_full_regular_price',      '1580', '培训项目报名版正价(元)'),
  ('project_video_early_price',       '780',  '培训项目视频版早鸟价(元)'),
  ('project_video_regular_price',     '980',  '培训项目视频版正价(元)'),
  ('single_video_price_low',          '88',   '单视频最低价(元)'),
  ('single_video_price_high',         '128',  '单视频最高价(元)')
on conflict (key) do nothing;

-- ============================================================
-- Done.
-- After running: Supabase Dashboard → API → Reload schema
-- ============================================================
