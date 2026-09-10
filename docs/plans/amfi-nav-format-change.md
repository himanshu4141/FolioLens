# ExecPlan: AMFI NAV feed format change — downstream hardening

Status: Proposed (incident-driven; M1 is urgent)
Date: 2026-09-10
Branch: `claude/amfi-nav-format-change-rjxuuq`
Related: OpenFolio-Data `docs/SPEC-PHASE-6-amfi-nav-feed-v2.md` (upstream fix — ships first),
`docs/plans/openfolio-nav-metadata-integration.md` (how NAV/metadata reach FolioLens),
`docs/INFRASTRUCTURE.md` § Runbook: Freshness check.


## Goal


Keep held-fund NAVs, scheme identity (plan/option/family), and the daily silent-failure audit
correct through AMFI's NAV download format change, and make sure the app degrades to the backup
source *by design* when OpenFolio goes stale — not by accident, as it did this time.


## User Value


- Portfolio value, returns and the Fund Detail NAV chart stay current even when the upstream
  feed breaks. Between ~19 Aug and 10 Sep 2026 held NAVs sat at 18 Aug for most users.
- Compare Funds and Direct vs Regular keep pairing Direct/Regular plans correctly once AMFI stops
  putting the plan in the scheme name.
- The founder actually receives the freshness alert email. Today it is sent to a 404.


## Context


### What AMFI changed (verified live 2026-09-10)

AMFI's NAV downloads now have eight columns instead of six. `Scheme Name` is the family name only;
two new columns `Plan` (`Direct Plan` / `Regular Plan` / blank) and `Option` (free text: `Growth`,
`IDCW Option`, `IDCW-Re-investment`, …) carry what used to be the name tail. The old layout is
served as `Original_NAVAll.txt` **only until 30 September 2026**. `www.amfiindia.com/spages/NAVAll.txt`
now redirects to `portal.amfiindia.com/spages/NAVAll.txt` (new layout). The history report changed too.
Full column tables live in the OpenFolio spec linked above.

    Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date
    119551;INF209KA12Z1;INF209KA13Z9;Aditya Birla Sun Life Banking & PSU Debt Fund;Direct Plan;IDCW-Re-investment;107.2309;09-Sep-2026

### What it did to us (from Supabase logs, 2026-09-10)

1. **OpenFolio froze.** Its positional parser returned zero rows, the daily job "skipped upsert"
   but exited successfully, so no alert fired. `/health.db_nav_latest` has been `2026-08-18`.
2. **`sync-nav` believed OpenFolio.** The freshness gate (`_shared/nav-since-map.ts`) treats a held
   scheme as "current" when its local latest date ≥ OpenFolio's `db_nav_latest`. With upstream stuck
   at 18 Aug, the 02:30 UTC run today reported `current=33 stale=1 missing=1` and synced 2 schemes.
   Held NAVs were three weeks stale and the app showed no sign of it.
3. **Recovery was accidental.** The 04:30 UTC run saw `missing=35` (the since-map lookup returned
   nothing), routed every scheme to the fallback, got `HTTP 500` / timeouts from OpenFolio's
   `/v1/nav/{code}`, and pulled 16 new rows per scheme from mfapi.in. Held NAVs are now at 9 Sep —
   because two other things broke, not because the gate worked.
4. **The alert never arrived.** `freshness-check` reported `passed=4 failed=1` every day but its
   forward to `ROUTER_FRESHNESS_ALERT_URL` (`https://app.foliolens.in/api/freshness-alert`) returns
   `404 NOT_FOUND`. There is no `api/freshness-alert` handler in this repo.

### Code in this repo that touches the feed or its shape

| Where | Today | Exposure |
|---|---|---|
| `supabase/functions/sync-nav/index.ts` + `_shared/nav-since-map.ts` | Gate on `db_nav_latest`; fallback to mfapi only on OpenFolio 404/error/missing | Stale-but-healthy upstream = frozen NAVs (the bug above) |
| `supabase/functions/fetch-fund-nav/index.ts` | 3-day short-circuit → OpenFolio `since` → mfapi on 404/error/empty-first-sync | Incremental fetch from a frozen upstream returns "no new points" and is treated as up to date |
| `supabase/functions/freshness-check/index.ts` + `_shared/freshness-check.ts` | Checks held NAV age, cron failures, cursors, OpenFolio `/health`, composition staleness; alert via router | Router route missing → alerts lost; no check on OpenFolio `db_nav_latest` *age* |
| `api/_cdsl_nsdl_parser.py::fetch_amfi_isin_map` | Fetches `www.amfiindia.com/spages/NAVAll.txt`, positional `parts[3]` name, ISINs at 1/2, `len(parts) < 6` guard | Still parses (8 ≥ 6, ISIN/name positions unchanged) but `scheme_name` is now family-only and the URL is a redirect that may vanish; test fixture is old layout |
| `supabase/functions/seed-scheme-master/index.ts::detectPlanType/inferAmcName`, `sync-fund-meta` (`parseMfapiSchemeIdentity`) | Name parsing on mfapi.in names | mfapi.in still emits old-style long names (09 Sep). If it moves to the new layout after 30 Sep, plan detection yields null |
| `universe-backfill`, `sync-fund-meta` | Write OpenFolio `family_name` / `plan_type` / `option_type` only when non-null | Safe by construction; OpenFolio M1 will populate from AMFI's columns |
| `scheme_active` (fund view, `fundSearch.ts`, `navUtils.ts`, `usePortfolio.ts`) | `true` = seen in AMFI NAVAll within 30 days (from OpenFolio) | If OpenFolio's NAV is not repaired by ~17 Sep, every scheme flips `false` → matured badges everywhere, search ordering inverted |


## Assumptions


- OpenFolio Phase 6 M0 (header-driven parser + non-zero exit + gap repair) lands before 13 Sep;
  this plan's M1 does not depend on it, M3 does.
- mfapi.in remains available as the backup NAV source through and after 30 Sep. If it breaks,
  see Decision Log D3.
- No React Query / Zustand / AsyncStorage / SQLite cache shape changes: all work is server-side
  (Edge Functions, Python API) plus tests. `nav_history` rows only get fresher. State this in the PR
  per the cache rules; no `docs/architecture/cache-surfaces.md` update needed.


## Definitions


- **Freshness gate** — the pre-check in `sync-nav` that decides which held schemes need a fetch by
  comparing each scheme's latest local `nav_date` with OpenFolio's `db_nav_latest`.
- **Trading-day age** — number of Indian market days between a date and today (weekends excluded;
  holidays approximated by a fixed tolerance, see M1).
- **Old / new layout** — the 6-column vs 8-column AMFI text file described above.


## Scope


- Edge Functions: `sync-nav`, `fetch-fund-nav`, `freshness-check` and their `_shared` helpers.
- Python: `api/_cdsl_nsdl_parser.py` and its tests.
- Docs: `docs/INFRASTRUCTURE.md` (cron table rows for `sync-nav` / `freshness-check`, runbook), this plan.
- Analytics: extend the existing `sync-nav` `sync_completed` payload (see M1); no new event family.


## Out of Scope


- Parsing AMFI files inside FolioLens as a NAV source (official-source ingestion lives in OpenFolio).
- UI changes. Any plan/option label fix is upstream data.
- Cache invalidation changes.


## Approach


Treat OpenFolio as *possibly stale even when healthy*. A `db_nav_latest` older than N trading days
means the upstream is not a valid "current" bar; the gate must then fall through to per-scheme
sync with mfapi as the source, and the audit must say so out loud.


## Alternatives Considered


- **Always sync from both sources and take the newer row.** Doubles mfapi traffic for ~no gain on
  normal days; rejected. The age-aware gate keeps the cheap path when upstream is genuinely fresh.
- **Add a direct AMFI `NAVAll.txt` reader to `sync-nav` as a last resort.** Feasible (1.5 MB fetch,
  header-driven parse of ~14k lines) but duplicates OpenFolio and the "official-sources-only lives
  upstream" decision. Parked as D3, only if mfapi dies after 30 Sep.


## Milestones


### M1 — Age-aware freshness gate + working alerts (urgent, this week)

Scope:
1. `_shared/nav-since-map.ts::evaluateOpenFolioNavFreshnessGate` gains a `today` input and a
   `maxUpstreamAgeTradingDays` (default 2). If `db_nav_latest` is older than that, return
   `shouldSkip=false`, `upstreamStale=true`, and put every held scheme whose local latest is also
   older than the threshold into `syncSchemeCodes`. `sync-nav` then routes those schemes straight to
   mfapi (skip the OpenFolio delta call when `upstreamStale`), logging `[sync-nav] upstream stale
   age_days=N — routing N schemes to mfapi`.
2. `fetch-fund-nav`: when the incremental OpenFolio fetch returns no new points **and** the local
   latest is older than the threshold, fall through to mfapi instead of declaring "up to date".
3. `freshness-check`: new check `openfolio_nav_age` — fail when `db_nav_latest` is older than 3
   calendar days on a weekday. Fix delivery: either add the `api/freshness-alert` Vercel handler
   (mirror `feedback-notify.py`: verify HMAC, send via Resend) or point `ROUTER_FRESHNESS_ALERT_URL`
   at the existing router; add a startup log line that names the resolved URL. Add a test that the
   alert payload includes each failed check's name and detail.
4. Analytics: `sync_completed` payload gains `upstream_stale` (boolean) and `upstream_age_bucket`
   (`0-1`, `2-3`, `4-7`, `8+` days). Both low-cardinality, no identifiers; extend the sanitizer test.
5. Tests: gate tests for (a) upstream fresh → unchanged behaviour, (b) upstream 5 days old → all
   held schemes routed, (c) upstream missing → unchanged behaviour; `fetch-fund-nav` fall-through
   test; freshness-check age test. Run the full Jest suite (shared hooks/data access are touched).

Expected outcome: with OpenFolio still frozen, an hourly `sync-nav` run inserts the day's NAVs
from mfapi for every held scheme; the 08:00 UTC audit sends one email naming `openfolio_nav_age`.

Commands:

    npm run typecheck && npm run lint && npm test -- --runInBand
    supabase functions deploy sync-nav fetch-fund-nav freshness-check --no-verify-jwt

Acceptance: logs show `upstream stale` routing on the next cron; email received; `max(nav_date)`
for held funds = last trading day.

### M2 — AMFI parser and name-derived identity hardening

1. `api/_cdsl_nsdl_parser.py`: read the header row and map columns by name; compose `scheme_name`
   as `"<Scheme Name> - <Plan> - <Option>"` when the new columns exist (keeps the provisional-identity
   display shape); move `AMFI_NAV_URL` to `https://portal.amfiindia.com/spages/NAVAll.txt`.
   Add a new-layout sample to `api/tests/test_fetch_amfi_isin_map.py` and keep the old one.
2. `seed-scheme-master::detectPlanType` and `sync-fund-meta::parseMfapiSchemeIdentity`: also accept
   `Direct Plan` / `Regular Plan` tokens without the ` - ` separator and treat a family-only name as
   `plan_type=null` (never guess). Unit tests for both shapes.
3. `docs/INFRASTRUCTURE.md`: update the `sync-nav`, `fetch-fund-nav`, `freshness-check` rows and the
   freshness runbook (new check, alert route).

Acceptance: Python + Jest tests green on both layouts; a CAS import with a CDSL/NSDL statement still
resolves ISINs to scheme codes.

### M3 — Consume OpenFolio Phase 6 output (after upstream M0/M1 ship)

1. Trigger `universe-backfill` (workflow_dispatch) and `sync-fund-meta` once OpenFolio serves
   `plan_type` / `option_type` from AMFI's columns; spot-check Direct vs Regular pairing for five
   families and `planOptionLabel` on Fund Detail.
2. Verify `scheme_active` is `true` again for held funds and search ordering is normal.
3. Verify `family_name` did not churn for held funds (compare `scheme_master.family_name` before /
   after; expect zero diffs).
4. Manual smoke of the freshness gate now that upstream is fresh: `upstream_stale=false`, delta path
   used, mfapi fallback count ≈ 0.

### M4 — Post-30-Sep check

1. On 1 Oct: confirm mfapi.in still returns data and plan-bearing names for two held schemes; confirm
   `fetch_amfi_isin_map` still loads (> 10,000 ISINs). If mfapi has broken, open D3.


## Validation


- `npm run typecheck`, `npm run lint`, `npm test -- --runInBand` (full run: shared data access touched).
- `cd api && python -m pytest tests/test_fetch_amfi_isin_map.py -q`.
- After deploy: Supabase logs for `[sync-nav] upstream stale`, `[freshness-check] summary passed=… failed=…`
  followed by a `200` from the alert route, and `select max(nav_date) from nav_history where scheme_code in (held)`.


## Risks And Mitigations


- **Trading-day maths misfires on holidays** → threshold of 2 trading days plus a 1-day tolerance;
  a false "stale" only costs one mfapi sweep, never data loss.
- **mfapi.in changes or dies after 30 Sep** → D3; until then it is the only backup, so M1 must not
  make it the *primary*: the age-aware gate still prefers OpenFolio when fresh.
- **Alert route change needs Vercel env / deploy** → verify with a forced-failure POST from the runbook.
- **OpenFolio `HTTP 500` on `/v1/nav/{code}`** → upstream owns it; FolioLens already falls back on error.


## Decision Log


- D1 (2026-09-10): Gate on upstream *age*, not just presence. Presence-only gating is what froze NAVs.
- D2 (2026-09-10): No FolioLens-side AMFI ingestion. Official-source parsing stays in OpenFolio.
- D3 (open): If mfapi.in breaks after 30 Sep, decide between (a) direct `portal.amfiindia.com`
  NAVAll read in `sync-nav` for held schemes only, or (b) relying solely on OpenFolio with the new
  age alert. Default lean: (b), since OpenFolio now fails loudly.


## Progress


- [ ] M1.1 age-aware gate + mfapi routing in `sync-nav`
- [ ] M1.2 `fetch-fund-nav` stale fall-through
- [ ] M1.3 `freshness-check` age check + working alert delivery
- [ ] M1.4 analytics fields + sanitizer test
- [ ] M1.5 tests green, functions deployed, first stale-routing run observed
- [ ] M2.1 header-driven `fetch_amfi_isin_map` + fixtures + portal URL
- [ ] M2.2 plan-type detection hardening
- [ ] M2.3 INFRASTRUCTURE.md updates
- [ ] M3 consume OpenFolio Phase 6 (backfill, pairing, `scheme_active`, family_name diff)
- [ ] M4 post-30-Sep check
