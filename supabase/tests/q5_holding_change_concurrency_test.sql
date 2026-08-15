begin;

create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;

select extensions.plan(3);

select extensions.dblink_connect(
  'q5_writer',
  'hostaddr=' || host(inet_server_addr()) ||
    ' port=5432 dbname=' || current_database() ||
    ' user=postgres password=postgres'
);
select extensions.dblink_connect(
  'q5_runner',
  'hostaddr=' || host(inet_server_addr()) ||
    ' port=5432 dbname=' || current_database() ||
    ' user=postgres password=postgres'
);

-- Deterministic cleanup makes the fixture safe after an interrupted prior run.
select extensions.dblink_exec(
  'q5_writer',
  $$delete from public.cas_import where id = '00000000-0000-0000-0000-000000005301'::uuid$$
);
select extensions.dblink_exec(
  'q5_writer',
  $$delete from public.user_fund where id = '00000000-0000-0000-0000-000000005201'::uuid$$
);
select extensions.dblink_exec(
  'q5_writer',
  $$delete from public.scheme_master where scheme_code = 987654321$$
);
select extensions.dblink_exec(
  'q5_writer',
  $$delete from public.app_user where id = '00000000-0000-0000-0000-000000005101'::uuid$$
);

select extensions.dblink_exec(
  'q5_writer',
  $$insert into public.app_user (id) values ('00000000-0000-0000-0000-000000005101'::uuid)$$
);
select extensions.dblink_exec(
  'q5_writer',
  $$insert into public.scheme_master (scheme_code, scheme_name, scheme_category)
    values (987654321, 'Q5 concurrency fixture', 'Synthetic')$$
);
select extensions.dblink_exec(
  'q5_writer',
  $$insert into public.user_fund (id, user_id, scheme_code, is_active)
    values (
      '00000000-0000-0000-0000-000000005201'::uuid,
      '00000000-0000-0000-0000-000000005101'::uuid,
      987654321,
      true
    )$$
);
select extensions.dblink_exec(
  'q5_writer',
  $$insert into public.cas_import (id, user_id, import_source, import_status)
    values (
      '00000000-0000-0000-0000-000000005301'::uuid,
      '00000000-0000-0000-0000-000000005101'::uuid,
      'pdf',
      'pending'
    )$$
);

select extensions.dblink_exec('q5_writer', 'begin');
select extensions.dblink_exec(
  'q5_writer',
  $sql$do $lock$
    begin
      perform pg_advisory_xact_lock(
        hashtextextended(
          '00000000-0000-0000-0000-000000005101:987654321',
          0
        )
      );
    end;
  $lock$;$sql$
);
select extensions.dblink_exec(
  'q5_writer',
  $$update public.user_fund
    set is_active = false
    where id = '00000000-0000-0000-0000-000000005201'::uuid$$
);

create temporary table q5_runner_backend (pid integer not null) on commit drop;
insert into q5_runner_backend (pid)
select pid
from extensions.dblink('q5_runner', 'select pg_backend_pid()') as result(pid integer);

select extensions.dblink_send_query(
  'q5_runner',
  $query$
    select public.apply_cas_import_plans_v3(
      '00000000-0000-0000-0000-000000005101'::uuid,
      '00000000-0000-0000-0000-000000005301'::uuid,
      '[{
        "scheme_code": 987654321,
        "provisional_scheme_name": "Q5 concurrency fixture",
        "expected_fund_id": "00000000-0000-0000-0000-000000005201",
        "expected_transaction_ids": [],
        "delete_ids": [],
        "inserts": [],
        "closing_units": 1,
        "closing_balance_is_current": true
      }]'::jsonb
    )::text
  $query$
);

do $$
declare
  attempt integer;
begin
  for attempt in 1..100 loop
    exit when exists (
      select 1
      from pg_stat_activity
      where pid = (select q5_runner_backend.pid from q5_runner_backend)
        and wait_event_type = 'Lock'
        and wait_event = 'advisory'
    );
    perform pg_sleep(0.01);
  end loop;
end;
$$;

select extensions.ok(
  exists (
    select 1
    from pg_stat_activity
    where pid = (select q5_runner_backend.pid from q5_runner_backend)
      and wait_event_type = 'Lock'
      and wait_event = 'advisory'
  ),
  'v3 waits on the scheme lock before capturing holding state'
);

select extensions.dblink_exec('q5_writer', 'commit');

create temporary table q5_runner_result (payload jsonb not null) on commit drop;
insert into q5_runner_result (payload)
select payload::jsonb
from extensions.dblink_get_result('q5_runner') as result(payload text);

select extensions.is(
  (select (payload ->> 'holding_changed_count')::integer from q5_runner_result),
  1,
  'duplicate-only v3 reports the holding change committed before its locked snapshot'
);

select extensions.is(
  (
    select is_active
    from extensions.dblink(
      'q5_writer',
      $$select is_active
        from public.user_fund
        where id = '00000000-0000-0000-0000-000000005201'::uuid$$
    ) as result(is_active boolean)
  ),
  true,
  'the import applies the current positive closing balance after the concurrent writer'
);

select extensions.dblink_exec(
  'q5_writer',
  $$delete from public.cas_import where id = '00000000-0000-0000-0000-000000005301'::uuid$$
);
select extensions.dblink_exec(
  'q5_writer',
  $$delete from public.user_fund where id = '00000000-0000-0000-0000-000000005201'::uuid$$
);
select extensions.dblink_exec(
  'q5_writer',
  $$delete from public.scheme_master where scheme_code = 987654321$$
);
select extensions.dblink_exec(
  'q5_writer',
  $$delete from public.app_user where id = '00000000-0000-0000-0000-000000005101'::uuid$$
);

select extensions.dblink_disconnect('q5_runner');
select extensions.dblink_disconnect('q5_writer');

select * from extensions.finish();

rollback;
