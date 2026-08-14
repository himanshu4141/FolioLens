begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(41);

-- Execute the complete existing-holding decision table:
-- 2 prior states x 3 balance kinds x 2 recency states x 2 ledger states.
with cases as (
  select
    prior_state,
    balance_kind,
    closing_units,
    balance_is_current,
    has_transactions,
    case
      when not balance_is_current then prior_state and has_transactions
      when balance_kind = 'positive' then true
      when balance_kind = 'zero' then false
      else has_transactions
    end as expected
  from (values (false), (true)) as prior(prior_state)
  cross join (
    values
      ('positive'::text, '1'::jsonb),
      ('zero'::text, '0'::jsonb),
      ('missing'::text, 'null'::jsonb)
  ) as balance(balance_kind, closing_units)
  cross join (values (false), (true)) as recency(balance_is_current)
  cross join (values (false), (true)) as ledger(has_transactions)
)
select extensions.is(
  public.resolve_user_fund_activation_v1(
    true,
    prior_state,
    closing_units,
    balance_is_current,
    has_transactions
  ),
  expected,
  format(
    'existing prior=%s balance=%s current=%s has_tx=%s',
    prior_state,
    balance_kind,
    balance_is_current,
    has_transactions
  )
)
from cases;

-- Execute the complete new-holding decision table:
-- 3 balance kinds x 2 recency states x 2 ledger states. Prior activation is
-- deliberately null so this also proves it cannot leak into first imports.
with cases as (
  select
    balance_kind,
    closing_units,
    balance_is_current,
    has_transactions,
    case
      when balance_kind = 'positive' then true
      when balance_kind = 'zero' then false
      else has_transactions
    end as expected
  from (
    values
      ('positive'::text, '1'::jsonb),
      ('zero'::text, '0'::jsonb),
      ('missing'::text, 'null'::jsonb)
  ) as balance(balance_kind, closing_units)
  cross join (values (false), (true)) as recency(balance_is_current)
  cross join (values (false), (true)) as ledger(has_transactions)
)
select extensions.is(
  public.resolve_user_fund_activation_v1(
    false,
    null,
    closing_units,
    balance_is_current,
    has_transactions
  ),
  expected,
  format(
    'new balance=%s current=%s has_tx=%s',
    balance_kind,
    balance_is_current,
    has_transactions
  )
)
from cases;

select extensions.throws_ok(
  $$select public.resolve_user_fund_activation_v1(null, null, 'null'::jsonb, true, false)$$,
  'P0001',
  'cas_invalid_activation_evidence',
  'holding existence is required'
);

select extensions.throws_ok(
  $$select public.resolve_user_fund_activation_v1(true, null, 'null'::jsonb, true, false)$$,
  'P0001',
  'cas_invalid_activation_evidence',
  'an existing holding requires prior activation'
);

select extensions.throws_ok(
  $$select public.resolve_user_fund_activation_v1(true, true, 'null'::jsonb, null, false)$$,
  'P0001',
  'cas_invalid_activation_evidence',
  'balance recency is required'
);

select extensions.throws_ok(
  $$select public.resolve_user_fund_activation_v1(true, true, 'null'::jsonb, true, null)$$,
  'P0001',
  'cas_invalid_activation_evidence',
  'the post-plan ledger snapshot is required'
);

select extensions.throws_ok(
  $$select public.resolve_user_fund_activation_v1(true, true, '"bad"'::jsonb, true, true)$$,
  'P0001',
  'cas_invalid_activation_evidence',
  'closing units must be numeric or missing'
);

select * from extensions.finish();

rollback;
