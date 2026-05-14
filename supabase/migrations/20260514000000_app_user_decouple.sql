-- Decouple user-owned tables from `auth.users` by introducing a
-- self-contained `public.app_user` identity table and re-FK-ing every
-- application table onto it.
--
-- Why: today every user-owned table has
--   user_id uuid ... references auth.users(id) on delete cascade
-- which makes the entire public schema structurally dependent on a
-- Supabase-managed table. If we ever migrate auth (Clerk, WorkOS,
-- self-hosted, ...) or the project as a whole, every one of those FKs
-- breaks. Pre-live is the right moment to fix this cheaply.
--
-- Design:
--   - `public.app_user.id` is the same uuid as `auth.users.id`, so RLS
--     policies that read `auth.uid() = user_id` keep working untouched.
--   - `public.app_user` does NOT FK back to `auth.users`. The public
--     schema is now self-contained — the only remaining `auth.*`
--     references are (a) `auth.uid()` in RLS policies and (b) the two
--     sync triggers below. Both are isolated, one-file surface areas
--     to rewrite on exit.
--   - Two triggers on `auth.users` keep `public.app_user` in lockstep:
--       AFTER INSERT → insert
--       AFTER DELETE → delete
--     Inserts and deletes happen via the auth admin API; we don't
--     update auth.users.id, so an UPDATE trigger isn't needed.
--   - Existing FKs to `auth.users(id)` are dropped via a DO block
--     (constraint names are auto-generated and some pre-date the
--     `fund` → `user_fund` rename) and recreated against
--     `public.app_user(id)` with `on delete cascade`. Same semantics,
--     portable target.

-- ─── 1. Identity table ────────────────────────────────────────────────────

create table public.app_user (
  id         uuid primary key,
  created_at timestamptz not null default now()
);

comment on table public.app_user is
  'Application-side identity row, one per auth.users record. Decouples user-owned tables from the auth schema so we can swap auth providers without rewriting every FK. Kept in sync via triggers on auth.users (see handle_auth_user_created / handle_auth_user_deleted).';

-- service_role manages this table directly via the sync triggers;
-- authenticated callers never read it (they already have auth.uid()).
alter table public.app_user enable row level security;

grant all on public.app_user to service_role;

-- ─── 2. Backfill from existing auth.users ────────────────────────────────

insert into public.app_user (id, created_at)
select id, created_at from auth.users
on conflict (id) do nothing;

-- ─── 3. Sync triggers on auth.users ───────────────────────────────────────

create or replace function public.handle_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.app_user (id, created_at)
  values (new.id, coalesce(new.created_at, now()))
  on conflict (id) do nothing;
  return new;
end;
$$;

comment on function public.handle_auth_user_created() is
  'Mirrors new auth.users rows into public.app_user. SECURITY DEFINER so the trigger writes under the postgres role regardless of which role inserted into auth.users (supabase_auth_admin during sign-up).';

create or replace function public.handle_auth_user_deleted()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.app_user where id = old.id;
  return old;
end;
$$;

comment on function public.handle_auth_user_deleted() is
  'Removes the public.app_user mirror row when an auth.users row is deleted. Application tables cascade off public.app_user (not auth.users) so they only need to react to this delete.';

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_auth_user_created();

create trigger on_auth_user_deleted
  after delete on auth.users
  for each row execute function public.handle_auth_user_deleted();

-- ─── 4. Re-FK every user-owned public table ───────────────────────────────
-- Constraint names are auto-generated and a few pre-date the `fund` →
-- `user_fund` rename, so resolve them dynamically rather than hard-coding.
-- For each FK from public.* into auth.users(id): drop it, then add an
-- equivalent FK into public.app_user(id) with `on delete cascade`.

do $$
declare
  fk record;
  new_constraint_name text;
begin
  for fk in
    select
      conrelid::regclass::text  as table_name,
      conname                   as constraint_name,
      pg_get_constraintdef(oid) as definition,
      (select attname from pg_attribute
        where attrelid = conrelid and attnum = conkey[1]) as column_name
    from pg_constraint
    where contype = 'f'
      and connamespace = 'public'::regnamespace
      and confrelid = 'auth.users'::regclass
  loop
    execute format(
      'alter table %s drop constraint %I',
      fk.table_name, fk.constraint_name
    );

    -- Preserve the original constraint name so error messages and any
    -- introspection that pattern-matches on `_user_id_fkey` keep working.
    new_constraint_name := fk.constraint_name;

    execute format(
      'alter table %s add constraint %I foreign key (%I) references public.app_user(id) on delete cascade',
      fk.table_name, new_constraint_name, fk.column_name
    );
  end loop;
end;
$$;

-- ─── 5. Sanity check ──────────────────────────────────────────────────────
-- Verify no public-schema FK still points at auth.users. Raises an error
-- inside the migration transaction if anything was missed.

do $$
declare
  remaining int;
begin
  select count(*)
    into remaining
    from pg_constraint
    where contype = 'f'
      and connamespace = 'public'::regnamespace
      and confrelid = 'auth.users'::regclass;

  if remaining > 0 then
    raise exception
      'app_user decouple: % public FK(s) still reference auth.users', remaining;
  end if;
end;
$$;
