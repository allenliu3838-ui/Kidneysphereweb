-- ============================================================
-- migration_20260513_admin_batch_grant_membership.sql
--
-- Admin RPC: batch grant membership (GlomCon 教育会员等)
-- 与 admin_batch_grant_project 对称，但发放 membership 类型权益
-- 并同步 profiles.membership_status
-- Idempotent: re-run safe.
-- ============================================================

create or replace function public.admin_batch_grant_membership(
  p_emails text[],
  p_product_code text,
  p_grant_reason text default 'admin_batch_grant_membership'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _email text;
  _uid uuid;
  _product record;
  _granted int := 0;
  _already int := 0;
  _not_found int := 0;
  _details jsonb := '[]'::jsonb;
  _duration interval;
begin
  if not public.is_admin() then
    raise exception 'Forbidden: admin only';
  end if;

  select * into _product from public.products
    where product_code = p_product_code
      and product_type = 'membership_plan'
      and is_active = true
    limit 1;
  if not found then
    raise exception 'Membership product not found or inactive: %', p_product_code;
  end if;

  _duration := coalesce((_product.duration_days || ' days')::interval, interval '365 days');

  foreach _email in array p_emails loop
    select id into _uid from auth.users where lower(email) = lower(trim(_email)) limit 1;

    if _uid is null then
      _not_found := _not_found + 1;
      _details := _details || jsonb_build_object('email', trim(_email), 'result', 'not_found');
      continue;
    end if;

    -- Skip if user already has any active membership
    if exists (
      select 1 from public.user_entitlements
      where user_id = _uid
        and entitlement_type = 'membership'
        and status = 'active'
        and (end_at is null or end_at > now())
    ) then
      _already := _already + 1;
      _details := _details || jsonb_build_object('email', trim(_email), 'result', 'already_active');
      continue;
    end if;

    insert into public.user_entitlements (
      user_id, entitlement_type, source_product_id,
      membership_product_id, start_at, end_at, status, grant_reason
    ) values (
      _uid, 'membership', _product.id,
      _product.id, now(), now() + _duration, 'active',
      p_grant_reason
    );

    update public.profiles set membership_status = 'member' where id = _uid;

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

revoke all on function public.admin_batch_grant_membership(text[], text, text) from public;
grant execute on function public.admin_batch_grant_membership(text[], text, text) to authenticated;
