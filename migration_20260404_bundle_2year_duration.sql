-- ============================================================
-- Migration: Change ALL products to 2-year duration
-- Updates: all product duration_days + all existing user entitlements
-- Safe to re-run (idempotent).
-- ============================================================

-- 1. Update ALL products: duration_days = 730 (2 years)
UPDATE public.products
SET duration_days = 730;

-- 2. Update ALL existing user entitlements to 2 years from start
UPDATE public.user_entitlements
SET end_at = start_at + interval '730 days';
