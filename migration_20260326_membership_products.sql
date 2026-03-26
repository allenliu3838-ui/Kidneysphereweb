-- ============================================================
-- Migration: GlomCon 教育会员产品 + 会员定价配置
-- 创建年费/月费会员商品，配置会员价格
-- Run in Supabase SQL Editor. Idempotent (safe to re-run).
-- ============================================================

-- 1. 创建年费会员商品
insert into public.products (
  product_code, product_type, title, subtitle, description,
  price_cny, list_price_cny, membership_period, duration_days,
  recommended, requires_review, is_active, sort_order
) values (
  'MEMBERSHIP-YEARLY',
  'membership_plan',
  'GlomCon 教育会员 · 年费',
  '解锁全部 GlomCon 中国教育系列',
  '年费会员可观看全部 GlomCon 中国教育系列视频及未来新增会员专属内容。购买任意培训项目自动获得 1 年会员权益。',
  199, 299, 'yearly', 365,
  true, true, true, 10
)
on conflict (product_code) do update set
  title = excluded.title,
  subtitle = excluded.subtitle,
  description = excluded.description,
  price_cny = excluded.price_cny,
  list_price_cny = excluded.list_price_cny,
  membership_period = excluded.membership_period,
  duration_days = excluded.duration_days,
  recommended = excluded.recommended,
  is_active = excluded.is_active,
  sort_order = excluded.sort_order,
  updated_at = now();

-- 2. 创建月费会员商品
insert into public.products (
  product_code, product_type, title, subtitle, description,
  price_cny, list_price_cny, membership_period, duration_days,
  recommended, requires_review, is_active, sort_order
) values (
  'MEMBERSHIP-MONTHLY',
  'membership_plan',
  'GlomCon 教育会员 · 月费',
  '按月解锁 GlomCon 中国教育系列',
  '月费会员可观看全部 GlomCon 中国教育系列视频。适合短期体验。',
  29, 39, 'monthly', 30,
  false, true, true, 11
)
on conflict (product_code) do update set
  title = excluded.title,
  subtitle = excluded.subtitle,
  description = excluded.description,
  price_cny = excluded.price_cny,
  list_price_cny = excluded.list_price_cny,
  membership_period = excluded.membership_period,
  duration_days = excluded.duration_days,
  recommended = excluded.recommended,
  is_active = excluded.is_active,
  sort_order = excluded.sort_order,
  updated_at = now();

-- 3. 更新 system_config 会员定价
insert into public.system_config (key, value, label)
values
  ('membership_yearly_price', '199', '年费会员价格(元)'),
  ('membership_monthly_price', '29', '月费会员价格(元)'),
  ('membership_enabled', 'true', '是否开启会员购买')
on conflict (key) do update set
  value = excluded.value,
  label = excluded.label;

-- 4. 创建首发优惠价格版本（前50名 ¥99/年）
insert into public.product_price_versions (
  product_id, version_name, list_price_cny, sale_price_cny,
  effective_start_at, status
)
select p.id, '首发优惠（前50名）', 299, 99, now(), 'active'
from public.products p
where p.product_code = 'MEMBERSHIP-YEARLY'
  and not exists (
    select 1 from public.product_price_versions pv
    where pv.product_id = p.id and pv.version_name = '首发优惠（前50名）'
  );
