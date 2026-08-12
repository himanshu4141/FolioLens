\set ON_ERROR_STOP on
\set QUIET 1

\if :{?target_import_id}
\else
  \quit 2
\endif

copy (
  select
    t.id,
    t.user_id,
    t.fund_id,
    t.transaction_date,
    t.transaction_type,
    t.units,
    t.nav_at_transaction,
    t.amount,
    t.folio_number,
    t.cas_import_id,
    t.cas_event_ordinal,
    t.created_at
  from public.transaction as t
  where t.cas_import_id = :'target_import_id'::uuid
  order by t.id
) to stdout with (format csv, header true);
