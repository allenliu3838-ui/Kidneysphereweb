-- MIGRATION_20260130_CASE_COMMENTCOUNT_HOTFIX.sql
-- Purpose:
-- Hotfix for older DBs where public.cases.comment_count does not exist yet.
-- If a trg_case_comment_count trigger exists (or you add one later), inserts/updates
-- on public.case_comments may fail without this column.

begin;

-- 1) Ensure the denormalized counter exists.
alter table public.cases
  add column if not exists comment_count integer not null default 0;

-- 2) Backfill comment_count for existing cases (best-effort, idempotent)
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

-- 3) Make recompute_case_comment_count robust (works even if case_comments has no deleted_at)
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

-- 4) (Re)create trigger to keep comment_count in sync
-- Safe even if it already exists.
drop trigger if exists trg_case_comment_count on public.case_comments;
create trigger trg_case_comment_count
after insert or update or delete on public.case_comments
for each row execute function public.trg_case_comment_count();

commit;
