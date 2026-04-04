-- ============================================================
-- Migration: Change bundle products from 1 year to 2 years
-- Updates: product duration_days + existing user entitlements
-- Safe to re-run (idempotent).
-- ============================================================

-- 1. Update all bundle products: duration_days = 730 (2 years)
UPDATE public.products
SET duration_days = 730
WHERE product_type = 'specialty_bundle';

-- 2. Extend existing entitlements for bundle purchases to 2 years from start
--    Only extend if the entitlement was granted via a bundle product
--    and the current expires_at is less than start + 2 years
UPDATE public.user_entitlements ue
SET expires_at = ue.granted_at + interval '730 days'
WHERE ue.product_id IN (
  SELECT id FROM public.products WHERE product_type = 'specialty_bundle'
)
AND ue.expires_at < ue.granted_at + interval '730 days';
