-- MIGRATION_20260324_FIX_LEARNING_VIDEOS_RLS.sql
--
-- Fix: admins could not soft-delete learning_videos because the only SELECT
-- policy restricts to `enabled = true AND deleted_at IS NULL`.
-- PostgreSQL requires that the *updated* row still be visible via at least one
-- SELECT policy (the "RLS with-check on UPDATE" behaviour), so soft-deleting
-- (SET deleted_at = now()) immediately hides the row from the only SELECT
-- policy and the UPDATE is rejected.
--
-- Solution: add an admin-only SELECT policy with no row filter so that the
-- updated row remains visible to the admin performing the update.

-- 1) Admin SELECT — admins can see ALL rows (including disabled / soft-deleted)
drop policy if exists "learning_videos_admin_select" on public.learning_videos;
create policy "learning_videos_admin_select"
  on public.learning_videos
  for select
  to authenticated
  using (public.is_admin());
