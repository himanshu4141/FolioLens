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
