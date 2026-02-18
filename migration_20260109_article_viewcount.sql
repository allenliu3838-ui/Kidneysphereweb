-- MIGRATION_20260109_ARTICLE_VIEWCOUNT.sql
-- Adds article view counter + RPC incrementer (safe, backward compatible).
--
-- Run in Supabase SQL Editor.

-- 1) Add view_count column
alter table if exists public.articles
  add column if not exists view_count integer not null default 0;

-- Optional index (helps sorting/filtering by views later)
create index if not exists articles_view_count_idx on public.articles(view_count desc);

-- 2) RPC to increment view_count (bypasses RLS via SECURITY DEFINER)
create or replace function public.increment_article_view(p_article_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
begin
  update public.articles
  set view_count = coalesce(view_count, 0) + 1
  where id = p_article_id
    and deleted_at is null
    and status = 'published'
  returning view_count into new_count;

  return new_count;
end;
$$;

grant execute on function public.increment_article_view(uuid) to anon, authenticated;
