-- ============================================================
-- Migration: Fix project_access entitlements missing specialty_id
-- Issue: Users granted project_access via admin_batch_grant_project
-- may have NULL specialty_id if the product lacks specialty_id,
-- causing video access checks to fail.
-- ============================================================

-- 1. Backfill: update existing project_access entitlements that have
--    project_id but no specialty_id, using the products table
update public.user_entitlements ue
set specialty_id = (
  select pr.specialty_id from public.products pr
  where pr.project_id = ue.project_id
    and pr.specialty_id is not null
    and pr.is_active = true
  limit 1
)
where ue.entitlement_type = 'project_access'
  and ue.specialty_id is null
  and ue.project_id is not null
  and exists (
    select 1 from public.products pr
    where pr.project_id = ue.project_id
      and pr.specialty_id is not null
      and pr.is_active = true
  );

-- 2. Enhanced check_video_access: handle project_access with null specialty_id
--    by looking up specialty via project_id → products
create or replace function public.check_video_access(
  p_user_id uuid,
  p_video_id uuid,
  p_specialty_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_access_type text;
  v_membership_accessible boolean;
  v_specialty_id uuid;
begin
  -- Fetch video metadata
  select access_type, membership_accessible, specialty_id
    into v_access_type, v_membership_accessible, v_specialty_id
    from public.learning_videos
    where id = p_video_id;

  -- If video not found, deny
  if v_access_type is null then return false; end if;

  -- registered_free: always allowed for authenticated users
  if v_access_type = 'registered_free' then return true; end if;

  -- Use p_specialty_id from param or from video record
  if p_specialty_id is null then
    p_specialty_id := v_specialty_id;
  end if;

  -- Check single video entitlement
  if exists(
    select 1 from public.user_entitlements
    where user_id = p_user_id and entitlement_type = 'single_video'
      and video_id = p_video_id and status = 'active'
      and (end_at is null or end_at > now())
  ) then return true; end if;

  -- Check specialty bundle entitlement
  if p_specialty_id is not null and exists(
    select 1 from public.user_entitlements
    where user_id = p_user_id and entitlement_type = 'specialty_bundle'
      and specialty_id = p_specialty_id and status = 'active'
      and (end_at is null or end_at > now())
  ) then return true; end if;

  -- Check project_access entitlement (training project users)
  -- Handles both: entitlement with matching specialty_id, or
  -- entitlement with project_id whose product links to the specialty
  if p_specialty_id is not null and exists(
    select 1 from public.user_entitlements ue
    where ue.user_id = p_user_id and ue.entitlement_type = 'project_access'
      and ue.status = 'active'
      and (ue.end_at is null or ue.end_at > now())
      and (
        ue.specialty_id = p_specialty_id
        or (ue.specialty_id is null and ue.project_id is not null and exists(
          select 1 from public.products pr
          where pr.project_id = ue.project_id
            and pr.specialty_id = p_specialty_id
            and pr.is_active = true
        ))
      )
  ) then return true; end if;

  -- Training project users can also see membership-accessible videos (GlomCon etc.)
  if (v_access_type = 'paid_membership' or v_membership_accessible = true) and exists(
    select 1 from public.user_entitlements
    where user_id = p_user_id and entitlement_type = 'project_access'
      and status = 'active'
      and (end_at is null or end_at > now())
  ) then return true; end if;

  -- Check membership entitlement (for membership-accessible videos)
  if (v_access_type = 'paid_membership' or v_membership_accessible = true) and exists(
    select 1 from public.user_entitlements
    where user_id = p_user_id and entitlement_type = 'membership'
      and status = 'active'
      and (end_at is null or end_at > now())
  ) then return true; end if;

  return false;
end;
$$;

-- 3. Also fix admin_batch_grant_project to fall back to project's specialty
--    from learning_projects.includes_bundle_product_id → products.specialty_id
create or replace function public.admin_batch_grant_project(
  p_emails text[],
  p_project_code text,
  p_grant_reason text default 'admin_batch_grant'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _email text;
  _uid uuid;
  _project record;
  _specialty_id uuid;
  _product_id uuid;
  _granted int := 0;
  _skipped int := 0;
  _not_found int := 0;
  _already int := 0;
  _details jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'Forbidden: admin only';
  end if;

  -- Look up project
  select * into _project from public.learning_projects where project_code = p_project_code;
  if not found then
    raise exception 'Project not found: %', p_project_code;
  end if;

  _specialty_id := null;

  -- Find a matching product for source reference and specialty
  select id, specialty_id into _product_id, _specialty_id from public.products
    where project_id = _project.id and product_type = 'project_registration' and is_active = true
    limit 1;

  -- Fallback: if product has no specialty_id, try any active product for this project
  if _specialty_id is null then
    select specialty_id into _specialty_id from public.products
      where project_id = _project.id and specialty_id is not null and is_active = true
      limit 1;
  end if;

  -- Fallback: try the bundle product referenced by the project
  if _specialty_id is null and _project.includes_bundle_product_id is not null then
    select specialty_id into _specialty_id from public.products
      where id = _project.includes_bundle_product_id and specialty_id is not null
      limit 1;
  end if;

  foreach _email in array p_emails loop
    -- Find user
    select id into _uid from auth.users where lower(email) = lower(trim(_email)) limit 1;

    if _uid is null then
      _not_found := _not_found + 1;
      _details := _details || jsonb_build_object('email', trim(_email), 'result', 'not_found');
      continue;
    end if;

    -- Check if already has active entitlement
    if exists (
      select 1 from public.user_entitlements
      where user_id = _uid and entitlement_type = 'project_access'
        and project_id = _project.id and status = 'active'
    ) then
      _already := _already + 1;
      _details := _details || jsonb_build_object('email', trim(_email), 'result', 'already_active');
      continue;
    end if;

    -- Grant project_access entitlement
    insert into public.user_entitlements (
      user_id, entitlement_type, source_product_id,
      specialty_id, project_id,
      start_at, end_at, status, grant_reason
    ) values (
      _uid, 'project_access', _product_id,
      _specialty_id, _project.id,
      now(), now() + interval '365 days', 'active',
      p_grant_reason
    );

    -- Create project enrollment (idempotent)
    insert into public.project_enrollments (
      user_id, project_id,
      enrollment_status, approval_status,
      approved_at, notes
    )
    select _uid, _project.id, 'confirmed', 'approved', now(), p_grant_reason
    where not exists (
      select 1 from public.project_enrollments
      where user_id = _uid and project_id = _project.id
    );

    _granted := _granted + 1;
    _details := _details || jsonb_build_object('email', trim(_email), 'result', 'granted');
  end loop;

  return jsonb_build_object(
    'ok', true,
    'granted', _granted,
    'already_active', _already,
    'not_found', _not_found,
    'total', array_length(p_emails, 1),
    'details', _details
  );
end;
$$;

revoke all on function public.admin_batch_grant_project(text[], text, text) from public;
grant execute on function public.admin_batch_grant_project(text[], text, text) to authenticated;
