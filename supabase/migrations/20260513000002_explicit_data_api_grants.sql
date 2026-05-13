-- Make Data API access on every public-schema table/view explicit.
--
-- Why: Supabase is removing the long-standing default that auto-exposes
-- tables in the `public` schema to PostgREST / GraphQL / supabase-js.
-- (Discussion: https://github.com/orgs/supabase/discussions/45329)
--
-- Rollout from the Supabase team:
--   - 2026-04-28: opt-in toggle for new projects
--   - 2026-05-30: new behavior becomes the default for new projects
--   - 2026-10-30: applied to all existing projects
--
-- All our existing tables were created before this change and therefore
-- inherited implicit grants on the `anon` / `authenticated` / `service_role`
-- roles. Once the new behavior reaches our project (or if the project is
-- ever recreated from migrations), Data API access disappears unless we
-- grant it ourselves.
--
-- This migration re-states those grants explicitly so the schema is
-- self-describing and the behavior is identical before and after the
-- Supabase rollout. RLS continues to enforce per-row access — the GRANTs
-- only control which roles can see the table at all.
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

-- ─── User-owned tables ─────────────────────────────────────────────────────
-- RLS already scopes rows to `auth.uid() = user_id`. The grants just make
-- the table visible to the Data API for the `authenticated` role.

grant select, insert, update, delete on public.user_fund            to authenticated;
grant select, insert, update, delete on public.transaction          to authenticated;
grant select, insert, update, delete on public.cas_import           to authenticated;
grant select, insert, update, delete on public.user_profile         to authenticated;
grant select, insert, update, delete on public.cas_inbound_session  to authenticated;
grant select, insert                 on public.user_feedback        to authenticated;

-- ─── Shared / catalog tables (read-only for authenticated) ────────────────
-- RLS allows SELECT to any authenticated user; writes are restricted to the
-- service role, which already has implicit privileges on tables it owns.

grant select on public.nav_history                 to authenticated;
grant select on public.index_history               to authenticated;
grant select on public.benchmark_mapping           to authenticated;
grant select on public.scheme_master               to authenticated;
grant select on public.fund_portfolio_composition  to authenticated;

-- ─── Compatibility view ────────────────────────────────────────────────────
-- `fund` is a security_invoker view joining user_fund + scheme_master. The
-- view defers permission checks to the underlying tables, but the Data API
-- still needs SELECT on the view itself to expose it.

grant select on public.fund to authenticated;

-- ─── service_role ─────────────────────────────────────────────────────────
-- service_role bypasses RLS but still needs table-level privileges. Grant
-- ALL on every Data-API-exposed object so Edge Functions and cron jobs
-- continue to read/write unchanged. (app_config is intentionally excluded
-- because it already lives outside the Data API surface — service_role
-- accesses it directly via its connection, not PostgREST.)

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
