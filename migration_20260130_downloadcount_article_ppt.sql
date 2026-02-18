-- MIGRATION_20260130_DOWNLOADCOUNT_ARTICLE_PPT.sql
-- Adds download counters for:
--   - public.articles (download_count)
--   - public.expert_ppts (download_count)
-- And provides RPC incrementers callable by anon/authenticated.
--
-- Run in Supabase SQL Editor, then Reload schema.

-- =========================================================
-- 1) Articles: download_count + RPC
-- =========================================================

alter table if exists public.articles
  add column if not exists download_count integer not null default 0;

create index if not exists articles_download_count_idx on public.articles(download_count desc);

create or replace function public.increment_article_download(p_article_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  update public.articles
  set download_count = coalesce(download_count, 0) + 1
  where id = p_article_id
    and deleted_at is null
    and status = 'published'
  returning download_count into new_count;

  return new_count;
end;
$$;

grant execute on function public.increment_article_download(uuid) to anon, authenticated;

-- =========================================================
-- 2) Expert PPTs: download_count + RPC
-- =========================================================

alter table if exists public.expert_ppts
  add column if not exists download_count integer not null default 0;

create index if not exists expert_ppts_download_count_idx on public.expert_ppts(download_count desc);

create or replace function public.increment_expert_ppt_download(p_ppt_id bigint)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  update public.expert_ppts
  set download_count = coalesce(download_count, 0) + 1
  where id = p_ppt_id
    and deleted_at is null
  returning download_count into new_count;

  return new_count;
end;
$$;

grant execute on function public.increment_expert_ppt_download(bigint) to anon, authenticated;
