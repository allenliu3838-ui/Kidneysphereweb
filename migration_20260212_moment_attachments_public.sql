-- MIGRATION_20260212_MOMENT_ATTACHMENTS_PUBLIC.sql (FIXED)
--
-- Enable anonymous visitors to see/download PDF/Word attachments on Moments.
--
-- Design:
-- - Moment attachments are stored in the PUBLIC Storage bucket: "moments"
-- - Rows are tracked in public.attachments with target_type = 'moment' and bucket = 'moments'
-- - This policy allows anon/authenticated to SELECT those rows
--
-- Safe to run multiple times.
--
-- Why FIXED?
-- Supabase SQL editor runs on Postgres. If a DO block uses `$$` and you also use `$$`
-- inside it (e.g. `execute $$ ... $$;`), Postgres may treat the inner `$$` as the end
-- of the DO body, causing `syntax error at or near "create"`.
-- We avoid that by using different dollar-quote tags: $mig$ for the DO body, and $sql$
-- for the dynamic SQL.

do $mig$
begin
  if to_regclass('public.attachments') is null then
    raise notice 'public.attachments does not exist. Please run SUPABASE_SETUP.sql first.';
    return;
  end if;

  -- Public read of moment attachments stored in the public "moments" bucket
  execute 'drop policy if exists attachments_select_public_moment_files on public.attachments';

  execute $sql$
    create policy attachments_select_public_moment_files
    on public.attachments
    for select
    to anon, authenticated
    using (
      deleted_at is null
      and target_type = 'moment'
      and bucket = 'moments'
    )
  $sql$;
end
$mig$;
