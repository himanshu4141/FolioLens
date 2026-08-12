\set ON_ERROR_STOP on
\set QUIET 1
\getenv target_import_id Q5_TARGET_IMPORT_ID

\if :{?target_import_id}
\else
  \quit 2
\endif

create temporary table q5_backup_target_guard as
select :'target_import_id'::uuid as import_id;

do $$
declare
  target_id uuid;
begin
  select import_id into strict target_id from q5_backup_target_guard;
  if (select count(*) from public.cas_import where id = target_id) <> 1 then
    raise exception using errcode = 'P0001', message = 'q5_backup_target_import_not_unique';
  end if;
  if not exists (
    select 1 from public.transaction where cas_import_id = target_id
  ) then
    raise exception using errcode = 'P0001', message = 'q5_backup_target_empty';
  end if;
  if exists (
    select 1
    from public.transaction as t
    join public.cas_import as owned_import on owned_import.id = target_id
    where t.cas_import_id = target_id
      and t.user_id is distinct from owned_import.user_id
  ) then
    raise exception using errcode = 'P0001', message = 'q5_backup_target_ownership_mismatch';
  end if;
end;
$$;

copy (
  select
    t.id,
    t.user_id,
    t.fund_id,
    t.transaction_date,
    t.transaction_type,
    t.units,
    t.nav_at_transaction,
    t.amount,
    t.folio_number,
    t.cas_import_id,
    t.cas_event_ordinal,
    t.created_at
  from public.transaction as t
  where t.cas_import_id = :'target_import_id'::uuid
  order by t.id
) to stdout with (format csv, header true);
