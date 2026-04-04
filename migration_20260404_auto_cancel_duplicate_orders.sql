-- ============================================================
-- Migration: Auto-cancel duplicate orders on approval
-- When an order is approved, cancel other pending orders from
-- the same user for the same product(s).
-- Safe to re-run (idempotent).
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_approve_order(
  p_order_id uuid,
  p_note text default null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _order record;
  _item record;
  _product record;
  _admin_id uuid := auth.uid();
  _result jsonb := '{"ok":true}'::jsonb;
  _proof_count integer;
  _cancelled_count integer := 0;
BEGIN
  -- Check admin
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Forbidden: admin only';
  END IF;

  -- Get order
  SELECT * INTO _order FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;
  IF _order.status NOT IN ('pending_review','pending_payment') THEN
    RAISE EXCEPTION 'Order status is %, cannot approve', _order.status;
  END IF;

  -- Require at least one payment proof
  SELECT count(*) INTO _proof_count
    FROM public.payment_proofs
    WHERE order_id = p_order_id;

  IF _proof_count = 0 THEN
    RAISE EXCEPTION '该订单尚未上传支付凭证，无法审批通过。请等待用户上传凭证后再审核。';
  END IF;

  -- Update order
  UPDATE public.orders SET
    status = 'approved',
    approved_at = now(),
    approved_by = _admin_id,
    remark = coalesce(p_note, remark)
  WHERE id = p_order_id;

  -- Grant entitlements for each order item
  FOR _item IN SELECT * FROM public.order_items WHERE order_id = p_order_id LOOP
    SELECT * INTO _product FROM public.products WHERE id = _item.product_id;
    IF NOT FOUND THEN CONTINUE; END IF;

    IF _product.product_type = 'membership_plan' THEN
      INSERT INTO public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
        membership_product_id, start_at, end_at, status, granted_by, grant_reason)
      VALUES (_order.user_id, 'membership', p_order_id, _product.id,
        _product.id, now(), now() + (_product.duration_days || ' days')::interval,
        'active', _admin_id, 'order_approved');
      UPDATE public.profiles SET membership_status = 'member' WHERE id = _order.user_id;

    ELSIF _product.product_type = 'specialty_bundle' THEN
      INSERT INTO public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
        specialty_id, start_at, end_at, status, granted_by, grant_reason)
      VALUES (_order.user_id, 'specialty_bundle', p_order_id, _product.id,
        _product.specialty_id, now(), now() + (_product.duration_days || ' days')::interval,
        'active', _admin_id, 'order_approved');

    ELSIF _product.product_type = 'single_video' THEN
      INSERT INTO public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
        video_id, start_at, end_at, status, granted_by, grant_reason)
      VALUES (_order.user_id, 'single_video', p_order_id, _product.id,
        _product.video_id, now(), now() + (_product.duration_days || ' days')::interval,
        'active', _admin_id, 'order_approved');
      PERFORM public.check_video_auto_upgrade(_order.user_id, _product.specialty_id);

    ELSIF _product.product_type = 'project_registration' THEN
      INSERT INTO public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
        project_id, specialty_id, start_at, end_at, status, granted_by, grant_reason)
      VALUES (_order.user_id, 'project_access', p_order_id, _product.id,
        _product.project_id, _product.specialty_id, now(), now() + coalesce((_product.duration_days || ' days')::interval, interval '365 days'),
        'active', _admin_id, 'order_approved');

      IF _product.project_id IS NOT NULL THEN
        INSERT INTO public.project_enrollments (user_id, project_id, cohort_id, source_order_id,
          enrollment_status, approval_status, approved_by, approved_at)
        VALUES (_order.user_id, _product.project_id, _product.cohort_id, p_order_id,
          'confirmed', 'approved', _admin_id, now())
        ON CONFLICT DO NOTHING;
      END IF;

    ELSIF _product.product_type = 'registration_plus_bundle' THEN
      IF _product.project_id IS NOT NULL THEN
        INSERT INTO public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
          project_id, specialty_id, start_at, end_at, status, granted_by, grant_reason)
        VALUES (_order.user_id, 'project_access', p_order_id, _product.id,
          _product.project_id, _product.specialty_id, now(), now() + coalesce((_product.duration_days || ' days')::interval, interval '365 days'),
          'active', _admin_id, 'order_approved');

        INSERT INTO public.project_enrollments (user_id, project_id, cohort_id, source_order_id,
          enrollment_status, approval_status, approved_by, approved_at)
        VALUES (_order.user_id, _product.project_id, _product.cohort_id, p_order_id,
          'confirmed', 'approved', _admin_id, now())
        ON CONFLICT DO NOTHING;
      END IF;

      IF _product.specialty_id IS NOT NULL THEN
        INSERT INTO public.user_entitlements (user_id, entitlement_type, source_order_id, source_product_id,
          specialty_id, start_at, end_at, status, granted_by, grant_reason)
        VALUES (_order.user_id, 'specialty_bundle', p_order_id, _product.id,
          _product.specialty_id, now(), now() + (_product.duration_days || ' days')::interval,
          'active', _admin_id, 'order_approved');
      END IF;
    END IF;
  END LOOP;

  -- Auto-grant 1-year membership for training project purchasers
  IF EXISTS(
    SELECT 1 FROM public.order_items oi
    JOIN public.products p ON p.id = oi.product_id
    WHERE oi.order_id = p_order_id
      AND p.product_type IN ('project_registration', 'registration_plus_bundle')
  ) THEN
    IF NOT EXISTS(
      SELECT 1 FROM public.user_entitlements
      WHERE user_id = _order.user_id
        AND entitlement_type = 'membership'
        AND status = 'active'
        AND (end_at IS NULL OR end_at > now())
    ) THEN
      INSERT INTO public.user_entitlements (user_id, entitlement_type, source_order_id,
        start_at, end_at, status, granted_by, grant_reason)
      VALUES (_order.user_id, 'membership', p_order_id,
        now(), now() + interval '365 days', 'active', _admin_id, '培训项目赠送会员');
      UPDATE public.profiles SET membership_status = 'member' WHERE id = _order.user_id;
    END IF;
  END IF;

  -- ★ NEW: Auto-cancel other pending/rejected orders for the same product(s)
  UPDATE public.orders o SET
    status = 'cancelled',
    remark = '同商品订单已通过，系统自动取消'
  WHERE o.user_id = _order.user_id
    AND o.id != p_order_id
    AND o.status IN ('pending_payment', 'pending_review', 'rejected')
    AND EXISTS (
      SELECT 1 FROM public.order_items oi1
      JOIN public.order_items oi2 ON oi1.product_id = oi2.product_id
      WHERE oi1.order_id = o.id
        AND oi2.order_id = p_order_id
    );

  GET DIAGNOSTICS _cancelled_count = ROW_COUNT;
  IF _cancelled_count > 0 THEN
    _result := jsonb_set(_result, '{cancelled_duplicates}', to_jsonb(_cancelled_count));
  END IF;

  -- Write audit log
  INSERT INTO public.audit_logs (operator_id, action, target_type, target_id, after_json)
  VALUES (_admin_id, 'order_approved', 'order', p_order_id::text,
    jsonb_build_object('order_no', _order.order_no, 'user_id', _order.user_id,
      'amount', _order.total_amount_cny, 'note', p_note,
      'cancelled_duplicates', _cancelled_count));

  RETURN _result;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_approve_order(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.admin_approve_order(uuid, text) TO authenticated;
