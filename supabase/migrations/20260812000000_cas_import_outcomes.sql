-- Q5 makes every CAS transaction outcome explicit in the audit record. The
-- columns are aggregate counts only; they contain no statement identifiers or
-- financial values.

alter table public.cas_import
  add column transactions_duplicate integer not null default 0,
  add column reconciliation_conflicts integer not null default 0,
  add column transactions_removed integer not null default 0;

alter table public.cas_import
  add constraint cas_import_transactions_duplicate_nonnegative
    check (transactions_duplicate >= 0),
  add constraint cas_import_reconciliation_conflicts_nonnegative
    check (reconciliation_conflicts >= 0),
  add constraint cas_import_transactions_removed_nonnegative
    check (transactions_removed >= 0);

comment on column public.cas_import.transactions_duplicate is
  'Valid incoming economic rows already present at import time.';
comment on column public.cas_import.reconciliation_conflicts is
  'Incoming economic rows rejected because reconciliation was ambiguous.';
comment on column public.cas_import.transactions_removed is
  'Existing transaction rows removed by uniquely matched reversals.';

-- Edge Functions deploy before migrations. Q5 probes this capability before
-- the first domain read/write so the mixed-version window fails closed.
create or replace function public.cas_import_schema_version_v3()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select 3;
$$;

revoke all on function public.cas_import_schema_version_v3() from public;
revoke all on function public.cas_import_schema_version_v3() from anon, authenticated;
grant execute on function public.cas_import_schema_version_v3() to service_role;

-- Existing table grants and RLS continue to govern the additive audit fields.
-- Rollback before any Q5 import may drop the function, constraints, and
-- columns. After Q5 imports, preserve the audit data and use a forward repair.
