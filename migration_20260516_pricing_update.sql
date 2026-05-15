-- ============================================================
-- Migration: GlomCon 教育会员价格上调 199 -> 299
-- 取消"首发优惠（前50名 ¥99/年）"
-- Run in Supabase SQL Editor. Idempotent.
-- ============================================================

-- 1) 更新年费产品价格：199 -> 299
update public.products
set
  price_cny      = 299,
  list_price_cny = 299,
  updated_at     = now()
where product_code = 'MEMBERSHIP-YEARLY';

-- 2) 同步 system_config
update public.system_config
set value = '299', description = '年费会员价格(元)'
where key = 'membership_yearly_price';

-- 3) 停用首发优惠的价格版本（前 50 名 ¥99/年）
--    保留历史记录以便审计，但 status 置为 inactive，前端/checkout 不再选用
update public.product_price_versions
set
  status = 'inactive',
  effective_end_at = now()
where version_name = '首发优惠（前50名）'
  and status = 'active';
