# Hotfix: Case replies failing due to missing cases.comment_count

## Symptom
Posting a reply on a case fails with an error similar to:

- `column "comment_count" of relation "cases" does not exist`

## Root cause
Some older database deployments were missing the denormalized column `public.cases.comment_count`.
If the `trg_case_comment_count` trigger (or `recompute_case_comment_count()` function) exists,
it attempts to update `cases.comment_count` after comment insert/update/delete, causing the write to fail.

## Fix
Run the migration:

- `MIGRATION_20260130_CASE_COMMENTCOUNT_HOTFIX.sql`

This migration:
- Adds `cases.comment_count` if missing
- Backfills counts
- Recreates `recompute_case_comment_count()` and `trg_case_comment_count()` in an idempotent way

