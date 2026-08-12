\set ON_ERROR_STOP on
\set QUIET 1
\getenv target_import_id Q5_TARGET_IMPORT_ID
\getenv expected_target_count Q5_EXPECTED_TARGET_COUNT
\getenv expected_target_digest Q5_EXPECTED_TARGET_DIGEST
\getenv expected_unrelated_count Q5_EXPECTED_UNRELATED_COUNT
\getenv expected_unrelated_digest Q5_EXPECTED_UNRELATED_DIGEST
\getenv backup_sha256 Q5_BACKUP_SHA256
\getenv approve_exact_target_delete Q5_APPROVE_EXACT_TARGET_DELETE

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
\if :{?expected_target_digest}
\else
  \echo 'expected_target_digest is required'
  \quit 2
\endif
\if :{?expected_unrelated_count}
\else
  \echo 'expected_unrelated_count is required'
  \quit 2
\endif
\if :{?expected_unrelated_digest}
\else
  \echo 'expected_unrelated_digest is required'
  \quit 2
\endif
\if :{?backup_sha256}
\else
  \echo 'backup_sha256 is required'
  \quit 2
\endif
\if :{?approve_exact_target_delete}
\else
  \echo 'approve_exact_target_delete is required'
  \quit 2
\endif

begin transaction isolation level serializable;

-- A short table lock prevents unrelated concurrent writes from invalidating
-- the approved digest between verification and commit.
lock table public.transaction in share row exclusive mode;

create temporary table q5_approved_manifest on commit drop as
select
  :'target_import_id'::uuid as import_id,
  :'expected_target_count'::integer as target_count,
  :'expected_target_digest'::text as target_digest,
  :'expected_unrelated_count'::integer as unrelated_count,
  :'expected_unrelated_digest'::text as unrelated_digest,
  :'backup_sha256'::text as backup_sha256,
  :'approve_exact_target_delete'::text as approval;

create temporary table q5_approved_backup
  (like public.transaction including defaults) on commit drop;
\copy q5_approved_backup (id, user_id, fund_id, transaction_date, transaction_type, units, nav_at_transaction, amount, folio_number, cas_import_id, cas_event_ordinal, created_at) from program 'cat "$Q5_BACKUP_PLAINTEXT_PATH"' with (format csv, header true)

do $$
declare
  actual_target_count integer;
  actual_unrelated_count integer;
  actual_target_digest text;
  actual_unrelated_digest text;
  expected q5_approved_manifest%rowtype;
  backup_count integer;
  backup_digest text;
begin
  select * into strict expected from q5_approved_manifest;
  if expected.approval <> 'APPROVE_Q5_EXACT_TARGET_DELETE' then
    raise exception using errcode = 'P0001', message = 'q5_immediate_approval_missing';
  end if;
  if expected.target_count <= 0 then
    raise exception using errcode = 'P0001', message = 'q5_target_count_invalid';
  end if;
  if length(expected.backup_sha256) <> 64 then
    raise exception using errcode = 'P0001', message = 'q5_backup_digest_invalid';
  end if;
  if (select count(*) from public.cas_import where id = expected.import_id) <> 1 then
    raise exception using errcode = 'P0001', message = 'q5_target_import_not_unique';
  end if;
  if exists (
    select 1
    from public.transaction as t
    join public.cas_import as owned_import on owned_import.id = expected.import_id
    where t.cas_import_id = expected.import_id
      and t.user_id is distinct from owned_import.user_id
  ) then
    raise exception using errcode = 'P0001', message = 'q5_target_ownership_mismatch';
  end if;

  select
    count(*)::integer,
    coalesce(
      encode(digest(string_agg(to_jsonb(t)::text, E'\n' order by t.id), 'sha256'), 'hex'),
      encode(digest('', 'sha256'), 'hex')
    )
  into backup_count, backup_digest
  from q5_approved_backup as t;

  if backup_count <> expected.target_count
    or backup_digest <> expected.target_digest
    or (select count(distinct cas_import_id) from q5_approved_backup) <> 1
    or exists (
      select 1
      from q5_approved_backup
      where cas_import_id is distinct from expected.import_id
    )
    or exists (
      select 1
      from q5_approved_backup as backup_row
      join public.cas_import as owned_import on owned_import.id = expected.import_id
      where backup_row.user_id is distinct from owned_import.user_id
    )
  then
    raise exception using errcode = 'P0001', message = 'q5_backup_manifest_mismatch';
  end if;

  select
    count(*)::integer,
    coalesce(
      encode(digest(string_agg(to_jsonb(t)::text, E'\n' order by t.id), 'sha256'), 'hex'),
      encode(digest('', 'sha256'), 'hex')
    )
  into actual_target_count, actual_target_digest
  from public.transaction as t
  where t.cas_import_id = expected.import_id;

  select
    count(*)::integer,
    coalesce(
      encode(digest(string_agg(to_jsonb(t)::text, E'\n' order by t.id), 'sha256'), 'hex'),
      encode(digest('', 'sha256'), 'hex')
    )
  into actual_unrelated_count, actual_unrelated_digest
  from public.transaction as t
  where t.cas_import_id is distinct from expected.import_id;

  if actual_target_count <> expected.target_count
    or actual_target_digest <> expected.target_digest
    or actual_unrelated_count <> expected.unrelated_count
    or actual_unrelated_digest <> expected.unrelated_digest
  then
    raise exception using errcode = 'P0001', message = 'q5_approved_manifest_changed';
  end if;
end;
$$;

create temporary table q5_deleted_count on commit drop as
with deleted as (
  delete from public.transaction as t
  using q5_approved_manifest as approved
  where t.cas_import_id = approved.import_id
  returning t.id
)
select count(*)::integer as value from deleted;

do $$
declare
  approved q5_approved_manifest%rowtype;
  deleted_count integer;
  actual_unrelated_count integer;
  actual_unrelated_digest text;
begin
  select * into strict approved from q5_approved_manifest;
  select value into strict deleted_count from q5_deleted_count;
  if deleted_count <> approved.target_count then
    raise exception using errcode = 'P0001', message = 'q5_delete_count_mismatch';
  end if;
  if exists (select 1 from public.transaction where cas_import_id = approved.import_id) then
    raise exception using errcode = 'P0001', message = 'q5_target_rows_remain';
  end if;

  select
    count(*)::integer,
    coalesce(
      encode(digest(string_agg(to_jsonb(t)::text, E'\n' order by t.id), 'sha256'), 'hex'),
      encode(digest('', 'sha256'), 'hex')
    )
  into actual_unrelated_count, actual_unrelated_digest
  from public.transaction as t;

  if actual_unrelated_count <> approved.unrelated_count
    or actual_unrelated_digest <> approved.unrelated_digest
  then
    raise exception using errcode = 'P0001', message = 'q5_unrelated_rows_changed';
  end if;
end;
$$;

select json_build_object(
  'deleted_count', value,
  'unrelated_unchanged', true
)::text
from q5_deleted_count;

commit;
