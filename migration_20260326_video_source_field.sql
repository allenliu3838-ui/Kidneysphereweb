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
--    Set source = glomcon, mark as paid membership, reclassify to 'glom'
update public.learning_videos
  set source = 'glomcon',
      is_paid = true,
      membership_accessible = true,
      category = case
        when category = 'glomcon' then 'glom'
        else category
      end
  where (category = 'glomcon' or membership_accessible = true)
    and (source is null or source = 'external');
