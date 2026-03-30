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
