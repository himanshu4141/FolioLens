-- Q3 CAS provider-neutral reconciliation preserves genuine identical events.
-- Application planning cannot do that while the old five-column unique key
-- collapses multiplicity, so the database race backstop gains a deterministic
-- per-identity ordinal and folio scope.

alter table public.transaction
  add column cas_event_ordinal integer not null default 0;

alter table public.transaction
  add constraint transaction_cas_event_ordinal_nonnegative
  check (cas_event_ordinal >= 0);

do $$
declare
  old_constraint_name text;
begin
  select constraint_columns.conname
    into old_constraint_name
  from (
    select
      constraint_row.conname,
      array_agg(attribute_row.attname order by key_column.ordinality) as columns
    from pg_catalog.pg_constraint as constraint_row
    cross join lateral unnest(constraint_row.conkey)
      with ordinality as key_column(attnum, ordinality)
    join pg_catalog.pg_attribute as attribute_row
      on attribute_row.attrelid = constraint_row.conrelid
     and attribute_row.attnum = key_column.attnum
    where constraint_row.conrelid = 'public.transaction'::regclass
      and constraint_row.contype = 'u'
    group by constraint_row.conname
  ) as constraint_columns
  where constraint_columns.columns = array[
    'fund_id'::name,
    'transaction_date'::name,
    'transaction_type'::name,
    'units'::name,
    'amount'::name
  ];

  if old_constraint_name is null then
    raise exception
      'Expected legacy transaction economic unique constraint was not found';
  end if;

  execute format(
    'alter table public.transaction drop constraint %I',
    old_constraint_name
  );
end
$$;

alter table public.transaction
  add constraint transaction_cas_event_identity_key
  unique nulls not distinct (
    fund_id,
    transaction_date,
    transaction_type,
    units,
    amount,
    folio_number,
    cas_event_ordinal
  );

comment on column public.transaction.cas_event_ordinal is
  'Zero-based ordinal preserving identical CAS events within one statement identity.';

-- Existing table-level grants and RLS policies continue to govern this column;
-- no provider-specific grant, function, or policy is introduced.
-- Rollback is intentionally not automated: rows with ordinal > 0 must first be
-- reconciled/consolidated before the old uniqueness constraint can be restored.
