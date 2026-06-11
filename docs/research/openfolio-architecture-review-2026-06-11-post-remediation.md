# FolioLens ↔ OpenFolio-Data — Post-Remediation Architecture Review (2026-06-11)

Independent re-review of the development environment after the remediation wave
that followed the 2026-06-10 architecture review
([openfolio-architecture-review-2026-06.md](./openfolio-architecture-review-2026-06.md), PR #197).
The prior review was treated as a **hypothesis**, not a source of truth; every
claim below was re-verified against current code and the live dev environment.

**Baselines**

| | |
|---|---|
| FolioLens `origin/main` | `3ea35b7f010a0ccf3f9c061e9e5805f2a4c115c3` (#208, 2026-06-11 14:00 +01) |
| OpenFolio-Data `origin/main` | `ee1a0b89336f8ee81ff940195567d532a403d9f3` (#53, 2026-06-10 23:54 +01) |
| Analysis timestamp | 2026-06-11T13:55:36Z |
| PRs reviewed since #197 | FolioLens #198–#208 (all merged 2026-06-10/11); OpenFolio-Data #53 |
| Live evidence | dev Supabase `imkgazlrxtlhkfptkzjc` (read-only SQL via management API); GCP project `fund-lens` (Cloud Run services/jobs/logs, GCS artifacts incl. a download of the serving `funds-holdings.db`); live API probe; GitHub Actions run history |
| Deployment parity | OpenFolio Cloud Run **service and both jobs** run image tag = `ee1a0b8` → upstream main is exactly what is deployed |

Production ignored throughout (intentional drift), except where a finding will
bite the eventual prod release.

---

## 1. Executive summary

The remediation wave was real and mostly competent: **9 of 12 recommendations
landed, and the two P0 user-facing bugs are demonstrably fixed in outcome
terms** — held-fund NAV is current through 2026-06-10 with all 7 cron jobs
green, and `nav_history` collapsed from 8.8 M rows / 1.59 GB to 120 k rows /
22 MB (DB total 1,685 MB → 119 MB). The storage problem is gone, the NAV
ladder is OpenFolio-first end to end, and Compare's as-reported fallback is a
genuinely well-built piece of provenance UX.

But the **single most important outcome was not delivered**: universe metadata
coverage. The chunked backfill machine was built (PRs #201/#202) and is
architecturally sound, but it has never been driven to completion — coverage
moved from 675 → only **1,481 of 37,595** schemes (target population 14,374).
All three driver-workflow runs ended **cancelled**, the last one killed at
exactly GitHub Actions' 6-hour job limit, with the cursor at chunk 6 and 69
row-failures recorded that nobody noticed. `official` composition is unchanged
at 1,413 schemes. **Compare still shows "—" for most non-held funds**, which
was the original review's #1 launch concern. The fallback metrics shipped in
#208 only help where metadata exists — so they currently help almost nowhere
outside held funds.

Three new problems were found that the previous review missed or caused:

1. **Migration-state drift on dev** (caused by the #198/#199 version collision
   and mis-diagnosed by #203): the repo's
   `20260610000000_drop_scheme_master_backfill_columns.sql` is recorded as
   applied on dev **but its DDL never executed** — the four "dropped" columns
   still exist with 9,217 stale rows. Dev schema ≠ migrations ≠ generated
   types, and the eventual prod release will silently diverge from dev.
2. **The weekly NAV-retention pruner has a real bug**: its candidate query is
   unpaginated and silently capped at PostgREST's 1,000-row default on a 37.6k
   table — it could never have drained the backlog (masked because the
   one-time cleanup was executed manually) and can miss future orphans.
3. **OpenFolio has no AUM data at all.** `fund_metrics.aum_cr` exists in the
   schema and API contract but nothing populates it — every value served is
   NULL. The previous review's source-of-truth matrix listing OF as the AUM
   owner was wrong. FolioLens's 70 AUM values come from the mfdata backup leg.
   Compare's AUM column will stay "—" for nearly all non-held funds even after
   the backfill completes, until an AUM source is wired upstream.

Upstream, OpenFolio-Data is in strong shape (50/50 AMC adapters, 99.9 %
metadata / 96.4 % holdings of the active universe, #53 shipped
`max_drawdown_5y` + `sample=month_end` + `active` — already deployed), but
**FolioLens consumes none of the three new #53 fields yet**, and the bulk
metadata endpoint's per-row reads over a gcsfuse-mounted 3.5 GB nav.db are the
likely reason the backfill crawls.

**Bottom line for beta:** the held-fund experience (portfolio, NAV, charts,
costs) is launch-ready today. The pick-any-fund experience (Compare/search) is
not, and the remaining work is mostly *operational completion and hygiene*,
not new architecture: drive the backfill to done with a driver that survives,
repair the migration state, fix the pruner pagination, retire two contradictory
legacy workflows, and add a daily freshness check so silent failures like this
wave's can't recur.

---

## 2. Review of completed work (R1–R12)

Outcome-first classification. "Value" = did the user-visible/system-visible
problem actually go away.

| Rec | What | Verdict | Value delivered | Confidence |
|---|---|---|---|---|
| R1 | Fix `sync-nav-hourly` cron (#198, renamed by #203) | **Implemented correctly** | **Yes** — held max(nav_date)=2026-06-10 (current); 16/16 runs succeeded in 48 h; all 7 jobs on `app_config_get` | High (live) |
| R2 | Bootstrap → invalidate React Query (#200) | **Implemented correctly** | Yes — shared `didSyncChangeData` predicate in both paths, net-delta counting avoids phantom invalidations, tested | High (code) |
| R3 | Retire GH universe backfill (#199) | **Implemented partially** | Mostly — writer is dead (workflow+script deleted; growth stopped). But the column-drop migration **never executed on dev** (collision fallout, §below) | High (live) |
| R4 | Chunked resumable OpenFolio backfill (#201/#202) | **Implemented partially — outcome NOT delivered** | **No** — coverage 675→1,481 of 14,374 target; never completed; driver dies at GH 6-h limit; 69 silent row-failures | High (live) |
| R5 | NAV retention + one-time cleanup (#204 + manual) | **Implemented correctly in outcome; pruner has a latent bug** | **Yes** — 8.8 M→120 k rows, 1.59 GB→22 MB; stamping works (7 schemes) | High (live) |
| R6 | category_rules accretion + daily demotion (#206) | **Implemented correctly** | Yes — 1,736→91 rows @ sentinel `1900-01-01`; cron daily 02:10 | High (live) |
| R7 | period_returns normalisation + amc_slug + dead readers (#207) | **Implemented correctly** (one latent flaw) | Yes — canonical decimals at write; merge semantics tested; 1,463 OF-shape vs 28 legacy rows | High |
| R8 | fetch-fund-nav OpenFolio-first (#205) | **Implemented correctly** | Yes — mirrors sync-nav ladder; 3-day gate; contract kept; stamps `nav_backfilled_at` | High |
| R9 | Upstream: max_drawdown_5y, month_end sampling, active flag (OF #53) | **Implemented correctly upstream; unconsumed downstream** | Not yet — deployed (API+jobs on `ee1a0b8`), but zero references in FolioLens code/types | High |
| R10 | Prod release runbook | **Not implemented** | n/a — fragments exist (INFRASTRUCTURE.md "Producing a release", release-pipeline.md) but no secrets/cron/backfill/verify sequence. Now *more* needed (see migration drift) | High |
| R11 | Compare as-reported fallback + 5y window (#208) | **Implemented correctly** | Partially realized — excellent provenance UX (`†` labels, computed-wins, write-back-poisoning guard), but useful only where metadata exists → gated on R4 | High |
| R12 | Client-twin contract-drift guard | **Not implemented** | n/a — twins verified field-identical today; no guard, and the app twin has zero importers (exit-runbook mirror only) | High |

### 2.1 The migration collision left dev drifted (new finding, P0-adjacent)

Sequence reconstructed from git + live `supabase_migrations.schema_migrations`:

- #198 and #199 both shipped version `20260610000000` (cron fix /
  column drop).
- #203 "resolved" the collision by renaming the **cron fix** to
  `20260610000001`, asserting in its commit message that dev already had
  `drop_scheme_master_backfill_columns` applied.
- **Live dev disagrees**: `schema_migrations` records `20260610000000` and
  `20260610000001` both under the name `fix_sync_nav_cron_app_config`, and
  `information_schema` shows `last_backfill_attempted_at`,
  `backfill_outcome`, `backfill_failure_count`, `is_inactive` **all still
  present** (9,217 rows carry stamps). The drop DDL never ran.
- Consequences: dev schema ≠ repo migrations ≠ generated
  `database.types.ts` (which says the columns are gone); a fresh prod push
  **will** execute the drop, so dev and prod diverge by construction; and
  `supabase db push` on dev now builds on an incorrect ledger.
- Two further collisions occurred in the same wave (#204's
  `nav_backfilled_at` landed as `…000001`, renamed to `…000005` by #206) —
  the numbering process itself is fragile when PRs merge same-day.

Fix is cheap: one new idempotent migration (`DROP COLUMN IF EXISTS` ×4 +
`DROP INDEX IF EXISTS`) plus a `supabase migration repair` of the two
misnamed ledger rows, and a convention change (timestamp-at-merge or CI
collision check — `supabase-validate.yml` is the natural home).

### 2.2 Why the backfill stalled (root-cause, new finding)

- All 3 runs of `universe-backfill.yml` concluded **cancelled**; run 3 ran
  15:59→21:59 — exactly the **6-hour GitHub Actions job limit**, which the
  loop-inside-one-job design (max 144 × 10 min ≈ 24 h) can never survive.
- In those 6 hours the metadata cursor advanced only 6 chunks (1,500 items),
  i.e. ~17 % of iterations made progress. The likely bottleneck is upstream:
  `/v1/metadata?page_size=300` performs ~4–5 SQLite lookups **per scheme**
  (registry, metrics, B1, audit, active) against **nav.db over a gcsfuse
  mount** (3.5 GB, per-request `immutable=1` connection) — hundreds of
  random FUSE reads per page. The edge function's 150 s isolate then times
  out mid-chunk and the cursor doesn't advance.
- `failed: 69` sits in the cursor state with no surfaced alert; composition
  phase has no cursor and `official` coverage is unchanged (1,413 schemes) —
  it never completed either. The `phase='both'` flaw (workflow exits on the
  metadata phase's `done` alone; a finished phase's deleted cursor restarts
  it from page 1 next invocation) compounds this.
- Stale comments still describe 5-page chunks after #202 cut it to 2.

### 2.3 Other latent defects found in the remediation code

| Defect | Where | Severity |
|---|---|---|
| Weekly pruner candidate query unpaginated → capped at 1,000 rows of 37.6k; cannot reliably find pruneable schemes; contradicts its own migration comment ("multiple weekly runs drain any backlog") | `nav-retention/index.ts:62–65` | P1 (masked today; first scheduled run 2026-06-14) |
| `mergeMfdataReturns` existing-wins semantics freeze returns/as_of for **mfdata-only** (OF-404) schemes at first write — fresher mfdata can never overwrite | `_shared/period-returns.ts:66–70` | P2 |
| `sync-nav` since-map query unpaginated → >1,000 NAV rows in 45-day window silently degrades some schemes to full re-fetch | `sync-nav/index.ts:71–84` | P3 (self-healing) |
| Phantom test: `useFundDetail.windowed.test.ts:131` cites `poisoning-trap.test.ts` which does not exist; the write-back guard is never functionally asserted | app tests | P3 |
| `fetch-fund-nav.rows_upserted` counts attempted rows (no `ignoreDuplicates`), unlike sync-nav | `fetch-fund-nav` | P3 |

---

## 3. Data architecture review

### 3.1 What is truly required (server-side)

| Data | Required? | Current state | Notes |
|---|---|---|---|
| `scheme_master` registry (37,595) | Yes (picker must resolve any CAS code) | 21 MB | enrichment coverage is the gap, not the seed |
| Held + on-demand NAV | Yes | 120,553 rows / 42 schemes / 22 MB; held fresh to 2026-06-10 | **policy now matches reality** — the review's target achieved |
| `official` composition | Yes (Insights/Compare) | 1,413 schemes, latest 2026-05-26 | coverage incomplete (≈16 % of active universe) |
| `index_history` | Yes (benchmarks) | 88,741 rows / 48 MB — now the largest table | fine; leave alone |
| User data (user_fund/transaction/cas) | Yes | 3 users / 39 holdings / 1,708 txs | healthy |
| `app_config` | Yes | 2 keys (base URL + a stalled backfill cursor) | cursor doubles as progress observability — keep |

### 3.2 Duplicated / cached / regenerable / unnecessary

- **Duplicated by design (keep):** `scheme_master` mirroring OF metadata
  (runtime independence from OF — correct); SQLite mirroring Postgres
  (offline-first — correct); the Deno/app OpenFolio client twins
  (exit-runbook boundary — still field-identical, but unguarded → R12).
- **Pure cache, regenerable:** every `nav_history` row (OF `/v1/nav` or
  mfapi); all composition rows; all OF-sourced `scheme_master` fields; the
  SQLite + React Query + CDN snapshot layers. Worst-case regeneration cost is
  the documented 1–2 s first-pick hydration. This property was exercised for
  real by the 8.6 M-row cleanup — it worked.
- **Duplicated wrongly / unnecessary syncs:**
  - `sync-amfi-portfolios.yml` (monthly, 11th) still writes
    `source='amfi'` composition from **mfdata.in** to dev **and prod** —
    contradicts the OF-first ladder, contradicts migration
    `20260610000000`'s comment that the tag is retired, and **violates the
    prod freeze**. Today's 06:00 UTC run left zero rows on dev (failed or
    no-op) — i.e. it also doesn't work. Retire it.
  - `backfill-stock-market-cap.yml` + script + the still-deployed
    `sync-stock-market-cap` edge function target a table **dropped** in
    #191. Any run fails. Delete all three (plus `diag-nav`, deployed March).
  - Dev's four zombie backfill columns (§2.1).
  - Upstream: holdings-DB `fund_metrics` table is vestigial (0 rows; metrics
    live in nav.db) and nav.db recomputes metrics for **37,963** schemes
    (incl. ~23k dead ones) every evening run — cheap but wasteful.

### 3.3 Strategy verdicts

- **NAV strategy (held + on-demand + 90-day retention): correct and now
  proven.** 22 MB steady state; freshness chain (AMFI → OF hourly evening
  job → sync-nav 18×/day → SQLite bootstrap/foreground → invalidation)
  verified working end to end. Remaining holes: the pruner pagination bug
  (P1) and the non-held SQLite stale-tail (P2, pre-#208 write-backs only).
- **Metadata strategy (OF-first, per-B1-status mfdata backup, honest
  nulls): sound design, incomplete execution.** Held funds: TER 35/36,
  returns 33/36, AUM 35/36 (mfdata-sourced). Universe: TER 1,165 / returns
  1,485 / **AUM 70** of 37,595. The backup ladder works; coverage is the
  whole game now.
- **Composition strategy (official > category_fallback > category_rules):
  correct; accretion fixed; provenance columns populated.** Coverage gated
  on the same backfill.
- **Compare data requirements:** 5y window per selected fund is sufficient
  (re-verified: trailing 1/3/5y anchors, 3y monthly σ, 5y max DD) and #208
  implements exactly that client-side with a clean poisoning guard. Local
  computation remains justified (mfdata's numbers were proven wrong;
  provenance labels handle mixed sources). Drawdown fallback awaits #53
  consumption.
- **SQLite cache strategy: correct.** Held-scope full-history mirror + 3
  index series, per-scope watermarks, additive drift-rebuild, 24 h persisted
  RQ cache with allowlist + `__BUSTER__ v7`. Cold-start invalidation gap is
  closed.
- **Supabase storage strategy: solved.** 119 MB total; nothing further
  needed (no partitioning, no sampling tiers — correctly rejected).

---

## 4. OpenFolio ownership review

OpenFolio-Data independently assessed: well-documented (SPEC/DECISIONS/
COVERAGE/RUNBOOK), well-tested (420 passing tests incl. offline fixtures),
cheaply deployed (~$0.5/mo, scale-to-zero, family-keyed v2 contract with
plan/ISIN resolution — 2,046 families ↔ 8,413 plan aliases). Operational
reality: AMC sources are fragile (residential-proxy quota exhaustion blocked
WhiteOak/Angel One on Jun 3; HSBC 404s caused two failed manual runs Jun 7;
one future-dated HSBC snapshot `2026-06-12` betrays a date-parse bug that
leaks into `/health`). The monthly job self-heals via carry-forward.

### Ownership matrix (target state)

| Domain | Owner | Status today | Action |
|---|---|---|---|
| Scheme identity (families, plans, ISINs, active flag) | **OpenFolio** | ✅ owned; `active` shipped in #53 | FolioLens should consume `active` (picker ranking) |
| NAV (universe history, latest, deltas) | **OpenFolio** | ✅ owned (nav.db 3.5 GB, hourly evening ingest, monthly GH release) | none — FolioLens correctly keeps only held+on-demand |
| NAV-derived metrics (ret_1/3/5y/incep, volatility, max_drawdown_5y) | **OpenFolio** | ✅ computed nightly for 37,963 codes; DD lands tonight (job image already #53) | FolioLens consume as as-reported fallback |
| **AUM** | **OpenFolio (should)** | ❌ **structurally NULL — no source wired**; FolioLens's 70 values are mfdata leftovers | wire AMFI monthly AAUM (or disclosure net-assets) upstream; until then Compare must label AUM "unavailable", not pretend coverage |
| B1 metadata (TER, manager, exit load, minima, riskometer…) + per-field status | **OpenFolio** | ✅ 8,665 TER / 8,782 rows | keep mfdata backup leg until held-fund B1 proves out, then sunset |
| Composition + provenance | **OpenFolio** | ✅ 96.4 % of active universe upstream; FolioLens mirror at 16 % | finish backfill |
| Benchmark/index series | **FolioLens** (`sync-index`, Yahoo/NSE) | works | candidate to move upstream later (would also enable upstream beta/R²) — not now |
| beta/R² | mfdata (category-gated) | deliberate | revisit only if index series move upstream |
| User data, XIRR, portfolio analytics, picker UX, category_rules heuristics | **FolioLens** | ✅ | none |
| Compare metrics (primary) | **FolioLens client** (computed locally, provenance-labelled) | ✅ | keep; OF metrics are the fallback tier |

**Should anything move?** No FolioLens-stored data should move upstream
(the `scheme_master` mirror is operational independence, not duplication
debt). Two computations should *eventually* migrate up: max drawdown (done in
#53 — consume it) and beta/R² (only if OF ingests index series). The
responsibility split is fundamentally correct.

**Upstream asks (new, evidence-based):**
1. AUM source (`fund_metrics.aum_cr` is a NULL contract today).
2. Bulk `/v1/metadata` performance: copy nav.db to local disk at startup
   (like the holdings DB) or batch per-page lookups into single JOINs —
   this is what's starving the FolioLens backfill.
3. Reject/clamp future `disclosure_date` at parse time (HSBC 2026-06-12).
4. Skip the dead ~23k codes in nightly metrics recompute (cosmetic).

---

## 5. Launch readiness (public beta on dev)

Only correctness / trust / data quality / operational reliability items.

### P0 — must fix before beta

| # | Issue | Why it blocks | Fix shape |
|---|---|---|---|
| P0-1 | **Universe metadata + composition coverage** still ~4 % / ~16 % (backfill never completed; driver dies at GH 6-h limit; 69 silent failures; phase-both flaw) | Compare/search shows "—" for most of the universe; #208's fallback can't fire without metadata; this was the original launch-blocker and remains | Re-architect the driver (scheduled short-lived workflow runs every 10–15 min that fire N chunks and exit — survives the 6-h cap — or pg_cron self-invocation); fix phase coordination; raise per-chunk reliability (smaller pages, or upstream perf fix §4); drive to done; verify with acceptance SQL |
| P0-2 | **Dev migration-state drift** (drop migration recorded-but-never-executed; ledger names wrong; types ≠ schema) | Every future `db push` builds on a lie; prod release will produce a schema dev never ran; this class of error caused the original P0 cron outage | One idempotent re-drop migration + `supabase migration repair`; add CI collision check |

### P1 — fix before/at beta, none require architecture

1. **nav-retention pagination bug** — paginate candidates (or push the
   predicate into one SQL delete); first cron fire is 2026-06-14.
2. **Retire `sync-amfi-portfolios.yml`** (writes to prod during freeze;
   wrong ladder; currently failing silently) and **delete the
   stock-market-cap workflow/script/function + `diag-nav`** (target dropped
   table / dead diagnostics).
3. **Freshness observability** — the defining meta-failure of this cycle is
   that *everything broke silently* (cron 5 days, backfill cancelled ×3, 69
   row-failures, amfi job no-op). One daily edge function: held max
   nav_date, cron failures in 24 h, backfill cursor staleness, OF `/health`
   probe → email/Slack. Small effort, outsized trust payoff.
4. **Consume OF #53**: `max_drawdown_5y` into the as-reported fallback
   (closes the Risk-card hole), `active` into picker ranking (37k-row
   search currently ranks dead schemes equal to live ones, alphabetically).
5. **mergeMfdataReturns freeze** — allow fresher mfdata to overwrite
   mfdata-shaped values (only OF values should be protected).
6. **AUM honesty** — until upstream AUM exists, ensure Compare labels AUM
   as unavailable rather than implying data; longer fix is upstream (§4).
7. **R10 prod-release runbook** — required before the prod launch (not the
   dev beta), but write it while the migration-drift lesson is fresh.

### P2 — soon after beta

`sync-nav` since-map pagination; non-held SQLite stale-tail top-up
(review §P2, still open); picker data-completeness ranking; upstream
future-date guard; phantom test + stale comments; R12 drift-guard fixture
test; zombie-function deploy hygiene (deploy workflow ships deleted
functions' siblings — consider pruning deployed-but-unsourced functions).

---

## 6. Improvement opportunities (Principal-Engineer view, ranked)

| Rank | Opportunity | Impact | Effort | Risk |
|---|---|---|---|---|
| 1 | Finish + harden universe backfill (driver redesign, phase fix, completion) | **High** — unlocks Compare/search for the whole universe; converts #208 from latent to live | S–M | Low (idempotent) |
| 2 | Daily data-freshness monitor (NAV age, cron health, cursors, OF /health) | **High** — prevents the silent-failure class that caused both P0s | S | None |
| 3 | Upstream bulk-metadata performance (local nav.db copy or JOIN-per-page) | Med-High — makes #1 fast and reliable; helps monthly syncs | S–M | Low |
| 4 | AUM source upstream (AMFI monthly AAUM adapter → `fund_metrics`) | Med-High — Compare cost/size column goes from fake-empty to real | M | Low |
| 5 | Consume #53 (DD fallback, `active` ranking, `month_end` for Past-SIP egress) | Med — closes Risk-card gap; honest search; ~30× smaller Past-SIP payloads | S–M | Low |
| 6 | Migration hygiene (repair + CI collision check) + R10 runbook | High at prod-release time | S | None |
| 7 | Search ranking: boost active + has-metadata schemes | Med (UX/trust) | S–M | Low |
| 8 | R12 twin-contract fixture test | Low-Med (insurance) | S | None |
| 9 | Index series ownership move into OpenFolio (then upstream beta/R²) | Med long-term (removes Yahoo dependency) | M–L | Med |
| 10 | Cost | Already optimal (~$0.5/mo GCP + free-tier-sized Supabase at 119 MB) — no action | — | — |

---

## 7. Recommended roadmap (small team, launch-focused)

**Days 0–30 — finish the launch story (everything here is small):**
1. Backfill driver redesign + drive metadata **and** composition to
   completion; acceptance: `openfolio_meta_synced_at` ≥ ~8k active, official
   composition ≈ upstream coverage, 5 random unheld funds render TER/returns
   /composition without hydration spinner.
2. Migration repair + idempotent re-drop + CI version-collision check.
3. nav-retention pagination fix (before Jun 14 cron) — verify first run's
   deletes are 0-or-tiny and held rows invariant.
4. Retire `sync-amfi-portfolios` + stock-market-cap trio + `diag-nav`.
5. Freshness monitor (one edge function + one cron + alert hook).
6. Consume `active` flag + `max_drawdown_5y` fallback (small app PRs).
7. Beta smoke checklist: cold-launch NAV date, fresh-pick Compare, Past-SIP,
   CAS import.

**Days 31–60 — trust & ops depth:**
1. Upstream AUM adapter + FolioLens mapping (+ backfill re-run for the field).
2. Upstream bulk-metadata perf fix; re-run a full backfill cycle to validate
   wall-clock (should drop from ~24 h to ~1–2 h).
3. `mergeMfdataReturns` freshness fix; stale-tail top-up; since-map pagination.
4. R10 runbook written + **rehearsed against a scratch project** (migrations
   → functions → secrets → crons → backfill → verify).
5. R12 fixture test; search ranking v1.

**Days 61–90 — prod launch & consolidation:**
1. Execute prod release per runbook (incl. running the universe backfill on
   prod and the retention setup); soak, then public beta → prod cutover.
2. Past-SIP `sample=month_end` adoption; monthly coverage-vs-upstream
   reconciliation job (counts FolioLens vs OF COVERAGE numbers, alerts on
   divergence).
3. Decide index-series ownership (move to OF or formalise Yahoo/NSE in
   FolioLens with a fallback); only then evaluate upstream beta/R².

---

## 8. Architecture challenges (attempted disproofs)

**Held-fund NAV strategy** — *challenged: shouldn't we store universe NAV so
any fund is instant?* Disproof fails. The 90-day-retention held+on-demand
model now has production evidence: 22 MB vs 1.6 GB for identical UX (1–2 s
one-time hydration on first pick, then cached). The universe tier exists
upstream (nav.db, monthly public releases) if a feature ever needs it.
**Verdict: keep.** The only residual risk is hydration latency spikes if OF
cold-starts — mfapi fallback covers it.

**OpenFolio-first** — *challenged: single-maintainer upstream, fragile AMC
sources, proxy quotas — is the dependency safe?* Partially sustained as a
risk, not as an architecture error. Mitigations already in place: mfapi
fallback ladder at every NAV call site, per-B1-status mfdata backup,
`scheme_master` mirror (app never calls OF at runtime), EXIT-RUNBOOK, monthly
nav.db releases as escape artifacts. The data quality argument is decisive:
mfdata's computed numbers were demonstrably wrong; AMFI/AMC-sourced data with
provenance is the only defensible primary. **Verdict: keep, but FolioLens
must monitor OF health (P1-3) — today an OF outage would surface only as
quiet fallback degradation.**

**SQLite-first reads** — *challenged: the cache caused the stale-NAV P0;
why not network-first React Query?* Disproof fails. The bug was a missing
invalidation (fixed, tested), not the architecture. Network-first would
regress offline UX and multiply egress for a portfolio screen recomputed on
every focus. The remaining stale-tail edge case is bounded (≤ days, non-held
funds, pre-#208 residue) and cheap to fix. **Verdict: keep.**

**Metadata sync strategy** — *challenged: three sync stamps, two-source
ladder, 7-day gates — over-engineered?* No: each stamp gates a real freshness
domain and the per-field B1 status machine is precisely what makes "honest
null vs backup" possible. What's actually wrong is **operational**: coverage
never completed, and the backfill-stamps-defer-mfdata-backup interaction (documented)
plus only 15/36 held funds OF-fresh deserve a post-completion audit.
**Verdict: design sound; finish the execution.**

**Compare implementation** — *challenged: local metric computation duplicates
upstream work and risks divergent numbers.* Sustained in part. Local
computation is evidence-justified (upstream-blob inaccuracy) and
provenance-labelled, so trust is preserved; the 5y window is right-sized. But
the *fallback* tier should lean harder on OF metrics now that they exist
(incl. drawdown), and the AUM column is currently theatre (no upstream
source). **Verdict: keep the primary; finish the fallback (consume #53) and
fix AUM honesty.**

---

## 9. Final recommendations

| # | Recommendation | Confidence | Impact | Urgency |
|---|---|---|---|---|
| 1 | Drive universe backfill to completion with a survivable driver; fix phase-both; surface `failed` counts | High | High | **P0** |
| 2 | Repair dev migration ledger + idempotent re-drop + CI collision check | High | High (prod correctness) | **P0** |
| 3 | Fix nav-retention candidate pagination before first cron fire (Jun 14) | High | Med | P1 |
| 4 | Retire `sync-amfi-portfolios` (esp. its prod writes) + stock-market-cap trio + `diag-nav` | High | Med | P1 |
| 5 | Ship a daily freshness/health monitor (incl. OF /health) | High | High | P1 |
| 6 | Consume #53: `max_drawdown_5y` fallback + `active` in picker | High | Med | P1 |
| 7 | Wire AUM upstream (AMFI AAUM) → `fund_metrics.aum_cr`; until then label AUM unavailable | High | Med | P1 |
| 8 | Fix `mergeMfdataReturns` mfdata-refresh freeze | High | Low-Med | P2 |
| 9 | Write + rehearse the prod release runbook (R10) | High | High at release | P1 (timed) |
| 10 | Upstream bulk-metadata perf (local nav.db / JOIN pages) | Med-High | Med | P2 |
| 11 | R12 fixture test for the client twins | Med | Low | P2 |
| 12 | Stale-tail top-up, since-map pagination, search ranking, comment/test hygiene | High | Low | P2 |

**What NOT to do:** no partitioning, no universe-NAV tier, no rewrite of the
sync pipeline, no merging of the three sync stamps, no dropping the 37k seed,
no replacement of local Compare math — all were re-challenged and all stand.

---

## 10. Implementation plan — concrete PRs, dependencies, prompts

Every roadmap item from §7 converted into an independently mergeable PR (or an
explicitly-labelled operational milestone where no code changes are needed).
`FL-*` = FolioLens, `OD-*` = OpenFolio-Data, `OP-*` = operational (no PR).

### 10.1 PR catalog

| ID | Title | Repo | Size | Urgency | Hard deps |
|---|---|---|---|---|---|
| FL-1 | Survivable universe-backfill driver + phase coordination | FolioLens | M | **P0** | — |
| FL-2 | Migration ledger repair + idempotent re-drop + CI collision guard | FolioLens | S | **P0** | — |
| FL-3 | nav-retention: candidates from nav_history, not a capped scheme_master scan | FolioLens | S | P1 (⏰ before Sun Jun 14) | — |
| FL-4 | Retire legacy writers: sync-amfi-portfolios, stock-market-cap trio, diag-nav | FolioLens | S | P1 | — |
| FL-5 | Daily data-freshness monitor (NAV age, cron failures, cursors, OF health) | FolioLens | M | P1 | — |
| FL-6 | Compare: max_drawdown_5y as-reported fallback (twins + writers + UI) | FolioLens | M | P1 | FL-12 soft |
| FL-7 | scheme_active flag: migration + writers + picker demotion | FolioLens | M | P1 | **FL-2**; FL-12 soft |
| FL-8 | period_returns: un-freeze mfdata-only refresh | FolioLens | S | P2 | — |
| FL-9 | Non-held NAV stale-tail top-up + real write-back-poisoning test | FolioLens | S | P2 | — |
| FL-10 | sync-nav since-map pagination + fetch-fund-nav rows_upserted semantics | FolioLens | S | P2 | — |
| FL-11 | Prod release runbook (R10) + beta smoke checklist | FolioLens | S (docs) | P1 (timed) | FL-2 lesson |
| FL-12 | OpenFolio client-twin drift guard (R12) | FolioLens | S | P2 (land early) | — |
| FL-13 | Picker search ranking: liveness + data completeness | FolioLens | S–M | P2 | **FL-7** |
| FL-14 | Past-SIP month-end sampling via local RPC | FolioLens | S–M | P2 | — |
| FL-15 | Monthly coverage reconciliation (extends monitor) | FolioLens | S | P2 | **FL-5** |
| FL-16 | Decision doc: index-series ownership (stay vs move upstream) | FolioLens | S (docs) | P3 | — |
| OD-1 | AUM source: AMFI monthly AAUM → fund_metrics | OpenFolio-Data | M | P1 | — |
| OD-2 | Bulk /v1/metadata: batch page queries (stop per-row gcsfuse reads) | OpenFolio-Data | S–M | P1 | — |
| OD-3 | Parser: reject/clamp future disclosure dates | OpenFolio-Data | S | P2 | — |

Operational milestones (no PR):

| ID | What | Preconditions |
|---|---|---|
| OP-1 | Drive universe backfill to completion on dev (metadata **and** composition); acceptance SQL in FL-1. Re-run metadata phase after OD-1 (AUM) and after OD-2 (speed) | FL-1 merged+deployed; OD-2 strongly recommended first |
| OP-2 | Verify first scheduled nav-retention run (Sun 2026-06-14 03:00 UTC): held rows invariant, deletes plausible, logs clean | FL-3 merged+deployed |
| OP-3 | Prod release rehearsal then execution per runbook (incl. prod universe backfill + retention setup) | FL-2, FL-11, OP-1; ideally all P1s |

Roadmap coverage check: 30-day items → FL-1/2/3/4/5/6/7 + FL-11's smoke
checklist + OP-1/OP-2. 60-day items → OD-1, OD-2, FL-8/9/10/11/12/13. 90-day
items → OP-3, FL-14, FL-15, FL-16, OD-3. Nothing from §7 is unmapped.

### 10.2 Parallelism and dependency graph

**Wave 1 — start all in parallel now:** FL-1, FL-2, FL-3 (deadline), FL-4,
FL-5, FL-12, OD-2, OD-3.
**Wave 2 — after their deps:** FL-6 (after FL-12), FL-7 (after FL-2, FL-12),
FL-8, FL-9, FL-10, FL-11, OD-1 — all parallel with each other.
**Wave 3:** FL-13 (after FL-7), FL-14, FL-15 (after FL-5), FL-16; OP-1 runs as
soon as FL-1 deploys and re-runs after OD-1/OD-2; OP-3 last.

```
FL-2 ─────────────► FL-7 ─────► FL-13
FL-12 ─(soft)─────► FL-6, FL-7          (guard lands before twin edits)
FL-1 ──────────────► OP-1 ◄─(speed)── OD-2
OD-1 ──────────────► OP-1 re-run (metadata phase) → AUM populated
FL-5 ─────────────► FL-15
FL-3 ─────────────► OP-2 (Sun Jun 14)
FL-4, FL-8, FL-9, FL-10, FL-11, FL-14, FL-16, OD-3 ── no deps (parallel)
{FL-2, FL-11, OP-1} ────────────────────────────────► OP-3 (prod release)
```

Only three hard code dependencies exist (FL-2→FL-7, FL-7→FL-13, FL-5→FL-15);
everything else is parallelisable. FL-2 should merge **first** among
migration-bearing PRs so no new migration lands on the broken ledger (FL-7 is
the only other Wave-1/2 PR with a migration; FL-5 and FL-14 add SQL helpers —
sequence them after FL-2 too, which is automatic if FL-2 merges first in
Wave 1).

### 10.3 Shared prompt preambles

**FolioLens preamble — paste before every FL-* prompt:**

> You are working on himanshu4141/FolioLens. Branch from latest `origin/main`.
> Follow CLAUDE.md: typecheck zero errors, lint `--max-warnings 0`,
> `npx jest --coverage` (≥95 % for `src/utils/`); tests mock at wrapper
> boundaries (`@/src/lib/...`), never `@/src/lib/supabase`. Migrations:
> `supabase db push` to dev (imkgazlrxtlhkfptkzjc) from a clean checkout —
> never MCP apply_migration; never touch prod (ohcaaioabjvzewfysqgh). Edge
> functions deploy via the Supabase MCP tool with `../_shared/` imports
> rewritten to `./_shared/`; cron-called functions need `--no-verify-jwt`.
> Verify every live-state claim in this prompt yourself with read-only SQL
> before coding. Before opening the PR: validate every test-plan item and mark
> each "Validated by Claude" or "Requires manual verification" with evidence
> (command output, SQL results); update affected docs (README "What works
> now", docs/INFRASTRUCTURE.md, docs/architecture/data-sync-pipeline.md;
> docs/architecture/cache-surfaces.md + `__BUSTER__` bump or
> `[cache-shape-stable]` tag if client-visible shapes change).

**OpenFolio-Data preamble — paste before every OD-* prompt:**

> You are working on himanshu4141/OpenFolio-Data. Branch from latest
> `origin/main`. Validation gate: `ruff`, `pyright` (0 errors), `pytest` all
> green; tests are offline (fixtures only, e.g. `tests/fixtures/nav_stub.db`
> — repo convention, no network). Mind the monthly-job OOM history (#46–#48,
> #52): stream per-scheme, batch ≤500, no full-table loads. Update
> `docs/openapi.yaml` for any API change, README if behaviour changes, and
> add a dated `DECISIONS.md` entry for every judgment call. State memory
> impact in the PR description.

### 10.4 PR specifications + prompts

---

#### FL-1 `fix(backfill): survivable universe-backfill driver + phase coordination`

- **Objective:** make the backfill actually finish: driver that survives
  GitHub's 6-hour job limit; `phase='both'` reports/terminates on **both**
  phases; persistent done-markers so "cursor absent" stops being ambiguous;
  failures loud; stale comments fixed.
- **Files:** `supabase/functions/universe-backfill/index.ts`,
  `.github/workflows/universe-backfill.yml`, `_shared/__tests__/*`,
  `docs/universe-backfill-implementation.md`.
- **Validation:** deploy to dev; 3 manual invocations advance the cursor and
  return both phases' progress; workflow run completes within one scheduled
  slot; after OP-1: `count(openfolio_meta_synced_at)` ≥ ~8,000,
  `count(DISTINCT scheme_code) FROM fund_portfolio_composition WHERE
  source='official'` ≈ upstream coverage, 5 random unheld funds render
  TER/returns/composition in Compare without hydration spinner.
- **Tests:** unit tests for cursor/done-marker state machine (both phases ×
  {fresh, mid-walk, done, failed-rows}), response-shape test for `both`.
- **Docs:** universe-backfill-implementation.md (driver redesign),
  INFRASTRUCTURE.md workflow table.
- **Rollback:** function is idempotent; disable the workflow schedule; cursors
  and markers are plain app_config rows (deletable).

**Prompt:**

> The universe-backfill remediation (#201/#202) built a chunked resumable
> edge function but it has never completed. Verify on dev: app_config key
> `universe_backfill_metadata_cursor` = `{"phase":"metadata","cursor":6,
> "totalCount":14374,"written":1431,"skipped":0,"failed":69}`, no composition
> cursor, `count(openfolio_meta_synced_at)` ≈ 1,481 of 37,595. All 3 runs of
> universe-backfill.yml concluded "cancelled" — the last ran exactly 6 hours
> (GitHub Actions' hard per-job limit), which the current
> loop-inside-one-job design (144 × 10 min) can never survive. Four fixes,
> one PR: (1) **Driver**: change universe-backfill.yml to `schedule: cron
> every 15 min` + `workflow_dispatch`, each run performs at most ~8
> sequential invocations with short sleeps and exits well under 15 min; add a
> `concurrency` group so runs never overlap; when the function reports all
> requested phases done, the run exits 0 immediately (subsequent scheduled
> runs become instant no-ops — cheap; optionally auto-disable via `gh
> workflow disable` as a final step, justify your choice). (2) **Done
> markers**: in supabase/functions/universe-backfill/index.ts, today a
> finished phase **deletes** its cursor (lines ~409–414, ~491–496), which is
> indistinguishable from never-started, so a finished phase restarts from
> page 1 on the next 'both' invocation. Write
> `universe_backfill_{phase}_done_at` to app_config on completion and have
> the phase runner short-circuit when the marker exists (a `force=true` body
> param clears markers for deliberate re-runs — OP-1 re-runs need this). (3)
> **phase='both' coordination**: the handler currently returns only the
> metadata phase's result (composition's result is returned only when
> phase==='composition', lines ~428–453); make `both` return
> `{composition: {...}, metadata: {...}, done: bothDone}` and make the
> workflow's exit condition use that `done`. (4) **Loudness**: when a chunk's
> `failed` count grows, log it at error level and include it in the response;
> the workflow must fail its run (non-zero exit) if an invocation returns
> HTTP ≥500 or `failed` grew by more than ~50 in one run, so a human sees
> it. Also fix the stale "~5 pages (~1500 items)" comments in index.ts
> (~line 33) and the workflow header — #202 reduced PAGES_PER_INVOCATION to
> 2. Keep all mapping logic in `_shared/openfolio.ts` untouched. Unit-test
> the cursor/marker state machine and the new `both` response shape
> (dependency-injected, no network — extend `_shared/__tests__/`). Deploy to
> dev, run 3 invocations manually, show cursor advancing and the response
> shape. Do NOT drive the full backfill in this PR — that is operational
> milestone OP-1; document its acceptance SQL in
> docs/universe-backfill-implementation.md: count(openfolio_meta_synced_at)
> ≥ ~8,000; official-composition distinct schemes ≈ OpenFolio coverage;
> 5 random unheld funds render in Compare without spinner.

---

#### FL-2 `fix(migrations): ledger repair + idempotent re-drop + CI collision guard`

- **Objective:** make dev's migration ledger truthful again, actually drop the
  four zombie columns, and prevent version collisions structurally.
- **Files:** new migration, `supabase/migrations/README` note (if any),
  `.github/workflows/supabase-validate.yml`, `scripts/` (guard script),
  `docs/INFRASTRUCTURE.md`.
- **Validation:** `information_schema.columns` shows the 4 columns gone on
  dev; `supabase_migrations.schema_migrations` names match repo files;
  `supabase db push --dry-run` from clean checkout reports nothing pending;
  CI guard fails a PR that introduces a duplicate version (prove with a
  scratch branch).
- **Tests:** the CI guard script itself (pure, unit-testable or shell-tested).
- **Docs:** INFRASTRUCTURE.md migrations section: the collision incident +
  the new rule.
- **Rollback:** columns are unused by any reader (verify by grep) — re-adding
  them via a revert migration is safe; ledger repair commands are recorded in
  the PR for manual reversal.

**Prompt:**

> Dev's migration ledger is drifted. Verify first (read-only SQL on dev):
> `SELECT version, name FROM supabase_migrations.schema_migrations WHERE
> version LIKE '20260610%'` shows BOTH 20260610000000 and 20260610000001
> named `fix_sync_nav_cron_app_config`, while the repo's 20260610000000 is
> `drop_scheme_master_backfill_columns.sql`; and `information_schema.columns`
> shows scheme_master still HAS last_backfill_attempted_at, backfill_outcome,
> backfill_failure_count, is_inactive (9,217 rows stamped) — the drop DDL
> never executed even though the version is marked applied (PR #203's commit
> message mis-diagnosed this). Three deliverables: (1) a new migration
> `20260612xxxxxx_drop_backfill_columns_for_real.sql` using `ALTER TABLE ...
> DROP COLUMN IF EXISTS` ×4 and `DROP INDEX IF EXISTS
> idx_scheme_master_backfill_rotation`, with a header comment telling the
> whole story; grep first to prove no reader of these columns exists in
> app/, src/, supabase/, scripts/. (2) Ledger repair: update the two
> mis-named rows so (version,name) matches the repo files — document the
> exact statements/commands you run (UPDATE on
> supabase_migrations.schema_migrations or `supabase migration repair`),
> execute against dev, and show before/after. (3) CI collision guard: a
> small script (scripts/check-migration-versions.mjs or shell) that fails if
> two files in supabase/migrations share a version prefix OR if a PR adds a
> version ≤ the max version on origin/main; wire it into
> supabase-validate.yml. Prove it works by showing it catch a synthetic
> duplicate. Push the migration to dev, then show: columns gone, ledger
> consistent, `supabase db push` from a clean checkout is a no-op. Note in
> the PR that regenerating database.types.ts is a no-op here (types already
> assume the columns are gone — that was part of the drift).

---

#### FL-3 `fix(nav-retention): drive candidates from nav_history, not a capped scheme_master scan`

- **Objective:** fix the 1,000-row silent cap; make the pruner correct for
  any future orphan volume. ⏰ Must deploy before Sunday 2026-06-14 03:00 UTC.
- **Files:** `supabase/functions/nav-retention/index.ts`,
  `supabase/functions/_shared/nav-retention.ts` + tests.
- **Validation:** dry-run mode on dev returns the expected candidate set
  (currently ≈ 0–6 schemes); held codes never in the delete set; after
  Sunday's run (OP-2): held rows invariant
  (`count(*) FROM nav_history WHERE scheme_code IN (SELECT scheme_code FROM
  user_fund)` unchanged), logs show plausible deletes.
- **Tests:** pagination/exhaustion of the candidate walk; held-exclusion;
  cap behaviour (`MAX_ROWS_PER_RUN`).
- **Docs:** INFRASTRUCTURE.md retention runbook section (drop the now-false
  "weekly runs drain any backlog" claim → true again).
- **Rollback:** revert; deletes are regenerable data by design (OF/mfapi).

**Prompt:**

> Bug in supabase/functions/nav-retention/index.ts (PR #204): the candidates
> query at lines ~62–65 (`scheme_master` filtered by
> `nav_backfilled_at.is.null,nav_backfilled_at.lt.<cutoff>`) is unpaginated
> and unordered — PostgREST caps it at 1,000 rows on a 37,595-row table, so
> the pruner can only ever consider an arbitrary ~1,000 schemes (the
> migration comment in 20260610000002 claiming "multiple weekly runs drain
> any backlog" is false). The backlog was cleaned manually, so today
> nav_history has only ~120k rows / 42 schemes — verify both facts
> read-only. Fix by inverting the walk: candidates = schemes that actually
> HAVE nav rows (small by construction post-cleanup) minus held minus
> recently-stamped. Implement as: page `nav_history` distinct scheme_codes
> via a SQL helper (a `security definer` function
> `public.nav_history_scheme_codes()` returning distinct codes, added in a
> tiny migration — sequence this PR after FL-2 merges so the ledger is clean
> — or a paginated PostgREST walk with `.range()` like universe-backfill's
> loadFullUniverse, lines 92–117; justify your pick), then look up only
> those codes' `nav_backfilled_at` in scheme_master (`.in()` batches of
> ≤200). Keep `isPruneable`, the held-exclusion, SCHEME_DELETE_BATCH_SIZE
> and MAX_ROWS_PER_RUN exactly as they are. Add a `dryRun: true` body param
> that returns the would-delete scheme list without deleting (the weekly
> cron keeps POSTing no body = real run). Extend
> _shared/__tests__/nav-retention tests: candidate-walk exhaustion past one
> page, held exclusion, dry-run. Deploy to dev before Saturday; run
> dryRun and paste the output in the PR. Update the runbook section in
> docs/INFRASTRUCTURE.md.

---

#### FL-4 `chore: retire legacy writers — sync-amfi-portfolios, stock-market-cap trio, diag-nav`

- **Objective:** remove the last pre-OpenFolio scheduled writer (which also
  writes to **prod** during the freeze), and the dead stock-market-cap and
  diag-nav artifacts.
- **Files:** delete `.github/workflows/sync-amfi-portfolios.yml`,
  `scripts/sync-amfi-portfolios.mjs`,
  `.github/workflows/backfill-stock-market-cap.yml`,
  `scripts/backfill-stock-market-cap.mjs`,
  `supabase/functions/sync-stock-market-cap/` (if present in repo);
  README/docs tables.
- **Validation:** `gh workflow list` (or Actions UI) shows neither workflow;
  grep proves no references; dev DB `source='amfi'` count stays 0; deployed
  functions `sync-stock-market-cap` and `diag-nav` deleted from dev
  (`supabase functions delete`) — list functions before/after.
- **Tests:** none (deletions); CI green proves nothing referenced them.
- **Docs:** README workflows table, data-sync-pipeline.md,
  deprecate-post-openfolio.md (new phase entry).
- **Rollback:** git revert restores workflows/scripts; functions redeploy
  from history if ever needed.

**Prompt:**

> Retire the last contradictory legacy writers. Evidence to verify and cite:
> (1) `.github/workflows/sync-amfi-portfolios.yml` is still scheduled
> (`cron: '0 6 11 * *'`) and its script
> (scripts/sync-amfi-portfolios.mjs) writes `source='amfi'`
> fund_portfolio_composition rows from mfdata.in — contradicting the
> OpenFolio-first ladder AND migration 20260610000000's comment that the tag
> is retired; its prod job block (`SUPABASE_SECRET_KEY_PROD`) means it
> mutates prod monthly despite the intentional prod freeze; dev currently
> has ZERO amfi rows (`SELECT count(*) FROM fund_portfolio_composition WHERE
> source='amfi'`), so its 2026-06-11 06:00 UTC run wrote nothing — it is
> simultaneously policy-violating and non-functional. (2)
> backfill-stock-market-cap.yml + scripts/backfill-stock-market-cap.mjs
> target the `stock_market_cap` table DROPPED by 20260608000001 — any run
> fails. (3) The deployed edge functions `sync-stock-market-cap` (updated
> 2026-06-08) and `diag-nav` (2026-03-25) are zombies. Delete the two
> workflows + two scripts (+ the sync-stock-market-cap function source dir
> if present), delete both deployed functions from dev via `supabase
> functions delete <slug> --project-ref imkgazlrxtlhkfptkzjc`, and update
> README's workflows table, docs/architecture/data-sync-pipeline.md, and
> docs/plans/deprecate-post-openfolio.md. Decision to document (don't act):
> `COMPOSITION_SOURCE_RANK` keeps its 'amfi' entry because prod still
> carries legacy amfi rows from before the freeze — removing the rank is a
> post-prod-cleanup task. State the tradeoff: dev loses nothing (the writer
> produced 0 rows); prod loses a broken monthly mutation it should never
> have had.

---

#### FL-5 `feat(ops): daily data-freshness monitor`

- **Objective:** end the silent-failure era: one daily check that would have
  caught every failure in this cycle (frozen NAV, cancelled backfill, failed
  rows, dead amfi job, OF outage).
- **Files:** new `supabase/functions/freshness-check/`, migration (cron +
  `security definer` helper to read `cron.job_run_details`), `_shared`
  helpers + tests, INFRASTRUCTURE.md.
- **Validation:** invoke on dev → green report; simulate a failure (e.g.
  temporarily point OF base URL at a bad host in the request body override)
  → alert fires; cron visible in `cron.job`.
- **Tests:** pure checks unit-tested (thresholds, trading-day allowance,
  cursor staleness rules) with injected clock/data.
- **Docs:** INFRASTRUCTURE.md (new section: what it checks, how to add a
  check, where alerts go).
- **Rollback:** unschedule cron; function is read-only.

**Prompt:**

> Build a `freshness-check` edge function + daily pg_cron job (08:00 UTC,
> `app_config_get` URL pattern, `--no-verify-jwt`). Context: in the last 10
> days, every failure was silent — sync-nav-hourly failed 18×/day for 5 days
> unnoticed; all 3 universe-backfill workflow runs were cancelled with 69
> row-failures recorded in an app_config cursor nobody read; a monthly
> composition workflow no-opped. Checks (each returns
> {name, ok, detail}): (1) **Held NAV age**: max(nav_date) over schemes in
> user_fund ≥ today − 3 calendar days (tolerates weekends + one holiday;
> make the threshold a constant with a comment). (2) **Cron failures**:
> count of failed runs in `cron.job_run_details` joined to `cron.job` over
> the last 24 h = 0. PostgREST can't see the cron schema, so add a migration
> creating `public.recent_cron_failures(hours int)` as a `security definer`
> SQL function returning (jobname, status, start_time, message) — read-only,
> grant execute to service_role only; sequence the migration after FL-2.
> (3) **Backfill cursors**: for each `universe_backfill_*_cursor` in
> app_config: warn if `failed` > 0 or if the cursor value hasn't changed in
> 48 h while no `_done_at` marker exists (stalled walk — coordinate key
> names with FL-1 if it has merged; otherwise use today's key names and note
> the follow-up). (4) **OpenFolio health**: GET
> `${OPENFOLIO_API_BASE}/health` (no key needed) → status ok,
> `db_schemes` > 1,500, `latest_disclosure_date` ≤ today + 1 day (a
> future-dated HSBC snapshot leaked through once). (5) **Composition
> staleness**: max(portfolio_date) of source='official' within 75 days.
> Alerting: on any failed check, send one consolidated email via the same
> Resend pathway notify-feedback uses (read that function first and reuse
> its util/secret); always emit a structured `[freshness-check]` summary
> log line. Unit-test every check pure (inject rows + clock). Deploy to
> dev, run once green, then demonstrate one simulated failure end-to-end
> (e.g. body override `{openfolio_base: 'https://invalid.example'}`) and
> paste the alert. Document in INFRASTRUCTURE.md.

---

#### FL-6 `feat(compare): max_drawdown_5y as-reported fallback`

- **Objective:** consume OpenFolio #53's `max_drawdown_5y` so the Risk card's
  drawdown is no longer blank for metadata-only funds.
- **Files:** both twins (`supabase/functions/_shared/openfolio.ts`
  `FundMetadataMetrics` ~215–223; `src/lib/data/composition.ts` ~200–206),
  writers (`sync-fund-meta`, `universe-backfill`, `fetch-fund-snapshot` —
  merge into `risk_ratios` jsonb), reader (`src/utils/computedFundMetrics.ts`
  `selectCompareMetrics` ~311–351, currently `maxDrawdown: null` at ~346),
  Compare Risk card (`ClearLensCompareFundsScreen.tsx` ~1275–1336), tests.
- **Validation:** after tonight's OF nav job (image already #53), spot-check
  one scheme's `/v1/schemes/{code}/metadata` carries max_drawdown_5y; sync a
  held fund on dev → risk_ratios contains it; Compare shows † drawdown for a
  metadata-only fund and switches to computed once the series loads.
- **Tests:** new guard reader (null/missing/negative-decimal cases);
  selectCompareMetrics fallback including DD; UI footnote text.
- **Docs:** cache-surfaces.md — risk_ratios payload gains a key (assess
  `__BUSTER__`; jsonb key addition is usually `[cache-shape-stable]` — the
  reader must tolerate absence either way).
- **Rollback:** revert; the jsonb key is inert for old readers.

**Prompt:**

> OpenFolio-Data #53 (deployed; data materialises in nav.db from the
> 2026-06-11 evening run onward) added `max_drawdown_5y` (decimal ≤ 0,
> peak-to-trough over trailing 5y) to FundMetrics in
> /v1/schemes/{id}/metadata and /v1/metadata. FolioLens consumes none of
> it: both OpenFolio client twins' FundMetadataMetrics lack the field, and
> Compare's as-reported fallback hard-codes `maxDrawdown: null`
> (src/utils/computedFundMetrics.ts ~line 346) so metadata-only funds show
> a blank drawdown with the footnote "Drawdown, Sharpe, and Sortino require
> full NAV history." Changes: (1) add `max_drawdown_5y: number | null` to
> FundMetadataMetrics in BOTH twins (supabase/functions/_shared/openfolio.ts
> and src/lib/data/composition.ts — keep them byte-identical in the shared
> region; if FL-12's drift guard has landed, it will enforce this). (2) In
> the three metadata writers (sync-fund-meta, universe-backfill metadata
> phase, fetch-fund-snapshot), merge `max_drawdown_5y` into the existing
> `risk_ratios` jsonb alongside volatility (follow sync-fund-meta's
> merge-don't-replace pattern at ~337–345; never write the key when
> upstream is null — honest nulls). (3) Add a pure reader
> `readOfMaxDrawdown(riskRatios)` in src/utils/mfdataGuards.ts (validate:
> number, ≤ 0, > −1) and use it in selectCompareMetrics' fallback branch so
> `maxDrawdown` fills with `source: 'as-reported'`; the Risk card's
> drawdown bars must include as-reported funds with the same `†` provenance
> treatment as volatility (~1297–1336) and the footnote must stop claiming
> drawdown always needs full history (say "Sharpe and Sortino require full
> NAV history" + the as-reported note). Computed-from-series must still win
> whenever any series metric computes — do not mix sources within a fund's
> row. Tests: the new guard (all edge cases), selectCompareMetrics with DD
> present/absent, computed-wins. Feature-detect: everything must behave
> identically when the field is absent (older blobs). Assess
> cache-surfaces.md: risk_ratios is an existing jsonb in the scheme_master
> select, so this should be `[cache-shape-stable]` — justify or bump
> `__BUSTER__`.

---

#### FL-7 `feat(registry): scheme_active flag — migration + writers + picker demotion`

- **Objective:** persist OpenFolio's `active` registry signal and stop the
  picker ranking wound-up schemes equal to live ones.
- **Files:** migration (`scheme_master.scheme_active boolean`), twins
  (`SchemeFamily`/metadata types if needed), writers (`universe-backfill`
  metadata phase, `sync-fund-meta`), `src/utils/fundSearch.ts` (~85–115),
  `database.types.ts` regen, tests.
- **Validation:** after a backfill chunk + one sync-fund-meta run on dev:
  `count(scheme_active)` > 0; picker query orders
  `scheme_active.desc.nullslast, scheme_name.asc`; a known wound-up scheme
  sorts below live ones for the same query.
- **Tests:** writer mapping (true/false/missing → null), search ordering
  unit test at the query-builder level.
- **Docs:** data-sync-pipeline.md (new column + who writes it);
  cache-surfaces.md — **the picker select adds a column → assess
  `__BUSTER__`**.
- **Rollback:** revert app code; column is additive and nullable (leave it).

**Prompt:**

> OpenFolio-Data #53 added `active: boolean` to FundMetadata /
> SchemeRegistryItem (true when the scheme appeared in AMFI NAVAll within 30
> days; false for wound-up/merged schemes). FolioLens's picker currently
> ranks all 37,595 scheme_master rows purely alphabetically within ilike
> matches (src/utils/fundSearch.ts:85–115) — dead schemes rank equal to
> live ones. This PR depends on FL-2 (clean migration ledger) — confirm
> it merged. Changes: (1) migration adds `scheme_master.scheme_active
> boolean` (nullable; comment: null = not yet synced from OpenFolio; do NOT
> default false — honest nulls). (2) Map the upstream `active` field in the
> metadata writers: universe-backfill's metadata phase and sync-fund-meta's
> OpenFolio leg both upsert it (add the field to the twins' FundMetadata
> type in the shared region of both files — byte-identical). (3)
> searchSchemes orders `scheme_active.desc.nullslast` then
> `scheme_name.asc` and adds the column to its select; do NOT filter
> inactive schemes out (a CAS can legitimately hold a matured scheme — they
> must stay findable, just demoted). (4) Regenerate database.types.ts.
> Tests: writer mapping (true/false/undefined), query-builder ordering.
> Validate on dev: push migration, deploy functions, run one backfill chunk
> (`force` a small metadata chunk if FL-1's markers are live), then show a
> search where a wound-up scheme (find one: scheme_active=false) sorts
> below active matches. The picker select changes shape → check
> docs/architecture/cache-surfaces.md and bump `__BUSTER__` if the
> scheme_master query head is persisted (follow the v7 precedent in
> src/lib/queryClient.ts:42–80).

---

#### FL-8 `fix(meta): period_returns — fresher mfdata may refresh mfdata-written values`

- **Objective:** close the staleness freeze: OF-404 schemes whose returns come
  only from mfdata currently can never update after first write.
- **Files:** `supabase/functions/_shared/period-returns.ts` (~66–70) + tests;
  callers unchanged.
- **Validation:** dev spot-check one mfdata-only scheme across two simulated
  syncs with different as_of_date — values update; one OF-then-mfdata scheme
  — OF values survive.
- **Tests:** the three scenarios below + existing suite green.
- **Docs:** none beyond the file's header comment.
- **Rollback:** revert (reader is dual-shape; data self-corrects on next
  sync either way).

**Prompt:**

> Latent flaw from #207: `mergeMfdataReturns` in
> supabase/functions/_shared/period-returns.ts makes the EXISTING blob win
> over incoming mfdata for every overlapping key (lines ~66–70). That
> protects OpenFolio-written values (intended) but also freezes
> mfdata-written values: an OF-404 scheme that gets returns from the mfdata
> backup leg can never receive fresher mfdata numbers or a newer
> as_of_date. Required semantics, expressed as three scenarios that must
> become unit tests: (A) blob written by OF (`mergeOfReturns`) → incoming
> mfdata must NOT overwrite those canonical keys; (B) blob written only by
> mfdata → fresher incoming mfdata (newer or equal as_of_date)
> MUST overwrite values, ranks and as_of_date; (C) mixed history (OF
> overwrote some keys of an older mfdata blob) → OF-written keys survive,
> mfdata-era extras refresh. Design constraint: the blob currently has no
> per-key provenance — you may add a minimal marker (e.g. an `of_keys:
> string[]` array maintained by `mergeOfReturns`, or per-key source map) as
> long as `readReturnPct` (src/utils/mfdataGuards.ts:155–166) continues to
> work unchanged on old AND new blobs (it ignores unknown keys — verify
> with its tests) and the 28 legacy mfdata-shape rows on dev still read
> correctly (cite the live count). Pin conversion correctness (12.5 ↔
> 0.125) and all three scenarios in
> _shared/__tests__/period-returns.test.ts. `[cache-shape-stable]` only if
> the client-visible read behaviour is unchanged — assess.

---

#### FL-9 `fix(nav): non-held stale-tail top-up + real write-back-poisoning test`

- **Objective:** close the review's old P2: SQLite series for non-held funds
  written before #208 can serve an aging tail forever; also replace the
  phantom test reference with a real functional test.
- **Files:** `src/hooks/useFundDetail.ts` (~358–404), Compare hydration
  callback (`ClearLensCompareFundsScreen.tsx` ~1986–2025), tests
  (`useFundDetail.windowed.test.ts` — fix lines ~122–135 citing the
  non-existent `poisoning-trap.test.ts`).
- **Validation:** simulated stale local series + hydration response with newer
  `last_nav_date` → fetcher tops up the tail; full-history path still writes
  back; windowed path still never writes back.
- **Tests:** top-up triggered/not-triggered; the previously-phantom poisoning
  assertion implemented for real.
- **Docs:** none.
- **Rollback:** revert; behaviour returns to serve-any-local-rows.

**Prompt:**

> Two related gaps in src/hooks/useFundDetail.ts. (1) Stale tail:
> `fetchFundNavHistory` returns any non-empty local SQLite series without a
> freshness check (~380–388), and delta sync only covers held schemes — so
> a non-held scheme whose FULL series was written back pre-#208 serves an
> aging tail forever; Compare's `fetch-fund-nav` hydration refreshes
> Supabase and invalidates the query, but the refetch reads stale SQLite
> first, so the top-up never reaches the device. Fix: the hydration
> response already carries `last_nav_date`
> (ClearLensCompareFundsScreen.tsx ~1986–2025) — after a successful
> hydration, compare it against the local SQLite max(nav_date) for that
> scheme; when local is older, fetch only the missing tail from Supabase
> (`gte` local max) and append it to SQLite (this is a full-history series
> so tail write-back is safe — explain why in a comment), THEN invalidate.
> Implement the comparison as a pure exported helper with unit tests; keep
> Fund Detail's behaviour unchanged. (2) Test debt: `npx jest
> useFundDetail.windowed` — the write-back-poisoning case (~122–135) is a
> placeholder citing a `poisoning-trap.test.ts` that does not exist. Write
> the real functional assertion: a windowed (`sinceDate`) fetch must NOT
> write to SQLite; a full fetch MUST. Mock at the wrapper boundaries per
> repo convention. Validation evidence: test output + a manual trace of one
> simulated stale-tail top-up (described step by step in the PR).

---

#### FL-10 `chore(sync): since-map pagination + rows_upserted semantics`

- **Objective:** two small edge-function hygiene fixes from the review.
- **Files:** `supabase/functions/sync-nav/index.ts` (~71–84),
  `supabase/functions/fetch-fund-nav/index.ts` (~80).
- **Validation:** dev invoke sync-nav — every held scheme resolves a `since`
  (log it); fetch-fund-nav re-invocation on a fresh scheme reports
  `rows_upserted: 0` instead of the attempted count.
- **Tests:** since-map builder paginates past 1,000 rows (pure helper test);
  upsert-count semantics.
- **Docs:** none.
- **Rollback:** revert; both behaviours degrade gracefully today.

**Prompt:**

> Two small fixes. (1) sync-nav's since-map query
> (supabase/functions/sync-nav/index.ts ~71–84) fetches the last 45 days of
> nav_history for all held schemes in ONE unpaginated query ordered desc —
> PostgREST caps it at 1,000 rows, so with enough held schemes the tail
> falls out of the map and those schemes silently degrade to full-history
> re-fetches (`since=null`). Paginate with `.range()` until short page
> (extract a pure helper + unit test with >1,000 synthetic rows), or
> justify switching to a grouped SQL helper. Keep the
> first-occurrence-per-scheme semantics identical. (2) fetch-fund-nav
> counts `rows_upserted += chunk.length` without `ignoreDuplicates`
> (~line 80) so re-hydrations report attempted rows, not new rows — unlike
> sync-nav. Align it: `ignoreDuplicates: true` + count actual inserts,
> preserving the response contract `{scheme_code, rows_upserted,
> last_nav_date, status}` (Compare and Past-SIP read it — check call sites
> before changing anything). Deploy both to dev; evidence: logs from one
> sync-nav run showing per-scheme since values for ALL held schemes, and a
> double-invocation of fetch-fund-nav showing 0 on the second call.

---

#### FL-11 `docs(release): prod release runbook (R10) + beta smoke checklist`

- **Objective:** the missing R10 — a scripted landing for the intentional
  prod drift, plus the beta smoke checklist.
- **Files:** new `docs/release-runbook.md`; link from INFRASTRUCTURE.md +
  release-pipeline.md.
- **Validation:** dry-read by a second pair of eyes (or agent) executing
  each step against DEV as a rehearsal — every command must be runnable
  as written.
- **Tests:** n/a (docs).
- **Docs:** is the deliverable.
- **Rollback:** n/a.

**Prompt:**

> Write docs/release-runbook.md: the scripted prod release for FolioLens's
> intentionally-drifted prod (ohcaaioabjvzewfysqgh, ~6 weeks behind). Source
> material: docs/INFRASTRUCTURE.md "Producing a release" (5 steps, covers
> migrations+functions+OTA only), docs/architecture/release-pipeline.md
> (CI pipelines), and the 2026-06-11 post-remediation review §2.1/§5
> (docs/research/openfolio-architecture-review-2026-06-11-post-remediation.md)
> for the failure modes it must prevent. Required sequence, each step with
> the exact commands and a verification query: (1) preflight — diff repo
> migrations vs prod's schema_migrations ledger (the dev ledger drifted via
> a version collision; prod must be checked for the same class of issue
> BEFORE pushing), confirm the FL-2 collision guard is green; (2) secrets
> parity — enumerate every secret the edge functions read (grep
> Deno.env.get across supabase/functions: OPENFOLIO_API_BASE/KEY, RESEND,
> POSTHOG, etc.) and verify each exists on prod; (3) migrations push +
> ledger verify; (4) edge function deploys (list every function and its
> --no-verify-jwt requirement); (5) cron verification SQL (all jobs present,
> app_config_get-based, app_config.supabase_functions_base_url set for
> prod); (6) data backfill — run the universe backfill to completion on prod
> (FL-1's driver, env=prod) + seed retention; (7) post-deploy verification —
> held NAV freshness, coverage counts, freshness-check green, one Compare
> smoke; (8) rollback notes per step. Add a separate "Beta smoke checklist"
> section (cold-launch NAV date visible without pull-to-refresh; fresh
> unheld pick in Compare renders TER/returns/composition; Past-SIP run; CAS
> import round-trip; offline relaunch). Keep every claim about current
> state verifiable — where you cannot verify prod state read-only, mark the
> step "verify at execution time". Link it from INFRASTRUCTURE.md and
> release-pipeline.md.

---

#### FL-12 `test(contract): OpenFolio client-twin drift guard (R12)`

- **Objective:** lock the two clients' shared contract region so FL-6/FL-7
  (and future edits) can't silently diverge them.
- **Files:** marker comments in both twins, new jest test
  (`src/lib/data/__tests__/twin-contract.test.ts`), possibly jest config.
- **Validation:** test fails when one twin's shared region is edited alone
  (demonstrate in PR with a scratch diff), passes on main.
- **Tests:** is the deliverable.
- **Docs:** header comments in both twins pointing at the guard.
- **Rollback:** delete the test (no runtime impact).

**Prompt:**

> R12 from the June reviews is still open: src/lib/data/composition.ts is a
> deliberate, documented mirror of supabase/functions/_shared/openfolio.ts
> (exit-runbook boundary; verified byte-equivalent on 2026-06-11 across all
> shared types and the 8 endpoint methods) but nothing guards against
> silent drift, and composition.ts has zero importers and zero tests.
> Implement the cheapest durable guard: (1) wrap the shared contract region
> in BOTH files with `// BEGIN OPENFOLIO SHARED CONTRACT (guarded — see
> twin-contract.test.ts)` / `// END OPENFOLIO SHARED CONTRACT` markers —
> the region covers the type declarations and request-building constants
> that must stay in lock-step (types AssetMix … SchemeListPage, endpoint
> paths, query-param names, env-var resolution), NOT the Deno-only sync
> core (runOpenFolioSync etc.) or the app/Deno-specific fetch plumbing —
> choose the boundary so both regions can be byte-identical and move
> anything that prevents that. (2) A jest test that reads both files from
> disk, extracts the regions, normalises trailing whitespace only, and
> asserts equality with a diff-style failure message telling the editor to
> update both files. (3) Prove it: include in the PR description the test
> output from a deliberate one-sided edit (then revert it). Coordinate with
> FL-6/FL-7 if they're in flight — this PR should land FIRST so their twin
> edits are guarded; the markers must not change runtime behaviour
> (comments only). Note `'!src/lib/data/**'` is excluded from coverage in
> jest.config.js — the new test lives outside that exclusion's effect on
> thresholds; confirm jest picks it up.

---

#### FL-13 `feat(search): rank picker results by liveness + data completeness`

- **Objective:** finish the picker UX: among matches, live schemes with real
  metadata first. Depends on FL-7.
- **Files:** `src/utils/fundSearch.ts`, tests; possibly a partial index
  migration if measured slow.
- **Validation:** searches for common terms ("flexi cap", an AMC name) put
  active+enriched schemes first; wound-up/naked rows still findable.
- **Tests:** ordering unit tests at query-builder level.
- **Docs:** none.
- **Rollback:** revert ordering change.

**Prompt:**

> Depends on FL-7 (scheme_active column populated; confirm merged and
> backfilled). Improve searchSchemes ranking
> (src/utils/fundSearch.ts:85–115): current order is purely alphabetical
> within ilike matches over 37,595 rows, 95 % of which are historical
> shells. New order: `scheme_active.desc.nullslast`, then data-completeness
> (openfolio_meta_synced_at not-null first — add it to the select or derive
> a boolean), then `scheme_name.asc`. Do NOT exclude anything (CAS imports
> reference matured schemes). Keep the gin_trgm-backed ilike matching and
> the 25-row paging exactly as-is; measure query latency on dev before/after
> (EXPLAIN ANALYZE via read-only SQL) and only add an index/migration if
> p95 regresses materially — justify either way. Unit-test the
> query-builder ordering. Check cache-surfaces.md: if the select head
> changes shape for a persisted query, bump `__BUSTER__`; otherwise tag
> `[cache-shape-stable]` with reasoning. UX evidence: before/after search
> results for "flexi cap" and one AMC name, showing a wound-up scheme
> demoted.

---

#### FL-14 `feat(past-sip): month-end NAV via local RPC`

- **Objective:** cut Past-SIP egress ~30× by reading ~60–240 month-end points
  instead of the full paginated series.
- **Files:** migration (SQL function `public.month_end_nav(p_scheme_code
  int)`), `ClearLensPastSipCheckScreen.tsx` (~116–143), tests.
- **Validation:** Past-SIP result for a known fund identical before/after
  (same month-end points); payload size logged before/after.
- **Tests:** RPC fallback behaviour; month-end selection edge cases (month
  with no trading day data, current partial month) — SQL tested via a pure
  TS mirror helper or pgTAP-style assertions in the migration comment.
- **Docs:** data-sync-pipeline.md read-paths table.
- **Rollback:** screen falls back to the existing paginated path (keep it as
  the fallback branch).

**Prompt:**

> Past SIP Check fetches a fund's full NAV series from Supabase with
> pagination (~3–6k rows) though it only consumes month-end points
> (src/components/clearLens/screens/tools/ClearLensPastSipCheckScreen.tsx
> ~116–143, after a fetch-fund-nav warm-up which stays unchanged —
> rows are local in Postgres post-hydration, so no OpenFolio call is needed
> at read time; note this is why we do NOT use OF's new
> `sample=month_end`). Add a migration creating
> `public.month_end_nav(p_scheme_code int) RETURNS TABLE(nav_date date,
> nav numeric)` — last row per calendar month from nav_history, `STABLE`,
> `security invoker`, grant to authenticated+anon per the existing
> read-policy pattern (check how nav_history is exposed today and match
> it). Sequence after FL-2. Update the screen to call
> `.rpc('month_end_nav', ...)` and keep the existing paginated fetch as an
> explicit fallback when the RPC errors (feature-detect, log which path
> ran). The SIP engine must receive the same shaped rows — assert
> equivalence in a unit test with a fixture series (incl. a month with a
> single trading day and the current partial month: the RPC returns its
> last available row; the engine already anchors on month-end — verify and
> cite). Evidence: identical XIRR/result for one fund before/after, and
> the row counts (≈3–6k → ≈60–240).

---

#### FL-15 `feat(ops): monthly coverage reconciliation`

- **Objective:** catch coverage regressions (the silent 4 %-coverage era)
  structurally. Depends on FL-5.
- **Files:** extend `freshness-check` (monthly branch) or sibling function +
  cron migration; tests.
- **Validation:** dev run reports FolioLens-vs-OpenFolio counts within
  tolerance post-OP-1; simulated divergence alerts.
- **Tests:** tolerance math pure tests.
- **Docs:** INFRASTRUCTURE.md monitor section.
- **Rollback:** unschedule.

**Prompt:**

> Extend the FL-5 freshness-check (confirm merged) with a monthly
> reconciliation (1st of month, separate cron entry → same function with
> `{mode:'monthly'}`): compare (a)
> `count(openfolio_meta_synced_at IS NOT NULL)` on scheme_master vs
> OpenFolio's `/v1/metadata` total `count` (page_size=1 — the response
> carries the total); (b) `count(DISTINCT scheme_code) WHERE
> source='official'` vs `/v1/composition` total; (c) max official
> portfolio_date vs OF /health `latest_disclosure_date`. Alert when
> FolioLens-side coverage < 85 % of upstream or the disclosure-date lag
> exceeds 45 days (constants with comments). Reuse FL-5's alert pathway and
> check-report shape; pure-test the tolerance math. Deploy, run once on dev
> post-OP-1, paste the report. Document the thresholds in
> INFRASTRUCTURE.md.

---

#### FL-16 `docs(spike): index-series ownership decision`

- **Objective:** decide (don't build): keep `sync-index` (Yahoo/NSE in
  FolioLens) vs move index series into OpenFolio-Data (which would unlock
  upstream beta/R² later).
- **Files:** `docs/plans/index-series-ownership.md`.
- **Validation:** doc answers the decision with costs; reviewed by owner.
- **Tests/Docs/Rollback:** n/a (decision doc).

**Prompt:**

> Research-and-decide doc only, no code:
> docs/plans/index-series-ownership.md. Question: should benchmark index
> series (currently FolioLens's sync-index hourly cron → Yahoo/NSE →
> index_history, 48 MB, 3 TRI indexes + CDN snapshots) move upstream into
> OpenFolio-Data (new index store + /v1/index endpoints), which would also
> unlock computing beta/R² upstream against its own NAV store and retire
> the last mfdata-only analytics leg (risk_ratios beta)? Survey: current
> sync-index implementation + failure history (read the function + cron run
> details on dev), Yahoo/NSE ToS-and-stability considerations, what
> OpenFolio would need (source, storage size, job cadence, API), FolioLens
> migration path, and the do-nothing option. Deliver a recommendation with
> effort/risk and an explicit "decide by" condition (e.g. revisit only if
> Yahoo breaks twice in a quarter or beta-upstream becomes a committed
> feature). Keep it under 2 pages; cite code/file evidence.

---

#### OD-1 `feat(aum): AMFI monthly AAUM → fund_metrics` (OpenFolio-Data)

- **Objective:** give `fund_metrics.aum_cr` a real source — today it is
  structurally NULL (schema + API exist, no writer passes data).
- **Files:** new source adapter (e.g. `src/mfholdings/metadata/amfi_aaum.py`
  or `nav/aum.py`), monthly job wiring (`cli`/`pipeline`), fixtures + tests,
  `docs/SOURCES.md`, `DECISIONS.md`, README coverage note.
- **Validation:** local build writes aum_cr/aum_date for the large AMCs'
  schemes; one fund hand-checked against the AMC's published AAUM; API
  serves it.
- **Tests:** parser fixtures (offline), join-to-scheme_code matching, job
  wiring.
- **Docs:** SOURCES.md (mechanism + URL), DECISIONS.md entry, openapi.yaml
  untouched (field already documented).
- **Rollback:** additive column data; consumers feature-detect (FolioLens
  already maps aum_cr when present).

**Prompt:**

> fund_metrics.aum_cr/aum_date are a NULL contract: the schema
> (store/schema.py, nav/navdb.py), the API response (api.py ~477–481) and
> compute_fund_metrics' optional params all exist, but no caller ever
> passes AUM — verify with `grep -rn aum_cr src/` (only definitions, no
> producer) and a query against a built DB. Wire a real source: AMFI
> publishes scheme-wise **monthly Average AUM** (portal.amfiindia.com — the
> AAUM disclosure download; research the exact endpoint/format the same way
> SOURCES.md documents other AMFI mechanisms, and reuse the
> session-retry pattern from the AMFI scheme-CSV adapter in
> metadata/adapters/amfi_scheme_data.py, which already handles the
> portal's redirect flakiness). Build an adapter that downloads the latest
> month's AAUM, parses scheme_code → (aum_cr, aum_date=month-end), and a
> job step in the monthly build (after metrics compute) that upserts into
> fund_metrics in batches ≤500 (OOM discipline). Where AMFI lists AAUM at a
> level that doesn't map 1:1 to plan scheme_codes, distribute/resolve via
> the registry the same way other adapters resolve scheme identity — never
> guess; unmapped rows are skipped with a count logged. Offline fixture
> tests for the parser (commit a truncated real file) and the upsert.
> Hand-verify one well-known fund's AAUM against its AMC factsheet and cite
> it in the PR. DECISIONS.md entry: chosen source, level of aggregation,
> known caveats (AAUM = quarterly/monthly average, not point-in-time NAV
> AUM — name the field semantics honestly in docs). Downstream note for the
> PR body: FolioLens already maps aum_cr when present; its universe
> backfill must be re-run (FolioLens OP-1) to pick values up.

---

#### OD-2 `perf(api): batch the bulk-metadata page queries` (OpenFolio-Data)

- **Objective:** make `/v1/metadata` pages cheap — today each 300-item page
  does ~4–5 per-scheme lookups against a gcsfuse-mounted 3.5 GB nav.db
  (~1,200–1,500 random FUSE reads/page), which is the likely reason the
  FolioLens backfill crawls and times out.
- **Files:** `src/mfholdings/api.py` (get_metadata_bulk ~573–633, and the
  same pattern in any other bulk path), `nav/navdb.py` + `store/__init__.py`
  (new batch getters), tests.
- **Validation:** timed page fetch (page_size=300) before/after on the
  deployed service or a local 3-GB-class fixture — target <5 s/page; FolioLens
  backfill chunk wall-time drops correspondingly.
- **Tests:** batch getters vs per-row results equivalence on nav_stub.db.
- **Docs:** DECISIONS.md perf entry.
- **Rollback:** revert; behaviour identical, only slower.

**Prompt:**

> /v1/metadata (api.py get_metadata_bulk, ~573–633) assembles each page by
> calling, PER SCHEME: nav_store.get_registry, nav_store.get_fund_metrics,
> nav_store.get_scheme_active, store.get_fund_metadata_b1 (when not
> updated_since-paged) and store.get_fund_metadata_field_audit — ~4–5
> queries × 300 items ≈ 1,200–1,500 lookups per page, where nav.db is a
> 3.5 GB SQLite opened read-only over a gcsfuse mount (random reads are
> network round-trips). Downstream effect: FolioLens's universe backfill
> chunk (2 pages × 300) frequently exceeds its 150 s isolate budget.
> Restructure to ≤4 queries per page total: (1) one nav.db query joining
> nav_registry × fund_metrics × latest_nav (for the active cutoff) over
> `scheme_code IN (page codes)` — add a `get_metadata_page_rows(codes,
> active_cutoff)` method to NavStore; (2) one holdings-DB query for B1 rows
> IN codes and (3) one for audit rows IN codes (grouped in Python). Keep
> the updated_since branch's pagination source as-is (it pages the holdings
> DB) but batch its nav.db lookups the same way. Response must be
> byte-identical to today — prove with a test that renders a page via old
> and new paths over tests/fixtures/nav_stub.db and compares. Single-scheme
> /v1/schemes/{id}/metadata stays as-is. Measure and report: time per
> page_size=300 page before/after (local fixture timing is acceptable;
> note the gcsfuse amplification argument). Do NOT copy nav.db to local
> disk/memory — it exceeds the 1 GiB instance (document this rejected
> alternative in DECISIONS.md). Ruff/pyright/pytest green.

---

#### OD-3 `fix(parse): reject future disclosure dates` (OpenFolio-Data)

- **Objective:** stop future-dated snapshots (live example: an HSBC snapshot
  dated 2026-06-12 is being served on 2026-06-11 and surfaces as /health
  `latest_disclosure_date`).
- **Files:** disclosure-date normalisation site (parser/normalize/pipeline —
  locate it), tests with the HSBC-style case, DECISIONS.md.
- **Validation:** rebuild (or fixture-run) shows the future date rejected
  with a warning; /health latest_disclosure_date sane.
- **Tests:** boundary cases (today, today+1, today+30, obviously-swapped
  DD-MM).
- **Docs:** DECISIONS.md entry.
- **Rollback:** revert; bad dates return (cosmetic).

**Prompt:**

> The serving funds-holdings.db contains a snapshot with
> disclosure_date = 2026-06-12 (HSBC) — a future date as of build time —
> which propagates to /health's latest_disclosure_date. Reproduce: query
> snapshot for disclosure_date > build date on the current artifact; then
> find which HSBC file produced it and why the parsed date is in the
> future (likely a DD-MM/MM-DD swap or an "as on" string mis-parsed —
> diagnose, don't guess; the raw bytes are archived per the fetch layer's
> convention). Fix at the normalisation point where disclosure_date is
> finalised: a date more than 1 day in the future at build time is invalid
> → log a warning with amc + source_url and fall back to the
> month-end the file claims to cover when derivable, else skip the
> snapshot (never store a future date). Add boundary tests (today, +1 ok
> as timezone slack, +2 rejected, swapped-format case from the real HSBC
> string). If the diagnosis reveals a general DD-MM ambiguity, fix the
> general case and say so. DECISIONS.md entry. Note the next monthly build
> self-heals the existing bad row (snapshots are rebuilt); state whether
> anything must be done for the current artifact or we wait for the
> June 13 run.

---

### 10.5 Suggested execution order (one-line view)

```
Day 0:   FL-2 → merge first (unblocks all migration-bearing PRs)
Day 0:   FL-1, FL-3, FL-4, FL-5, FL-12, OD-2, OD-3   (parallel)
Day 1-2: OP-1 (drive backfill; re-run after OD-1/OD-2 land)
Day 2+:  FL-6, FL-7, FL-8, FL-9, FL-10, FL-11, OD-1  (parallel)
Jun 14:  OP-2 (watch first retention run)
Week 2+: FL-13, FL-14, FL-15, FL-16
Then:    OP-3 (prod rehearsal → release)
```

---

## Appendix — key measurements (dev, 2026-06-11T13:55Z)

| Metric | Review (06-10) | Now (06-11) |
|---|---|---|
| DB total | 1,685 MB | **119 MB** |
| nav_history | 8,804,996 rows / 8,141 schemes / 1,588 MB | **120,553 rows / 42 schemes / 22 MB** |
| held max(nav_date) | 2026-06-05 (frozen) | **2026-06-10 (current)** |
| sync-nav-hourly | 18/18 failed per day | 16/16 succeeded (48 h) |
| scheme_master OF-synced | 675 | 1,481 (of 14,374 target) — **stalled** |
| TER / AUM / period_returns | 585 / 70 / 688 | 1,165 / **70** / 1,485 |
| period_returns shapes | 659 OF / 29 mfdata | 1,463 OF / 28 mfdata |
| composition | official 1,415; rules 1,736/91 | official 1,415 (1,413 schemes); **rules 91/91 @ sentinel** |
| backfill cursor | n/a | metadata phase, cursor 6, written 1,431, **failed 69**; no composition cursor |
| index_history | 48 MB | 48 MB / 88,741 rows |
| users (dev) | — | 3 users / 39 holdings / 1,708 txs |
| OpenFolio serving DBs | — | funds-holdings.db 53 MB (2,046 families, 8,413 plan aliases, TER 8,665, **fund_metrics empty-by-design**); nav.db 3.5 GB (metrics for 37,963 nightly) |
| OpenFolio jobs | — | nav hourly 22:00–03:00 IST all green; monthly ingest last run Jun 7 (2 retries); API + jobs on `ee1a0b8` (#53) |
