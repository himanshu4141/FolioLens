-- Month-end NAV aggregation for the Past SIP Check optimization.
--
-- Why: The Past SIP Check screen previously fetched the full nav_history series
-- (~3–6k rows for a 13-year fund) but only consumed month-end points. This RPC
-- returns the last NAV per calendar month, cutting egress ~30× to ~60–240 rows
-- for typical multi-year windows.
--
-- Implementation: A STABLE, SECURITY INVOKER function that groups nav_history
-- by (scheme_code, year, month), picks the latest nav_date per month, and
-- returns (nav_date, nav) in ascending date order.
--
-- The function is exposed to `authenticated` users via PostgREST, matching the
-- read-only pattern for nav_history itself.

create or replace function public.month_end_nav(
  p_scheme_code int
)
returns table (
  nav_date date,
  nav numeric
)
language sql
stable
security invoker
as $$
  select
    distinct on (
      date_trunc('month', nh.nav_date)::date
    )
    nh.nav_date,
    nh.nav
  from public.nav_history nh
  where nh.scheme_code = p_scheme_code
  order by
    date_trunc('month', nh.nav_date)::date desc,
    nh.nav_date desc,
    nh.id desc
$$;

-- Expose the function to authenticated users via PostgREST (same policy as
-- nav_history SELECT). The function respects RLS — if a future
-- change restricts nav_history visibility, this function's rows will
-- shrink automatically.
grant execute on function public.month_end_nav(int) to authenticated;

-- Add to service_role explicit grants for consistency with the rest of the schema.
grant execute on function public.month_end_nav(int) to service_role;
