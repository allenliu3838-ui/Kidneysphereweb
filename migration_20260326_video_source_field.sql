-- ============================================================
-- Migration: 视频库改版 — 添加 source（内容来源）字段
-- 分离"内容来源"(source) 和"专科方向"(category) 两个维度
-- source: glomcon / kidneysphere / external
-- ============================================================

-- 1. Add source column to learning_videos
alter table public.learning_videos
  add column if not exists source text default 'external';

comment on column public.learning_videos.source
  is '内容来源：glomcon = GlomCon 中国, kidneysphere = 肾域原创, external = 外部资源';

-- 2. Migrate existing glomcon category videos:
--    Set source = glomcon, and re-classify to actual specialty category
--    (Videos with category='glomcon' need manual review for correct specialty)
update public.learning_videos
  set source = 'glomcon'
  where category = 'glomcon'
    and (source is null or source = 'external');

-- 3. Also mark membership_accessible videos as glomcon source
--    (these are GlomCon membership videos by definition)
update public.learning_videos
  set source = 'glomcon'
  where membership_accessible = true
    and (source is null or source = 'external');

-- NOTE: After running this migration, manually review videos with
-- category='glomcon' and update their category to the correct specialty
-- (e.g., 'glom', 'tx', 'path', etc.) based on actual content.
-- Example:
--   UPDATE learning_videos SET category = 'glom' WHERE id = '...' AND category = 'glomcon';
