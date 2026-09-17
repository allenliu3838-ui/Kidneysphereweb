-- Database-owner only. Conflicting catalog bindings/function definitions/ACLs
-- abort the whole rollback. Purchase snapshots, receipts and customer data stay.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select kidneysphere_release_private.restore_payment_enrollment_20260914();
commit;
