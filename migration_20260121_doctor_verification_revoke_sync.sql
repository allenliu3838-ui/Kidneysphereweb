-- KidneySphereAI / KidneySphere
-- Doctor Verification: Revocation + Deletion + Profile sync (Admin manage)
--
-- Problem fixed
-- - Admin deletes a row in public.doctor_verifications, but the user still shows as "已认证".
--   Root cause: profiles.role stayed doctor_verified.
--
-- What this migration adds
-- 1) Admin RPC to revoke verification (keep audit trail)
-- 2) Admin RPC to hard-delete verification record
-- 3) Triggers to keep profiles.role in sync on UPDATE/DELETE of doctor_verifications
-- 4) One-time sync: downgrade profiles.role=doctor_verified when no approved verification exists
--
-- Run in Supabase SQL Editor (Role: postgres), then Settings -> API -> Reload schema.
-- Safe to re-run (idempotent).

begin;

-- 0) Ensure required columns exist (older deployments)
alter table if exists public.profiles
  add column if not exists doctor_verified_at timestamptz;

alter table if exists public.doctor_verifications
  add column if not exists method text,
  add column if not exists status text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid,
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid,
  add column if not exists note text;

-- Normalize status values if missing
update public.doctor_verifications
set status = case
  when status is not null and btrim(status) <> '' then status
  when lower(coalesce(method,'')) = 'invite_code' then 'approved'
  when invite_code is not null and btrim(invite_code) <> '' then 'approved'
  else 'pending'
end
where status is null or btrim(status) = '';

-- 1) Admin RPC: revoke doctor verification (recommended)
-- Note: parameter name is p_note to avoid ambiguity with column "note".
create or replace function public.admin_revoke_doctor_verification(
  target_user_id uuid,
  p_note text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  ts timestamptz := now();
  admin_uid uuid;
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

  -- Downgrade profile role (do not touch admin roles)
  update public.profiles p
    set role = case
                when lower(coalesce(p.role,'')) in ('owner','super_admin','admin') then p.role
                when lower(coalesce(p.role,'')) in ('doctor_verified','doctor','doctor_pending') then 'member'
                else p.role
              end,
        doctor_verified_at = null,
        updated_at = ts
  where p.id = target_user_id;

  -- Mark verification record as revoked (keeps audit trail)
  update public.doctor_verifications dv
    set status = 'revoked',
        reviewed_at = ts,
        reviewed_by = admin_uid,
        verified_at = null,
        verified_by = null,
        note = p_note
  where dv.user_id = target_user_id;

  return json_build_object('ok', true, 'status', 'revoked', 'revoked_at', ts);
end;
$$;

revoke all on function public.admin_revoke_doctor_verification(uuid, text) from public;
grant execute on function public.admin_revoke_doctor_verification(uuid, text) to authenticated;

-- 2) Admin RPC: hard-delete verification record (use with caution)
create or replace function public.admin_delete_doctor_verification(
  target_user_id uuid
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  ts timestamptz := now();
  admin_uid uuid;
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

  delete from public.doctor_verifications dv
  where dv.user_id = target_user_id;

  -- Extra safety (trigger also does this)
  update public.profiles p
    set role = case
                when lower(coalesce(p.role,'')) in ('owner','super_admin','admin') then p.role
                when lower(coalesce(p.role,'')) in ('doctor_verified','doctor','doctor_pending') then 'member'
                else p.role
              end,
        doctor_verified_at = null,
        updated_at = ts
  where p.id = target_user_id;

  return json_build_object('ok', true, 'deleted', true, 'at', ts);
end;
$$;

revoke all on function public.admin_delete_doctor_verification(uuid) from public;
grant execute on function public.admin_delete_doctor_verification(uuid) to authenticated;

-- 3) Trigger: sync profiles.role when status changes (approve/reject/revoke)
create or replace function public._sync_profile_on_doctor_verification_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  st text;
  ts timestamptz := now();
begin
  st := lower(coalesce(new.status,''));

  -- Approved -> doctor_verified (unless admin)
  if st = 'approved' or st = 'verified' then
    update public.profiles p
      set role = case
                  when lower(coalesce(p.role,'')) in ('owner','super_admin','admin') then p.role
                  else 'doctor_verified'
                end,
          doctor_verified_at = coalesce(p.doctor_verified_at, new.verified_at, new.created_at, ts),
          updated_at = ts
    where p.id = new.user_id;

  -- Pending -> doctor_pending (only promote member/user)
  elsif st = 'pending' then
    update public.profiles p
      set role = case
                  when lower(coalesce(p.role,'')) in ('', 'member', 'user') then 'doctor_pending'
                  else p.role
                end,
          updated_at = ts
    where p.id = new.user_id;

  -- Rejected/Revoked -> member (only downgrade doctor_* roles)
  elsif st in ('rejected','revoked') then
    update public.profiles p
      set role = case
                  when lower(coalesce(p.role,'')) in ('owner','super_admin','admin') then p.role
                  when lower(coalesce(p.role,'')) in ('doctor_verified','doctor','doctor_pending') then 'member'
                  else p.role
                end,
          doctor_verified_at = null,
          updated_at = ts
    where p.id = new.user_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_profile_on_doctor_verification_change on public.doctor_verifications;
create trigger trg_sync_profile_on_doctor_verification_change
after insert or update of status on public.doctor_verifications
for each row
execute function public._sync_profile_on_doctor_verification_change();

-- 4) Trigger: sync profiles.role when verification row is deleted
create or replace function public._sync_profile_on_doctor_verification_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ts timestamptz := now();
begin
  update public.profiles p
    set role = case
                when lower(coalesce(p.role,'')) in ('owner','super_admin','admin') then p.role
                when lower(coalesce(p.role,'')) in ('doctor_verified','doctor','doctor_pending') then 'member'
                else p.role
              end,
        doctor_verified_at = null,
        updated_at = ts
  where p.id = old.user_id;
  return old;
end;
$$;

drop trigger if exists trg_sync_profile_on_doctor_verification_delete on public.doctor_verifications;
create trigger trg_sync_profile_on_doctor_verification_delete
after delete on public.doctor_verifications
for each row
execute function public._sync_profile_on_doctor_verification_delete();

-- 5) One-time sync: if profile says doctor_verified but no approved verification exists, downgrade to member.
-- This fixes the current bug when an admin deleted the verification row directly in Table Editor.
update public.profiles p
set role = 'member',
    doctor_verified_at = null,
    updated_at = now()
where lower(coalesce(p.role,'')) in ('doctor_verified','doctor')
  and lower(coalesce(p.role,'')) not in ('owner','super_admin','admin')
  and not exists (
    select 1
    from public.doctor_verifications dv
    where dv.user_id = p.id
      and lower(coalesce(dv.status,'')) in ('approved','verified')
  );

commit;
