-- Opt in to Supabase's new "no auto-exposure" Data API default, today.
--
-- Why: Supabase is removing the long-standing default that auto-exposes
-- tables in the `public` schema to PostgREST / GraphQL / supabase-js.
-- (Discussion: https://github.com/orgs/supabase/discussions/45329)
--
-- Rollout from the Supabase team:
--   - 2026-04-28: opt-in toggle for new projects
--   - 2026-05-30: new behavior becomes the default for new projects
--   - 2026-10-30: applied to all existing projects (us)
--
-- We could wait until October and just add explicit GRANTs — but then the
-- GRANTs would be masked by the legacy implicit grants until the switchover,
-- and a missing GRANT on a future table would silently work in development
-- and break in October. Flipping the behavior now (this migration) makes
-- the explicit GRANTs load-bearing today, so any missing grant fails loudly
-- in staging the moment it's introduced.
--
-- This migration does three things, in order:
--   1. Stops future implicit grants by stripping the default-privileges
--      entries Supabase pre-installed on the `public` schema.
--   2. Revokes the implicit grants already attached to every existing
--      public-schema object from `anon` / `authenticated`. (service_role
--      is intentionally untouched — it bypasses RLS and we want it to
--      keep working.)
--   3. Re-grants exactly the access each table needs, by role.
--
-- Convention going forward (see AGENTS.md → "Supabase migrations"):
--   - User-owned tables (RLS by user_id): grant SELECT, INSERT, UPDATE,
--     DELETE to `authenticated`. RLS does the per-row gating.
--   - Shared read-only tables (catalog / reference data): grant SELECT
--     to `authenticated`. Writes go through the service role.
--   - Service-role-only tables (e.g. `app_config`): no grants. RLS has
--     no policy, so only `postgres` / `service_role` can read or write.
--   - We never grant to `anon` — there is no anonymous surface area in
--     the app today.

-- ─── 1. Stop future implicit grants ───────────────────────────────────────
-- ALTER DEFAULT PRIVILEGES only affects objects created *after* this runs.
-- We cover both `postgres` (default owner for our migrations) and
-- `supabase_admin` (Supabase's internal role that originally installed
-- the implicit grants) so new tables don't silently re-inherit them.

alter default privileges for role postgres       in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres       in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres       in schema public revoke all on routines  from anon, authenticated;
alter default privileges for role supabase_admin in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role supabase_admin in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role supabase_admin in schema public revoke all on routines  from anon, authenticated;

-- ─── 2. Strip implicit grants from existing objects ───────────────────────
-- Wipes the slate for `anon` and `authenticated` so the GRANTs below are
-- the only thing standing between those roles and our tables. Functions
-- and sequences are revoked too: we don't expose any RPCs to `anon` /
-- `authenticated` today, and we use UUID PKs rather than serial columns.
-- service_role is left alone — it bypasses RLS and Edge Functions /
-- cron jobs depend on its full access.

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all routines  in schema public from anon, authenticated;

-- ─── 3a. User-owned tables ────────────────────────────────────────────────
-- RLS already scopes rows to `auth.uid() = user_id`. The grants just make
-- the table visible to the Data API for the `authenticated` role.

grant select, insert, update, delete on public.user_fund            to authenticated;
grant select, insert, update, delete on public.transaction          to authenticated;
grant select, insert, update, delete on public.cas_import           to authenticated;
grant select, insert, update, delete on public.user_profile         to authenticated;
grant select, insert, update, delete on public.cas_inbound_session  to authenticated;
grant select, insert                 on public.user_feedback        to authenticated;

-- ─── 3b. Shared / catalog tables (read-only for authenticated) ────────────
-- RLS allows SELECT to any authenticated user; writes are restricted to the
-- service role, which keeps its implicit privileges from step 2.

grant select on public.nav_history                 to authenticated;
grant select on public.index_history               to authenticated;
grant select on public.benchmark_mapping           to authenticated;
grant select on public.scheme_master               to authenticated;
grant select on public.fund_portfolio_composition  to authenticated;

-- ─── 3c. Compatibility view ───────────────────────────────────────────────
-- `fund` is a security_invoker view joining user_fund + scheme_master. The
-- view defers row checks to the underlying tables, but the Data API still
-- needs SELECT on the view itself to expose it.

grant select on public.fund to authenticated;

-- ─── 3d. service_role belt-and-suspenders ─────────────────────────────────
-- service_role's implicit grants were not revoked in step 2, but re-state
-- them explicitly so the schema is self-describing and a future REVOKE on
-- service_role doesn't silently break Edge Functions / cron jobs.
-- (app_config is intentionally excluded — it lives outside the Data API
-- surface; service_role accesses it via its connection, not PostgREST.)

grant all on public.user_fund                   to service_role;
grant all on public.transaction                 to service_role;
grant all on public.cas_import                  to service_role;
grant all on public.user_profile                to service_role;
grant all on public.cas_inbound_session         to service_role;
grant all on public.user_feedback               to service_role;
grant all on public.nav_history                 to service_role;
grant all on public.index_history               to service_role;
grant all on public.benchmark_mapping           to service_role;
grant all on public.scheme_master               to service_role;
grant all on public.fund_portfolio_composition  to service_role;
grant all on public.fund                        to service_role;
