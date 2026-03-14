-- ============================================================
-- Add Alibaba Cloud VOD (阿里云视频点播) support to learning_videos
-- ============================================================

begin;

-- 1. Add aliyun_vid column (stores the Alibaba Cloud video ID for reference)
alter table public.learning_videos
  add column if not exists aliyun_vid text;

-- 2. Expand the kind check constraint to include 'aliyun'
--    Drop old constraint and recreate with the new value.
do $$
begin
  -- Drop the existing check if it exists (constraint name varies by migration)
  alter table public.learning_videos drop constraint if exists learning_videos_kind_check;
  -- Some setups may not have a named constraint; try to add regardless
  alter table public.learning_videos
    add constraint learning_videos_kind_check
    check (kind in ('bilibili','external','mp4','aliyun'));
exception when others then
  raise notice 'kind constraint update skipped: %', sqlerrm;
end $$;

commit;
