-- MIGRATION_20260108_V7_2_LIKES_MENTIONS_MEDIA.sql
--
-- v7.2 增量：评论点赞 + @医生搜索 + 学习中心视频表/桶 + 文章媒体桶
--
-- 依赖：先执行 SUPABASE_SETUP.sql（首次搭建）
--      再执行 MIGRATION_20260107_NEXT.sql（文章表/讲者头像/权限）
--      再执行本文件

-- ------------------------------
-- 1) 评论点赞：病例评论 & 动态评论
-- ------------------------------

alter table if exists public.case_comments
  add column if not exists like_count int not null default 0;

alter table if exists public.moment_comments
  add column if not exists like_count int not null default 0;

create table if not exists public.case_comment_likes (
  comment_id bigint not null references public.case_comments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create table if not exists public.moment_comment_likes (
  comment_id bigint not null references public.moment_comments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

-- Like count triggers (case comments)
create or replace function public._case_comment_like_inc()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  update public.case_comments
    set like_count = like_count + 1
    where id = new.comment_id;
  return new;
end;
$$;

create or replace function public._case_comment_like_dec()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  update public.case_comments
    set like_count = greatest(like_count - 1, 0)
    where id = old.comment_id;
  return old;
end;
$$;

drop trigger if exists trg_case_comment_like_ins on public.case_comment_likes;
create trigger trg_case_comment_like_ins
after insert on public.case_comment_likes
for each row execute function public._case_comment_like_inc();

drop trigger if exists trg_case_comment_like_del on public.case_comment_likes;
create trigger trg_case_comment_like_del
after delete on public.case_comment_likes
for each row execute function public._case_comment_like_dec();

-- Like count triggers (moment comments)
create or replace function public._moment_comment_like_inc()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  update public.moment_comments
    set like_count = like_count + 1
    where id = new.comment_id;
  return new;
end;
$$;

create or replace function public._moment_comment_like_dec()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  update public.moment_comments
    set like_count = greatest(like_count - 1, 0)
    where id = old.comment_id;
  return old;
end;
$$;

drop trigger if exists trg_moment_comment_like_ins on public.moment_comment_likes;
create trigger trg_moment_comment_like_ins
after insert on public.moment_comment_likes
for each row execute function public._moment_comment_like_inc();

drop trigger if exists trg_moment_comment_like_del on public.moment_comment_likes;
create trigger trg_moment_comment_like_del
after delete on public.moment_comment_likes
for each row execute function public._moment_comment_like_dec();

-- RLS for likes tables
alter table public.case_comment_likes enable row level security;

drop policy if exists "case_comment_likes_select_own" on public.case_comment_likes;
create policy "case_comment_likes_select_own"
  on public.case_comment_likes
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "case_comment_likes_insert_own" on public.case_comment_likes;
create policy "case_comment_likes_insert_own"
  on public.case_comment_likes
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "case_comment_likes_delete_own" on public.case_comment_likes;
create policy "case_comment_likes_delete_own"
  on public.case_comment_likes
  for delete
  to authenticated
  using (user_id = auth.uid());

alter table public.moment_comment_likes enable row level security;

drop policy if exists "moment_comment_likes_select_own" on public.moment_comment_likes;
create policy "moment_comment_likes_select_own"
  on public.moment_comment_likes
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "moment_comment_likes_insert_own" on public.moment_comment_likes;
create policy "moment_comment_likes_insert_own"
  on public.moment_comment_likes
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "moment_comment_likes_delete_own" on public.moment_comment_likes;
create policy "moment_comment_likes_delete_own"
  on public.moment_comment_likes
  for delete
  to authenticated
  using (user_id = auth.uid());

-- ------------------------------
-- 2) @医生：搜索 RPC
-- ------------------------------

create or replace function public.search_doctors(_q text, _limit int default 12)
returns table(
  id uuid,
  full_name text,
  avatar_url text,
  role text
)
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  q text;
  lim int;
begin
  if auth.uid() is null then
    raise exception 'auth required';
  end if;

  q := coalesce(trim(_q), '');
  lim := greatest(1, least(coalesce(_limit, 12), 20));

  return query
  select p.id, p.full_name, p.avatar_url, p.role
  from public.profiles p
  where p.full_name is not null
    and (q = '' or p.full_name ilike '%' || q || '%')
    and lower(coalesce(p.role,'')) in (
      'doctor',
      'doctor_pending',
      'doctor_verified',
      'admin',
      'super_admin',
      'owner'
    )
  order by
    case when q <> '' and lower(p.full_name) = lower(q) then 0 else 1 end,
    p.updated_at desc nulls last
  limit lim;
end;
$$;

grant execute on function public.search_doctors(text, int) to authenticated;

-- ------------------------------
-- 3) 学习中心：可维护的视频表
-- ------------------------------

create table if not exists public.learning_videos (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null,
  kind text not null default 'external', -- bilibili | external | mp4
  source_url text,
  mp4_url text,
  bvid text,
  speaker text,
  needs_check bool not null default false,
  enabled bool not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.learning_videos enable row level security;

drop policy if exists "learning_videos_select_public" on public.learning_videos;
create policy "learning_videos_select_public"
  on public.learning_videos
  for select
  to anon, authenticated
  using (enabled = true and deleted_at is null);

drop policy if exists "learning_videos_admin_insert" on public.learning_videos;
create policy "learning_videos_admin_insert"
  on public.learning_videos
  for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "learning_videos_admin_update" on public.learning_videos;
create policy "learning_videos_admin_update"
  on public.learning_videos
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "learning_videos_admin_delete" on public.learning_videos;
create policy "learning_videos_admin_delete"
  on public.learning_videos
  for delete
  to authenticated
  using (public.is_admin());

-- ------------------------------
-- 4) Storage：文章媒体 & 学习视频 mp4
-- ------------------------------

-- Buckets (public read)
insert into storage.buckets (id, name, public)
values ('article_media', 'article_media', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('learning_videos', 'learning_videos', true)
on conflict (id) do nothing;

-- Public read for both buckets

drop policy if exists "article_media_public_read" on storage.objects;
create policy "article_media_public_read"
  on storage.objects
  for select
  to public
  using (bucket_id = 'article_media');


drop policy if exists "learning_videos_public_read" on storage.objects;
create policy "learning_videos_public_read"
  on storage.objects
  for select
  to public
  using (bucket_id = 'learning_videos');

-- Admin write for both buckets

drop policy if exists "article_media_admin_write" on storage.objects;
create policy "article_media_admin_write"
  on storage.objects
  for all
  to authenticated
  using (bucket_id = 'article_media' and public.is_admin())
  with check (bucket_id = 'article_media' and public.is_admin());


drop policy if exists "learning_videos_admin_write" on storage.objects;
create policy "learning_videos_admin_write"
  on storage.objects
  for all
  to authenticated
  using (bucket_id = 'learning_videos' and public.is_admin())
  with check (bucket_id = 'learning_videos' and public.is_admin());
