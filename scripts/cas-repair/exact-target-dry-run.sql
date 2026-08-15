\set ON_ERROR_STOP on
\set QUIET 1
\getenv target_import_id Q5_TARGET_IMPORT_ID

\if :{?target_import_id}
\else
  \echo 'target_import_id is required'
  \quit 2
\endif

begin transaction isolation level repeatable read read only;

with target_guard as (
  -- The primary key guarantees at most one row; division by zero makes a
  -- missing target or cross-owner attribution a hard failure without a temp
  -- table in read-only mode.
  select 1 / case
    when count(*) = 1 and not exists (
      select 1
      from public.transaction as t
      join public.cas_import as owned_import
        on owned_import.id = :'target_import_id'::uuid
      where t.cas_import_id = :'target_import_id'::uuid
        and t.user_id is distinct from owned_import.user_id
    ) then 1
    else 0
  end as value
  from public.cas_import
  where id = :'target_import_id'::uuid
), target_rows as (
  select t.*
  from public.transaction as t
  where t.cas_import_id = :'target_import_id'::uuid
), unrelated_rows as (
  select t.*
  from public.transaction as t
  where t.cas_import_id is distinct from :'target_import_id'::uuid
), manifest as (
  select
    (select count(*)::integer from target_rows) as target_count,
    (select count(distinct fund_id)::integer from target_rows) as touched_scheme_count,
    (select count(*)::integer from unrelated_rows) as unrelated_count,
    coalesce(
      (select encode(digest(string_agg(to_jsonb(row_value)::text, E'\n' order by row_value.id), 'sha256'), 'hex') from target_rows as row_value),
      encode(digest('', 'sha256'), 'hex')
    ) as target_digest,
    coalesce(
      (select encode(digest(string_agg(to_jsonb(row_value)::text, E'\n' order by row_value.id), 'sha256'), 'hex') from unrelated_rows as row_value),
      encode(digest('', 'sha256'), 'hex')
    ) as unrelated_digest
  from target_guard
  where target_guard.value = 1
)
select json_build_object(
  'target_count', target_count,
  'touched_scheme_count', touched_scheme_count,
  'unrelated_count', unrelated_count,
  'target_digest', target_digest,
  'unrelated_digest', unrelated_digest
)::text
from manifest;

rollback;
