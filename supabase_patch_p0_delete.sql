-- KidneySphere · P0 Patch (Delete Permission / Admin Check)
-- Run in Supabase SQL Editor for project: eaatpwakhcjxjonlyfii
-- Safe to re-run.

-- Why this patch exists:
-- - Deletion is implemented as "soft delete" (UPDATE ... SET deleted_at=NOW()).
-- - RLS must allow UPDATE for (author OR admin).
-- - Admin check should be robust to whitespace/case issues.

-- 1) Robust admin check (TRIM + LOWER)
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(trim(coalesce(p.role,''))) in ('super_admin','admin','owner')
  );
$$;

-- 2) Normalize existing roles (recommended)
update public.profiles
set role = lower(trim(role))
where role is not null and role <> lower(trim(role));

-- 3) Ensure RLS is enabled (idempotent)
alter table public.cases enable row level security;
alter table public.case_comments enable row level security;

-- 4) Ensure soft-delete UPDATE policies exist (author OR admin)
drop policy if exists cases_update_author_or_admin on public.cases;
create policy cases_update_author_or_admin
on public.cases
for update
to authenticated
using (auth.uid() = author_id or public.is_admin())
with check (auth.uid() = author_id or public.is_admin());

drop policy if exists comments_update_author_or_admin on public.case_comments;
create policy comments_update_author_or_admin
on public.case_comments
for update
to authenticated
using (auth.uid() = author_id or public.is_admin())
with check (auth.uid() = author_id or public.is_admin());

-- 5) (Optional) Physical DELETE permissions for admins
-- If you only want soft-delete, you can comment out the following two blocks.
drop policy if exists cases_delete_admin on public.cases;
create policy cases_delete_admin
on public.cases
for delete
to authenticated
using (public.is_admin());

drop policy if exists comments_delete_admin on public.case_comments;
create policy comments_delete_admin
on public.case_comments
for delete
to authenticated
using (public.is_admin());
