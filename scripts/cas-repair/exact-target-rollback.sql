\set ON_ERROR_STOP on
\set QUIET 1

\if :{?expected_restore_count}
\else
  \echo 'expected_restore_count is required'
  \quit 2
\endif

begin transaction isolation level serializable;
lock table public.transaction in share row exclusive mode;

create temporary table q5_restore (like public.transaction including defaults) on commit drop;
create temporary table q5_restore_manifest on commit drop as
select :'expected_restore_count'::integer as expected_restore_count;
\copy q5_restore (id, user_id, fund_id, transaction_date, transaction_type, units, nav_at_transaction, amount, folio_number, cas_import_id, cas_event_ordinal, created_at) from program 'cat "$Q5_BACKUP_PLAINTEXT_PATH"' with (format csv, header true)

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

select json_build_object(
  'restored_count', count(*),
  'primary_keys_conflicted', false
)::text
from q5_restore;

commit;
