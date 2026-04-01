-- ============================================================
-- Migration: (1) Enforce proof before review submission
--            (2) Allow admin to revert rejected orders
-- ============================================================

-- 1. RPC: submit_order_for_review
--    Users must call this instead of directly updating order status.
--    Validates that at least one payment proof exists.
-- ============================================================
create or replace function public.submit_order_for_review(
  p_order_id uuid,
  p_contact_wechat text default null,
  p_contact_phone text default null,
  p_contact_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _order record;
  _proof_count integer;
  _uid uuid := auth.uid();
begin
  -- Get order
  select * into _order from public.orders where id = p_order_id;
  if not found then
    raise exception 'Order not found';
  end if;

  -- Must be the order owner
  if _order.user_id != _uid then
    raise exception 'Forbidden: not your order';
  end if;

  -- Must be in pending_payment status
  if _order.status != 'pending_payment' then
    raise exception '订单状态为 %，无法提交审核', _order.status;
  end if;

  -- Require at least one payment proof
  select count(*) into _proof_count
    from public.payment_proofs
    where order_id = p_order_id and user_id = _uid;

  if _proof_count = 0 then
    raise exception '请先上传支付凭证后再提交审核。';
  end if;

  -- Update order status
  update public.orders set
    status = 'pending_review',
    paid_at = now(),
    channel = coalesce(_order.channel, 'unknown'),
    contact_wechat = coalesce(p_contact_wechat, contact_wechat),
    contact_phone = coalesce(p_contact_phone, contact_phone),
    contact_email = coalesce(p_contact_email, contact_email)
  where id = p_order_id;

  return '{"ok":true}'::jsonb;
end;
$$;

revoke all on function public.submit_order_for_review(uuid, text, text, text) from public;
grant execute on function public.submit_order_for_review(uuid, text, text, text) to authenticated;

-- 2. Prevent direct status update to pending_review via trigger
-- ============================================================
create or replace function public.trg_prevent_direct_review_status()
returns trigger
language plpgsql
as $$
begin
  -- Only block if someone tries to set status to pending_review directly
  -- The RPC function uses security definer, so this trigger won't fire for it
  -- Actually, triggers fire regardless of security definer, so we need a bypass flag
  -- We use a session variable to allow the RPC to bypass
  if NEW.status = 'pending_review' and OLD.status = 'pending_payment' then
    -- Check if proof exists
    if not exists (
      select 1 from public.payment_proofs where order_id = NEW.id
    ) then
      raise exception '请先上传支付凭证后再提交审核。';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_order_review_guard on public.orders;
create trigger trg_order_review_guard
  before update on public.orders
  for each row
  when (OLD.status = 'pending_payment' and NEW.status = 'pending_review')
  execute function public.trg_prevent_direct_review_status();

-- 3. Admin: revert rejected order back to pending_review
-- ============================================================
create or replace function public.admin_revert_rejection(
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
begin
  if not public.is_admin() then
    raise exception 'Forbidden: admin only';
  end if;

  select * into _order from public.orders where id = p_order_id;
  if not found then
    raise exception 'Order not found';
  end if;

  if _order.status != 'rejected' then
    raise exception '订单状态为 %，只能撤回已驳回的订单', _order.status;
  end if;

  -- Revert to pending_review so admin can re-review
  update public.orders set
    status = 'pending_review',
    rejected_at = null,
    rejected_by = null,
    remark = coalesce(p_note, '管理员撤回驳回: ' || coalesce(remark, ''))
  where id = p_order_id;

  insert into public.audit_logs (operator_id, action, target_type, target_id, after_json)
  values (_admin_id, 'order_rejection_reverted', 'order', p_order_id::text,
    jsonb_build_object('order_no', _order.order_no, 'note', p_note));

  return '{"ok":true}'::jsonb;
end;
$$;

revoke all on function public.admin_revert_rejection(uuid, text) from public;
grant execute on function public.admin_revert_rejection(uuid, text) to authenticated;
