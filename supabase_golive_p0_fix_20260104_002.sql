-- KidneySphere Go-Live P0 Fix
-- Version: 20260104_002
--
-- What this fixes (P0):
-- 1) admin 判断函数（trim + lower，避免 role 写成 super_admin 但识别不到）
-- 2) 病例 / 评论 / 动态 的“软删除”（UPDATE deleted_at）权限：作者 OR 管理员
-- 3) Moments 图片上传：创建 Storage bucket=moments，并补齐 storage.objects RLS policy
--
-- ✅ 可重复运行（幂等）

-- ----------------------------
-- 0) Admin helper
-- ----------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1
    from public.profiles
    where id = auth.uid()
      and lower(trim(coalesce(role,''))) in ('admin','super_admin','owner')
  );
$$;

-- ----------------------------
-- 1) Cases / Comments soft-delete permissions
-- ----------------------------
alter table if exists public.cases enable row level security;
alter table if exists public.case_comments enable row level security;

-- Drop ALL UPDATE/DELETE policies on these tables to avoid conflict
do $$
declare r record;
begin
  for r in
    select tablename, policyname
    from pg_policies
    where schemaname='public'
      and tablename in ('cases','case_comments')
      and cmd in ('UPDATE','DELETE')
  loop
    execute format('drop policy if exists %I on public.%I;', r.policyname, r.tablename);
  end loop;
end $$;

-- Re-create minimal policies we need (soft delete is UPDATE)
create policy cases_update_author_or_admin
on public.cases
for update
to authenticated
using (auth.uid() = author_id or public.is_admin())
with check (auth.uid() = author_id or public.is_admin());

create policy cases_delete_author_or_admin
on public.cases
for delete
to authenticated
using (auth.uid() = author_id or public.is_admin());

create policy case_comments_update_author_or_admin
on public.case_comments
for update
to authenticated
using (auth.uid() = author_id or public.is_admin())
with check (auth.uid() = author_id or public.is_admin());

create policy case_comments_delete_author_or_admin
on public.case_comments
for delete
to authenticated
using (auth.uid() = author_id or public.is_admin());

-- ----------------------------
-- 2) Moments (table + policies)
-- ----------------------------
create table if not exists public.moments (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text,
  content text,
  images text[] not null default '{}',
  like_count integer not null default 0,
  deleted_at timestamptz
);

alter table public.moments add column if not exists images text[] not null default '{}';
alter table public.moments add column if not exists like_count integer not null default 0;
alter table public.moments add column if not exists deleted_at timestamptz;
alter table public.moments enable row level security;

do $$
declare r record;
begin
  for r in
    select tablename, policyname
    from pg_policies
    where schemaname='public'
      and tablename='moments'
      and cmd in ('INSERT','UPDATE','DELETE')
  loop
    execute format('drop policy if exists %I on public.%I;', r.policyname, r.tablename);
  end loop;
end $$;

drop policy if exists moments_select_public on public.moments;
drop policy if exists moments_select_admin on public.moments;

create policy moments_select_public
on public.moments
for select
to anon, authenticated
using (deleted_at is null);

create policy moments_select_admin
on public.moments
for select
to authenticated
using (public.is_admin());

create policy moments_insert_own
on public.moments
for insert
to authenticated
with check (auth.uid() = author_id);

create policy moments_update_own_or_admin
on public.moments
for update
to authenticated
using (auth.uid() = author_id or public.is_admin())
with check (auth.uid() = author_id or public.is_admin());

create policy moments_delete_own_or_admin
on public.moments
for delete
to authenticated
using (auth.uid() = author_id or public.is_admin());

-- ----------------------------
-- 3) Storage bucket + RLS (bucket = 'moments')
-- ----------------------------
insert into storage.buckets (id, name, public)
values ('moments', 'moments', true)
on conflict (id) do update set public = excluded.public;

alter table storage.objects enable row level security;

drop policy if exists "moments_public_read" on storage.objects;
drop policy if exists "moments_insert_own" on storage.objects;
drop policy if exists "moments_delete_own_or_admin" on storage.objects;

create policy "moments_public_read"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'moments');

create policy "moments_insert_own"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'moments'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "moments_delete_own_or_admin"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'moments'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or public.is_admin()
  )
);

-- ✅ After running:
-- Supabase → Settings → API → 点击 “Reload schema”
-- 然后刷新网站再测试发布/删除。
