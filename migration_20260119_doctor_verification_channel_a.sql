-- KidneySphere - Doctor Verification (Channel A: Invite Code)
--
-- What this enables:
-- 1) A simple doctor verification flow using an invite code (no upload required)
-- 2) Verified doctors can publish cases, reply in case discussions, and attach files to cases
-- 3) Enforcement is done via RLS policies (frontend only shows guidance)
--
-- After running this migration:
-- - Add/rotate invite codes in public.doctor_invite_codes
-- - Users can verify at: verify-doctor.html
-- - (Optional) Click "Reload schema" in Supabase Settings → API

begin;

-- 0) Columns on profiles to store doctor info (optional but useful)
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

-- Seed a default code (PLEASE change it)
insert into public.doctor_invite_codes(code, note)
values ('DOCTOR2026', '默认邀请码（请在上线前修改/替换）')
on conflict (code) do nothing;

-- 2) Verification records (audit log)
create table if not exists public.doctor_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  real_name text not null,
  hospital text not null,
  department text,
  title text,
  invite_code text,
  status text not null default 'approved',
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  verified_by uuid references auth.users(id) on delete set null,
  note text
);
create unique index if not exists doctor_verifications_user_id_ux on public.doctor_verifications(user_id);
alter table public.doctor_verifications enable row level security;

drop policy if exists doctor_verifications_select_self on public.doctor_verifications;
create policy doctor_verifications_select_self
  on public.doctor_verifications
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- No direct inserts/updates from client; verification is done via RPC.

-- 3) Helper: is doctor verified?
create or replace function public.is_doctor_verified()
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and lower(coalesce(p.role,'')) in ('owner','super_admin','admin','doctor_verified','doctor')
  );
$$;

-- 4) Main RPC: verify with invite code (Channel A)
-- Security notes:
-- - SECURITY DEFINER so it can update profiles.role safely
-- - Invite codes are stored in a protected table and validated server-side
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

  -- If already verified (or admin), allow updating the stored info without consuming invite uses.
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

    -- Consume one use only if user wasn't verified before
    will_increment := true;

    -- Upgrade role
    update public.profiles
      set role = 'doctor_verified',
          full_name = case when coalesce(trim(full_name),'') = '' then trim(real_name) else full_name end,
          doctor_hospital = trim(hospital),
          doctor_department = dep,
          doctor_title = ttl,
          doctor_verified_at = ts,
          updated_at = ts
      where id = uid;

  else
    -- Already verified/admin: just update profile fields (no role change)
    update public.profiles
      set doctor_hospital = trim(hospital),
          doctor_department = dep,
          doctor_title = ttl,
          updated_at = ts
      where id = uid;
  end if;

  -- Upsert verification record
  insert into public.doctor_verifications(user_id, real_name, hospital, department, title, invite_code, status, created_at, verified_at, verified_by)
  values (uid, trim(real_name), trim(hospital), dep, ttl, nullif(trim(invite_code),''), 'approved', ts, ts, uid)
  on conflict (user_id) do update
    set real_name = excluded.real_name,
        hospital = excluded.hospital,
        department = excluded.department,
        title = excluded.title,
        invite_code = excluded.invite_code,
        status = 'approved',
        verified_at = ts,
        verified_by = uid;

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

-- 5) Enforce: only verified doctors can publish cases and reply in case discussions
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

-- Attachments: allow all for Moments; require doctor verified for Case/Case Comment
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
