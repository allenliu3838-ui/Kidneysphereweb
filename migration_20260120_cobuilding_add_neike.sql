-- MIGRATION_20260120_COBUILDING_ADD_NEIKE.sql
-- 目的：
-- 1) 共建单位统一追加“肾内科”
-- 2) 将“肾脏内科/肾病科/肾内/肾病”等尾缀统一规范为“肾内科”
-- 3) 特别修正：黔西南州人民医院肾脏内科 -> 黔西南州人民医院肾内科
--
-- 说明：本脚本可重复执行（幂等）。

begin;

update public.about_showcase
set title =
  regexp_replace(title, '\s*(肾脏内科|肾病科|肾内科|肾内|肾病)\s*$', '', 'g')
where category = 'co_building';

update public.about_showcase
set title = regexp_replace(title, '\s+$', '', 'g') || '肾内科'
where category = 'co_building'
  and title !~ '肾内科\s*$';

commit;
