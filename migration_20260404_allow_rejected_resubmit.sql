-- ============================================================
-- Migration: Allow rejected orders to be resubmitted
-- Fixes: Users can resubmit payment proof after order rejection
-- Safe to re-run (idempotent).
-- ============================================================

CREATE OR REPLACE FUNCTION public.submit_order_for_review(
  p_order_id uuid,
  p_contact_wechat text default null,
  p_contact_phone text default null,
  p_contact_email text default null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _order record;
  _proof_count integer;
  _uid uuid := auth.uid();
BEGIN
  -- Get order
  SELECT * INTO _order FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  -- Must be the order owner
  IF _order.user_id != _uid THEN
    RAISE EXCEPTION 'Forbidden: not your order';
  END IF;

  -- Must be in pending_payment or rejected status
  IF _order.status NOT IN ('pending_payment', 'rejected') THEN
    RAISE EXCEPTION '订单状态为 %，无法提交审核', _order.status;
  END IF;

  -- Require at least one payment proof
  SELECT count(*) INTO _proof_count
    FROM public.payment_proofs
    WHERE order_id = p_order_id AND user_id = _uid;

  IF _proof_count = 0 THEN
    RAISE EXCEPTION '请先上传支付凭证后再提交审核。';
  END IF;

  -- Update order status
  UPDATE public.orders SET
    status = 'pending_review',
    paid_at = now(),
    remark = null,
    channel = coalesce(_order.channel, 'unknown'),
    contact_wechat = coalesce(p_contact_wechat, orders.contact_wechat),
    contact_phone = coalesce(p_contact_phone, orders.contact_phone),
    contact_email = coalesce(p_contact_email, orders.contact_email)
  WHERE id = p_order_id;

  RETURN '{"ok":true}'::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_order_for_review(uuid, text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.submit_order_for_review(uuid, text, text, text) TO authenticated;
