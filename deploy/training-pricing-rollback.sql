-- Restore only the fields changed by migration_20260914_training_prices.sql.
-- Database-owner execution only. No web/API endpoint is installed.
-- All rows are checked against their saved post-release values before restoring.
-- A conflicting later edit aborts the entire rollback. Review the reported row.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select kidneysphere_release_private.restore_training_prices_20260914();
commit;
