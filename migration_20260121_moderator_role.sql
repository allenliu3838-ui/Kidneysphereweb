-- Adds "moderator" role support (UI dropdown + backend allowlist)
-- Safe to run multiple times.

begin;

-- If a previous version of search_doctors() exists with a different RETURN TABLE,
-- Postgres will reject CREATE OR REPLACE (can't change OUT row type).
-- Drop first to make this migration resilient.
drop function if exists public.search_doctors(text, int);

-- 1) Allow moderator in the super_admin role switch RPC
create or replace function public.set_user_role(target_user uuid, new_role text)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  my_role text;
  nr text;
begin
  select lower(coalesce(p.role,'')) into my_role
  from public.profiles p
  where p.id = auth.uid();

  if my_role <> 'super_admin' and my_role <> 'owner' then
    raise exception 'super_admin required';
  end if;

  nr := lower(coalesce(new_role,''));
  if nr not in ('member','moderator','admin','super_admin','owner') then
    raise exception 'invalid role: %', new_role;
  end if;

  update public.profiles
  set role = nr
  where id = target_user;
end;
$$;

grant execute on function public.set_user_role(uuid, text) to authenticated;

-- 2) Treat moderator as "doctor-verified" for posting cases/comments/attachments gates
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
      and lower(coalesce(p.role,'')) in ('owner','super_admin','admin','moderator','doctor_verified','doctor')
  );
$$;

grant execute on function public.is_doctor_verified() to anon, authenticated;

-- 3) Mention picker helper: include moderator in doctor search
create or replace function public.search_doctors(_q text, _limit int default 12)
returns table(
  id uuid,
  full_name text,
  hospital text,
  title text,
  role text
)
language sql
security definer
set search_path = public
set row_security = off
as $$
  select
    p.id,
    p.full_name,
    dv.hospital,
    dv.title,
    p.role
  from public.profiles p
  left join public.doctor_verifications dv on dv.user_id = p.id and dv.status = 'approved'
  where (
      p.full_name ilike '%' || _q || '%'
      or dv.hospital ilike '%' || _q || '%'
      or dv.department ilike '%' || _q || '%'
      or dv.title ilike '%' || _q || '%'
    )
    and lower(coalesce(p.role,'')) in (
      'doctor_verified','doctor','doctor_pending','moderator','admin','super_admin','owner'
    )
  order by
    case lower(coalesce(p.role,''))
      when 'super_admin' then 1
      when 'owner' then 1
      when 'admin' then 2
      when 'moderator' then 3
      when 'doctor_verified' then 4
      when 'doctor' then 4
      when 'doctor_pending' then 5
      else 9
    end,
    p.full_name asc
  limit greatest(1, least(_limit, 50));
$$;

grant execute on function public.search_doctors(text, int) to anon, authenticated;

commit;
