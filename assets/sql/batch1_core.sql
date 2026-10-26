-- KidneySphere AI Follow-up Registry (Core Schema v1)
-- Includes: projects, baseline (with IgAN Oxford MEST-C), visits, labs, meds, genetics variants, patient tokens,
-- RLS policies, and patient token RPC (security definer) + trial write lock.

-- Extensions
create extension if not exists pgcrypto;

-- ---------------------------
-- Tables
-- ---------------------------

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  center_code text not null,
  registry_type text not null default 'general',
  module text not null default 'GENERAL',
  created_by uuid,
  created_at timestamptz not null default now(),

  -- Trial controls (recommended for multi-center reproducibility)
  trial_enabled boolean not null default true,
  trial_started_at timestamptz not null default now(),
  trial_expires_at timestamptz not null default (now() + interval '56 days'),
  trial_grace_until timestamptz not null default (now() + interval '70 days'),
  trial_note text,

  constraint projects_trial_grace_ge_expires check (trial_grace_until >= trial_expires_at)
);

create index if not exists projects_created_by_idx on public.projects(created_by);
create index if not exists projects_center_code_idx on public.projects(center_code);

create table if not exists public.patients_baseline (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,

  -- No PII fields. Only de-identified research code.
  sex text, -- 'M'/'F'
  birth_year int,

  baseline_date date,
  baseline_scr numeric,  -- μmol/L
  baseline_upcr numeric, -- mg/g or g/g (site-defined)
  consent_research boolean not null default true,

  -- IgAN pathology (Oxford MEST-C)
  biopsy_date date,
  oxford_m smallint,
  oxford_e smallint,
  oxford_s smallint,
  oxford_t smallint,
  oxford_c smallint,

  created_by uuid,
  created_at timestamptz not null default now(),

  constraint patients_baseline_unique unique(project_id, patient_code),
  constraint oxford_m_check check (oxford_m in (0,1) or oxford_m is null),
  constraint oxford_e_check check (oxford_e in (0,1) or oxford_e is null),
  constraint oxford_s_check check (oxford_s in (0,1) or oxford_s is null),
  constraint oxford_t_check check (oxford_t in (0,1,2) or oxford_t is null),
  constraint oxford_c_check check (oxford_c in (0,1,2) or oxford_c is null)
);

create index if not exists patients_baseline_project_patient_idx on public.patients_baseline(project_id, patient_code);

create table if not exists public.visits_long (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,

  visit_date date not null,
  sbp numeric,
  dbp numeric,
  scr_umol_l numeric, -- serum creatinine (μmol/L)
  upcr numeric,       -- protein/creatinine ratio (site-defined)
  egfr numeric,       -- optional precomputed
  notes text,

  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists visits_long_project_patient_date_idx on public.visits_long(project_id, patient_code, visit_date);

create table if not exists public.labs_long (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,

  lab_date date,
  lab_name text,
  lab_value numeric,
  lab_unit text,

  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists labs_long_project_patient_idx on public.labs_long(project_id, patient_code);

create table if not exists public.meds_long (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,

  drug_name text,
  drug_class text,
  dose text,
  start_date date,
  end_date date,

  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists meds_long_project_patient_idx on public.meds_long(project_id, patient_code);

create table if not exists public.variants_long (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,

  test_date date,
  test_name text,     -- e.g., WES / panel name
  gene text,
  variant text,       -- short description
  hgvs_c text,
  hgvs_p text,
  transcript text,
  zygosity text,      -- het/hom/hem
  classification text,-- ACMG: P/LP/VUS/LB/B
  lab_name text,
  notes text,

  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists variants_long_project_patient_idx on public.variants_long(project_id, patient_code);

create table if not exists public.patient_tokens (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,

  token text not null unique,
  active boolean not null default true,
  expires_at timestamptz,

  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists patient_tokens_project_patient_idx on public.patient_tokens(project_id, patient_code);
create index if not exists patient_tokens_token_idx on public.patient_tokens(token);

-- ---------------------------
-- Helper: set created_by on insert when authenticated
-- ---------------------------

create or replace function public._set_created_by()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists tr_projects_created_by on public.projects;
create trigger tr_projects_created_by
before insert on public.projects
for each row execute function public._set_created_by();

-- Optional for other tables (won't set for anon token submissions)
drop trigger if exists tr_patients_created_by on public.patients_baseline;
create trigger tr_patients_created_by
before insert on public.patients_baseline
for each row execute function public._set_created_by();

drop trigger if exists tr_visits_created_by on public.visits_long;
create trigger tr_visits_created_by
before insert on public.visits_long
for each row execute function public._set_created_by();

drop trigger if exists tr_labs_created_by on public.labs_long;
create trigger tr_labs_created_by
before insert on public.labs_long
for each row execute function public._set_created_by();

drop trigger if exists tr_meds_created_by on public.meds_long;
create trigger tr_meds_created_by
before insert on public.meds_long
for each row execute function public._set_created_by();

drop trigger if exists tr_vars_created_by on public.variants_long;
create trigger tr_vars_created_by
before insert on public.variants_long
for each row execute function public._set_created_by();

drop trigger if exists tr_tokens_created_by on public.patient_tokens;
create trigger tr_tokens_created_by
before insert on public.patient_tokens
for each row execute function public._set_created_by();

-- ---------------------------
-- Trial write lock
-- ---------------------------

create or replace function public.assert_project_write_allowed(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_trial_enabled boolean;
declare v_expires timestamptz;
begin
  select trial_enabled, trial_expires_at into v_trial_enabled, v_expires
  from public.projects
  where id = p_project_id;

  if not found then
    raise exception 'project_not_found';
  end if;

  if v_trial_enabled and now() > v_expires then
    raise exception 'trial_expired';
  end if;
end;
$$;

create or replace function public._trial_block_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare pid uuid;
begin
  if tg_op = 'DELETE' then
    pid := old.project_id;
  else
    pid := new.project_id;
  end if;

  perform public.assert_project_write_allowed(pid);

  if tg_op = 'DELETE' then
    return old;
  else
    return new;
  end if;
end;
$$;

-- Apply trial lock triggers to all write tables
drop trigger if exists tr_patients_trial_lock on public.patients_baseline;
create trigger tr_patients_trial_lock
before insert or update or delete on public.patients_baseline
for each row execute function public._trial_block_write();

drop trigger if exists tr_visits_trial_lock on public.visits_long;
create trigger tr_visits_trial_lock
before insert or update or delete on public.visits_long
for each row execute function public._trial_block_write();

drop trigger if exists tr_labs_trial_lock on public.labs_long;
create trigger tr_labs_trial_lock
before insert or update or delete on public.labs_long
for each row execute function public._trial_block_write();

drop trigger if exists tr_meds_trial_lock on public.meds_long;
create trigger tr_meds_trial_lock
before insert or update or delete on public.meds_long
for each row execute function public._trial_block_write();

drop trigger if exists tr_vars_trial_lock on public.variants_long;
create trigger tr_vars_trial_lock
before insert or update or delete on public.variants_long
for each row execute function public._trial_block_write();

drop trigger if exists tr_tokens_trial_lock on public.patient_tokens;
create trigger tr_tokens_trial_lock
before insert or update or delete on public.patient_tokens
for each row execute function public._trial_block_write();

-- ---------------------------
-- RLS (Row Level Security)
-- ---------------------------

alter table public.projects enable row level security;
alter table public.patients_baseline enable row level security;
alter table public.visits_long enable row level security;
alter table public.labs_long enable row level security;
alter table public.meds_long enable row level security;
alter table public.variants_long enable row level security;
alter table public.patient_tokens enable row level security;

-- Projects: owner-only access
drop policy if exists projects_select_own on public.projects;
create policy projects_select_own
on public.projects for select
to authenticated
using (created_by = auth.uid());

drop policy if exists projects_insert_auth on public.projects;
create policy projects_insert_auth
on public.projects for insert
to authenticated
with check (created_by is null or created_by = auth.uid());

drop policy if exists projects_update_own on public.projects;
create policy projects_update_own
on public.projects for update
to authenticated
using (created_by = auth.uid())
with check (created_by = auth.uid());

drop policy if exists projects_delete_own on public.projects;
create policy projects_delete_own
on public.projects for delete
to authenticated
using (created_by = auth.uid());

-- Helper predicate for child tables
-- "exists project owned by current user"
-- Baseline
drop policy if exists baseline_select_own on public.patients_baseline;
create policy baseline_select_own
on public.patients_baseline for select
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists baseline_insert_own on public.patients_baseline;
create policy baseline_insert_own
on public.patients_baseline for insert
to authenticated
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists baseline_update_own on public.patients_baseline;
create policy baseline_update_own
on public.patients_baseline for update
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()))
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists baseline_delete_own on public.patients_baseline;
create policy baseline_delete_own
on public.patients_baseline for delete
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

-- Visits
drop policy if exists visits_select_own on public.visits_long;
create policy visits_select_own
on public.visits_long for select
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists visits_insert_own on public.visits_long;
create policy visits_insert_own
on public.visits_long for insert
to authenticated
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists visits_update_own on public.visits_long;
create policy visits_update_own
on public.visits_long for update
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()))
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists visits_delete_own on public.visits_long;
create policy visits_delete_own
on public.visits_long for delete
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

-- Labs
drop policy if exists labs_select_own on public.labs_long;
create policy labs_select_own
on public.labs_long for select
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists labs_insert_own on public.labs_long;
create policy labs_insert_own
on public.labs_long for insert
to authenticated
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists labs_update_own on public.labs_long;
create policy labs_update_own
on public.labs_long for update
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()))
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists labs_delete_own on public.labs_long;
create policy labs_delete_own
on public.labs_long for delete
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

-- Meds
drop policy if exists meds_select_own on public.meds_long;
create policy meds_select_own
on public.meds_long for select
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists meds_insert_own on public.meds_long;
create policy meds_insert_own
on public.meds_long for insert
to authenticated
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists meds_update_own on public.meds_long;
create policy meds_update_own
on public.meds_long for update
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()))
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists meds_delete_own on public.meds_long;
create policy meds_delete_own
on public.meds_long for delete
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

-- Variants
drop policy if exists vars_select_own on public.variants_long;
create policy vars_select_own
on public.variants_long for select
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists vars_insert_own on public.variants_long;
create policy vars_insert_own
on public.variants_long for insert
to authenticated
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists vars_update_own on public.variants_long;
create policy vars_update_own
on public.variants_long for update
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()))
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists vars_delete_own on public.variants_long;
create policy vars_delete_own
on public.variants_long for delete
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

-- Patient tokens (owner only)
drop policy if exists tokens_select_own on public.patient_tokens;
create policy tokens_select_own
on public.patient_tokens for select
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists tokens_insert_own on public.patient_tokens;
create policy tokens_insert_own
on public.patient_tokens for insert
to authenticated
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists tokens_update_own on public.patient_tokens;
create policy tokens_update_own
on public.patient_tokens for update
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()))
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists tokens_delete_own on public.patient_tokens;
create policy tokens_delete_own
on public.patient_tokens for delete
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

-- ---------------------------
-- RPC for token-based follow-up
-- ---------------------------

create or replace function public.create_patient_token(
  p_project_id uuid,
  p_patient_code text,
  p_expires_in_days int default 365
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid;
declare v_token text;
declare v_ok boolean;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  if not exists (select 1 from public.projects p where p.id = p_project_id and p.created_by = v_uid) then
    raise exception 'no_access';
  end if;

  if not exists (select 1 from public.patients_baseline b where b.project_id = p_project_id and b.patient_code = p_patient_code) then
    raise exception 'patient_not_found';
  end if;

  perform public.assert_project_write_allowed(p_project_id);

  -- generate token
 v_token := replace(gen_random_uuid()::text, '-', '');

  insert into public.patient_tokens(project_id, patient_code, token, expires_at, active, created_by)
  values (p_project_id, p_patient_code, v_token, now() + make_interval(days => p_expires_in_days), true, v_uid);

  return v_token;
end;
$$;

grant execute on function public.create_patient_token(uuid, text, int) to authenticated;

-- DROP first: CREATE OR REPLACE cannot change OUT parameter set
drop function if exists public.patient_get_context(text);
create or replace function public.patient_get_context(p_token text)
returns table (
  project_id uuid,
  project_name text,
  center_code text,
  module text,
  patient_code text,
  sex text,
  birth_year int,
  trial_expires_at timestamptz,
  trial_grace_until timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    p.id as project_id,
    p.name as project_name,
    p.center_code,
    p.module,
    t.patient_code,
    b.sex,
    b.birth_year,
    p.trial_expires_at,
    p.trial_grace_until
  from public.patient_tokens t
  join public.projects p on p.id = t.project_id
  left join public.patients_baseline b
    on b.project_id = t.project_id and b.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  limit 1;
$$;

grant execute on function public.patient_get_context(text) to anon, authenticated;

drop function if exists public.patient_list_visits(text, int);
create or replace function public.patient_list_visits(
  p_token text,
  p_limit int default 30
)
returns table (
  visit_date date,
  sbp numeric,
  dbp numeric,
  scr_umol_l numeric,
  upcr numeric,
  egfr numeric,
  notes text,
  created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    v.visit_date,
    v.sbp,
    v.dbp,
    v.scr_umol_l,
    v.upcr,
    v.egfr,
    v.notes,
    v.created_at
  from public.patient_tokens t
  join public.visits_long v
    on v.project_id = t.project_id and v.patient_code = t.patient_code
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  order by v.visit_date desc nulls last, v.created_at desc
  limit greatest(1, least(p_limit, 100));
$$;

grant execute on function public.patient_list_visits(text, int) to anon, authenticated;

create or replace function public.patient_submit_visit(
  p_token text,
  p_visit_date date,
  p_sbp numeric,
  p_dbp numeric,
  p_scr_umol_l numeric,
  p_upcr numeric,
  p_egfr numeric,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_project_id uuid;
declare v_patient_code text;
declare v_visit_id uuid;
begin
  select t.project_id, t.patient_code into v_project_id, v_patient_code
  from public.patient_tokens t
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > now())
  limit 1;

  if v_project_id is null then
    raise exception 'token_invalid_or_expired';
  end if;

  perform public.assert_project_write_allowed(v_project_id);

  insert into public.visits_long(project_id, patient_code, visit_date, sbp, dbp, scr_umol_l, upcr, egfr, notes)
  values (v_project_id, v_patient_code, p_visit_date, p_sbp, p_dbp, p_scr_umol_l, p_upcr, p_egfr, left(p_notes, 500))
  returning id into v_visit_id;

  return v_visit_id;
end;
$$;

grant execute on function public.patient_submit_visit(text, date, numeric, numeric, numeric, numeric, numeric, text) to anon, authenticated;

-- END
-- Migration 0002: Add CHECK constraints for clinical value ranges
-- Prevents obviously erroneous data from being stored.
-- DROP first to make this idempotent on re-runs.

-- visits_long: blood pressure and renal function ranges
alter table public.visits_long
  drop constraint if exists visits_sbp_range,
  drop constraint if exists visits_dbp_range,
  drop constraint if exists visits_scr_range,
  drop constraint if exists visits_egfr_range,
  drop constraint if exists visits_upcr_range;

alter table public.visits_long
  add constraint visits_sbp_range  check (sbp  is null or (sbp  between 40  and 300)),
  add constraint visits_dbp_range  check (dbp  is null or (dbp  between 20  and 200)),
  add constraint visits_scr_range  check (scr_umol_l is null or (scr_umol_l between 10 and 5000)),
  add constraint visits_egfr_range check (egfr is null or (egfr between 0  and 200)),
  add constraint visits_upcr_range check (upcr is null or upcr >= 0);

-- patients_baseline: birth_year and baseline lab ranges
alter table public.patients_baseline
  drop constraint if exists baseline_birth_year_range,
  drop constraint if exists baseline_scr_range,
  drop constraint if exists baseline_upcr_range;

alter table public.patients_baseline
  add constraint baseline_birth_year_range check (birth_year is null or (birth_year between 1900 and 2100)),
  add constraint baseline_scr_range  check (baseline_scr  is null or (baseline_scr  between 10 and 5000)),
  add constraint baseline_upcr_range check (baseline_upcr is null or baseline_upcr >= 0);
-- KidneySphere AI — Phase 1 Migration
-- Adds events_long table: clinical endpoints (computed + manual)
-- Event types: egfr_decline_40pct | egfr_decline_57pct | esrd | death |
--              complete_remission | partial_remission | custom

-- ---------------------------
-- Table
-- ---------------------------

create table if not exists public.events_long (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,

  -- Endpoint classification
  event_type text not null,        -- see valid types above
  event_date date,
  confirmed boolean not null default true,
  source text not null default 'manual', -- 'computed' | 'manual'
  notes text,

  created_by uuid,
  created_at timestamptz not null default now(),

  constraint events_long_event_type_check check (
    event_type in (
      'egfr_decline_40pct',
      'egfr_decline_57pct',
      'esrd',
      'death',
      'complete_remission',
      'partial_remission',
      'custom'
    )
  )
);

create index if not exists events_long_project_patient_idx
  on public.events_long(project_id, patient_code);

create index if not exists events_long_event_type_idx
  on public.events_long(project_id, event_type);

-- ---------------------------
-- created_by trigger
-- ---------------------------

drop trigger if exists tr_events_created_by on public.events_long;
create trigger tr_events_created_by
before insert on public.events_long
for each row execute function public._set_created_by();

-- ---------------------------
-- Trial write lock
-- ---------------------------

drop trigger if exists tr_events_trial_lock on public.events_long;
create trigger tr_events_trial_lock
before insert or update or delete on public.events_long
for each row execute function public._trial_block_write();

-- ---------------------------
-- RLS
-- ---------------------------

alter table public.events_long enable row level security;

drop policy if exists events_select_own on public.events_long;
create policy events_select_own
on public.events_long for select
to authenticated
using (exists (
  select 1 from public.projects p
  where p.id = project_id and p.created_by = auth.uid()
));

drop policy if exists events_insert_own on public.events_long;
create policy events_insert_own
on public.events_long for insert
to authenticated
with check (exists (
  select 1 from public.projects p
  where p.id = project_id and p.created_by = auth.uid()
));

drop policy if exists events_update_own on public.events_long;
create policy events_update_own
on public.events_long for update
to authenticated
using (exists (
  select 1 from public.projects p
  where p.id = project_id and p.created_by = auth.uid()
))
with check (exists (
  select 1 from public.projects p
  where p.id = project_id and p.created_by = auth.uid()
));

drop policy if exists events_delete_own on public.events_long;
create policy events_delete_own
on public.events_long for delete
to authenticated
using (exists (
  select 1 from public.projects p
  where p.id = project_id and p.created_by = auth.uid()
));

-- END
-- KidneySphere AI — Subscription Model (v3)
--
-- Changes:
--   1. Trial period: 56 days → 90 days (3 months)
--      Grace period: 70 days → 100 days (10-day buffer after trial)
--   2. Add subscription_plan + subscription_active_until to projects
--   3. Update assert_project_write_allowed() to allow paid subscribers
--   4. Add admin_set_subscription() RPC (service-role only)
--
-- Subscription plans:
--   'trial'       — default; write access until trial_expires_at
--   'pro'         — paid individual/lab plan
--   'institution' — paid multi-center plan
--
-- Write-access rules (any one of):
--   A. trial_enabled = false  (admin override)
--   B. plan IN ('pro','institution') AND active_until IS NULL OR active_until > now()
--   C. plan = 'trial' AND now() <= trial_expires_at
--
-- After trial + grace: data is NEVER deleted. Researchers can still READ and
-- download their data. Paying restores write access immediately.
-- ---------------------------

-- ---------------------------
-- 1. Extend trial defaults for NEW projects
-- ---------------------------

ALTER TABLE public.projects
  ALTER COLUMN trial_expires_at SET DEFAULT (now() + interval '90 days'),
  ALTER COLUMN trial_grace_until SET DEFAULT (now() + interval '100 days');

-- ---------------------------
-- 2. Backfill existing projects that haven't expired yet
--    (extend their trial proportionally to 90 days from started_at)
-- ---------------------------

UPDATE public.projects
SET
  trial_expires_at  = trial_started_at + interval '90 days',
  trial_grace_until = trial_started_at + interval '100 days'
WHERE
  trial_enabled = true
  AND now() < (trial_started_at + interval '90 days');

-- ---------------------------
-- 3. Add subscription columns
-- ---------------------------

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS subscription_plan text NOT NULL DEFAULT 'trial',
  ADD COLUMN IF NOT EXISTS subscription_active_until timestamptz;

ALTER TABLE public.projects
  DROP CONSTRAINT IF EXISTS subscription_plan_check;
ALTER TABLE public.projects
  ADD CONSTRAINT subscription_plan_check
    CHECK (subscription_plan IN ('trial', 'pro', 'institution'));

-- ---------------------------
-- 4. Update write-lock function
-- ---------------------------

CREATE OR REPLACE FUNCTION public.assert_project_write_allowed(p_project_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trial_enabled          boolean;
  v_trial_expires          timestamptz;
  v_subscription_plan      text;
  v_subscription_until     timestamptz;
BEGIN
  SELECT
    trial_enabled,
    trial_expires_at,
    subscription_plan,
    subscription_active_until
  INTO
    v_trial_enabled,
    v_trial_expires,
    v_subscription_plan,
    v_subscription_until
  FROM public.projects
  WHERE id = p_project_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_not_found';
  END IF;

  -- Rule A: trial restriction disabled by admin
  IF NOT v_trial_enabled THEN
    RETURN;
  END IF;

  -- Rule B: active paid subscription
  IF v_subscription_plan IN ('pro', 'institution') THEN
    IF v_subscription_until IS NULL OR v_subscription_until > now() THEN
      RETURN;
    END IF;
    -- Paid plan has expired → fall through to trial check
  END IF;

  -- Rule C: within trial period
  IF v_trial_expires IS NOT NULL AND now() <= v_trial_expires THEN
    RETURN;
  END IF;

  -- Nothing matched → block write
  RAISE EXCEPTION 'subscription_required';
END;
$$;

-- ---------------------------
-- 5. Admin RPC: activate / extend subscription
--    Must be called with service_role key (server-side only).
-- ---------------------------

CREATE OR REPLACE FUNCTION public.admin_set_subscription(
  p_project_id      uuid,
  p_plan            text,
  p_active_until    timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_role text;
BEGIN
  v_session_role := current_setting('role', true);

  -- Allowed callers:
  --   'service_role'    → Supabase service-role key (server-side / Edge Functions)
  --   'supabase_admin'  → Supabase internal admin
  --   'postgres'        → SQL Editor (superuser, trusted admin access)
  -- All other roles (authenticated, anon) are blocked unless they own the project.
  IF v_session_role NOT IN ('service_role', 'supabase_admin', 'postgres') THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.projects
      WHERE id = p_project_id AND created_by = auth.uid()
    ) THEN
      RAISE EXCEPTION 'admin_only';
    END IF;
  END IF;

  IF p_plan NOT IN ('trial', 'pro', 'institution') THEN
    RAISE EXCEPTION 'invalid_plan: %. Must be one of: trial, pro, institution', p_plan;
  END IF;

  UPDATE public.projects
  SET
    subscription_plan         = p_plan,
    subscription_active_until = p_active_until
  WHERE id = p_project_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_not_found: %', p_project_id;
  END IF;
END;
$$;

-- Usage example (run in Supabase SQL Editor):
--
--   SELECT public.admin_set_subscription(
--     'your-project-uuid'::uuid,
--     'pro'::text,
--     (now() + interval '1 year')::timestamptz
--   );
--
-- To find project UUIDs:
--   SELECT id, name, center_code, subscription_plan FROM public.projects;

GRANT EXECUTE ON FUNCTION public.admin_set_subscription(uuid, text, timestamptz)
  TO authenticated;

-- ---------------------------
-- 6. Expose subscription fields via patient_get_context
--    (so patient follow-up links also respect subscription state)
-- ---------------------------

-- Must DROP first: return type changed (added subscription_plan, subscription_active_until).
-- CREATE OR REPLACE cannot change OUT parameter set.
DROP FUNCTION IF EXISTS public.patient_get_context(text);

CREATE OR REPLACE FUNCTION public.patient_get_context(p_token text)
RETURNS TABLE (
  project_id              uuid,
  project_name            text,
  center_code             text,
  module                  text,
  patient_code            text,
  sex                     text,
  birth_year              int,
  trial_expires_at        timestamptz,
  trial_grace_until       timestamptz,
  subscription_plan       text,
  subscription_active_until timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id                       AS project_id,
    p.name                     AS project_name,
    p.center_code,
    p.module,
    t.patient_code,
    b.sex,
    b.birth_year,
    p.trial_expires_at,
    p.trial_grace_until,
    p.subscription_plan,
    p.subscription_active_until
  FROM public.patient_tokens t
  JOIN public.projects p ON p.id = t.project_id
  LEFT JOIN public.patients_baseline b
    ON b.project_id = t.project_id AND b.patient_code = t.patient_code
  WHERE t.token = p_token
    AND t.active = true
    AND (t.expires_at IS NULL OR t.expires_at > now())
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.patient_get_context(text) TO anon, authenticated;

-- END
