-- MIGRATION_20260122_ADMIN_ROLE_HELPERS_HOTFIX.sql
-- Hotfix: normalize role strings (trim/lower) and make helper RPCs resilient.
-- Safe to run multiple times.

begin;

-- Normalize existing role values (best-effort).
update public.profiles
set role = lower(trim(role))
where role is not null
  and role <> lower(trim(role));

-- Map common variants to canonical values.
update public.profiles
set role = 'super_admin'
where lower(trim(role)) in ('superadmin','super-admin','super admin');

update public.profiles
set role = 'admin'
where lower(trim(role)) in ('administrator');

-- Admin helper (used by RLS + front-end).
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select exists(
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(trim(coalesce(p.role,''))) in ('admin','super_admin','owner')
  );
$$;

grant execute on function public.is_admin() to anon, authenticated;

-- Super-admin helper.
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select exists(
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(trim(coalesce(p.role,''))) in ('super_admin','owner')
  );
$$;

grant execute on function public.is_super_admin() to anon, authenticated;

-- Doctor-verified helper: moderators/admins are treated as verified.
create or replace function public.is_doctor_verified()
returns boolean
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(trim(coalesce(p.role,''))) in ('owner','super_admin','admin','moderator','doctor_verified','doctor')
  );
$$;

grant execute on function public.is_doctor_verified() to anon, authenticated;

commit;

-- After running this migration, please go to:
-- Supabase Dashboard → Settings → API → Reload schema
