-- ============================================================
-- Migration: 给 atlas_categories 设板块排序 + emoji + 新增 2 个板块
-- Run in Supabase SQL Editor. Idempotent (safe to re-run).
-- ============================================================
--
-- 落地后 atlas.html 按 sort_order 渲染 5 个板块:
--   1. 肾小球病
--   2. 肾移植内科
--   3. 重症肾内和透析
--   4. 儿童肾脏     (敬请期待)
--   5. 血管通路     (敬请期待)

-- 1) 给现有 3 个分类设 sort_order + icon (不改名字, 名字交给 admin 决定)
update public.atlas_categories set icon = '🧬', sort_order = 1
where slug = 'glomerular-immunology';

update public.atlas_categories set icon = '🫀', sort_order = 2
where slug = 'kidney-transplant-nephrology';

update public.atlas_categories set icon = '🚨', sort_order = 3
where slug = 'aki-critical-care-nephrology';

-- 2) 新增儿童肾脏 + 血管通路 (idempotent, slug 是 unique key)
insert into public.atlas_categories (slug, name, icon, sort_order, status, description)
values
  ('pediatric-nephrology', '儿童肾脏',  '👶', 4, 'published', '儿童肾脏疾病专题图谱'),
  ('vascular-access',      '血管通路',  '🩸', 5, 'published', '血管通路建立与维护图谱')
on conflict (slug) do update set
  name        = excluded.name,
  icon        = excluded.icon,
  sort_order  = excluded.sort_order,
  status      = excluded.status,
  description = coalesce(public.atlas_categories.description, excluded.description);
