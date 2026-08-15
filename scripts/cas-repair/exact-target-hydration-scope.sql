\set ON_ERROR_STOP on
\set QUIET 1
\getenv target_import_id Q5_TARGET_IMPORT_ID
\getenv expected_target_count Q5_EXPECTED_TARGET_COUNT

\if :{?target_import_id}
\else
  \echo 'target_import_id is required'
  \quit 2
\endif
\if :{?expected_target_count}
\else
  \echo 'expected_target_count is required'
  \quit 2
\endif

begin;
create temporary table q5_hydration_backup
  (like public.transaction including defaults) on commit drop;
alter table q5_hydration_backup
  add column prior_holding_is_active boolean not null;
\copy q5_hydration_backup (id, user_id, fund_id, transaction_date, transaction_type, units, nav_at_transaction, amount, folio_number, cas_import_id, cas_event_ordinal, created_at, prior_holding_is_active) from program 'cat "$Q5_BACKUP_PLAINTEXT_PATH"' with (format csv, header true)

do $$
begin
  if (select count(*) from q5_hydration_backup) <> :'expected_target_count'::integer
    or :'expected_target_count'::integer <= 0
    or (select count(distinct cas_import_id) from q5_hydration_backup) <> 1
    or exists (
      select 1
      from q5_hydration_backup
      where cas_import_id is distinct from :'target_import_id'::uuid
    )
  then
    raise exception using errcode = 'P0001', message = 'q5_hydration_scope_mismatch';
  end if;

  if exists (
    select 1
    from q5_hydration_backup as backup_row
    left join public.user_fund as holding on holding.id = backup_row.fund_id
    left join public.cas_import as owned_import on owned_import.id = backup_row.cas_import_id
    where holding.id is null
      or owned_import.id is null
      or holding.user_id is distinct from backup_row.user_id
      or owned_import.user_id is distinct from backup_row.user_id
  ) then
    raise exception using errcode = 'P0001', message = 'q5_hydration_owner_mismatch';
  end if;
end;
$$;

select json_build_object(
  'mode', 'exact-target-repair',
  'scheme_codes', json_agg(scope.scheme_code order by scope.scheme_code)
)::text
from (
  select distinct holding.scheme_code
  from q5_hydration_backup as backup_row
  join public.user_fund as holding on holding.id = backup_row.fund_id
) as scope;

rollback;
