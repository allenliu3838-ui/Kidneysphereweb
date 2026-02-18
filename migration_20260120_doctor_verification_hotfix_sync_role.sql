-- KidneySphereAI / KidneySphere
-- HOTFIX: Doctor verification record exists, but UI role stays "Member" after refresh
-- ("医生认证" menu not ✅ / role not green).
--
-- Run this ONCE in Supabase SQL Editor (Role: postgres), then:
--   Settings -> API -> Reload schema
--
-- Safe to re-run (idempotent).

begin;

-- 1) Ensure doctor_verifications has the columns used by newer code
alter table if exists public.doctor_verifications
  add column if not exists method text,
  add column if not exists status text,
  add column if not exists invite_code text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists reviewed_at timestamptz,
  add column if not exists verified_at timestamptz,
  add column if not exists note text;

-- 2) Normalize existing rows (best-effort)
-- Method: if invite_code exists -> invite_code; else manual
update public.doctor_verifications
set method = case
  when method is not null and btrim(method) <> '' then method
  when invite_code is not null and btrim(invite_code) <> '' then 'invite_code'
  else 'manual'
end
where method is null or btrim(method) = '';

-- Status: invite_code -> approved; otherwise pending
update public.doctor_verifications
set status = case
  when status is not null and btrim(status) <> '' then status
  when method = 'invite_code' then 'approved'
  else 'pending'
end
where status is null or btrim(status) = '';

-- 3) Ensure profiles has doctor-related columns
alter table if exists public.profiles
  add column if not exists doctor_hospital text,
  add column if not exists doctor_department text,
  add column if not exists doctor_title text,
  add column if not exists doctor_verified_at timestamptz;

-- 4) Backfill profiles rows for users who have an approved verification but no profile row
insert into public.profiles (id, full_name, role, doctor_hospital, doctor_department, doctor_title, doctor_verified_at)
select
  dv.user_id,
  dv.real_name,
  'doctor_verified',
  dv.hospital,
  dv.department,
  dv.title,
  coalesce(dv.verified_at, dv.created_at, now())
from public.doctor_verifications dv
left join public.profiles p on p.id = dv.user_id
where p.id is null
  and lower(coalesce(dv.status, '')) = 'approved';

-- 5) Sync existing profiles.role to doctor_verified when verification is approved
update public.profiles p
set
  role = 'doctor_verified',
  full_name = case
    when coalesce(btrim(p.full_name), '') = '' then dv.real_name
    else p.full_name
  end,
  doctor_hospital = coalesce(nullif(btrim(p.doctor_hospital), ''), dv.hospital),
  doctor_department = coalesce(nullif(btrim(p.doctor_department), ''), dv.department),
  doctor_title = coalesce(nullif(btrim(p.doctor_title), ''), dv.title),
  doctor_verified_at = coalesce(p.doctor_verified_at, dv.verified_at, dv.created_at, now()),
  updated_at = now()
from public.doctor_verifications dv
where dv.user_id = p.id
  and lower(coalesce(dv.status, '')) = 'approved'
  and lower(coalesce(p.role, '')) not in (
    'owner','super_admin','admin',
    'doctor_verified','doctor'
  );

-- 6) Make is_doctor_verified robust (profiles role OR approved verification record)
create or replace function public.is_doctor_verified()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and lower(coalesce(p.role,'')) in (
          'owner','super_admin','admin',
          'doctor_verified','doctor'
        )
    )
    or exists (
      select 1
      from public.doctor_verifications dv
      where dv.user_id = auth.uid()
        and lower(coalesce(dv.status,'')) = 'approved'
    )
  );
$$;

commit;
