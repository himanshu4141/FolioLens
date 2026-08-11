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

-- Edge deployment intentionally precedes this migration. The new Edge code
-- probes this function before any domain write and fails closed while the
-- migration is not yet present. Once present, transaction plans are applied
-- under deterministic per-fund advisory locks. The snapshot comparison closes
-- the read/plan/write race, while the function transaction makes every exact
-- reversal delete plus insert set all-or-nothing.
create or replace function public.cas_reconciliation_schema_version_v1()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select 1;
$$;

create or replace function public.apply_cas_transaction_plans_v1(
  p_user_id uuid,
  p_import_id uuid,
  p_plans jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  plan_row jsonb;
  fund_uuid uuid;
  expected_ids uuid[];
  current_ids uuid[];
  requested_delete_count integer;
  actual_delete_count integer;
  inserted_count integer := 0;
  deleted_count integer := 0;
  current_insert_count integer;
begin
  if jsonb_typeof(p_plans) is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'cas_invalid_transaction_plan';
  end if;

  -- Acquire every lock in UUID order so multi-fund imports cannot deadlock.
  for fund_uuid in
    select distinct (value ->> 'fund_id')::uuid
    from jsonb_array_elements(p_plans)
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended(fund_uuid::text, 0));
  end loop;

  -- Revalidate the exact immutable-ID snapshot only after every lock is held.
  -- A concurrent split/combined import therefore makes the losing plan fail
  -- before either its deletes or inserts can run.
  for plan_row in select value from jsonb_array_elements(p_plans)
  loop
    fund_uuid := (plan_row ->> 'fund_id')::uuid;
    if not exists (
      select 1
      from public.user_fund as user_fund_row
      where user_fund_row.id = fund_uuid
        and user_fund_row.user_id = p_user_id
    ) then
      raise exception using errcode = 'P0001', message = 'cas_fund_scope_mismatch';
    end if;

    select coalesce(array_agg(value::uuid order by value::uuid), '{}'::uuid[])
      into expected_ids
    from jsonb_array_elements_text(
      coalesce(plan_row -> 'expected_transaction_ids', '[]'::jsonb)
    );

    select coalesce(array_agg(transaction_row.id order by transaction_row.id), '{}'::uuid[])
      into current_ids
    from public.transaction as transaction_row
    where transaction_row.user_id = p_user_id
      and transaction_row.fund_id = fund_uuid;

    if current_ids is distinct from expected_ids then
      raise exception using errcode = 'P0001', message = 'cas_snapshot_conflict';
    end if;
  end loop;

  for plan_row in select value from jsonb_array_elements(p_plans)
  loop
    fund_uuid := (plan_row ->> 'fund_id')::uuid;
    select jsonb_array_length(coalesce(plan_row -> 'delete_ids', '[]'::jsonb))
      into requested_delete_count;

    with requested_ids as (
      select value::uuid as id
      from jsonb_array_elements_text(
        coalesce(plan_row -> 'delete_ids', '[]'::jsonb)
      )
    ), deleted_rows as (
      delete from public.transaction as transaction_row
      using requested_ids
      where transaction_row.id = requested_ids.id
        and transaction_row.user_id = p_user_id
        and transaction_row.fund_id = fund_uuid
      returning transaction_row.id
    )
    select count(*)::integer into actual_delete_count from deleted_rows;

    if actual_delete_count <> requested_delete_count then
      raise exception using errcode = 'P0001', message = 'cas_delete_scope_mismatch';
    end if;
    deleted_count := deleted_count + actual_delete_count;

    with inserted_rows as (
      insert into public.transaction (
        user_id,
        fund_id,
        transaction_date,
        transaction_type,
        units,
        nav_at_transaction,
        amount,
        folio_number,
        cas_import_id,
        cas_event_ordinal
      )
      select
        p_user_id,
        fund_uuid,
        (incoming_row.value ->> 'transaction_date')::date,
        (incoming_row.value ->> 'transaction_type')::public.transaction_type,
        (incoming_row.value ->> 'units')::numeric,
        (incoming_row.value ->> 'nav_at_transaction')::numeric,
        (incoming_row.value ->> 'amount')::numeric,
        nullif(incoming_row.value ->> 'folio_number', ''),
        p_import_id,
        (incoming_row.value ->> 'cas_event_ordinal')::integer
      from jsonb_array_elements(
        coalesce(plan_row -> 'inserts', '[]'::jsonb)
      ) as incoming_row
      returning id
    )
    select count(*)::integer into current_insert_count from inserted_rows;
    inserted_count := inserted_count + current_insert_count;
  end loop;

  return jsonb_build_object(
    'inserted_count', inserted_count,
    'deleted_count', deleted_count
  );
end;
$$;

revoke all on function public.cas_reconciliation_schema_version_v1() from public;
revoke all on function public.cas_reconciliation_schema_version_v1() from anon, authenticated;
grant execute on function public.cas_reconciliation_schema_version_v1() to service_role;

revoke all on function public.apply_cas_transaction_plans_v1(uuid, uuid, jsonb) from public;
revoke all on function public.apply_cas_transaction_plans_v1(uuid, uuid, jsonb) from anon, authenticated;
grant execute on function public.apply_cas_transaction_plans_v1(uuid, uuid, jsonb) to service_role;

-- Existing table-level grants and RLS policies continue to govern this column;
-- RPC execution is service-role-only; no client-facing grant or policy is introduced.
-- Rollback is intentionally not automated: rows with ordinal > 0 must first be
-- reconciled/consolidated before the old uniqueness constraint can be restored.
