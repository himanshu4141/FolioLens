-- M2.1 (docs/plans/amfi-nav-format-change.md): carry AMFI's own Plan/Option
-- columns into a CAS-created provisional scheme_master identity, instead of
-- leaving plan_type/option_type null until the next universe-backfill/
-- sync-fund-meta cycle hydrates it.
--
-- api/_cdsl_nsdl_parser.py now derives plan_type/option_type from AMFI's new
-- 8-column NAVAll layout (Plan/Option as standalone columns) and forwards them
-- as `provisional_plan_type`/`provisional_option_type` on each import plan
-- (see _shared/import-cas.ts). Both are optional and null for casparser-
-- sourced CAS (CAMS/KFintech/MFCentral) and for the pre-Phase-6 6-column AMFI
-- layout, which have no equivalent source data.
--
-- Same signature as the currently active apply_cas_import_plans_v2
-- (20260814000000_cas_holding_activation_recency.sql) — only the
-- scheme_master INSERT changes. `on conflict (scheme_code) do nothing` is
-- unconditional and unchanged: the catalog authority boundary means this can
-- only ever create a brand-new row, never overwrite plan_type/option_type
-- (or their 'amfi'/'name'/'mfdata' provenance) on an existing shared row.
-- cas_import_schema_version_v3() stays at 3 — old Edge Function code that
-- doesn't send the two new (optional) fields gets exactly today's behavior
-- (both columns null on insert), so there is no deployment-order hazard to
-- gate on.

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
  scheme_plan_type_value text;
  scheme_option_type_value text;
  scheme_plan_option_source_value text;
  expected_fund_uuid uuid;
  fund_uuid uuid;
  expected_ids uuid[];
  current_ids uuid[];
  requested_delete_count integer;
  actual_delete_count integer;
  current_insert_count integer;
  holding_existed boolean;
  prior_is_active boolean;
  has_transactions boolean;
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

    if not (plan_row ? 'closing_balance_is_current')
      or jsonb_typeof(plan_row -> 'closing_balance_is_current') <> 'boolean'
    then
      raise exception using errcode = 'P0001', message = 'cas_invalid_closing_balance_recency';
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

    -- AMFI-sourced plan/option (new 8-column NAVAll layout only). Both are
    -- optional; when absent, plan_option_source stays null exactly like the
    -- pre-M2 behaviour. Never validated beyond emptiness — non-financial,
    -- last-resort display data that self-heals via the next backfill cycle
    -- even if malformed.
    scheme_plan_type_value := nullif(plan_row ->> 'provisional_plan_type', '');
    scheme_option_type_value := nullif(plan_row ->> 'provisional_option_type', '');
    scheme_plan_option_source_value := case
      when scheme_plan_type_value is not null or scheme_option_type_value is not null
        then 'amfi'
      else null
    end;

    with inserted_scheme as (
      insert into public.scheme_master (
        scheme_code,
        scheme_name,
        plan_type,
        option_type,
        plan_option_source,
        cas_identity_created_at
      )
      values (
        scheme_code_value,
        scheme_name_value,
        scheme_plan_type_value,
        scheme_option_type_value,
        scheme_plan_option_source_value,
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

    holding_existed := nullif(plan_row ->> 'expected_fund_id', '') is not null;
    if holding_existed then
      select user_fund_row.is_active
        into prior_is_active
      from public.user_fund as user_fund_row
      where user_fund_row.id = fund_uuid
        and user_fund_row.user_id = p_user_id;
    else
      prior_is_active := false;
    end if;

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

    select exists (
      select 1
      from public.transaction as transaction_row
      where transaction_row.user_id = p_user_id
        and transaction_row.fund_id = fund_uuid
    ) into has_transactions;

    final_is_active := public.resolve_user_fund_activation_v1(
      holding_existed,
      prior_is_active,
      plan_row -> 'closing_units',
      (plan_row ->> 'closing_balance_is_current')::boolean,
      has_transactions
    );

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

revoke all on function public.apply_cas_import_plans_v2(uuid, uuid, jsonb) from public;
revoke all on function public.apply_cas_import_plans_v2(uuid, uuid, jsonb) from anon, authenticated;
grant execute on function public.apply_cas_import_plans_v2(uuid, uuid, jsonb) to service_role;
