# Phase 9 M5 — CDN snapshots for benchmark index history


## Goal


After this milestone, the three benchmark indices (Nifty 50 TRI, Nifty 100 TRI, Nifty 500 TRI) serve their full history as static JSON files from Supabase Storage's public CDN, and every screen that needs index history fetches the snapshot in a single round-trip instead of paginating through `index_history` via PostgREST.


## User Value


For a returning user on Portfolio:

- Today the `^NIFTY500TRI` benchmark fetch paginates ~2,000–8,000 rows through PostgREST. Cold cache: 2–8 paginated round trips, ~1–4s.
- After this milestone: one CDN GET, edge-cached, ~30–80ms globally. Same payload size after gzip (~50–100 KB).

The win is structural: benchmark history is **identical for every user**, never user-scoped, and changes only once per business day (after `sync-index` runs at 1:45 PM UTC). Serving it as a static blob is the textbook fit.


For the founder: PostgREST egress on `index_history` SELECTs drops to roughly zero. Supabase Storage egress is comparable per-byte but the CDN edge cache means most reads never touch the origin.


## Context


This is the lighter cousin of the SQLite read cache (PR #136). PR #136 builds a per-device offline cache that's incrementally maintained. M5 ships a global edge-cached snapshot that's regenerated server-side once per day and consumed by every client. The two compose: the SQLite layer in PR #136 can be seeded from the snapshot on cold start instead of from a paginated `index_history` SELECT.

The pattern is not "bundle data with the app". Bundling has known drawbacks (bundle bloat, OTA-fresh impossible, wasted bytes on funds the user doesn't hold). A daily-refreshed CDN file gives the same first-load speed without those costs and updates without app rebuilds.


## Assumptions


- Supabase Storage's public buckets serve via CloudFront-style CDN with configurable `Cache-Control`. Default is 3600s; we'll set 3600s + `stale-while-revalidate=86400` so a stale snapshot keeps serving while a background refresh happens.
- The three tracked benchmarks (`^NSEITRI`, `^NIFTY100TRI`, `^NIFTY500TRI`) cover every user's needs today. Adding a new benchmark = one line in the edge function's allowlist.
- `sync-index` runs at 1:45 PM UTC (7:15 PM IST) on weekdays. The snapshot regeneration runs at 2:00 PM UTC (7:30 PM IST), 15 minutes after, so it picks up the day's new close.
- A snapshot of `^NIFTY500TRI` covers ~2,000 trading days × ~30 bytes per row JSON ≈ 60 KB raw, ~15 KB gzipped. Trivial.
- Network failures on the snapshot fetch fall back to the existing `index_history` SELECT. The CDN is an accelerator, not a single point of failure.


## Definitions


- **Snapshot**: the JSON file at `https://<project>.supabase.co/storage/v1/object/public/<bucket>/<symbol>.json`. Shape: `{ symbol, generated_at, points: Array<{ date, value }> }`.
- **Bucket**: a Supabase Storage container. We use a single public bucket `static-snapshots` for all generated artefacts (today: index snapshots; future: top-fund NAV snapshots, scheme_master snapshots).
- **Read-through**: the app's `fetchIndexHistory(symbol)` tries the snapshot first; on 404 / parse error / network failure, falls back to the `index_history` SELECT it used to do. The pattern matches the SQLite read-through in PR #136.


## Scope


In:

- A new `static-snapshots` public Supabase Storage bucket (created via migration).
- A new edge function `regenerate-index-snapshots` that reads `index_history`, builds JSON, uploads to the bucket. One call per scheduled run regenerates all tracked symbols.
- A `pg_cron` schedule wired to invoke the function daily at 14:00 UTC on weekdays.
- An app-side `fetchIndexSnapshot(symbol)` helper that GETs the JSON with proper error handling, plus a React Query wrapper for the cache.
- Wiring the three call sites that currently SELECT from `index_history`:
    - `fetchPortfolioData` (benchmark for `marketXirr`)
    - `fetchAllIndexRows` inside `useInvestmentVsBenchmarkTimeline`
    - `app/fund/[id].tsx` index query
- Tests for the helper.

Out:

- Top-fund NAV snapshots. Mentioned in the bigger conversation but deferred — bigger payload (~1 MB total for top 50 funds), more nuanced cron, and most users don't hold the "top funds". Save for a follow-up.
- Bundle-time inclusion. Explicitly chose CDN over bundling — see context.
- A Vercel-hosted variant. Supabase Storage already has a global CDN; adding a Vercel route on top would duplicate infrastructure.


## Out of Scope


- Cache invalidation when a user requests a manual sync. The CDN's `max-age` + `stale-while-revalidate` is the freshness contract; users who want today's exact close can hit the read-through fallback (Settings → Data Sync → Sync now invalidates the React Query cache layer, which forces the next read to refetch the CDN snapshot).
- Multi-region replication. Supabase Storage already serves from a global CDN; an additional Cloudflare layer would add latency for no measurable benefit.
- Generating snapshots from any source other than `index_history`. The bucket file is a literal projection of the table.


## Approach


### Layer 1 — Supabase Storage bucket


Migration creates a public `static-snapshots` bucket with no row-level restrictions. Files inside are world-readable by anyone with the URL. `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` set per-upload.

The bucket name is intentionally future-proof — a single bucket can hold:

    static-snapshots/
      index/
        nseitri.json
        nifty100tri.json
        nifty500tri.json
      (future: fund-nav/<scheme_code>.json, scheme-master.json, etc.)


### Layer 2 — `regenerate-index-snapshots` edge function


For each symbol in the allowlist:

1. `SELECT index_date, close_value FROM index_history WHERE index_symbol = ? ORDER BY index_date ASC` (paginated through the 1000-row PostgREST limit).
2. Build JSON: `{ symbol, generated_at: ISO8601, points: [{ date, value }] }`.
3. Upload to `static-snapshots/index/<lowercased-symbol-without-^>.json` with `cache-control: public, max-age=3600, stale-while-revalidate=86400`.
4. Track per-symbol summary in the function's response: `{ symbol, rows, bytes, ok }`.

If any symbol fails, the function still completes the others and returns an aggregate. `analytics.track('snapshot_regenerated', {...})` for observability.

Deployed with `--no-verify-jwt` so `pg_cron` can call it.


### Layer 3 — pg_cron schedule


Migration adds a weekday cron at 14:00 UTC (7:30 PM IST, 15 min after `sync-index`). Schedule:

    SELECT cron.schedule(
      'regenerate-index-snapshots-daily',
      '0 14 * * 1-5',
      $$ ... net.http_post(...) ... $$
    );


### Layer 4 — App-side helper


New `src/hooks/useIndexSnapshot.ts` exporting:

    export interface IndexSnapshot {
      symbol: string;
      generated_at: string;
      points: Array<{ date: string; value: number }>;
    }

    export async function fetchIndexSnapshot(symbol: string): Promise<IndexSnapshot | null>;

The helper:

1. Builds the URL from `EXPO_PUBLIC_SUPABASE_URL` + bucket path.
2. Issues a plain `fetch()` (no Supabase client — the file is public).
3. Returns the parsed JSON, or `null` on 404 / parse error / network timeout.
4. `perfStart` / `perfEnd` around the fetch for observability.

A `useIndexSnapshot(symbol)` React Query hook with key `['index-snapshot', symbol]`, persisted, staleTime 6h.

The three existing call sites get a small wrapper `fetchIndexHistory(symbol, sinceDate?)` that:

1. Tries `fetchIndexSnapshot(symbol)` first.
2. On success: returns the points filtered to `sinceDate` if given.
3. On null: falls back to the existing paginated `index_history` SELECT.

Each call site replaces its current SELECT with `fetchIndexHistory`.


## Alternatives Considered


- **Bundle JSON in the app.** Cleanest perceived UX but: bundle bloats ~150 KB per index for 8-year history, OTA can't ship updates, snapshot goes stale on app install. Rejected in conversation.
- **Vercel-hosted JSON with Vercel Cron.** Same end-result. Adds a second infra surface (`foliolens-site` repo + Vercel cron + Supabase service-role key in Vercel env). Supabase Storage gives the same CDN with one less moving part.
- **Inline the snapshot generation into `sync-index`.** Couples ingest with serving. Failed snapshot upload would make `sync-index` flaky. Keeping them as separate cron jobs lets each fail independently.
- **`Cache-Control: public, immutable`.** The snapshot is named without a hash so we can't mark it immutable; we'd need cache busting via query string and that adds friction at every call site. The `max-age + stale-while-revalidate` model is good enough.


## Milestones


### M5.1 — Storage bucket migration


Scope: a single migration `<timestamp>_create_static_snapshots_bucket.sql` that creates the public `static-snapshots` bucket. Idempotent.

Outcome: bucket visible in Supabase Dashboard → Storage. `curl https://<project>.supabase.co/storage/v1/object/public/static-snapshots/` returns the bucket listing (or empty).

Commands:

    supabase db push   # apply on dev


### M5.2 — `regenerate-index-snapshots` edge function


Scope: function at `supabase/functions/regenerate-index-snapshots/index.ts`. Reuses `_shared/supabase-client.ts` and `_shared/cors.ts` patterns. Allowlist is a constant `TRACKED_SYMBOLS = ['^NSEITRI', '^NIFTY100TRI', '^NIFTY500TRI']`.

Deployed via the MCP `deploy_edge_function` tool (per memory rule — CLI deploy hits JSR 403 in Docker, and the function's `../_shared/` imports need rewriting to `./_shared/` when uploading via MCP).

Outcome: manual invoke from the dashboard regenerates all three files. `curl <bucket>/index/nseitri.json` returns parseable JSON.


### M5.3 — pg_cron schedule


Scope: migration `<timestamp>_regenerate_index_snapshots_cron.sql` that adds the schedule.

Outcome: `cron.job` table shows the new entry. Manually `select net.http_post(...)` confirms invocation works.


### M5.4 — App-side helper + tests


Scope: `src/hooks/useIndexSnapshot.ts` with `fetchIndexSnapshot` + `useIndexSnapshot` + `fetchIndexHistory` wrapper. Jest tests using a mocked `fetch`.

Acceptance: lines coverage 95%+ on the new file. Cold and warm fetch tests, plus 404 fallback test.


### M5.5 — Wire the three call sites


Scope: replace `index_history` SELECTs in:

- `src/hooks/usePortfolio.ts` (the `benchmarkQuery` block)
- `src/hooks/useInvestmentVsBenchmarkTimeline.ts` (`fetchAllIndexRows`)
- `app/fund/[id].tsx` (`['fund-detail-index', symbol]` query)

Each becomes a `fetchIndexHistory(symbol, firstTxDate)` call. The fallback path keeps the existing pagination — so on snapshot 404 or parse error, behaviour is identical to today.

Acceptance: existing tests still pass with the snapshot helper mocked to return `null` (force fallback path).


### M5.6 — Persist allowlist


Scope: add `'index-snapshot'` to `PERSIST_ALLOWLIST` in `src/lib/queryClient.ts` so the snapshot survives reloads on disk.

Acceptance: snapshot persists across web reloads (verified via DevTools Application tab).


### M5.7 — Deployed validation


Scope: deploy migrations + edge function to dev project. Trigger the cron manually. Open the app, hard-reload, observe `[perf] query:indexSnapshot` log line with `< 100ms` typical and `source: 'snapshot'` rather than `source: 'fallback'`.

Acceptance: PostHog `perf_mark` event `query:indexSnapshot` shows up with realistic timing in production-like conditions.


## Validation


- Per-milestone unit tests (Jest).
- Manual smoke: trigger cron, fetch JSON, hard-reload app, check console for `query:indexSnapshot` mark.
- Network tab on web: cold load Portfolio → see one `<bucket>/index/<symbol>.json` GET, no `index_history` PostgREST request.
- Airplane mode test after warmup: persisted snapshot serves cached chart.


## Risks And Mitigations


- **Snapshot becomes stale during a market-data outage.** Mitigation: `stale-while-revalidate=86400` means stale snapshots keep serving for up to a day, plus the read-through fallback to `index_history` covers the rare case where the snapshot is truly missing.
- **Supabase Storage egress costs.** Mitigation: ~15 KB gzipped × ~100k MAU × 1 fetch/week = ~1.5 GB/week. Within free tier comfortably. CDN cache hit ratio should be 95%+ given the daily-only refresh.
- **Edge function fails partway through.** Mitigation: the function returns per-symbol summaries; a partial success leaves the previous version of the failed symbol's file untouched (stale but valid). Next day's cron retries.
- **A new benchmark gets added but the snapshot list isn't updated.** Mitigation: the read-through fallback handles unknown symbols transparently — they just always take the slow path until the allowlist is extended.
- **Schema change in `index_history` rows.** Mitigation: the snapshot is a JSON projection of two columns (`index_date`, `close_value`); any breaking schema change would break the SELECT inside `regenerate-index-snapshots` and be caught immediately by the daily cron's failure log.


## Decision Log


- 2026-05-12: Chose Supabase Storage over Vercel-hosted file. Single infra surface, same CDN guarantee, no service-role-key-in-Vercel risk.
- 2026-05-12: Snapshot path is `index/<lowercased-symbol-without-^>.json` to leave room for future snapshot types under the same bucket.
- 2026-05-12: Deferred top-fund NAV snapshots. Most users don't overlap with "top by AUM" funds enough to justify the storage cost yet; revisit after we see real PostHog data on which schemes get hit hardest.
- 2026-05-12: Read-through pattern with fallback (matches PR #136's SQLite layer). Snapshot fetch failure never breaks the screen; it just makes that one read slower.


## Progress

- [ ] M5.1 — Storage bucket migration
- [ ] M5.2 — `regenerate-index-snapshots` edge function
- [ ] M5.3 — pg_cron schedule
- [ ] M5.4 — App-side `fetchIndexSnapshot` + tests
- [ ] M5.5 — Wire the three call sites
- [ ] M5.6 — Persist allowlist entry
- [ ] M5.7 — Deployed validation on dev
