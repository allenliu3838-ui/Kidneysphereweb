-- ============================================================
-- Migration: 20260508 V Optimizations
-- ------------------------------------------------------------
-- 1. Enable pg_cron extension
-- 2. Add 'in_progress' to learning_projects.status check
-- 3. Cron: cancel pending_payment orders older than 24h
-- 4. Cron: process membership/entitlement expirations daily
-- 5. Cron: switch early-bird price to regular price after deadline
-- 6. Order approval/rejection notifications via notification_jobs
-- 7. Deactivate all *-REG-VIDEO-2026 products (drop video tier)
--
-- Safe to re-run (all statements are idempotent).
-- ============================================================

-- ============================================================
-- 1. ENABLE pg_cron
-- ============================================================
create extension if not exists pg_cron;

-- ============================================================
-- 2. ADD 'in_progress' STATUS to learning_projects + cohorts
-- ------------------------------------------------------------
-- Existing statuses: draft / recruiting / closed / ended
-- New: in_progress (招生已结束、班期正在进行)
-- ============================================================
do $$
declare
  cn text;
begin
  for cn in
    select conname from pg_constraint
    where conrelid = 'public.learning_projects'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.learning_projects drop constraint %I', cn);
  end loop;
end $$;

alter table public.learning_projects
  add constraint learning_projects_status_check
  check (status in ('draft','recruiting','in_progress','closed','ended'));

do $$
declare
  cn text;
begin
  for cn in
    select conname from pg_constraint
    where conrelid = 'public.cohorts'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.cohorts drop constraint %I', cn);
  end loop;
end $$;

alter table public.cohorts
  add constraint cohorts_status_check
  check (status in ('draft','recruiting','in_progress','closed','ended'));

-- ============================================================
-- 3. NOTIFICATION TEMPLATES (site channel)
-- ------------------------------------------------------------
-- We reuse the existing notification_templates / notification_jobs
-- tables created by migration_20260322_unified_commerce.sql.
-- ============================================================
insert into public.notification_templates (code, type, title, subject, body, channel, is_active)
values
  ('order_approved', 'order',
   '订单已通过',
   '您的订单已审核通过',
   '您的订单 {{order_no}} 已审核通过，权益已开通。点击进入「我的学习」查看详情。',
   'site', true),
  ('order_rejected', 'order',
   '订单已驳回',
   '您的订单未通过审核',
   '您的订单 {{order_no}} 未通过审核。{{reason}} 您可以在「我的学习 → 订单」中重新提交付款凭证。',
   'site', true)
on conflict (code) do update set
  type = excluded.type,
  title = excluded.title,
  subject = excluded.subject,
  body = excluded.body,
  channel = excluded.channel,
  is_active = excluded.is_active,
  updated_at = now();

-- ============================================================
-- 4. UPDATE admin_approve_order — add notification_jobs insert
-- ------------------------------------------------------------
-- Replaces the version from migration_20260404_auto_cancel_duplicate_orders.sql.
-- All previous behaviour preserved + notification dispatch at the end.
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

  if exists(
    select 1 from public.order_items oi
    join public.products p on p.id = oi.product_id
    where oi.order_id = p_order_id
      and p.product_type in ('project_registration', 'registration_plus_bundle')
  ) then
    if not exists(
      select 1 from public.user_entitlements
      where user_id = _order.user_id
        and entitlement_type = 'membership'
        and status = 'active'
        and (end_at is null or end_at > now())
    ) then
      insert into public.user_entitlements (user_id, entitlement_type, source_order_id,
        start_at, end_at, status, granted_by, grant_reason)
      values (_order.user_id, 'membership', p_order_id,
        now(), now() + interval '365 days', 'active', _admin_id, '培训项目赠送会员');
      update public.profiles set membership_status = 'member' where id = _order.user_id;
    end if;
  end if;

  -- Auto-cancel duplicate pending orders for same product
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

  -- ★ NEW: Send in-app notification
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
-- 5. UPDATE admin_reject_order — add notification_jobs insert
-- ============================================================
create or replace function public.admin_reject_order(
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
  _admin_id uuid := auth.uid();
  _template_id uuid;
  _reason text;
begin
  if not public.is_admin() then
    raise exception 'Forbidden: admin only';
  end if;

  select * into _order from public.orders where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;

  update public.orders set
    status = 'rejected',
    rejected_at = now(),
    rejected_by = _admin_id,
    remark = coalesce(p_note, remark)
  where id = p_order_id;

  -- ★ NEW: Send in-app notification
  select id into _template_id from public.notification_templates
    where code = 'order_rejected' and is_active = true limit 1;
  if _template_id is not null then
    _reason := case
      when p_note is not null and length(trim(p_note)) > 0 then '驳回原因：' || p_note
      else ''
    end;
    insert into public.notification_jobs (template_id, user_id, related_order_id, channel, status, sent_at, payload_json)
    values (_template_id, _order.user_id, p_order_id, 'site', 'sent', now(),
      jsonb_build_object('order_no', _order.order_no, 'reason', _reason));
  end if;

  insert into public.audit_logs (operator_id, action, target_type, target_id, after_json)
  values (_admin_id, 'order_rejected', 'order', p_order_id::text,
    jsonb_build_object('order_no', _order.order_no, 'note', p_note));

  return '{"ok":true}'::jsonb;
end;
$$;

revoke all on function public.admin_reject_order(uuid, text) from public;
grant execute on function public.admin_reject_order(uuid, text) to authenticated;

-- ============================================================
-- 6. CRON HELPER: cancel stale pending_payment orders (>24h)
-- ============================================================
create or replace function public.cron_cancel_stale_orders()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _affected integer := 0;
begin
  update public.orders set
    status = 'cancelled',
    cancelled_at = now(),
    remark = coalesce(nullif(remark, '') || ' | ', '') || '系统自动取消：超过 24 小时未付款'
  where status = 'pending_payment'
    and created_at < now() - interval '24 hours';

  get diagnostics _affected = row_count;
  return jsonb_build_object('cancelled', _affected);
end;
$$;

-- ============================================================
-- 7. CRON HELPER: process expirations (memberships + entitlements)
-- ============================================================
create or replace function public.cron_process_expirations()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _ent_expired integer := 0;
  _profiles_demoted integer := 0;
  _memberships_expired integer := 0;
begin
  -- Expire user_entitlements past their end_at
  update public.user_entitlements set
    status = 'expired',
    updated_at = now()
  where status = 'active'
    and end_at is not null
    and end_at < now();
  get diagnostics _ent_expired = row_count;

  -- Demote profiles whose membership entitlements are all gone
  update public.profiles p set
    membership_status = 'none'
  where p.membership_status = 'member'
    and not exists (
      select 1 from public.user_entitlements ue
      where ue.user_id = p.id
        and ue.entitlement_type = 'membership'
        and ue.status = 'active'
        and (ue.end_at is null or ue.end_at > now())
    );
  get diagnostics _profiles_demoted = row_count;

  -- Expire memberships table entries (content sync hub consistency)
  update public.memberships set
    status = 'expired',
    updated_at = now()
  where status = 'active'
    and current_period_end is not null
    and current_period_end < now();
  get diagnostics _memberships_expired = row_count;

  return jsonb_build_object(
    'entitlements_expired', _ent_expired,
    'profiles_demoted', _profiles_demoted,
    'memberships_expired', _memberships_expired
  );
end;
$$;

-- ============================================================
-- 8. CRON HELPER: switch early-bird price to regular price
-- ------------------------------------------------------------
-- For products with early_bird_deadline set:
--   if deadline passed AND list_price_cny is the regular price:
--     price_cny := list_price_cny  (raise to regular)
--     list_price_cny := null       (no more strikethrough)
--     early_bird_deadline := null  (don't re-trigger)
-- ============================================================
create or replace function public.cron_switch_early_bird_to_regular()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _affected integer := 0;
begin
  update public.products set
    price_cny = list_price_cny,
    list_price_cny = null,
    early_bird_deadline = null,
    updated_at = now()
  where early_bird_deadline is not null
    and early_bird_deadline < now()
    and list_price_cny is not null
    and list_price_cny > price_cny;

  get diagnostics _affected = row_count;
  return jsonb_build_object('switched', _affected);
end;
$$;

-- ============================================================
-- 9. SCHEDULE CRON JOBS
-- ------------------------------------------------------------
-- Use cron.schedule(name, schedule, command). Names are unique.
-- Re-running this migration removes existing jobs and adds anew.
-- ============================================================
do $$
declare
  _job record;
begin
  for _job in select jobname from cron.job where jobname in (
    'ks_cancel_stale_orders_hourly',
    'ks_process_expirations_daily',
    'ks_switch_early_bird_daily'
  ) loop
    perform cron.unschedule(_job.jobname);
  end loop;
end $$;

select cron.schedule(
  'ks_cancel_stale_orders_hourly',
  '15 * * * *',  -- :15 every hour
  $$ select public.cron_cancel_stale_orders(); $$
);

select cron.schedule(
  'ks_process_expirations_daily',
  '20 2 * * *',  -- 02:20 UTC daily
  $$ select public.cron_process_expirations(); $$
);

select cron.schedule(
  'ks_switch_early_bird_daily',
  '25 2 * * *',  -- 02:25 UTC daily
  $$ select public.cron_switch_early_bird_to_regular(); $$
);

-- ============================================================
-- 10. DEACTIVATE *-REG-VIDEO-2026 PRODUCTS (drop video tier)
-- ============================================================
update public.products set
  is_active = false,
  updated_at = now()
where product_code in (
  'GLOM-REG-VIDEO-2026',
  'ICU-REG-VIDEO-2026',
  'TX-REG-VIDEO-2026',
  'PATHO-REG-VIDEO-2026',
  'DA-REG-VIDEO-2026'
);

-- ============================================================
-- 11. GRANT EXECUTE on cron helpers to admin tooling (optional)
-- ============================================================
grant execute on function public.cron_cancel_stale_orders()        to authenticated;
grant execute on function public.cron_process_expirations()        to authenticated;
grant execute on function public.cron_switch_early_bird_to_regular() to authenticated;

-- ============================================================
-- DONE
-- ============================================================
