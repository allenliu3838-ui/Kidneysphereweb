-- MIGRATION_20260118_CASE_AI_ARTIFACTS.sql
-- Stage 1 (Free AI + manual paste-back): store AI summary / structured artifacts per case.
--
-- ✅ After running this migration, please go to:
-- Supabase Dashboard → Settings → API → Click “Reload schema”.

-- Safety: ensure UUID generator exists (Supabase usually has pgcrypto enabled)
create extension if not exists pgcrypto;

-- Optional helper (future): doctor_verified check
create or replace function public.is_doctor_verified()
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
      and lower(coalesce(p.role,'')) = 'doctor_verified'
  );
$$;

-- Main table
create table if not exists public.case_ai_artifacts (
  id uuid primary key default gen_random_uuid(),
  case_id bigint not null references public.cases(id) on delete cascade,
  kind text not null check (kind in ('summary_md','structured_json')),
  content_md text,
  content_json jsonb,
  source_hash text,
  prompt_version text,
  model text,
  created_by uuid references auth.users(id) on delete set null,
  creator_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Unique key: one artifact per (case, kind)
create unique index if not exists case_ai_artifacts_case_kind_key
on public.case_ai_artifacts(case_id, kind);

create index if not exists case_ai_artifacts_case_id_idx
on public.case_ai_artifacts(case_id);

-- Touch updated_at on update
create or replace function public.case_ai_artifacts_touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_case_ai_artifacts_touch on public.case_ai_artifacts;
create trigger trg_case_ai_artifacts_touch
before update on public.case_ai_artifacts
for each row execute function public.case_ai_artifacts_touch_updated_at();

-- RLS
alter table public.case_ai_artifacts enable row level security;

-- Read: any authenticated user who can see the case can read artifacts
-- (Cases table already restricts deleted_at and auth)
create policy case_ai_artifacts_select_authed
on public.case_ai_artifacts
for select
to authenticated
using (
  exists(
    select 1 from public.cases c
    where c.id = case_id
      and c.deleted_at is null
  )
);

-- Insert: case author / admin / doctor_verified
create policy case_ai_artifacts_insert_author_or_admin
on public.case_ai_artifacts
for insert
to authenticated
with check (
  auth.uid() = created_by
  and exists(select 1 from public.cases c where c.id = case_id and c.deleted_at is null)
  and (
    public.is_admin()
    or public.is_doctor_verified()
    or exists(select 1 from public.cases c where c.id = case_id and c.author_id = auth.uid())
  )
);

-- Update: case author / admin / doctor_verified
create policy case_ai_artifacts_update_author_or_admin
on public.case_ai_artifacts
for update
to authenticated
using (
  exists(select 1 from public.cases c where c.id = case_id and c.deleted_at is null)
  and (
    public.is_admin()
    or public.is_doctor_verified()
    or exists(select 1 from public.cases c where c.id = case_id and c.author_id = auth.uid())
  )
)
with check (
  exists(select 1 from public.cases c where c.id = case_id and c.deleted_at is null)
  and (
    public.is_admin()
    or public.is_doctor_verified()
    or exists(select 1 from public.cases c where c.id = case_id and c.author_id = auth.uid())
  )
);

-- Delete: admin only (keep history stable)
create policy case_ai_artifacts_delete_admin
on public.case_ai_artifacts
for delete
to authenticated
using (public.is_admin());

