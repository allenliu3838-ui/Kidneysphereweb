-- ============================================================
-- migration_20260330_admin_check_emails.sql
--
-- Admin RPC: bulk check user emails for registration & entitlements
-- ============================================================

create or replace function public.admin_check_user_emails(
  p_emails text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _email text;
  _uid uuid;
  _name text;
  _ent_count int;
  _ent_types text[];
  _results jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'Forbidden: admin only';
  end if;

  foreach _email in array p_emails loop
    -- Find user by email (case-insensitive)
    select id into _uid
      from auth.users
      where lower(email) = lower(trim(_email))
      limit 1;

    if _uid is null then
      _results := _results || jsonb_build_object(
        'email', trim(_email),
        'status', 'not_registered',
        'user_id', null,
        'full_name', null,
        'entitlements', 0,
        'entitlement_types', '[]'::jsonb
      );
    else
      -- Get profile name
      select full_name into _name from public.profiles where id = _uid;

      -- Count active entitlements
      select count(*), array_agg(distinct entitlement_type)
        into _ent_count, _ent_types
        from public.user_entitlements
        where user_id = _uid and status = 'active'
          and (end_at is null or end_at > now());

      _results := _results || jsonb_build_object(
        'email', trim(_email),
        'status', case when _ent_count > 0 then 'active' else 'no_entitlements' end,
        'user_id', _uid,
        'full_name', coalesce(_name, ''),
        'entitlements', _ent_count,
        'entitlement_types', to_jsonb(coalesce(_ent_types, array[]::text[]))
      );
    end if;
  end loop;

  return _results;
end;
$$;

revoke all on function public.admin_check_user_emails(text[]) from public;
grant execute on function public.admin_check_user_emails(text[]) to authenticated;

-- ============================================================
-- 2. Batch grant project_access + enrollment for registered users
-- ============================================================

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

  _specialty_id := _project.specialty_id;

  -- Find a matching product for source reference
  select id into _product_id from public.products
    where project_id = _project.id and product_type = 'project_registration' and is_active = true
    limit 1;

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
