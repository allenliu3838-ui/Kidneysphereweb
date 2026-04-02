-- ============================================================
-- Fix: Grant RPC permissions to authenticated users
-- 修复：授予已认证用户调用 RPC 函数的权限
-- Without these grants, frontend RPC calls return empty results
-- because auth.uid() returns NULL or the call is rejected.
-- Run in Supabase SQL Editor. Idempotent (safe to re-run).
-- ============================================================

-- User-facing RPCs (my-learning page)
GRANT EXECUTE ON FUNCTION public.get_my_entitlements() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_orders() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_enrollments() TO authenticated;

-- Video access check (watch page + video-access API)
GRANT EXECUTE ON FUNCTION public.check_video_access(uuid, uuid, uuid) TO authenticated;

-- Order creation (checkout page)
GRANT EXECUTE ON FUNCTION public.create_order_with_items(uuid, text) TO authenticated;

-- Proof submission (checkout page)
GRANT EXECUTE ON FUNCTION public.submit_order_for_review(uuid, text, text, text) TO authenticated;

-- Proof duplicate check
GRANT EXECUTE ON FUNCTION public.check_proof_duplicate(text) TO authenticated;
