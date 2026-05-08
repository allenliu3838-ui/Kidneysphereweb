-- ============================================================
-- Migration: 20260509 Membership Duration & Video Access Consistency
-- ------------------------------------------------------------
-- 1. admin_approve_order: gift membership duration tracks training
--    project duration_days (not hardcoded 365). For users with an
--    existing active membership, extend end_at if new is later.
-- 2. learning_videos: trigger to enforce source/access consistency
--    - source='glomcon' implies is_paid=true, membership_accessible=true,
--      specialty_id=null (free GlomCon videos collapse to membership-only)
--    - membership_accessible=true on free video (is_paid=false) is normalized
--      to membership_accessible=false (flag is meaningless for free)
-- 3. One-time backfill of existing inconsistent rows.
--
-- Safe to re-run (CREATE OR REPLACE + idempotent backfill).
-- ============================================================

-- ============================================================
-- 1. REPLACE admin_approve_order
-- ============================================================
create or replace function public.admin_approve_order(
  p_order_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _order record;
  _item record;
  _product record;
  _admin_id uuid := auth.uid();
  _result jsonb := '{"ok":true}'::jsonb;
  _proof_count integer;
  _cancelled_count integer := 0;
  _template_id uuid;
  _proj_max_duration integer;
  _proj_codes text;
  _existing_ent_id uuid;
  _existing_end_at timestamptz;
  _new_end_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Forbidden: admin only';
  end if;

  select * into _order from public.orders where id = p_order_id;
  if not found then
    raise exception 'Order not found';
  end if;
  if _order.status not in ('pending_review','pending_payment') then
    raise exception 'Order status is %, cannot approve', _order.status;
  end if;

  select count(*) into _proof_count
    from public.payment_proofs
    where order_id = p_order_id;

  if _proof_count = 0 then
    raise exception '该订单尚未上传支付凭证，无法审批通过。请等待用户上传凭证后再审核。';
  end if;

  update public.orders set
    status = 'approved',
    approved_at = now(),
    approved_by = _admin_id,
    remark = coalesce(p_note, remark)
  where id = p_order_id;

  for _item in select * from public.order_items where order_id = p_order_id loop
    select * into _product from public.products where id = _item.product_id;
    if not found then continue; end if;

    if _product.product_type = 'membership_plan' then
      insert into public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
        membership_product_id, start_at, end_at, status, granted_by, grant_reason)
      values (_order.user_id, 'membership', p_order_id, _product.id,
        _product.id, now(), now() + (_product.duration_days || ' days')::interval,
        'active', _admin_id, 'order_approved');
      update public.profiles set membership_status = 'member' where id = _order.user_id;

    elsif _product.product_type = 'specialty_bundle' then
      insert into public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
        specialty_id, start_at, end_at, status, granted_by, grant_reason)
      values (_order.user_id, 'specialty_bundle', p_order_id, _product.id,
        _product.specialty_id, now(), now() + (_product.duration_days || ' days')::interval,
        'active', _admin_id, 'order_approved');

    elsif _product.product_type = 'single_video' then
      insert into public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
        video_id, start_at, end_at, status, granted_by, grant_reason)
      values (_order.user_id, 'single_video', p_order_id, _product.id,
        _product.video_id, now(), now() + (_product.duration_days || ' days')::interval,
        'active', _admin_id, 'order_approved');
      perform public.check_video_auto_upgrade(_order.user_id, _product.specialty_id);

    elsif _product.product_type = 'project_registration' then
      insert into public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
        project_id, specialty_id, start_at, end_at, status, granted_by, grant_reason)
      values (_order.user_id, 'project_access', p_order_id, _product.id,
        _product.project_id, _product.specialty_id, now(), now() + coalesce((_product.duration_days || ' days')::interval, interval '365 days'),
        'active', _admin_id, 'order_approved');

      if _product.project_id is not null then
        insert into public.project_enrollments (user_id, project_id, cohort_id, source_order_id,
          enrollment_status, approval_status, approved_by, approved_at)
        values (_order.user_id, _product.project_id, _product.cohort_id, p_order_id,
          'confirmed', 'approved', _admin_id, now())
        on conflict do nothing;
      end if;

    elsif _product.product_type = 'registration_plus_bundle' then
      if _product.project_id is not null then
        insert into public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
          project_id, specialty_id, start_at, end_at, status, granted_by, grant_reason)
        values (_order.user_id, 'project_access', p_order_id, _product.id,
          _product.project_id, _product.specialty_id, now(), now() + coalesce((_product.duration_days || ' days')::interval, interval '365 days'),
          'active', _admin_id, 'order_approved');

        insert into public.project_enrollments (user_id, project_id, cohort_id, source_order_id,
          enrollment_status, approval_status, approved_by, approved_at)
        values (_order.user_id, _product.project_id, _product.cohort_id, p_order_id,
          'confirmed', 'approved', _admin_id, now())
        on conflict do nothing;
      end if;

      if _product.specialty_id is not null then
        insert into public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
          specialty_id, start_at, end_at, status, granted_by, grant_reason)
        values (_order.user_id, 'specialty_bundle', p_order_id, _product.id,
          _product.specialty_id, now(), now() + (_product.duration_days || ' days')::interval,
          'active', _admin_id, 'order_approved');
      end if;
    end if;
  end loop;

  -- ============================================================
  -- ★ Auto-grant GlomCon membership for training project purchasers
  -- Duration: longest duration_days among training products in this order
  -- If user has existing active membership, extend end_at only if new is later.
  -- ============================================================
  select
    max(coalesce(p.duration_days, 365)),
    string_agg(p.product_code, ', ')
  into _proj_max_duration, _proj_codes
  from public.order_items oi
  join public.products p on p.id = oi.product_id
  where oi.order_id = p_order_id
    and p.product_type in ('project_registration', 'registration_plus_bundle');

  if _proj_max_duration is not null then
    _new_end_at := now() + (_proj_max_duration || ' days')::interval;

    select id, end_at into _existing_ent_id, _existing_end_at
    from public.user_entitlements
    where user_id = _order.user_id
      and entitlement_type = 'membership'
      and status = 'active'
      and (end_at is null or end_at > now())
    order by coalesce(end_at, 'infinity'::timestamptz) desc
    limit 1;

    if _existing_ent_id is null then
      insert into public.user_entitlements (user_id, entitlement_type, source_order_id,
        start_at, end_at, status, granted_by, grant_reason)
      values (_order.user_id, 'membership', p_order_id,
        now(), _new_end_at, 'active', _admin_id,
        '培训项目赠送会员 · ' || _proj_codes);
      update public.profiles set membership_status = 'member' where id = _order.user_id;
    elsif _existing_end_at is not null and _new_end_at > _existing_end_at then
      update public.user_entitlements set
        end_at = _new_end_at,
        grant_reason = coalesce(grant_reason, '') || ' + 培训项目赠送 · ' || _proj_codes,
        updated_at = now()
      where id = _existing_ent_id;
    end if;
    -- else: existing membership lasts longer (or unlimited), don't shorten
  end if;

  update public.orders o set
    status = 'cancelled',
    remark = '同商品订单已通过，系统自动取消'
  where o.user_id = _order.user_id
    and o.id != p_order_id
    and o.status in ('pending_payment', 'pending_review', 'rejected')
    and exists (
      select 1 from public.order_items oi1
      join public.order_items oi2 on oi1.product_id = oi2.product_id
      where oi1.order_id = o.id
        and oi2.order_id = p_order_id
    );

  get diagnostics _cancelled_count = row_count;
  if _cancelled_count > 0 then
    _result := jsonb_set(_result, '{cancelled_duplicates}', to_jsonb(_cancelled_count));
  end if;

  select id into _template_id from public.notification_templates
    where code = 'order_approved' and is_active = true limit 1;
  if _template_id is not null then
    insert into public.notification_jobs (template_id, user_id, related_order_id, channel, status, sent_at, payload_json)
    values (_template_id, _order.user_id, p_order_id, 'site', 'sent', now(),
      jsonb_build_object('order_no', _order.order_no, 'amount', _order.total_amount_cny));
  end if;

  insert into public.audit_logs (operator_id, action, target_type, target_id, after_json)
  values (_admin_id, 'order_approved', 'order', p_order_id::text,
    jsonb_build_object('order_no', _order.order_no, 'user_id', _order.user_id,
      'amount', _order.total_amount_cny, 'note', p_note,
      'cancelled_duplicates', _cancelled_count));

  return _result;
end;
$$;

revoke all on function public.admin_approve_order(uuid, text) from public;
grant execute on function public.admin_approve_order(uuid, text) to authenticated;

-- ============================================================
-- 2. learning_videos consistency trigger
-- ------------------------------------------------------------
-- Rules enforced:
--   (a) source='glomcon' → is_paid=true, membership_accessible=true,
--       specialty_id=null. GlomCon content is exclusively for members
--       and never tied to a specialty/training project.
--   (b) is_paid=false → membership_accessible=false. The flag has no
--       meaning for free videos.
-- The trigger normalizes silently (no exception) so admins don't
-- get blocked; the form should still guide them.
-- ============================================================
create or replace function public.tg_learning_videos_normalize_access()
returns trigger
language plpgsql
as $$
begin
  if new.source = 'glomcon' then
    new.is_paid := true;
    new.membership_accessible := true;
    new.specialty_id := null;
  end if;

  if coalesce(new.is_paid, false) = false then
    new.membership_accessible := false;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_learning_videos_normalize_access on public.learning_videos;
create trigger trg_learning_videos_normalize_access
before insert or update on public.learning_videos
for each row
execute function public.tg_learning_videos_normalize_access();

-- ============================================================
-- 3. One-time backfill of inconsistent rows
-- ------------------------------------------------------------
-- (a) source='glomcon' but flags wrong → fix
-- (b) is_paid=false but membership_accessible=true → clear flag
-- ============================================================
update public.learning_videos set
  is_paid = true,
  membership_accessible = true,
  specialty_id = null
where source = 'glomcon'
  and (
    coalesce(is_paid, false) = false
    or coalesce(membership_accessible, false) = false
    or specialty_id is not null
  );

update public.learning_videos set
  membership_accessible = false
where coalesce(is_paid, false) = false
  and coalesce(membership_accessible, false) = true;

-- ============================================================
-- DONE
-- ============================================================
