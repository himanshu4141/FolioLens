begin;

create extension if not exists pgtap with schema extensions;

select extensions.plan(5);

create temporary table q5_repair_activation_cases (
  name text primary key,
  prior_is_active boolean not null,
  has_transactions_after_delete boolean not null,
  expected_after_apply boolean not null,
  actual_is_active boolean not null
);

insert into q5_repair_activation_cases (
  name,
  prior_is_active,
  has_transactions_after_delete,
  expected_after_apply,
  actual_is_active
)
values
  ('inactive-partial-target', false, true, false, false),
  ('active-sole-target', true, false, false, true),
  ('active-partial-target', true, true, true, true),
  ('inactive-sole-target', false, false, false, false);

update q5_repair_activation_cases
set actual_is_active = public.resolve_user_fund_activation_v1(
  true,
  prior_is_active,
  'null'::jsonb,
  false,
  has_transactions_after_delete
);

select extensions.is(
  actual_is_active,
  expected_after_apply,
  format('Q5 delete-only apply preserves resolver policy for %s', name)
)
from q5_repair_activation_cases
order by name;

-- Rollback is restoration, not another policy decision. The encrypted repair
-- backup captures this prior value for every touched holding.
update q5_repair_activation_cases
set actual_is_active = prior_is_active;

select extensions.ok(
  bool_and(actual_is_active is not distinct from prior_is_active),
  'Q5 rollback restores every captured prior activation exactly'
)
from q5_repair_activation_cases;

select * from extensions.finish();

rollback;
