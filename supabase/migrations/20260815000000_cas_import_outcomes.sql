-- Q5 makes every CAS transaction outcome explicit in the audit record. The
-- columns are aggregate counts only; they contain no statement identifiers or
-- financial values.

alter table public.cas_import
  add column transactions_duplicate integer not null default 0,
  add column reconciliation_conflicts integer not null default 0,
  add column transactions_rejected integer not null default 0,
  add column holdings_changed integer not null default 0,
  add column transactions_removed integer not null default 0;

alter table public.cas_import
  add constraint cas_import_transactions_duplicate_nonnegative
    check (transactions_duplicate >= 0),
  add constraint cas_import_reconciliation_conflicts_nonnegative
    check (reconciliation_conflicts >= 0),
  add constraint cas_import_transactions_rejected_nonnegative
    check (transactions_rejected >= 0),
  add constraint cas_import_holdings_changed_nonnegative
    check (holdings_changed >= 0),
  add constraint cas_import_transactions_removed_nonnegative
    check (transactions_removed >= 0);

comment on column public.cas_import.transactions_duplicate is
  'Valid incoming economic rows already present at import time.';
comment on column public.cas_import.reconciliation_conflicts is
  'Ambiguous reconciliation groups; distinct from rejected incoming row count.';
comment on column public.cas_import.transactions_rejected is
  'Exact incoming statement rows rejected because reconciliation was ambiguous.';
comment on column public.cas_import.holdings_changed is
  'User holding rows created or whose active state changed atomically during import.';
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

-- Wrap Q4's atomic writer so Q5 can distinguish a genuine harmless re-import
-- from a zero-transaction import that creates a holding or changes is_active.
-- The wrapper and v2 mutation run in the same database transaction.
create or replace function public.apply_cas_import_plans_v3(
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
  before_holdings jsonb := '{}'::jsonb;
  before_exists boolean;
  before_active boolean;
  after_exists boolean;
  after_active boolean;
  holding_changed_count integer := 0;
  mutation_result jsonb;
begin
  if jsonb_typeof(p_plans) is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'cas_invalid_import_plan';
  end if;

  -- The before/after comparison is part of the same per-user/scheme critical
  -- section as v2. Without taking these locks before the snapshot, a
  -- concurrent import can change a holding between the v3 read and v2's lock,
  -- causing holding_changed_count to incorrectly report zero. The locks are
  -- transaction-reentrant when v2 acquires the same sorted keys again.
  for scheme_code_value in
    select distinct (value ->> 'scheme_code')::integer
    from jsonb_array_elements(p_plans)
    order by 1
  loop
    perform pg_advisory_xact_lock(
      hashtextextended(p_user_id::text || ':' || scheme_code_value::text, 0)
    );
  end loop;

  for plan_row in select value from jsonb_array_elements(p_plans)
  loop
    scheme_code_value := (plan_row ->> 'scheme_code')::integer;
    select user_fund_row.is_active
      into before_active
    from public.user_fund as user_fund_row
    where user_fund_row.user_id = p_user_id
      and user_fund_row.scheme_code = scheme_code_value;
    before_exists := found;
    before_holdings := before_holdings || jsonb_build_object(
      scheme_code_value::text,
      jsonb_build_object('exists', before_exists, 'active', before_active)
    );
  end loop;

  mutation_result := public.apply_cas_import_plans_v2(p_user_id, p_import_id, p_plans);

  for plan_row in select value from jsonb_array_elements(p_plans)
  loop
    scheme_code_value := (plan_row ->> 'scheme_code')::integer;
    before_exists := coalesce(
      (before_holdings -> scheme_code_value::text ->> 'exists')::boolean,
      false
    );
    before_active := (before_holdings -> scheme_code_value::text ->> 'active')::boolean;

    select user_fund_row.is_active
      into after_active
    from public.user_fund as user_fund_row
    where user_fund_row.user_id = p_user_id
      and user_fund_row.scheme_code = scheme_code_value;
    after_exists := found;

    if before_exists is distinct from after_exists
      or (before_exists and after_exists and before_active is distinct from after_active)
    then
      holding_changed_count := holding_changed_count + 1;
    end if;
  end loop;

  return mutation_result || jsonb_build_object(
    'holding_changed_count', holding_changed_count
  );
end;
$$;

revoke all on function public.apply_cas_import_plans_v3(uuid, uuid, jsonb) from public;
revoke all on function public.apply_cas_import_plans_v3(uuid, uuid, jsonb) from anon, authenticated;
grant execute on function public.apply_cas_import_plans_v3(uuid, uuid, jsonb) to service_role;

-- Existing table grants and RLS continue to govern the additive audit fields.
-- Rollback before any Q5 import may drop the function, constraints, and
-- columns. After Q5 imports, preserve the audit data and use a forward repair.
