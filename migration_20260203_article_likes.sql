-- MIGRATION_20260203_ARTICLE_LIKES.sql
-- Adds article likes (点赞) + like_count (safe, backward compatible).
--
-- Run in Supabase SQL Editor.
-- After running: Settings → API → Reload schema (recommended).

-- 1) Add like_count column to articles
alter table if exists public.articles
  add column if not exists like_count integer not null default 0;

-- 2) Likes table (one like per user per article)
create table if not exists public.article_likes (
  article_id uuid not null references public.articles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (article_id, user_id)
);

create index if not exists idx_article_likes_user_created_at
on public.article_likes(user_id, created_at desc);

alter table public.article_likes enable row level security;

-- Select: user can read own likes; admin can read all
drop policy if exists article_likes_select_own on public.article_likes;
create policy article_likes_select_own
on public.article_likes
for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

-- Insert: only self; only for existing, non-deleted articles
drop policy if exists article_likes_insert_own on public.article_likes;
create policy article_likes_insert_own
on public.article_likes
for insert
to authenticated
with check (
  user_id = auth.uid()
  and exists (
    select 1 from public.articles a
    where a.id = article_id and a.deleted_at is null
  )
);

-- Delete: self or admin
drop policy if exists article_likes_delete_own on public.article_likes;
create policy article_likes_delete_own
on public.article_likes
for delete
to authenticated
using (user_id = auth.uid() or public.is_admin());

-- 3) Trigger: keep articles.like_count in sync
create or replace function public.trg_article_like_apply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.articles
  set like_count = like_count + 1
  where id = new.article_id;

  return new;
end;
$$;

create or replace function public.trg_article_like_revert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.articles
  set like_count = greatest(like_count - 1, 0)
  where id = old.article_id;

  return old;
end;
$$;

drop trigger if exists trg_article_like_apply on public.article_likes;
create trigger trg_article_like_apply
after insert on public.article_likes
for each row execute function public.trg_article_like_apply();

drop trigger if exists trg_article_like_revert on public.article_likes;
create trigger trg_article_like_revert
after delete on public.article_likes
for each row execute function public.trg_article_like_revert();

-- 4) Backfill counts (safe)
update public.articles a
set like_count = (
  select count(1) from public.article_likes l
  where l.article_id = a.id
)
where a.deleted_at is null;
