-- P0 Guardrails: strict input validation, PII blocking, server-side audit,
-- update metadata, anti-abuse limits, receipt token, and visit history.

-- 1) Unified updated_at/updated_by metadata (server-side)
create or replace function public._set_updated_meta()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

-- Add columns if missing
alter table public.projects          add column if not exists updated_at timestamptz not null default now();
alter table public.projects          add column if not exists updated_by uuid;
alter table public.patients_baseline add column if not exists updated_at timestamptz not null default now();
alter table public.patients_baseline add column if not exists updated_by uuid;
alter table public.visits_long       add column if not exists updated_at timestamptz not null default now();
alter table public.visits_long       add column if not exists updated_by uuid;
alter table public.labs_long         add column if not exists updated_at timestamptz not null default now();
alter table public.labs_long         add column if not exists updated_by uuid;
alter table public.meds_long         add column if not exists updated_at timestamptz not null default now();
alter table public.meds_long         add column if not exists updated_by uuid;
alter table public.variants_long     add column if not exists updated_at timestamptz not null default now();
alter table public.variants_long     add column if not exists updated_by uuid;
alter table public.patient_tokens    add column if not exists updated_at timestamptz not null default now();
alter table public.patient_tokens    add column if not exists updated_by uuid;

-- Triggers
 drop trigger if exists tr_projects_updated_meta on public.projects;
create trigger tr_projects_updated_meta before update on public.projects
for each row execute function public._set_updated_meta();

drop trigger if exists tr_patients_updated_meta on public.patients_baseline;
create trigger tr_patients_updated_meta before update on public.patients_baseline
for each row execute function public._set_updated_meta();

drop trigger if exists tr_visits_updated_meta on public.visits_long;
create trigger tr_visits_updated_meta before update on public.visits_long
for each row execute function public._set_updated_meta();

drop trigger if exists tr_labs_updated_meta on public.labs_long;
create trigger tr_labs_updated_meta before update on public.labs_long
for each row execute function public._set_updated_meta();

drop trigger if exists tr_meds_updated_meta on public.meds_long;
create trigger tr_meds_updated_meta before update on public.meds_long
for each row execute function public._set_updated_meta();

drop trigger if exists tr_vars_updated_meta on public.variants_long;
create trigger tr_vars_updated_meta before update on public.variants_long
for each row execute function public._set_updated_meta();

drop trigger if exists tr_tokens_updated_meta on public.patient_tokens;
create trigger tr_tokens_updated_meta before update on public.patient_tokens
for each row execute function public._set_updated_meta();

-- 2) PII detection + audit log
create table if not exists public.security_audit_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  project_id uuid,
  patient_code text,
  token_hash text,
  actor_uid uuid,
  event_type text not null,
  severity text not null default 'warn',
  details jsonb not null default '{}'::jsonb
);

create index if not exists security_audit_logs_created_idx on public.security_audit_logs(created_at desc);
create index if not exists security_audit_logs_project_idx on public.security_audit_logs(project_id, created_at desc);

alter table public.security_audit_logs enable row level security;

drop policy if exists sec_audit_select_own on public.security_audit_logs;
create policy sec_audit_select_own
on public.security_audit_logs for select
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

create or replace function public._contains_pii(p_text text)
returns boolean
language plpgsql
immutable
as $$
declare
  v text;
begin
  if p_text is null then
    return false;
  end if;
  v := lower(trim(p_text));
  if v = '' then
    return false;
  end if;

  -- China mobile phone (11 digits, common prefixes)
  if v ~ '(?:^|\D)1[3-9][0-9]{9}(?:\D|$)' then return true; end if;
  -- China ID (18)
  if v ~ '(?:^|\D)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9xX](?:\D|$)' then return true; end if;
  -- MRN / 病案号 / 住院号 keywords + id-like tail
  if v ~ '(mrn|病案号|住院号|门诊号|身份证|phone|手机号|电话)' then return true; end if;
  -- Suspicious long numeric identifier (8+ consecutive digits)
  if v ~ '\d{8,}' then return true; end if;
  -- Chinese personal name-like pattern after explicit label
  if v ~ '(姓名|患者|病人)[:： ]?[\x{4e00}-\x{9fa5}]{2,4}' then return true; end if;

  return false;
end;
$$;

-- 3) Visit history for admin traceability
create table if not exists public.visits_long_history (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null,
  project_id uuid not null,
  patient_code text not null,
  action text not null,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  old_row jsonb,
  new_row jsonb
);

create index if not exists visits_hist_visit_idx on public.visits_long_history(visit_id, changed_at desc);
create index if not exists visits_hist_project_idx on public.visits_long_history(project_id, changed_at desc);

alter table public.visits_long_history enable row level security;

drop policy if exists visits_hist_select_own on public.visits_long_history;
create policy visits_hist_select_own
on public.visits_long_history for select
to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

create or replace function public._audit_visits_long_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    insert into public.visits_long_history(visit_id, project_id, patient_code, action, changed_by, old_row, new_row)
    values (new.id, new.project_id, new.patient_code, 'UPDATE', auth.uid(), to_jsonb(old), to_jsonb(new));
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.visits_long_history(visit_id, project_id, patient_code, action, changed_by, old_row, new_row)
    values (old.id, old.project_id, old.patient_code, 'DELETE', auth.uid(), to_jsonb(old), null);
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists tr_visits_history on public.visits_long;
create trigger tr_visits_history
after update or delete on public.visits_long
for each row execute function public._audit_visits_long_changes();

-- 4) Receipt token (no PII/clinical payload)
create table if not exists public.visit_receipts (
  visit_id uuid primary key references public.visits_long(id) on delete cascade,
  receipt_token text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

drop function if exists public.patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text);
create or replace function public.patient_submit_visit_v2(
  p_token text,
  p_visit_date date,
  p_sbp numeric,
  p_dbp numeric,
  p_scr_umol_l numeric,
  p_upcr numeric,
  p_egfr numeric,
  p_notes text default null
)
returns table (
  visit_id uuid,
  server_time timestamptz,
  receipt_token text,
  receipt_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id uuid;
  v_patient_code text;
  v_visit_id uuid;
  v_now timestamptz := now();
  v_receipt_token text;
  v_receipt_exp timestamptz;
  v_min_count int;
  v_same_day_count int;
begin
  select t.project_id, t.patient_code into v_project_id, v_patient_code
  from public.patient_tokens t
  where t.token = p_token
    and t.active = true
    and (t.expires_at is null or t.expires_at > v_now)
  limit 1;

  if v_project_id is null then
    raise exception 'token_invalid_or_expired';
  end if;

  -- required core fields
  if p_visit_date is null or p_sbp is null or p_dbp is null or p_scr_umol_l is null or p_upcr is null then
    insert into public.security_audit_logs(project_id, patient_code, token_hash, event_type, severity, details)
    values (
      v_project_id,
      v_patient_code,
      encode(digest(coalesce(p_token,''), 'sha256'), 'hex'),
      'visit_submit_blocked_missing_core',
      'warn',
      jsonb_build_object('visit_date', p_visit_date, 'sbp', p_sbp, 'dbp', p_dbp, 'scr_umol_l', p_scr_umol_l, 'upcr', p_upcr)
    );
    raise exception 'missing_core_fields';
  end if;

  -- PII blocking (strict)
  if public._contains_pii(v_patient_code) or public._contains_pii(p_notes) then
    insert into public.security_audit_logs(project_id, patient_code, token_hash, event_type, severity, details)
    values (
      v_project_id,
      v_patient_code,
      encode(digest(coalesce(p_token,''), 'sha256'), 'hex'),
      'pii_detected_blocked',
      'high',
      jsonb_build_object('notes_len', coalesce(length(p_notes),0), 'patient_code', v_patient_code)
    );
    raise exception 'pii_detected_blocked';
  end if;

  -- anti-abuse: per-token/minute
  select count(*)::int into v_min_count
  from public.visits_long v
  where v.project_id = v_project_id
    and v.patient_code = v_patient_code
    and v.created_at > (v_now - interval '1 minute');

  if v_min_count >= 12 then
    update public.patient_tokens set active = false where token = p_token;
    insert into public.security_audit_logs(project_id, patient_code, token_hash, event_type, severity, details)
    values (
      v_project_id,
      v_patient_code,
      encode(digest(coalesce(p_token,''), 'sha256'), 'hex'),
      'token_auto_frozen_rate_limit',
      'high',
      jsonb_build_object('count_1m', v_min_count)
    );
    raise exception 'rate_limited_token_frozen';
  end if;

  select count(*)::int into v_same_day_count
  from public.visits_long v
  where v.project_id = v_project_id
    and v.patient_code = v_patient_code
    and v.visit_date = p_visit_date;

  if v_same_day_count >= 6 then
    update public.patient_tokens set active = false where token = p_token;
    insert into public.security_audit_logs(project_id, patient_code, token_hash, event_type, severity, details)
    values (
      v_project_id,
      v_patient_code,
      encode(digest(coalesce(p_token,''), 'sha256'), 'hex'),
      'token_auto_frozen_same_day_spike',
      'high',
      jsonb_build_object('visit_date', p_visit_date, 'same_day_count', v_same_day_count)
    );
    raise exception 'abnormal_duplicate_spike_token_frozen';
  end if;

  perform public.assert_project_write_allowed(v_project_id);

  insert into public.visits_long(project_id, patient_code, visit_date, sbp, dbp, scr_umol_l, upcr, egfr, notes)
  values (v_project_id, v_patient_code, p_visit_date, p_sbp, p_dbp, p_scr_umol_l, p_upcr, p_egfr, left(p_notes, 500))
  returning id into v_visit_id;

  v_receipt_token := replace(gen_random_uuid()::text, '-', '');
  v_receipt_exp := v_now + interval '24 hours';

  insert into public.visit_receipts(visit_id, receipt_token, expires_at)
  values (v_visit_id, v_receipt_token, v_receipt_exp)
  on conflict (visit_id) do update
    set receipt_token = excluded.receipt_token,
        expires_at = excluded.expires_at;

  insert into public.security_audit_logs(project_id, patient_code, token_hash, actor_uid, event_type, severity, details)
  values (
    v_project_id,
    v_patient_code,
    encode(digest(coalesce(p_token,''), 'sha256'), 'hex'),
    auth.uid(),
    'visit_submit_ok',
    'info',
    jsonb_build_object('visit_id', v_visit_id, 'visit_date', p_visit_date)
  );

  visit_id := v_visit_id;
  server_time := v_now;
  receipt_token := v_receipt_token;
  receipt_expires_at := v_receipt_exp;
  return next;
end;
$$;

grant execute on function public.patient_submit_visit_v2(text, date, numeric, numeric, numeric, numeric, numeric, text) to anon, authenticated;

-- Admin read history helper
drop function if exists public.admin_get_visit_history(uuid, text, int);
create or replace function public.admin_get_visit_history(
  p_project_id uuid,
  p_patient_code text default null,
  p_limit int default 200
)
returns table (
  changed_at timestamptz,
  action text,
  visit_id uuid,
  patient_code text,
  changed_by uuid,
  old_row jsonb,
  new_row jsonb
)
language sql
security definer
set search_path = public
as $$
  select
    h.changed_at,
    h.action,
    h.visit_id,
    h.patient_code,
    h.changed_by,
    h.old_row,
    h.new_row
  from public.visits_long_history h
  where h.project_id = p_project_id
    and (p_patient_code is null or h.patient_code = p_patient_code)
    and exists (
      select 1 from public.projects p
      where p.id = p_project_id and p.created_by = auth.uid()
    )
  order by h.changed_at desc
  limit greatest(1, least(p_limit, 1000));
$$;

grant execute on function public.admin_get_visit_history(uuid, text, int) to authenticated;

-- 5) Admin one-click token revoke
create or replace function public.revoke_patient_token(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project_id uuid;
  v_patient_code text;
begin
  select project_id, patient_code into v_project_id, v_patient_code
  from public.patient_tokens
  where token = p_token
  limit 1;

  if v_project_id is null then
    raise exception 'token_not_found';
  end if;

  if not exists (
    select 1 from public.projects p
    where p.id = v_project_id and p.created_by = auth.uid()
  ) then
    raise exception 'admin_only';
  end if;

  update public.patient_tokens
  set active = false,
      expires_at = least(coalesce(expires_at, now()), now())
  where token = p_token;

  insert into public.security_audit_logs(project_id, patient_code, actor_uid, event_type, severity, details)
  values (
    v_project_id,
    v_patient_code,
    auth.uid(),
    'token_revoked_by_admin',
    'warn',
    jsonb_build_object('token_hash', encode(digest(coalesce(p_token,''), 'sha256'), 'hex'))
  );
end;
$$;

grant execute on function public.revoke_patient_token(text) to authenticated;
-- Snapshot / Export IDs + audit trail + KTx template extension (minimal)

create table if not exists public.project_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_id text not null unique,
  project_id uuid not null references public.projects(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft','locked','deprecated')),
  kind text not null default 'snapshot' check (kind in ('snapshot','paper_package','export')),
  filter_summary jsonb not null default '{}'::jsonb,
  schema_version text not null default 'core_v1',
  n_patients int not null default 0,
  n_visits int not null default 0,
  missing_rate numeric not null default 0,
  qc_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid,
  locked_at timestamptz,
  locked_by uuid,
  notes text
);

create index if not exists project_snapshots_project_created_idx on public.project_snapshots(project_id, created_at desc);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid,
  actor_uid uuid,
  action text not null,
  snapshot_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_project_created_idx on public.audit_log(project_id, created_at desc);

alter table public.project_snapshots enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists snapshots_select_own on public.project_snapshots;
create policy snapshots_select_own on public.project_snapshots
for select to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists audit_select_own on public.audit_log;
create policy audit_select_own on public.audit_log
for select to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

create or replace function public._new_snapshot_code()
returns text
language plpgsql
as $$
declare
  v text;
begin
  v := 'KS-' || to_char(now(),'YYYY') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
  return v;
end;
$$;

drop function if exists public.create_project_snapshot(uuid, text, jsonb, text);
create or replace function public.create_project_snapshot(
  p_project_id uuid,
  p_kind text default 'snapshot',
  p_filter_summary jsonb default '{}'::jsonb,
  p_schema_version text default 'core_v1'
)
returns table (
  id uuid,
  snapshot_id text,
  status text,
  created_at timestamptz,
  n_patients int,
  n_visits int,
  missing_rate numeric,
  qc_summary jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_snapshot_id text;
  v_n_patients int := 0;
  v_n_visits int := 0;
  v_missing_rate numeric := 0;
  v_qc jsonb;
  v_id uuid;
begin
  if not exists (select 1 from public.projects p where p.id = p_project_id and p.created_by = v_uid) then
    raise exception 'admin_only';
  end if;

  if p_kind not in ('snapshot','paper_package','export') then
    raise exception 'invalid_kind';
  end if;

  select count(distinct patient_code) into v_n_patients from public.patients_baseline where project_id = p_project_id;
  select count(*) into v_n_visits from public.visits_long where project_id = p_project_id;

  select jsonb_build_object(
    'visits_missing_sbp', count(*) filter (where sbp is null),
    'visits_missing_dbp', count(*) filter (where dbp is null),
    'visits_missing_scr', count(*) filter (where scr_umol_l is null),
    'visits_missing_upcr', count(*) filter (where upcr is null)
  ) into v_qc
  from public.visits_long
  where project_id = p_project_id;

  if v_n_visits > 0 then
    select (
      ((count(*) filter (where sbp is null or dbp is null or scr_umol_l is null or upcr is null))::numeric / count(*)::numeric) * 100
    ) into v_missing_rate
    from public.visits_long
    where project_id = p_project_id;
  end if;

  v_snapshot_id := public._new_snapshot_code();

  insert into public.project_snapshots(
    snapshot_id, project_id, status, kind, filter_summary, schema_version,
    n_patients, n_visits, missing_rate, qc_summary, created_by
  )
  values (
    v_snapshot_id, p_project_id, 'draft', p_kind, coalesce(p_filter_summary,'{}'::jsonb), p_schema_version,
    v_n_patients, v_n_visits, coalesce(v_missing_rate,0), coalesce(v_qc,'{}'::jsonb), v_uid
  )
  returning project_snapshots.id into v_id;

  insert into public.audit_log(project_id, actor_uid, action, snapshot_id, details)
  values (
    p_project_id,
    v_uid,
    'snapshot_create',
    v_snapshot_id,
    jsonb_build_object('kind', p_kind, 'schema_version', p_schema_version, 'filter_summary', coalesce(p_filter_summary,'{}'::jsonb))
  );

  return query
  select s.id, s.snapshot_id, s.status, s.created_at, s.n_patients, s.n_visits, s.missing_rate, s.qc_summary
  from public.project_snapshots s where s.id = v_id;
end;
$$;

grant execute on function public.create_project_snapshot(uuid, text, jsonb, text) to authenticated;

create or replace function public.list_project_snapshots(p_project_id uuid)
returns setof public.project_snapshots
language sql
security definer
set search_path = public
as $$
  select s.*
  from public.project_snapshots s
  where s.project_id = p_project_id
    and exists (select 1 from public.projects p where p.id = p_project_id and p.created_by = auth.uid())
  order by s.created_at desc;
$$;

grant execute on function public.list_project_snapshots(uuid) to authenticated;

create or replace function public.lock_project_snapshot(p_snapshot_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid;
  v_snapshot text;
begin
  select project_id, snapshot_id into v_project, v_snapshot
  from public.project_snapshots
  where id = p_snapshot_id
  limit 1;

  if v_project is null then
    raise exception 'snapshot_not_found';
  end if;

  if not exists (select 1 from public.projects p where p.id = v_project and p.created_by = auth.uid()) then
    raise exception 'admin_only';
  end if;

  update public.project_snapshots
  set status = 'locked', locked_at = now(), locked_by = auth.uid()
  where id = p_snapshot_id and status <> 'locked';

  insert into public.audit_log(project_id, actor_uid, action, snapshot_id, details)
  values (v_project, auth.uid(), 'snapshot_lock', v_snapshot, '{}'::jsonb);
end;
$$;

grant execute on function public.lock_project_snapshot(uuid) to authenticated;

create or replace function public.log_project_audit(
  p_project_id uuid,
  p_action text,
  p_snapshot_id text default null,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.projects p where p.id = p_project_id and p.created_by = auth.uid()) then
    raise exception 'admin_only';
  end if;

  insert into public.audit_log(project_id, actor_uid, action, snapshot_id, details)
  values (p_project_id, auth.uid(), p_action, p_snapshot_id, coalesce(p_details,'{}'::jsonb));
end;
$$;

grant execute on function public.log_project_audit(uuid, text, text, jsonb) to authenticated;

-- KTx structured extension tables
create table if not exists public.ktx_baseline_ext (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,
  transplant_date date,
  donor_type text,
  induction_therapy text,
  maintenance_immuno jsonb not null default '[]'::jsonb,
  hla_mismatch_count int,
  pra_status text,
  dsa_status text,
  dsa_titer text,
  baseline_creatinine numeric,
  baseline_egfr numeric,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint ktx_baseline_unique unique(project_id, patient_code)
);

create table if not exists public.ktx_visits_ext (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  patient_code text not null,
  visit_date date not null,
  tac_trough numeric,
  csa_trough numeric,
  weight_kg numeric,
  infection_event text,
  rejection_event text,
  biopsy_banff text,
  graft_failure_date date,
  death_date date,
  return_to_dialysis boolean,
  return_to_dialysis_date date,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

alter table public.ktx_baseline_ext enable row level security;
alter table public.ktx_visits_ext enable row level security;

drop policy if exists ktxb_select_own on public.ktx_baseline_ext;
create policy ktxb_select_own on public.ktx_baseline_ext for select to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists ktxb_insert_own on public.ktx_baseline_ext;
create policy ktxb_insert_own on public.ktx_baseline_ext for insert to authenticated
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists ktxb_update_own on public.ktx_baseline_ext;
create policy ktxb_update_own on public.ktx_baseline_ext for update to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()))
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists ktxv_select_own on public.ktx_visits_ext;
create policy ktxv_select_own on public.ktx_visits_ext for select to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists ktxv_insert_own on public.ktx_visits_ext;
create policy ktxv_insert_own on public.ktx_visits_ext for insert to authenticated
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

drop policy if exists ktxv_update_own on public.ktx_visits_ext;
create policy ktxv_update_own on public.ktx_visits_ext for update to authenticated
using (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()))
with check (exists (select 1 from public.projects p where p.id = project_id and p.created_by = auth.uid()));

-- metadata triggers
 drop trigger if exists tr_ktxb_created_by on public.ktx_baseline_ext;
create trigger tr_ktxb_created_by before insert on public.ktx_baseline_ext
for each row execute function public._set_created_by();
drop trigger if exists tr_ktxb_updated_meta on public.ktx_baseline_ext;
create trigger tr_ktxb_updated_meta before update on public.ktx_baseline_ext
for each row execute function public._set_updated_meta();

drop trigger if exists tr_ktxv_created_by on public.ktx_visits_ext;
create trigger tr_ktxv_created_by before insert on public.ktx_visits_ext
for each row execute function public._set_created_by();
drop trigger if exists tr_ktxv_updated_meta on public.ktx_visits_ext;
create trigger tr_ktxv_updated_meta before update on public.ktx_visits_ext
for each row execute function public._set_updated_meta();
-- Demo booking requests table
-- Stores requests submitted via /demo page

create table if not exists demo_requests (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  name        text not null,
  institution text not null,
  department  text,
  email       text not null,
  contact     text,          -- wechat / phone
  use_case    text,          -- IGAN / LN / MN / GENERAL / KTX / OTHER
  message     text,
  status      text not null default 'pending'  -- pending / contacted / done
);

-- Allow anonymous inserts (public form submission)
alter table demo_requests enable row level security;

DROP POLICY IF EXISTS "allow_public_insert" ON demo_requests;
create policy "allow_public_insert" on demo_requests
  for insert to anon with check (true);

-- Only authenticated (staff) can read / update
DROP POLICY IF EXISTS "allow_auth_select" ON demo_requests;
create policy "allow_auth_select" on demo_requests
  for select to authenticated using (true);

DROP POLICY IF EXISTS "allow_auth_update" ON demo_requests;
create policy "allow_auth_update" on demo_requests
  for update to authenticated using (true);
-- KidneySphere AI — Trial Period Update (v7)
--
-- Changes:
--   1. Trial period: 90 days → 30 days
--      Grace period: 100 days → 37 days (7-day buffer after trial)
--   2. Backfill existing projects that haven't expired yet
--
-- Rationale:
--   30 days is sufficient to evaluate the system (core value apparent in 1-2 weeks).
--   Shorter trial creates clearer conversion decision point.
--   7-day grace is enough to export data and decide.
-- ---------------------------

-- ---------------------------
-- 1. Update defaults for NEW projects
-- ---------------------------

ALTER TABLE public.projects
  ALTER COLUMN trial_expires_at  SET DEFAULT (now() + interval '30 days'),
  ALTER COLUMN trial_grace_until SET DEFAULT (now() + interval '37 days');

-- ---------------------------
-- 2. Backfill existing projects that haven't started their trial yet
--    (i.e. still on the old 90-day default, and trial hasn't expired)
--    Only shorten trials that haven't expired yet and were created recently
--    (within the last 30 days — so they haven't already passed the new limit)
-- ---------------------------

UPDATE public.projects
SET
  trial_expires_at  = trial_started_at + interval '30 days',
  trial_grace_until = trial_started_at + interval '37 days'
WHERE
  trial_enabled = true
  AND now() < trial_expires_at
  AND now() < (trial_started_at + interval '30 days');

-- Projects already past 30 days from trial_started_at but still in the old
-- 90-day window are NOT modified — they keep their current expires_at to avoid
-- retroactively shortening an in-progress trial. They will simply expire on
-- their original schedule.

-- END
-- RCT Phase 1：在 patients_baseline 增加随机化字段
-- 观察性队列可全部留空（NULL）；无破坏性变更。

alter table public.patients_baseline
  add column if not exists treatment_arm text,
  add column if not exists randomization_id text,
  add column if not exists randomization_date date,
  add column if not exists stratification_factors jsonb;

comment on column public.patients_baseline.treatment_arm      is '干预组别：intervention（干预组）/ control（对照组）/ placebo（安慰剂组）或自定义；观察性队列留空';
comment on column public.patients_baseline.randomization_id   is '随机号（盲底管理编号）；观察性队列留空';
comment on column public.patients_baseline.randomization_date is '随机化日期；观察性队列留空';
comment on column public.patients_baseline.stratification_factors is '分层因素 JSON，如 {"中心":"BJ01","eGFR分层":"高风险"}；观察性队列留空';
