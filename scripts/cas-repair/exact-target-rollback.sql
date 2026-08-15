\set ON_ERROR_STOP on
\set QUIET 1
\getenv expected_restore_count Q5_EXPECTED_RESTORE_COUNT

\if :{?expected_restore_count}
\else
  \echo 'expected_restore_count is required'
  \quit 2
\endif

begin transaction isolation level serializable;
lock table public.user_fund in share row exclusive mode;
lock table public.transaction in share row exclusive mode;

create temporary table q5_restore_input (like public.transaction including defaults) on commit drop;
alter table q5_restore_input
  add column prior_holding_is_active boolean not null;
create temporary table q5_restore (like public.transaction including defaults) on commit drop;
create temporary table q5_restore_manifest on commit drop as
select :'expected_restore_count'::integer as expected_restore_count;
\copy q5_restore_input (id, user_id, fund_id, transaction_date, transaction_type, units, nav_at_transaction, amount, folio_number, cas_import_id, cas_event_ordinal, created_at, prior_holding_is_active) from program 'cat "$Q5_BACKUP_PLAINTEXT_PATH"' with (format csv, header true)

insert into q5_restore (
  id, user_id, fund_id, transaction_date, transaction_type, units,
  nav_at_transaction, amount, folio_number, cas_import_id,
  cas_event_ordinal, created_at
)
select
  id, user_id, fund_id, transaction_date, transaction_type, units,
  nav_at_transaction, amount, folio_number, cas_import_id,
  cas_event_ordinal, created_at
from q5_restore_input;

create temporary table q5_restore_holding_state on commit drop as
select
  user_id,
  fund_id,
  min(prior_holding_is_active::text)::boolean as prior_is_active
from q5_restore_input
group by user_id, fund_id;

do $$
begin
  if (select count(*) from q5_restore)
    <> (select expected_restore_count from q5_restore_manifest)
  then
    raise exception using errcode = 'P0001', message = 'q5_restore_count_mismatch';
  end if;
  if exists (
    select 1
    from public.transaction as current_row
    join q5_restore as backup_row on backup_row.id = current_row.id
  ) then
    raise exception using errcode = 'P0001', message = 'q5_restore_primary_key_conflict';
  end if;
  if (select count(distinct cas_import_id) from q5_restore) <> 1 then
    raise exception using errcode = 'P0001', message = 'q5_restore_scope_invalid';
  end if;
  if exists (
    select 1
    from q5_restore as backup_row
    left join public.cas_import as owned_import on owned_import.id = backup_row.cas_import_id
    where owned_import.id is null
      or backup_row.user_id is distinct from owned_import.user_id
  ) then
    raise exception using errcode = 'P0001', message = 'q5_restore_owner_mismatch';
  end if;
  if exists (
    select 1
    from q5_restore_input
    group by user_id, fund_id
    having count(distinct prior_holding_is_active) <> 1
  ) then
    raise exception using errcode = 'P0001', message = 'q5_restore_holding_state_invalid';
  end if;
  if exists (
    select 1
    from q5_restore_holding_state as backed_up_holding
    left join public.user_fund as holding
      on holding.id = backed_up_holding.fund_id
      and holding.user_id = backed_up_holding.user_id
    where holding.id is null
      or holding.is_active is distinct from public.resolve_user_fund_activation_v1(
        true,
        backed_up_holding.prior_is_active,
        'null'::jsonb,
        false,
        exists (
          select 1
          from public.transaction as current_row
          where current_row.user_id = backed_up_holding.user_id
            and current_row.fund_id = backed_up_holding.fund_id
        )
      )
  ) then
    raise exception using errcode = 'P0001', message = 'q5_restore_holding_state_changed';
  end if;
end;
$$;

insert into public.transaction (
  id,
  user_id,
  fund_id,
  transaction_date,
  transaction_type,
  units,
  nav_at_transaction,
  amount,
  folio_number,
  cas_import_id,
  cas_event_ordinal,
  created_at
)
select
  id,
  user_id,
  fund_id,
  transaction_date,
  transaction_type,
  units,
  nav_at_transaction,
  amount,
  folio_number,
  cas_import_id,
  cas_event_ordinal,
  created_at
from q5_restore;

create temporary table q5_restored_holding_count on commit drop as
with updated_holdings as (
  update public.user_fund as holding
  set is_active = backed_up_holding.prior_is_active
  from q5_restore_holding_state as backed_up_holding
  where holding.id = backed_up_holding.fund_id
    and holding.user_id = backed_up_holding.user_id
    and holding.is_active is distinct from backed_up_holding.prior_is_active
  returning holding.id
)
select count(*)::integer as value from updated_holdings;

do $$
begin
  if exists (
    select 1
    from q5_restore_holding_state as backed_up_holding
    join public.user_fund as holding
      on holding.id = backed_up_holding.fund_id
      and holding.user_id = backed_up_holding.user_id
    where holding.is_active is distinct from backed_up_holding.prior_is_active
  ) then
    raise exception using errcode = 'P0001', message = 'q5_restore_holding_activation_mismatch';
  end if;
end;
$$;

select json_build_object(
  'restored_count', count(*),
  'holdings_changed', (select value from q5_restored_holding_count),
  'primary_keys_conflicted', false
)::text
from q5_restore;

commit;
