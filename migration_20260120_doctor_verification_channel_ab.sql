-- KidneySphere - Doctor Verification (Channel A + Channel B)
--
-- Channel A: Invite code instant verification
-- Channel B: Manual verification request (upload doc) + admin review
--
-- IMPORTANT:
-- 1) Run this in Supabase SQL Editor (as postgres).
-- 2) Safe to re-run (idempotent). Designed to patch partial/older deployments.
-- 3) After running, go to Settings → API → "Reload schema".
--    (Or run: NOTIFY pgrst, 'reload schema';)
--
-- Why this v2 exists:
-- - Fix "column method does not exist" by ensuring columns are added BEFORE indexes.
-- - Fix "input parameters after one with a default value" by adding defaults.
-- - Fix invite-code verification not persisting after refresh by UPSERT-ing profiles
--   (create profile row if missing) instead of UPDATE-only.

begin;

-- 0) Columns on profiles to store doctor info
alter table if exists public.profiles
  add column if not exists doctor_hospital text,
  add column if not exists doctor_department text,
  add column if not exists doctor_title text,
  add column if not exists doctor_verified_at timestamptz;

-- 1) Invite codes table (admin-managed)
create table if not exists public.doctor_invite_codes (
  code text primary key,
  active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  max_uses integer,
  used_count integer not null default 0
);
alter table public.doctor_invite_codes enable row level security;

drop policy if exists doctor_invite_codes_admin_all on public.doctor_invite_codes;
create policy doctor_invite_codes_admin_all
  on public.doctor_invite_codes
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Seed a default code (PLEASE change it before production)
insert into public.doctor_invite_codes(code, note)
values ('DOCTOR2026', '默认邀请码（请在上线前修改/替换）')
on conflict (code) do nothing;

-- 2) Verification records (audit + status)
-- NOTE: For compatibility, we always (a) create table if missing,
--       (b) add missing columns BEFORE creating indexes.
create table if not exists public.doctor_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  real_name text not null,
  hospital text not null,
  department text,
  title text,
  invite_code text,
  method text not null default 'invite', -- invite | manual
  status text not null default 'approved', -- approved | pending | rejected
  document_bucket text,
  document_path text,
  document_name text,
  document_type text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz,
  verified_by uuid references auth.users(id) on delete set null,
  note text
);

-- Add missing columns if table existed before (older deployments)
alter table if exists public.doctor_verifications
  add column if not exists real_name text,
  add column if not exists hospital text,
  add column if not exists department text,
  add column if not exists title text,
  add column if not exists invite_code text,
  add column if not exists method text,
  add column if not exists status text,
  add column if not exists document_bucket text,
  add column if not exists document_path text,
  add column if not exists document_name text,
  add column if not exists document_type text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid references auth.users(id) on delete set null,
  add column if not exists note text;

alter table public.doctor_verifications enable row level security;

-- Indexes (after columns exist)
create unique index if not exists doctor_verifications_user_id_ux on public.doctor_verifications(user_id);
create index if not exists doctor_verifications_status_idx on public.doctor_verifications(status);
create index if not exists doctor_verifications_method_idx on public.doctor_verifications(method);

-- Read: self or admin
drop policy if exists doctor_verifications_select_self on public.doctor_verifications;
create policy doctor_verifications_select_self
  on public.doctor_verifications
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- 3) Helper: is doctor verified?
-- Use SECURITY DEFINER so it works reliably inside RLS policies.
create or replace function public.is_doctor_verified()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role,'')) in (
        'owner','super_admin','admin',
        'doctor_verified','doctor'
      )
  );
$$;

-- 4) Storage bucket for manual verification documents (private)
--    Path convention: {user_id}/{timestamp}_{filename}
insert into storage.buckets (id, name, public)
values ('doctor_verification', 'doctor_verification', false)
on conflict (id) do update set public = false;

-- Policies on storage.objects for this bucket
-- Allow user to upload into their own folder
drop policy if exists doctor_verification_insert_own on storage.objects;
create policy doctor_verification_insert_own
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'doctor_verification'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- Allow user (own folder) or admin to read
drop policy if exists doctor_verification_select_own_or_admin on storage.objects;
create policy doctor_verification_select_own_or_admin
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'doctor_verification'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or public.is_admin()
    )
  );

-- Allow user (own folder) or admin to delete
drop policy if exists doctor_verification_delete_own_or_admin on storage.objects;
create policy doctor_verification_delete_own_or_admin
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'doctor_verification'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or public.is_admin()
    )
  );

-- Allow user (own folder) or admin to update metadata (rare)
drop policy if exists doctor_verification_update_own_or_admin on storage.objects;
create policy doctor_verification_update_own_or_admin
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'doctor_verification'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or public.is_admin()
    )
  )
  with check (
    bucket_id = 'doctor_verification'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or public.is_admin()
    )
  );

-- 5) RPC: verify with invite code (Channel A)
create or replace function public.verify_doctor_with_code(
  invite_code text,
  real_name text,
  hospital text,
  department text default null,
  title text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  ts timestamptz := now();
  already_verified boolean := false;
  ok_code record;
  dep text;
  ttl text;
  will_increment boolean := false;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'not authenticated';
  end if;

  already_verified := public.is_doctor_verified();

  if real_name is null or length(trim(real_name)) < 2 then
    raise exception '请填写真实姓名';
  end if;
  if hospital is null or length(trim(hospital)) < 2 then
    raise exception '请填写单位/医院';
  end if;

  dep := nullif(trim(department), '');
  ttl := nullif(trim(title), '');

  if not already_verified then
    if invite_code is null or length(trim(invite_code)) < 4 then
      raise exception '请输入邀请码';
    end if;

    select * into ok_code
    from public.doctor_invite_codes c
    where c.code = trim(invite_code)
      and c.active = true
      and (c.expires_at is null or c.expires_at > ts)
      and (c.max_uses is null or c.used_count < c.max_uses)
    limit 1;

    if not found then
      raise exception '邀请码无效或已过期';
    end if;

    will_increment := true;

    -- IMPORTANT: UPSERT profile (some older accounts might not have a profiles row)
    insert into public.profiles (
      id, role, full_name,
      doctor_hospital, doctor_department, doctor_title,
      doctor_verified_at, updated_at
    )
    values (
      uid, 'doctor_verified', trim(real_name),
      trim(hospital), dep, ttl,
      ts, ts
    )
    on conflict (id) do update
      set role = 'doctor_verified',
          full_name = case when coalesce(trim(public.profiles.full_name),'') = '' then trim(real_name) else public.profiles.full_name end,
          doctor_hospital = trim(hospital),
          doctor_department = dep,
          doctor_title = ttl,
          doctor_verified_at = ts,
          updated_at = ts;

  else
    -- Already verified/admin: only update stored info; also ensure row exists
    insert into public.profiles (
      id, full_name,
      doctor_hospital, doctor_department, doctor_title,
      updated_at
    )
    values (
      uid, trim(real_name),
      trim(hospital), dep, ttl,
      ts
    )
    on conflict (id) do update
      set full_name = case when coalesce(trim(public.profiles.full_name),'') = '' then trim(real_name) else public.profiles.full_name end,
          doctor_hospital = trim(hospital),
          doctor_department = dep,
          doctor_title = ttl,
          updated_at = ts;
  end if;

  -- Upsert audit record
  insert into public.doctor_verifications(
    user_id, real_name, hospital, department, title,
    invite_code, method, status,
    created_at, reviewed_at, reviewed_by,
    verified_at, verified_by,
    note
  )
  values (
    uid, trim(real_name), trim(hospital), dep, ttl,
    nullif(trim(invite_code),''), 'invite', 'approved',
    ts, ts, uid,
    ts, uid,
    null
  )
  on conflict (user_id) do update
    set real_name = excluded.real_name,
        hospital = excluded.hospital,
        department = excluded.department,
        title = excluded.title,
        invite_code = excluded.invite_code,
        method = 'invite',
        status = 'approved',
        reviewed_at = ts,
        reviewed_by = uid,
        verified_at = ts,
        verified_by = uid,
        note = null,
        document_bucket = null,
        document_path = null,
        document_name = null,
        document_type = null;

  if will_increment then
    update public.doctor_invite_codes
      set used_count = used_count + 1
      where code = trim(invite_code);
  end if;

  return json_build_object('ok', true, 'role', 'doctor_verified', 'verified_at', ts);
end;
$$;

revoke all on function public.verify_doctor_with_code(text, text, text, text, text) from public;
grant execute on function public.verify_doctor_with_code(text, text, text, text, text) to authenticated;

-- 6) RPC: manual verification request (Channel B)
-- FIX: document_bucket/document_path must have defaults because department/title already have defaults.
create or replace function public.request_doctor_verification_manual(
  real_name text,
  hospital text,
  department text default null,
  title text default null,
  document_bucket text default null,
  document_path text default null,
  document_name text default null,
  document_type text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  ts timestamptz := now();
  dep text;
  ttl text;
  cur_role text;
begin
  uid := auth.uid();
  if uid is null then
    raise exception 'not authenticated';
  end if;

  if real_name is null or length(trim(real_name)) < 2 then
    raise exception '请填写真实姓名';
  end if;
  if hospital is null or length(trim(hospital)) < 2 then
    raise exception '请填写单位/医院';
  end if;
  if document_bucket is null or length(trim(document_bucket)) < 2 then
    raise exception '请上传证明材料';
  end if;
  if document_path is null or length(trim(document_path)) < 2 then
    raise exception '请上传证明材料';
  end if;

  dep := nullif(trim(department), '');
  ttl := nullif(trim(title), '');

  select lower(coalesce(role,'')) into cur_role
  from public.profiles
  where id = uid;

  -- Ensure profile row exists + update info; mark pending if user is a normal member
  insert into public.profiles(
    id, full_name,
    doctor_hospital, doctor_department, doctor_title,
    role, updated_at
  )
  values (
    uid, trim(real_name),
    trim(hospital), dep, ttl,
    case
      when coalesce(cur_role,'') in ('', 'member', 'user') then 'doctor_pending'
      when coalesce(cur_role,'') = 'doctor_pending' then 'doctor_pending'
      else cur_role
    end,
    ts
  )
  on conflict (id) do update
    set full_name = case when coalesce(trim(public.profiles.full_name),'') = '' then trim(real_name) else public.profiles.full_name end,
        doctor_hospital = trim(hospital),
        doctor_department = dep,
        doctor_title = ttl,
        updated_at = ts,
        role = case
                when lower(coalesce(public.profiles.role,'')) in ('', 'member', 'user') then 'doctor_pending'
                when lower(coalesce(public.profiles.role,'')) = 'doctor_pending' then 'doctor_pending'
                else public.profiles.role
              end;

  insert into public.doctor_verifications(
    user_id, real_name, hospital, department, title,
    invite_code, method, status,
    document_bucket, document_path, document_name, document_type,
    created_at, reviewed_at, reviewed_by, verified_at, verified_by, note
  )
  values (
    uid, trim(real_name), trim(hospital), dep, ttl,
    null, 'manual', 'pending',
    trim(document_bucket), trim(document_path), nullif(trim(document_name),''), nullif(trim(document_type),''),
    ts, null, null, null, null, null
  )
  on conflict (user_id) do update
    set real_name = excluded.real_name,
        hospital = excluded.hospital,
        department = excluded.department,
        title = excluded.title,
        invite_code = null,
        method = 'manual',
        status = 'pending',
        document_bucket = excluded.document_bucket,
        document_path = excluded.document_path,
        document_name = excluded.document_name,
        document_type = excluded.document_type,
        created_at = ts,
        reviewed_at = null,
        reviewed_by = null,
        verified_at = null,
        verified_by = null,
        note = null;

  return json_build_object('ok', true, 'status', 'pending', 'submitted_at', ts);
end;
$$;

revoke all on function public.request_doctor_verification_manual(text, text, text, text, text, text, text, text) from public;
grant execute on function public.request_doctor_verification_manual(text, text, text, text, text, text, text, text) to authenticated;

-- 7) RPC: admin review manual verification
create or replace function public.admin_review_doctor_verification(
  target_user_id uuid,
  approve boolean,
  note text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  ts timestamptz := now();
  admin_uid uuid;
  cur_role text;
begin
  admin_uid := auth.uid();
  if admin_uid is null then
    raise exception 'not authenticated';
  end if;
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if target_user_id is null then
    raise exception 'missing user';
  end if;

  select lower(coalesce(role,'')) into cur_role
  from public.profiles
  where id = target_user_id;

  if approve then
    -- Ensure profile exists + upgrade to doctor_verified if not admin
    insert into public.profiles(id, role, doctor_verified_at, updated_at)
    values (target_user_id, 'doctor_verified', ts, ts)
    on conflict (id) do update
      set role = case
                  when lower(coalesce(public.profiles.role,'')) in ('owner','super_admin','admin') then public.profiles.role
                  else 'doctor_verified'
                end,
          doctor_verified_at = ts,
          updated_at = ts;

    update public.doctor_verifications
      set status = 'approved',
          reviewed_at = ts,
          reviewed_by = admin_uid,
          verified_at = ts,
          verified_by = admin_uid,
          note = note
      where user_id = target_user_id;

    return json_build_object('ok', true, 'status', 'approved', 'verified_at', ts);

  else
    -- Reject: revert doctor_pending back to member (do not touch other roles)
    update public.profiles
      set role = case when lower(coalesce(role,'')) = 'doctor_pending' then 'member' else role end,
          updated_at = ts
      where id = target_user_id;

    update public.doctor_verifications
      set status = 'rejected',
          reviewed_at = ts,
          reviewed_by = admin_uid,
          verified_at = null,
          verified_by = null,
          note = note
      where user_id = target_user_id;

    return json_build_object('ok', true, 'status', 'rejected', 'reviewed_at', ts);
  end if;
end;
$$;

revoke all on function public.admin_review_doctor_verification(uuid, boolean, text) from public;
grant execute on function public.admin_review_doctor_verification(uuid, boolean, text) to authenticated;

-- 8) Enforce: only verified doctors can publish cases and reply in case discussions
-- Cases insert
DROP POLICY IF EXISTS cases_insert_authed ON public.cases;
CREATE POLICY cases_insert_authed
  ON public.cases
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = author_id
    AND public.is_doctor_verified()
  );

-- Case comments insert
DROP POLICY IF EXISTS comments_insert_authed ON public.case_comments;
CREATE POLICY comments_insert_authed
  ON public.case_comments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = author_id
    AND public.is_doctor_verified()
    AND EXISTS (SELECT 1 FROM public.cases c WHERE c.id = case_id)
  );

-- Attachments: require doctor verified for Case/Case Comment
DROP POLICY IF EXISTS attachments_insert_own ON public.attachments;
CREATE POLICY attachments_insert_own
  ON public.attachments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = author_id
    AND (
      target_type NOT IN ('case', 'case_comment')
      OR public.is_doctor_verified()
    )
  );

commit;
