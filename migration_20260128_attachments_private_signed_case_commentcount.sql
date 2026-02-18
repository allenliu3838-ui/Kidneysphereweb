-- MIGRATION_20260128_ATTACHMENTS_PRIVATE_SIGNED_CASE_COMMENTCOUNT.sql
-- Purpose:
-- 1) Make the discussion attachments bucket PRIVATE and serve files via signed URLs.
-- 2) Restrict attachments table reads to authenticated users.
-- 3) Keep cases.comment_count in sync with case_comments (including soft delete).
-- 4) Add a few performance indexes.

begin;

-- ------------------------------
-- ------------------------------
-- Attachments table: read policy split
--   - expert_ppt attachments: public (site-wide content)
--   - everything else: authenticated only
-- ------------------------------
drop policy if exists attachments_select_public on public.attachments;
drop policy if exists attachments_select_authed on public.attachments;
drop policy if exists attachments_select_authed_private on public.attachments;
drop policy if exists attachments_select_public_expert_ppt on public.attachments;

create policy attachments_select_public_expert_ppt
on public.attachments
for select
to anon, authenticated
using (deleted_at is null and target_type = 'expert_ppt');

create policy attachments_select_authed_private
on public.attachments
for select
to authenticated
using (deleted_at is null and target_type <> 'expert_ppt');

-- ------------------------------
-- Storage bucket: attachments -> private + authenticated read
-- ------------------------------
update storage.buckets
set public = false
where id = 'attachments';

-- Policies for storage.objects (bucket = 'attachments')
drop policy if exists "attachments_public_read" on storage.objects;
drop policy if exists "attachments_read_authed" on storage.objects;

create policy "attachments_read_authed"
on storage.objects
for select
to authenticated
using (bucket_id = 'attachments');

-- ------------------------------
-- Performance indexes
-- ------------------------------
create index if not exists idx_cases_board_created_at_live
on public.cases(board, created_at desc)
where deleted_at is null;

create index if not exists idx_cases_created_at_live
on public.cases(created_at desc)
where deleted_at is null;

create index if not exists idx_case_comments_case_created_at_live
on public.case_comments(case_id, created_at)
where deleted_at is null;

create index if not exists idx_moments_created_at_live
on public.moments(created_at desc)
where deleted_at is null;

-- ------------------------------
-- cases.comment_count sync
-- ------------------------------
-- NOTE: Older deployments may not have the denormalized column yet.
-- Ensure it exists before creating triggers/functions that update it.
alter table public.cases
  add column if not exists comment_count integer not null default 0;

-- Backfill comment_count for existing cases (best-effort, idempotent)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'case_comments'
      and column_name = 'deleted_at'
  ) then
    execute 'update public.cases c set comment_count = (select count(1) from public.case_comments cc where cc.case_id = c.id and cc.deleted_at is null)';
  else
    execute 'update public.cases c set comment_count = (select count(1) from public.case_comments cc where cc.case_id = c.id)';
  end if;
end $$;

create or replace function public.recompute_case_comment_count(_case_id bigint)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  _has_deleted_at boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'case_comments'
      and column_name = 'deleted_at'
  ) into _has_deleted_at;

  if _has_deleted_at then
    execute
      'update public.cases c set comment_count = (select count(1) from public.case_comments cc where cc.case_id = c.id and cc.deleted_at is null) where c.id = $1'
    using _case_id;
  else
    execute
      'update public.cases c set comment_count = (select count(1) from public.case_comments cc where cc.case_id = c.id) where c.id = $1'
    using _case_id;
  end if;
end;
$$;

create or replace function public.trg_case_comment_count()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  if (TG_OP = 'INSERT') then
    perform public.recompute_case_comment_count(new.case_id);
  elsif (TG_OP = 'UPDATE') then
    perform public.recompute_case_comment_count(coalesce(new.case_id, old.case_id));
    if new.case_id is distinct from old.case_id then
      perform public.recompute_case_comment_count(old.case_id);
    end if;
  else
    perform public.recompute_case_comment_count(old.case_id);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_case_comment_count on public.case_comments;
create trigger trg_case_comment_count
after insert or update or delete on public.case_comments
for each row execute function public.trg_case_comment_count();

commit;
