-- KidneySphereAI / KidneySphere — Patch: Fix soft-delete RLS for cases + case_comments
-- Build: v17_v4.1.8
--
-- Symptom:
--   "new row violates row-level security policy" when deleting a case/comment.
--
-- Notes:
--   - The frontend uses SOFT DELETE: UPDATE ... SET deleted_at = now().
--   - So you MUST have an UPDATE policy that allows the new row (WITH CHECK).
--   - This patch is designed to be relatively safe and idempotent.
--
-- Run this in Supabase SQL Editor as role "postgres".

-- 0) Ensure required columns exist (soft delete)
ALTER TABLE IF EXISTS public.cases ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE IF EXISTS public.case_comments ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 1) (Optional) admin allowlist table — if you already have it, this is a no-op
CREATE TABLE IF NOT EXISTS public.admin_allowlist (
  email text PRIMARY KEY,
  uid uuid,
  note text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.admin_allowlist ENABLE ROW LEVEL SECURITY;

-- IMPORTANT: By default we do NOT create any RLS policy on admin_allowlist,
-- so normal users can't read/write it. Manage it in SQL Editor only.

-- 2) Robust admin check
--    Supports:
--      A) profiles.role IN ('admin','staff','super_admin')
--      B) admin_allowlist match on uid OR email
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  ok boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  -- A) profiles.role
  BEGIN
    SELECT EXISTS(
      SELECT 1
      FROM public.profiles p
      WHERE p.id = v_uid
        AND p.role IN ('admin','staff','super_admin')
    ) INTO ok;
  EXCEPTION WHEN undefined_table THEN
    ok := false;
  END;
  IF ok THEN
    RETURN true;
  END IF;

  -- B) admin_allowlist
  BEGIN
    SELECT EXISTS(
      SELECT 1
      FROM public.admin_allowlist a
      WHERE (a.uid IS NOT NULL AND a.uid = v_uid)
         OR (v_email <> '' AND lower(a.email) = v_email)
    ) INTO ok;
  EXCEPTION WHEN undefined_table THEN
    ok := false;
  END;

  RETURN ok;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- 3) Case manage helper (case owner OR admin)
--    Your cases.id is bigint (bigserial). This function accepts text for compatibility.
CREATE OR REPLACE FUNCTION public.can_manage_case(case_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  cid bigint;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  IF public.is_admin() THEN
    RETURN true;
  END IF;

  BEGIN
    cid := case_id::bigint;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;

  RETURN EXISTS(
    SELECT 1
    FROM public.cases c
    WHERE c.id = cid
      AND c.author_id = v_uid
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.can_manage_case(text) TO authenticated;

-- 4) Add dedicated UPDATE policies for soft delete
--    (We keep existing UPDATE policies if any; this adds an extra permissive path.)
ALTER TABLE public.cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cases_update_soft_delete_owner_or_admin_v1 ON public.cases;
CREATE POLICY cases_update_soft_delete_owner_or_admin_v1
ON public.cases
FOR UPDATE
TO authenticated
USING (
  public.is_admin() OR auth.uid() = author_id
)
WITH CHECK (
  public.is_admin() OR auth.uid() = author_id
);

DROP POLICY IF EXISTS case_comments_update_soft_delete_owner_or_case_owner_or_admin_v1 ON public.case_comments;
CREATE POLICY case_comments_update_soft_delete_owner_or_case_owner_or_admin_v1
ON public.case_comments
FOR UPDATE
TO authenticated
USING (
  public.is_admin()
  OR auth.uid() = author_id
  OR public.can_manage_case(case_id::text)
)
WITH CHECK (
  public.is_admin()
  OR auth.uid() = author_id
  OR public.can_manage_case(case_id::text)
);

-- 5) (Optional) Debug RPC you can call from the frontend (Health page will try to call it)
CREATE OR REPLACE FUNCTION public.debug_admin()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'uid', coalesce(auth.uid()::text,''),
    'email', coalesce(auth.jwt()->>'email',''),
    'is_admin', public.is_admin()
  );
$$;

GRANT EXECUTE ON FUNCTION public.debug_admin() TO authenticated;

-- Done.
-- After running:
--   1) Open https://kidneysphere.com/health.html -> click "刷新状态".
--   2) Confirm DB is_admin = 是.
--   3) Retry deleting a case/comment.
