-- Q4 prevents one user's CAS statement from rewriting the shared scheme
-- catalog and makes catalog, holding, activation, and transaction mutation one
-- all-or-nothing operation.

alter table public.scheme_master
  add column cas_identity_created_at timestamptz,
  add column cas_identity_hydrated_at timestamptz;

comment on column public.scheme_master.cas_identity_created_at is
  'Set only when CAS import had to create a minimal provisional scheme identity.';

comment on column public.scheme_master.cas_identity_hydrated_at is
  'Set when an authoritative metadata writer replaces a CAS-provisional scheme identity.';

-- Edge deployment intentionally precedes migrations. The Q4 Edge code probes
-- this function before its first domain read and fails closed while absent.
create or replace function public.cas_import_schema_version_v2()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select 2;
$$;

create or replace function public.apply_cas_import_plans_v2(
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
  scheme_code_value integer;
  scheme_name_value text;
  expected_fund_uuid uuid;
  fund_uuid uuid;
  expected_ids uuid[];
  current_ids uuid[];
  requested_delete_count integer;
  actual_delete_count integer;
  current_insert_count integer;
  closing_units_value numeric;
  final_is_active boolean;
  inserted_count integer := 0;
  deleted_count integer := 0;
  fund_count integer := 0;
  provisional_scheme_count integer := 0;
  current_provisional_count integer;
begin
  if jsonb_typeof(p_plans) is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'cas_invalid_import_plan';
  end if;

  if not exists (
    select 1
    from public.cas_import as import_row
    where import_row.id = p_import_id
      and import_row.user_id = p_user_id
  ) then
    raise exception using errcode = 'P0001', message = 'cas_import_scope_mismatch';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_plans) as plan(value)
    group by (plan.value ->> 'scheme_code')
    having count(*) > 1
  ) then
    raise exception using errcode = 'P0001', message = 'cas_duplicate_scheme_plan';
  end if;

  -- Same-user imports lock the same scheme keys. Sorted acquisition prevents
  -- multi-scheme requests from deadlocking each other.
  for scheme_code_value in
    select distinct (value ->> 'scheme_code')::integer
    from jsonb_array_elements(p_plans)
    order by 1
  loop
    perform pg_advisory_xact_lock(
      hashtextextended(p_user_id::text || ':' || scheme_code_value::text, 0)
    );
  end loop;

  -- Resolve the expected holding roster and create only missing identities and
  -- holdings. ON CONFLICT DO NOTHING is the catalog authority boundary: a CAS
  -- can never update any column on an existing shared row.
  for plan_row in select value from jsonb_array_elements(p_plans)
  loop
    scheme_code_value := (plan_row ->> 'scheme_code')::integer;
    scheme_name_value := btrim(plan_row ->> 'provisional_scheme_name');
    if scheme_code_value <= 0
      or scheme_name_value is null
      or scheme_name_value = ''
      or length(scheme_name_value) > 500
    then
      raise exception using errcode = 'P0001', message = 'cas_invalid_scheme_identity';
    end if;

    if not (plan_row ? 'closing_units')
      or jsonb_typeof(plan_row -> 'closing_units') not in ('number', 'null')
      or (
        jsonb_typeof(plan_row -> 'closing_units') = 'number'
        and (plan_row ->> 'closing_units')::numeric < 0
      )
    then
      raise exception using errcode = 'P0001', message = 'cas_invalid_closing_units';
    end if;

    if nullif(plan_row ->> 'expected_fund_id', '') is null then
      expected_fund_uuid := null;
    else
      expected_fund_uuid := (plan_row ->> 'expected_fund_id')::uuid;
    end if;

    select user_fund_row.id
      into fund_uuid
    from public.user_fund as user_fund_row
    where user_fund_row.user_id = p_user_id
      and user_fund_row.scheme_code = scheme_code_value;

    if fund_uuid is distinct from expected_fund_uuid then
      raise exception using errcode = 'P0001', message = 'cas_snapshot_conflict';
    end if;

    with inserted_scheme as (
      insert into public.scheme_master (
        scheme_code,
        scheme_name,
        cas_identity_created_at
      )
      values (
        scheme_code_value,
        scheme_name_value,
        now()
      )
      on conflict (scheme_code) do nothing
      returning scheme_code
    )
    select count(*)::integer
      into current_provisional_count
    from inserted_scheme;
    provisional_scheme_count := provisional_scheme_count + current_provisional_count;

    if fund_uuid is null then
      insert into public.user_fund (user_id, scheme_code, is_active)
      values (p_user_id, scheme_code_value, false)
      returning id into fund_uuid;
    end if;

    fund_count := fund_count + 1;
  end loop;

  -- Revalidate every immutable transaction snapshot after all locks and domain
  -- identities exist, but before the first delete, insert, or activation write.
  for plan_row in select value from jsonb_array_elements(p_plans)
  loop
    scheme_code_value := (plan_row ->> 'scheme_code')::integer;
    select user_fund_row.id
      into fund_uuid
    from public.user_fund as user_fund_row
    where user_fund_row.user_id = p_user_id
      and user_fund_row.scheme_code = scheme_code_value;

    if fund_uuid is null then
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
    scheme_code_value := (plan_row ->> 'scheme_code')::integer;
    select user_fund_row.id
      into fund_uuid
    from public.user_fund as user_fund_row
    where user_fund_row.user_id = p_user_id
      and user_fund_row.scheme_code = scheme_code_value;

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

    if jsonb_typeof(plan_row -> 'closing_units') = 'number' then
      closing_units_value := (plan_row ->> 'closing_units')::numeric;
      final_is_active := closing_units_value > 0;
    else
      select exists (
        select 1
        from public.transaction as transaction_row
        where transaction_row.user_id = p_user_id
          and transaction_row.fund_id = fund_uuid
      ) into final_is_active;
    end if;

    update public.user_fund as user_fund_row
      set is_active = final_is_active
    where user_fund_row.id = fund_uuid
      and user_fund_row.user_id = p_user_id;
  end loop;

  return jsonb_build_object(
    'fund_count', fund_count,
    'inserted_count', inserted_count,
    'deleted_count', deleted_count,
    'provisional_scheme_count', provisional_scheme_count
  );
end;
$$;

revoke all on function public.cas_import_schema_version_v2() from public;
revoke all on function public.cas_import_schema_version_v2() from anon, authenticated;
grant execute on function public.cas_import_schema_version_v2() to service_role;

revoke all on function public.apply_cas_import_plans_v2(uuid, uuid, jsonb) from public;
revoke all on function public.apply_cas_import_plans_v2(uuid, uuid, jsonb) from anon, authenticated;
grant execute on function public.apply_cas_import_plans_v2(uuid, uuid, jsonb) to service_role;

-- Existing table RLS/grants still govern the new columns. No client-facing
-- policy or RPC grant is introduced. Rollback is intentionally manual because
-- committed provisional identities may be referenced by user_fund rows.
