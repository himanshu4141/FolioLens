# FolioLens ↔ OpenFolio-Data — Beta Readiness Review (2026-06-12)

Fresh post-remediation review focused on **data quality, metadata quality, Compare readiness,
Fund Detail readiness, sync correctness, and beta readiness** — not architecture. Every claim
below was verified against current code and the live dev environment; previous reports were
treated as hypotheses.

**Baselines**

| | |
|---|---|
| FolioLens `origin/main` analysed | `d9e10e5ff22b18311c74a5d5b1f71eed1674c1c6` (local main == origin/main) |
| OpenFolio-Data `origin/main` analysed | `50d2ef7ce1523e1dde162048981e42746c3612ee` (#61; local main == origin/main) |
| Analysis timestamp | 2026-06-12T17:11:23Z |
| Dev Supabase | `imkgazlrxtlhkfptkzjc` (read-only SQL) |
| GCP | `fund-lens` — `openfolio-api` rev 00052-2br and all 3 jobs on image `50d2ef7` (exact deployment parity with main) |
| Live probes | OpenFolio API metadata endpoints (with key), `/health`, AMFI AAUM portal (read-only fetch via repo code), GitHub Actions run history |
| Prod | ignored (intentional freeze) |

---

## 1. Executive summary

The remediation wave **worked**. All 14 claimed FolioLens items (FL1–10, FL12–15) are merged,
deployed, and verifiable in live state; OP1 was genuinely driven to completion (both done
markers present, 8,351/8,351 active schemes metadata-synced, 8,296 schemes with official
composition, all crons green, DB at ~140 MB). The held-fund experience is launch-ready:
35/36 held schemes have fresh NAV (max 2026-06-11), TER, returns and official composition.
The random-active-fund experience moved from ~4 % coverage to **72–79 % fully
Compare-ready**, with honest "—" degradation for the rest.

Four new, material problems were found that the completed-work reports do not reflect:

1. **OD1 (AMFI AAUM → AUM) is functionally broken.** A live test of the merged adapter
   against the real AMFI portal parsed **1 junk row and resolved 0 schemes**: the report it
   fetches is *AMC-level* ("Fund-wise"), not scheme-level, the current-month report is all
   `N/A` (AMFI publishes quarterly), and a junk footer row makes the fetcher accept the empty
   page and stop searching. The `--aaum` flag is also wired only into the **monthly** (13th)
   scheduler. AUM will be **0 % tomorrow and every day after** until the adapter is
   re-pointed at a scheme-wise source. Every AUM cell in the app is currently "—"/"Unavailable".
2. **OpenFolio `/health` is dead** (>280 s, no response — confirmed twice). Regression from
   #61's cross-DB health check: it runs `SELECT COUNT(*) FROM nav_history` on the 3.5 GB
   nav.db over the GCS FUSE mount. Deployed today 12:49 UTC.
3. **The freshness monitor will break tomorrow morning, and its monthly mode is broken on
   arrival.** `fetchOpenFolioHealth` has no fetch timeout, so the hanging `/health` will hang
   the whole daily check past the isolate limit; and both monthly-reconciliation upstream
   fetchers send `Authorization: Bearer` where the API only accepts `X-API-Key` → guaranteed
   401 on the first run (Jul 1). The "end of the silent-failure era" is currently scheduled
   to end tomorrow at 08:00 UTC.
4. **~54 % of the active universe (4,515 IDCW/payout plans) carries distribution-distorted
   performance numbers.** NAV-only return/volatility/drawdown math treats income payouts as
   losses: a Banking & PSU **debt** fund shows 5y return −7.4 % and max drawdown **−34 %**
   (live API). 1,195 active IDCW schemes show drawdowns worse than −20 %. This affects both
   OpenFolio's as-reported metrics and FolioLens's locally-computed Compare metrics, which
   use the same unadjusted NAV.

Structural gap confirmed (not a regression): **nothing refreshes universe metadata after the
one-shot backfill.** Done-markers block re-runs; `sync-fund-meta` covers held funds only;
`openfolio-sync` is composition-for-held-only. Returns/TER/composition for the 8,300 unheld
active schemes are frozen at 2026-06-12 values until someone manually forces a re-run — and
the same mechanism is the only way corrected upstream metadata or future AUM will ever
propagate. A scheduled monthly forced re-run is a small workflow change and is the single
highest-leverage item on the list.

Also confirmed: served metadata still contains visible junk that PR #62 (open, unmerged)
addresses — 34+ garbage riskometer labels (full suitability sentences, OCR shrapnel like
"Very High Risk L M o o w de t r o at e"), 212 over-long benchmark strings with
holdings-bleed, 253 fund-manager values >200 chars, 92 TERs ≤ 0.

**Bottom line:** beta for held-fund workflows is ready today. Beta for "search any fund" is
close — coverage is no longer the problem; **value quality and monitoring are**. Five small
fixes (health endpoint, freshness hardening, scheme-wise AAUM, merge #62 + re-sync, monthly
refresh) plus an IDCW honesty pass separate today's state from a trustworthy public beta.

---

## 2. Completed work validation (FL1–10, FL12–15, OD1–3, OP1)

| Item | What | Verdict | Evidence |
|---|---|---|---|
| FL1 | Survivable backfill driver + done markers + `both` coordination | **Healthy** | OP1 drove it to completion in 8 short runs; `universe_backfill_{composition,metadata}_done_at` live in app_config; no cursors left; scheduled no-op runs succeed. Minor: the `*/15` cron now no-ops forever (GH minutes waste; repurpose it — see §11.5) |
| FL2 | Ledger repair + idempotent re-drop + CI collision guard | **Healthy (minor concerns)** | 4 zombie columns confirmed gone (`information_schema`); `20260612000000_drop_backfill_columns_for_real` applied; guard `scripts/check-migration-versions.mjs` wired in supabase-validate.yml and already caught a real collision (fa765b0 rename). Residue: ledger rows `20260610000000/1` are both still *named* `fix_sync_nav_cron_app_config` while the repo's `…000000` is the drop migration — version numbers align so `db push` is clean, but the name mismatch survives; cosmetic |
| FL3 | nav-retention candidate inversion (1k-cap fix) | **Healthy, pending first live run** | #211 merged + deployed (v18); first scheduled run is Sun 2026-06-14 03:00 UTC — watch it (OP-2) |
| FL4 | Retire legacy writers | **Healthy** | `sync-amfi-portfolios.yml`, `backfill-stock-market-cap.yml` gone from workflows; `sync-stock-market-cap` and `diag-nav` absent from the 20 deployed functions; composition table contains only `source='official'` rows |
| FL5 | Daily freshness monitor | **Regressed (latent, fires tomorrow)** | Function deployed (v11), daily cron green, this morning's 08:00 run passed — but it passed against the *old* OpenFolio image. The new image (12:49 UTC) hangs `/health`; `fetchOpenFolioHealth` has **no timeout** → tomorrow's run hangs the whole function. One bad upstream check should not take down the monitor |
| FL6 | max_drawdown_5y as-reported fallback | **Healthy** | Field in both twins; `readOfMaxDrawdown` guard in mfdataGuards.ts; 8,243 active schemes carry risk_ratios incl. DD. (Data caveat: IDCW distortion, §3) |
| FL7 | scheme_active flag + picker demotion | **Healthy** | Column live: 8,351 true / 5,749 false / 23,495 null; writers map it; search orders `scheme_active DESC NULLS LAST` |
| FL8 | period_returns mfdata-freeze fix | **Healthy** | `of_keys` provenance marker implemented in `_shared/period-returns.ts` with the three required scenarios tested |
| FL9 | Stale-tail top-up + real poisoning test | **Healthy** | Top-up helper at useFundDetail.ts:420; phantom test replaced |
| FL10 | since-map pagination + rows_upserted semantics | **Healthy** | `.range()` pagination at sync-nav:72–84; `ignoreDuplicates: true` at fetch-fund-nav:72 |
| FL12 | Twin-contract drift guard | **Healthy** | Markers in both twins; `supabase/functions/_shared/twin-contract.test.ts` matched by jest testMatch → runs in CI |
| FL13 | Search ranking (liveness + enrichment) | **Healthy** | fundSearch.ts orders active → enriched → name; OP1 probe confirmed live ordering |
| FL14 | Past-SIP month-end RPC | **Healthy** | `public.month_end_nav` exists on dev; screen calls it through `navHistoryRepo` (wrapper boundary kept); paginated fallback retained |
| FL15 | Monthly coverage reconciliation | **Regressed on arrival** | Code + cron (`freshness-check-monthly`, Jul 1) + helper RPCs all live, **but** both upstream fetchers send `Authorization: Bearer`; the API accepts only `X-API-Key` (verified in api.py middleware + live 401) → first run will report both upstream totals as unfetchable |
| OD1 | AMFI AAUM → fund_metrics.aum_cr | **Broken** | Live test (read-only, repo code, real portal): `parsed rows: 1` (junk row `name='0', aum_cr=0.0`), `resolved: 0`. Root causes: (a) `rpt=fwise` report is AMC-level, never scheme-level; (b) current-month report is all `N/A` (AMFI is quarterly) and the junk row makes `_fetch_latest_aaum_html` accept it and stop; (c) `--aaum` reached only the monthly-nav-release scheduler (13th, 10:00 UTC) — the 6×-daily nav job doesn't carry it. Net: upstream `aum_cr` is NULL for every scheme today and will stay NULL after tomorrow's first run |
| OD2 | Batch bulk-metadata page queries | **Healthy** | #55 merged; OP1 is the proof: metadata pages that previously starved a 150 s isolate (6 chunks in 6 h) completed 8 chunks per ~6-min workflow run |
| OD3 | Future disclosure-date rejection | **Healthy** | #56 merged (1-day grace, future-maturity rejection); registry `latest_disclosure_date=2026-06-12` on Jun 12 is sane |
| OP1 | Dev reset + full backfill | **Complete with known limitations** | §10 below |

Post-plan OpenFolio refactors #58–#61 (not in the original scope) are mostly hygiene, but
**#61 introduced the `/health` regression** (full `COUNT(*)` on nav_history over gcsfuse —
`compose.py compose_health` → `navdb.count_nav_rows`), confirmed dead at >280 s on the live
service.

---

## 3. OpenFolio data quality audit (current merged state)

Validation that exists today on `main`: pydantic typing on `FundMetadataRecord` (floats/dates
must parse), per-field B1 status machine (`value`/`officially_absent`/`not_applicable`/
`unresolved`/`parse_failed`/`source_failed`) with provenance audits, disclosure-date 1-day
future grace + future-maturity rejection (#56), fractional min-amount rejection in specific
adapters + carry-forward (#57), holdings-side plausibility guards (composition sums, numeric-
string corruption checks). **There is no central value-domain validation for B1 metadata** —
that is exactly what open PR #62 (`metadata/sanitise.py`: riskometer canonical 6-value set,
benchmark junk rejection, min-amount positivity/integrality, TER bounds, turnover bounds)
adds, and the dev data shows why it's needed:

| Field | Source | Validation today (merged) | Remaining risk (live evidence, active universe) | Confidence |
|---|---|---|---|---|
| Riskometer | AMC factsheets/sites (B1) | type=string only | **34+ garbage labels** (suitability sentences ×20, "and Relatively low Credit Risk" ×8, "free rate assumed to be 5.34%…" ×4, OCR shrapnel ×2) + casing duplicates ("Low to Moderate" 229 vs "Low To Moderate" 122); coverage only 37 % of active | High |
| Benchmark | AMC B1 | none beyond string | **212 values >120 chars**, 50 with holdings-bleed ("% of AUM", "Cholamandalam Cash, Call, NCA…"); rendered raw in Compare | High |
| TER | AMFI TER portal + AMC (B1) | parse-to-float | min 0.00 (92 schemes ≤ 0 — some legit index/new funds, unaudited), max **7.12 %** (2 schemes > 5 %); plausible-bounds guard pending #62 | High |
| AUM | AMFI AAUM (OD1) | n/a | **Structurally NULL — adapter broken (wrong report level + junk-row acceptance + monthly-only wiring)** | High (live test) |
| Min investment | AMC B1 | fractional rejection (#57) in 4 adapters + carry-forward | 16 zero values, 96 < ₹100, max ₹20 cr (institutional plans, probably legit); zero/positivity guard pending #62 | High |
| Min SIP | AMC B1 | fractional rejection (#57) | 26 zero values, 204 < ₹100 (₹10/₹50 SIPs are real — needs allowlist, not blanket floor) | High |
| Portfolio turnover | AMC B1 | parse-to-float | max 959 (% vs ratio ambiguity across AMCs; 46 > 100); bound guard pending #62 | Med |
| Category | AMFI seed + mfdata (FolioLens-side) | n/a upstream | 1,033 active schemes have neither scheme_category nor sebi_category | High |
| Returns | OF nav.db computed nightly | math is correct for growth plans | **IDCW distortion**: 4,247 active IDCW plans have NAV-only returns that count payouts as losses (debt funds with −7 % 5y "returns"); 6 ret_1y outside (−90 %, +300 %); 13 ret_5y < −50 % | High |
| Volatility / max DD | OF nav.db | computed | same IDCW distortion — 1,195 active IDCW schemes with DD worse than −20 %; 60 active schemes worse than −50 % (49 of those are *not* IDCW-named → some genuine, some data artifacts) | High |
| Fund manager | AMC B1 | none | 253 values > 200 chars (paragraph bleed); 0 pure-numeric junk; coverage 66.5 % | High |
| Dates (TER date, inception, disclosure) | AMC/AMFI | #56 future-date guards | disclosure dates sane post-#56; inception/ter_date not range-checked (no junk found in spot checks) | Med |

**Fully trustworthy today:** TER (98.9 % coverage, modulo the ≤0 tail), official composition
(provenance-dated), growth-plan returns/risk metrics, scheme identity/active flag, NAV.
**Needs hardening before users see it:** riskometer, benchmark string, fund_manager,
IDCW-plan performance numbers, AUM (absent), min amounts (zeros).

---

## 4. Random active fund audit (n=100, seeded `setseed(0.42)`, dev)

| Field | Available | Field | Available |
|---|---|---|---|
| TER | 99 % | Returns | 93 % |
| Risk ratios (vol/DD) | 97 % | Official composition | 92 % |
| Category | 82 % | Fund manager | 58 % |
| Benchmark (any) | 53 % | Riskometer | 38 % |
| AUM | **0 %** | | |

Readiness (sample → population):

- **Metadata readiness** (TER+category+riskometer+benchmark+manager all present): **26 %** —
  dragged down by riskometer (37 %) and benchmark (56 %) coverage.
- **Compare readiness** (TER+category+returns+risk+composition — OP1's "core" definition):
  **72 %** sample, 79 % population (6,614/8,351).
- **Fund-detail readiness** (TER+category+returns+composition): **72 %** sample. NAV chart
  hydrates on demand for ~every active scheme (OF nav.db covers the universe), so the chart
  itself is ~100 %.

Biggest causes of missing coverage, in order: AUM (broken upstream source, 100 %),
riskometer (B1 parse coverage, 63 %), benchmark (B1 parse coverage, 47 %), fund manager
(42 %), category (18 %, seed-mapping gap — these schemes never had an AMFI category string
that mapped, and mfdata enrichment only happens on first view), returns (7 %, mostly
genuinely young funds — honest), composition (8 %, schemes whose AMC disclosure didn't
match/parse).

**"Can a beta user search a random active fund and get a trustworthy experience?"**
**Mostly yes for growth plans, no for IDCW plans.** ~3 in 4 random funds render a complete
core experience; the remainder degrade honestly ("—", hidden all-empty rows). The trust
problem is not missing data — it is **wrong-looking data**: a user landing on any of the
4,200+ IDCW plans sees negative long-run returns and catastrophic drawdowns for boring debt
funds, and ~1 in 20 funds shows a junk riskometer/benchmark string. Those read as bugs, not
gaps.

---

## 5. Compare readiness audit

How Compare actually behaves (code-verified): stored metadata renders instantly; selecting
funds triggers `fetch-fund-nav` hydration and **locally computed** metrics win over
as-reported (`†`) ones; rows where every cell is "—" are removed and listed as
"not available" labels (ClearLensCompareFundsScreen.tsx:1901–1902); AUM/TER format as "—"
when null.

For random active funds:

- **Compare "succeeds" (core data + computable metrics): ~72–79 %.**
- **Degrades gracefully: ~100 %** of the remainder — nulls render as "—", empty rows hide,
  as-reported values are footnoted. No crash/spinner paths found; hydration covers the NAV
  series for effectively all active schemes, so the returns/risk section self-heals on
  selection even where stored metadata is missing.
- **Produces incomplete output: ~28 %** show at least one missing core field; **100 % miss
  AUM** (the row currently hides entirely — graceful but conspicuous for a finance app).

| Issue | Root cause class | Frequency (active universe) | Severity |
|---|---|---|---|
| AUM column empty for every fund | (2) OpenFolio issue — OD1 adapter broken (+ (3) no re-sync path once fixed) | 100 % | High |
| IDCW plans: misleading returns/vol/DD (both computed and as-reported) | (1) upstream data semantics (unadjusted NAV) — affects OF *and* local compute | ~54 % of schemes | **High (trust)** |
| Riskometer missing | (1)/(2) AMC factsheet parse coverage | 63 % | Med |
| Riskometer junk label rendered | (2) OpenFolio missing sanitisation (PR #62 open) | ~0.4 % of schemes, very visible | Med-High |
| Benchmark missing or junk | (1)/(2) same | 47 % missing + ~3 % junk | Med |
| Category missing → grouping/labels degraded | (3)/(4) FolioLens seed mapping; OF exposes none | 12 % | Med |
| Returns missing (young funds) | (1) legitimately absent | 7 % | Low (honest) |
| Composition missing | (1) AMC disclosure gaps | 4–8 % | Low-Med |
| Stored returns will silently age for unheld funds | (3) FolioLens sync gap — no recurring universe refresh | 0 % today → grows weekly | Med now, High in 4–8 weeks |

**"Would I be comfortable enabling Compare for all active funds?"** Yes for availability —
the degradation story is genuinely good. **Not yet for correctness**: IDCW metric distortion
and junk riskometer/benchmark strings would be read by users as the app being wrong, and the
AUM column is empty across the board. Fix those three (or visibly label the first), then yes.

---

## 6. Fund Detail readiness audit

| Tier | Readiness | Evidence |
|---|---|---|
| **Held funds** (36 schemes, 3 users) | **97 %** | 35/36 have NAV (max 2026-06-11; 34/36 fresh ≤3d), TER 35, returns 35, official composition 35, AUM 0. Exceptions: `130503` (no NAV rows at all — needs investigation) and `142499` (matured 2021 — stale by nature, needs "closed" treatment, not an error state) |
| **Active unheld** | **~72 % full experience; ~92 % acceptable** | Coverage as §4; NAV chart + benchmark overlay hydrate on demand for ~100 %; costs card: TER 99 %, AUM 0 % ("Unavailable"); riskometer line present for 38 % |
| **Inactive funds** (5,749 flagged + 23,495 unflagged registry shells) | **Identity + historical NAV only** | 5,749 OF-known inactive plans got metadata stamps; the 23,495 nulls are pre-2024 registry shells with name/ISIN only. Search demotes them (FL7/FL13) but they remain findable; opening one gives a NAV chart (where history exists) and "—" metadata. Acceptable for CAS-held matured schemes; no junk shown |

Per-area: metadata (good except riskometer/benchmark/manager coverage), returns (93 % stored
+ fresh today, but frozen-in-time for unheld — see §7), composition (96 % active),
benchmark overlay (works; benchmark_index mapping is FolioLens-owned and independent of the
junky declared_benchmark_name), cost info (TER strong, AUM absent), NAV history (on-demand
ladder healthy, proven by OP1 functional tests).

---

## 7. Sync ownership audit

| Field | Source of truth | OpenFolio storage | FolioLens storage | Sync path | Refresh path | Auto refresh? | Staleness risk |
|---|---|---|---|---|---|---|---|
| AUM | AMFI AAUM (quarterly) | nav.db `fund_metrics.aum_cr/aum_date` | `scheme_master.aum_cr` | universe-backfill metadata phase; sync-fund-meta (held, OF→mfdata backup); fetch-fund-snapshot (viewed, mfdata only) | same | Held: ≤7 d. Universe: **none** (done markers) | **Total — value is NULL upstream (OD1 broken)** |
| TER | AMFI TER portal + AMC B1 | holdings DB `fund_metadata.ter` | `scheme_master.expense_ratio/ter_date` | same three writers (B1-status-gated) | monthly upstream ingest; held ≤7 d | Held only | Universe frozen at 2026-06-12 |
| Benchmark (declared) | AMC B1 | `fund_metadata.benchmark` | `declared_benchmark_name` | same | same | Held only | same + junk strings |
| Benchmark (chart series) | Yahoo/NSE | — | `index_history` + `benchmark_index_symbol` | `sync-index` hourly cron | hourly | **Yes** | Low |
| Riskometer | AMC B1 | `fund_metadata.riskometer` | `risk_label` | same three writers | same | Held only | Universe frozen; 63 % absent |
| Returns (1/3/5y/incep) | OF nightly compute from nav.db | nav.db `fund_metrics` | `period_returns` jsonb (of_keys-protected) | universe-backfill; sync-fund-meta; (mfdata extras via fetch-fund-snapshot) | OF recomputes nightly; FolioLens held ≤7 d | Held only; Compare self-heals via local compute on selection | **Universe values age daily**; Fund-Detail returns card shows them with no as-of label |
| Risk ratios (vol/DD/beta) | OF nightly (+ mfdata beta) | nav.db `fund_metrics` | `risk_ratios` jsonb | same | same | Held only | same |
| Category | AMFI seed + mfdata | (none upstream) | `scheme_category`/`sebi_category` | seed + fetch-fund-snapshot on view | on view (7-d meta gate) | On view only | 1,033 active null until viewed (and mfdata must know them) |
| Fund manager | AMC B1 | `fund_metadata.fund_manager` | `fund_manager` | three writers | held ≤7 d | Held only | Universe frozen |
| Composition | AMC monthly disclosures | holdings DB snapshots | `fund_portfolio_composition` (`official`) | universe-backfill composition phase (one-shot); openfolio-sync monthly (held); fetch-fund-snapshot (viewed, 35-d gate) | upstream monthly ingest | Held monthly + viewed on demand; **universe: none** | Universe rows age after next disclosure cycle (~mid-July) |
| NAV | AMFI | nav.db (hourly evenings) | `nav_history` (held + on-demand, 90-d retention) | sync-nav 18×/d; fetch-fund-nav on demand | continuous | **Yes** | Low (proven) |

The pattern is consistent: **held funds and NAV/index series have working auto-refresh;
everything universe-wide was a one-shot.** The freshness monitor's composition-staleness
check keys on the *global* max(portfolio_date), which held-fund syncs keep fresh — so
universe staleness will never alert. The monthly reconciliation (#226) checks coverage
*counts*, not value age — it also won't alert.

---

## 8. AUM propagation analysis (traced, not assumed)

1. **Which job writes AUM into FolioLens:** three writers — `universe-backfill` metadata
   phase (`index.ts:405`, OF `metrics.aum_cr`), `sync-fund-meta` daily cron (held funds:
   OF `metrics.aum_cr` at line 317, else mfdata backup `aum/1e7` at line 352),
   `fetch-fund-snapshot.syncMeta` (viewed funds, **mfdata only**, line 303).
2. **Do already-synced schemes automatically receive new AUM values?** **No** for the
   universe: the metadata done-marker short-circuits every scheduled backfill run, and no
   other job touches unheld schemes' metadata. **Yes** for held funds (≤7 days via
   sync-fund-meta) and **partially** for viewed funds (mfdata AUM only, 7-day gate).
3. **Does corrected OpenFolio metadata propagate automatically?** No — same mechanism, same
   answer. A riskometer fixed upstream (e.g. after PR #62 merges) reaches held funds within
   a week and the rest of the universe never, absent a forced re-run.
4. **value→null / null→value:** null→value works on any re-sync (all writers patch
   non-null). **value→null does not propagate anywhere** — every writer is
   `if (x != null) patch.x = x`, so an upstream retraction (junk value corrected to honest
   null) leaves the junk in FolioLens forever. After #62 merges, this matters: sanitise will
   null-out the garbage riskometers upstream, but FolioLens will keep serving the garbage
   unless the re-sync also clears rejected values.
5. **Is a metadata refresh required?** Yes — for AUM (once upstream is fixed), for #62's
   cleanups, and on an ongoing basis for returns/TER staleness.
6. **Smallest safe operation:** `gh workflow run universe-backfill.yml -f environment=dev
   -f phase=metadata -f force=true` — the force flag clears the done marker, the cursor
   machinery resumes across the existing 15-min scheduled runs, and OP1 measured the full
   metadata phase at ~6 short runs (≈45–60 min wall-clock). Composition phase identical with
   `phase=composition`. **Do not run it for AUM until OD1 is actually fixed** — today it
   would be a no-op for AUM by construction.

---

## 9. OP1 closure assessment

**Status: Complete With Known Limitations.**

- **Completion:** both phases driven to done markers (2026-06-12T10:41/10:58Z), no residual
  cursors, coverage verified live this review (8,351/8,351 active metadata-synced, 8,296
  official-composition schemes, 8,020/8,351 active with composition). The two transient
  composition failures were replay-verified (290/290 rows present).
- **Repeatability:** proven — the run itself exercised force re-runs, cursor resumption,
  and the done-marker fall-through bugfix (v38). The reset SQL + backup schema are
  documented in #223.
- **Coverage achieved:** matches the report's numbers exactly; nothing regressed since.
- **Remaining gaps (carried, correctly documented):** AUM 0 %, category 1,033, returns 582,
  composition 331, held `130503`/`142499` anomalies.
- **Where the report is now wrong:** its premise that AUM ingestion is "follow-up #1 —
  add AUM ingestion" understates reality — OD1 *was* the AUM ingestion and it is broken
  (§2). Also follow-up 3 (persisted failure audit) and 6 (fail-on-row-failure) remain open.

---

## 10. Beta readiness — top 10 issues 100 users would actually hit

Ranked by (impact × frequency × trust damage):

1. **IDCW plans show wrong performance** (−7 % "5y return" on debt funds, −34 % "max
   drawdown") — 54 % of active schemes, both Compare and Fund Detail, both computed and
   as-reported tiers. Users who hold IDCW plans (very common) see their own fund maligned.
2. **AUM missing for every fund** — universally visible in Compare/Fund Detail ("Unavailable"
   / hidden row); finance users expect fund size as a basic trust signal.
3. **Junk riskometer/benchmark/manager strings** — ~0.4 % junk riskometers but rendered as
   prominent chips; 212 over-long benchmarks + 253 manager paragraphs in Compare cells.
   Reads as "the app is broken".
4. **Monitoring is about to go blind** — /health hang + no-timeout freshness fetch + monthly
   Bearer-401: the exact class of silent failure that caused the last two P0s, re-armed.
   Users experience this as future staleness nobody noticed.
5. **Universe staleness clock is ticking** — stored returns/TER for unheld funds frozen at
   Jun 12 with no as-of label and no refresh job; within 4–8 weeks of beta, visibly stale.
6. **Riskometer/benchmark/manager coverage gaps** (63 %/47 %/42 % missing) — honest "—" but
   makes the metadata section feel thin next to incumbents.
7. **Category missing for 12 %** — weakens compare grouping, insights classification, and
   search filters for those funds.
8. **TER ≤ 0 on 92 schemes + zero min-investment values** — small numbers shown as facts
   ("0.00 % expense ratio", "₹0 minimum") that are sometimes wrong.
9. **Held-fund edge cases** — a scheme with zero NAV rows (130503) renders a broken chart;
   matured schemes (142499) look "unhealthy" instead of "closed".
10. **Returns missing for young funds (7 %)** — honest and acceptable, but worth a "too new
    to rate" label rather than bare "—".

---

## 11. Remaining high-leverage work (top 10, ranked)

| # | Item | Repo | Why it matters / user impact | Effort | Risk | Before beta? |
|---|---|---|---|---|---|---|
| 1 | **Fix `/health`** — stop COUNT(*) over FUSE; serve cached/build-time counts | OD | Unblocks all monitoring; uptime checks; freshness-check | S | None | **Must** |
| 2 | **Harden freshness-check** — per-check timeout + isolation; `X-API-Key` header fix | FL | The monitor must survive a broken upstream; monthly reconciliation must work on Jul 1 | S | None | **Must** |
| 3 | **Re-source AAUM scheme-wise** — quarterly scheme-level AAUM; reject junk/empty pages; wire into daily or post-publish job | OD | Turns the app-wide empty AUM column into real data; OP1's #1 blocker | M | Low | **Must** |
| 4 | **Merge + extend PR #62 (sanitise)** and deploy; includes null-out-rejected semantics | OD | Kills visible junk at the source; protects every future sync | S–M | Low | **Must** |
| 5 | **Monthly forced universe refresh** — schedule `force=true` metadata+composition re-run after OF monthly publish (e.g. 16th); repurpose the no-op 15-min cron | FL | The propagation path for AUM, #62 cleanups, fresh returns/TER/composition — converts every upstream fix from "held funds only" to "everyone"; also needs clear-on-null for sanitised fields | S | Low (idempotent, proven by OP1) | **Must** |
| 6 | **IDCW honesty pass** — detect payout plans (name regex / option_type); suppress or caveat NAV-only returns/vol/DD; prefer growth-plan twin where resolvable | FL (+optional OD flag) | Removes the single biggest "this app is wrong" experience for 54 % of schemes | M | Med (matching growth twins) | **Should** (minimum: label + suppress risk metrics) |
| 7 | **Read-time render guards** — clamp risk_label to known set, length-cap benchmark/manager display | FL | Defense-in-depth: junk already in scheme_master keeps rendering until #62+refresh lands; cheap insurance forever | S | None | **Should** |
| 8 | **Category coverage** — map the 1,033 active nulls (AMFI seed re-map + name heuristics + one mfdata sweep) | FL | Compare grouping/insights for 12 % of funds | S–M | Low | **Should** |
| 9 | **Held edge cases** — investigate 130503 (no NAV); model matured schemes as "closed" state | FL | 100 beta users importing CAS files will hit matured schemes immediately | S | None | **Should** |
| 10 | Persistent backfill failure audit table (OP1 follow-up 3/6) | FL | Operational forensics; row failures currently vanish with cursors | S | None | Can wait |

Not on the list (deliberately): FL11/runbook (prod-launch-timed, beta is on dev), FL16,
index-series ownership, any re-architecture. The 15-min scheduled backfill cron should be
folded into #5 (monthly cadence) rather than left no-opping 2,880×/month.

---

## 12. Implementation prompts (Must + Should only)

Use the standard preambles from the 2026-06-11 review §10.3 (FolioLens / OpenFolio-Data).

### P1 (OD) `fix(api): /health must not scan nav.db — serve cached counts`

> The deployed `/health` endpoint hangs indefinitely (>280 s, verified live twice on
> openfolio-api rev 00052-2br, image 50d2ef7). Root cause introduced by #61:
> `compose_health` (src/mfholdings/compose.py:289) calls `NavStore.count_nav_rows()` —
> `SELECT COUNT(*) FROM nav_history` — against the 3.5 GB nav.db mounted read-only over GCS
> FUSE, which turns a full-table count into thousands of network page reads. Reproduce:
> `curl --max-time 90 https://openfolio-api-…/health` times out; `/v1/schemes/{id}/metadata`
> responds fine. Fix so `/health` is O(1): compute `db_nav_rows` and `db_nav_latest` ONCE per
> DB generation and cache them on app.state keyed by nav.db path+mtime (or persist a
> `meta(nav_row_count, max_nav_date)` single-row table written at the end of nav ingest —
> prefer this; fall back to `SELECT seq FROM sqlite_sequence` or `MAX(rowid)` as an
> approximate count and label the field accordingly in openapi.yaml if you choose
> approximation). `/health` must respond < 2 s cold. Keep the response model unchanged.
> Add a regression test asserting compose_health performs no nav_history full scan (e.g.
> monkeypatch count_nav_rows to raise after N ms, or assert the store method called is the
> cached one). Note in DECISIONS.md. Deploy and verify live: `/health` returns 200 with
> sane counts in < 2 s, twice in a row, and FolioLens freshness-check passes against it.

### P2 (FL) `fix(freshness-check): per-check timeouts + isolation; correct OpenFolio auth header`

> Two bugs in supabase/functions/freshness-check/index.ts, both verified: (1)
> `fetchOpenFolioHealth` (line ~145) and both monthly fetchers use bare `fetch` with no
> AbortController — the live OpenFolio /health currently hangs >280 s, which will hang the
> entire daily run past the isolate budget; one broken upstream check must never take down
> the monitor. Wrap every external fetch (OpenFolio health, metadata total, composition
> total) in a 15 s AbortController timeout helper, and run each check so that a
> timeout/throw marks THAT check failed with a detail string while all other checks still
> execute and report (the run completes, ok=false). (2) `fetchOpenFolioMetadataTotal` and
> `fetchOpenFolioCompositionTotal` (lines ~165–210) send `Authorization: Bearer ${apiKey}`
> — the OpenFolio API only accepts `X-API-Key` (see api.py middleware; verified live 401),
> so the monthly reconciliation (first run Jul 1) is guaranteed to fail its upstream
> fetches. Switch both to the `X-API-Key` header, matching `_shared/openfolio.ts:723`.
> Unit-test: timeout → single-check failure with others green; 401 path; happy path.
> Deploy to dev with --no-verify-jwt and demonstrate: one invocation against the current
> (hanging) /health completes in <30 s with the OpenFolio check failed and the other four
> checks reported; one `{mode:'monthly'}` invocation fetches both upstream totals
> successfully (after P1 lands, or against a body-override base URL stub).

### P3 (OD) `fix(aaum): scheme-wise AAUM source — the fund-wise report can never resolve schemes`

> OD1 (#54) is live-broken — verified by running the merged code read-only against the real
> portal: `_fetch_latest_aaum_html` returned the May-2026 *fund-wise* page, `parse_aaum_html`
> produced exactly one junk row (`AAUMDisclosureRow(scheme_code=None, name='0', aum_cr=0.0)`),
> and `resolve_aaum_rows` resolved 0 of it. Three compounding bugs in
> src/mfholdings/nav/aaum.py: (a) `rpt=fwise` is the AMC-level report — it lists "Aditya
> Birla Sun Life Mutual Fund", never schemes, so scheme/family resolution is structurally
> impossible; (b) recent monthly periods are all `N/A` (AMFI publishes AAUM quarterly) and
> the junk footer row makes the fetcher treat the empty page as a hit and stop trying older
> periods; (c) even when quarterly data exists this report level is wrong. Re-source:
> investigate AMFI's scheme-wise quarterly AAUM disclosure (the portal exposes a scheme-wise
> variant of AUMReport_Rpt_Po.aspx via the `rpt` parameter and/or AMFI publishes scheme-wise
> AAUM downloads under amfiindia.com → Research & Information → AUM data; diagnose the real
> endpoint with a browser/curl first and document it in SOURCES.md — do not guess). Then:
> parse scheme-level rows (they carry AMFI scheme codes), reject rows without a positive
> aum_cr AND a plausible name (kill the `'0'` footer class), and treat "zero resolvable
> rows" as failure so the period fallback keeps walking. Keep family-level fallback
> resolution only if the chosen source lacks codes. Update the truncated fixture to the real
> scheme-wise format. Also wire `--aaum` into the daily nav job args
> (deploy/cloud_run.tf nav-daily defaults or the evening scheduler override) so AUM appears
> within a day of a fix, not on the 13th of next month — it is cheap (one HTTP fetch +
> upsert) and idempotent. Acceptance: a local run against the live portal reports
> parsed ≥ 5,000, resolved ≥ 4,000 distinct scheme codes; hand-check one large fund's AAUM
> against its AMC factsheet and cite it; after deploy + job run, `/v1/schemes/{code}/metadata`
> serves non-null aum_cr for a held FolioLens scheme. PR body must state the FolioLens
> follow-up: forced universe metadata re-run required (FolioLens P5).

### P4 (OD) `feat(metadata): land central sanitise guards (PR #62) + retraction semantics`

> Review, fix up, and merge open PR #62 (metadata/sanitise.py central guards: riskometer
> canonical 6-value set + casing normalisation, benchmark junk rejection
> (>240 chars / holdings-bleed / no index term), min_investment/min_sip positivity+integrality,
> TER bounds with audit warnings, turnover bounds). Evidence it is needed (FolioLens dev,
> synced from current upstream): 34+ garbage riskometer labels including 20 full suitability
> sentences and OCR shrapnel ("Very High Risk L M o o w de t r o at e"), "Low to Moderate"
> vs "Low To Moderate" duplicates, 212 benchmarks >120 chars, 253 fund_manager values
> >200 chars, 92 TER ≤ 0, 26 min_sip = 0. Additions on top of #62 as it stands: (1) add a
> fund_manager guard (reject > ~200 chars or text containing obvious factsheet bleed; keep
> multi-manager comma lists); (2) be careful with min-SIP floors — ₹10/₹50/₹100 SIPs are
> legitimate; reject only ≤ 0 and non-integers, not small values; (3) when a previously
> stored value is now rejected by sanitise, the B1 field status must flip to a non-`value`
> status and the served field must become null — i.e. sanitisation must produce
> *retractions*, not just block new writes; assert this in a test (this is what lets
> downstream value→null propagation work). Run the metadata-quality-report command
> before/after on the current holdings DB and paste the junk-count deltas in the PR.
> ruff/pyright/pytest green; DECISIONS.md entry.

### P5 (FL) `feat(sync): monthly forced universe refresh + clear-on-null for sanitised fields`

> The universe backfill is one-shot: done-markers (live in app_config) short-circuit every
> scheduled run, sync-fund-meta covers only held funds, openfolio-sync only held-fund
> composition. Consequence (verified in code): stored period_returns/TER/riskometer for
> ~8,300 unheld active schemes are frozen at 2026-06-12 forever, upstream corrections (P3
> AUM, P4 sanitise) can never propagate, and the `*/15` cron now burns ~2,880 no-op runs a
> month. Changes: (1) rework .github/workflows/universe-backfill.yml scheduling: replace the
> 15-minute always-on cron with (a) a monthly trigger (16th, after OpenFolio's monthly
> publish on the 13th–15th) that invokes with `{phase:'both', force:true}` on its first
> iteration and then drives to completion across its own iterations — note a single run is
> ~15 min capped, and OP1 measured full completion at ~8×6-min runs, so implement the
> monthly mode as a repeating short schedule that self-disables: simplest correct design is
> keeping a frequent cron BUT making the function's no-op path free (done-marker check is
> one app_config read) and adding a `universe_backfill_refresh_due` marker written monthly
> by pg_cron that the workflow checks — choose the simplest design that (i) completes a
> full refresh monthly, (ii) doesn't run 2,880 no-ops, (iii) survives the 15-min cap;
> document the choice. (2) Writer semantics: in universe-backfill's metadata phase, when
> upstream b1_field_meta reports a non-`value` status for a field that FolioLens currently
> has a value for, write NULL for that column (riskometer/benchmark/manager/TER etc.) —
> this is the propagation path for P4's retractions; keep "absent field in response"
> (older API) as no-touch. Add unit tests for the patch builder: value→value, null-status→
> NULL write, missing→no-touch. (3) Update freshness-check's composition-staleness and the
> monthly reconciliation thresholds if needed so a completed monthly refresh keeps them
> green. Validate on dev: dispatch a forced metadata re-run end-to-end (done markers
> cleared → re-walked → re-stamped; cite before/after `openfolio_meta_synced_at`
> timestamps), and show one scheme whose junk risk_label became NULL after P4 is deployed
> upstream (or simulate with a stubbed response in tests). cache-surfaces.md: no
> client-visible shape change expected — justify `[cache-shape-stable]`.

### P6 (FL) `feat(trust): IDCW plan metric honesty`

> 4,515 of 8,351 active schemes (54 %) are IDCW/payout plans. Their NAV series drop on every
> income distribution, so NAV-only math — BOTH OpenFolio's as-reported metrics AND
> FolioLens's locally-computed Compare metrics — shows nonsense: live example, scheme 119551
> (Aditya Birla SL Banking & PSU Debt - DIRECT - IDCW): ret_5y −7.4 %, max_drawdown_5y
> −34 %, volatility 7.5 % — for a high-grade short-duration debt fund. 1,195 active IDCW
> schemes carry max_drawdown_5y worse than −20 %. Dev DB: detect plan kind via
> `option_type` where present plus a name regex
> (`(idcw|dividend|payout|income distribution)` case-insensitive — verify counts with
> read-only SQL and cite). Implement, in order of priority: (1) a pure helper
> `isPayoutPlan(schemeName, optionType)` in src/utils (unit-tested incl. tricky names like
> "Dividend Yield Fund - Growth" which must NOT match — require the payout token outside
> the strategy name, e.g. match only after the plan-segment delimiters; get this right with
> fixtures from real scheme_master names); (2) Compare + Fund Detail: for payout plans,
> suppress drawdown/volatility/Sharpe/Sortino rows and show returns with an explicit
> footnote "NAV-based; excludes income payouts — see the Growth plan for total returns"
> (follow feedback_trust_numbers: never show a value we believe is misleading as if it were
> comparable); (3) where a same-family Growth twin is resolvable (match on family/base name
> + plan_type with the existing scheme_master fields), add a one-tap "View Growth plan"
> link — do NOT silently substitute the twin's numbers. Tests: helper edge cases, Compare
> row suppression, footnote rendering, twin resolution happy/no-match. cache-surfaces.md
> check; `[cache-shape-stable]` if reads only.

### P7 (FL) `fix(ui): read-time render guards for metadata strings`

> Junk currently stored in scheme_master renders raw (and will keep rendering until the
> upstream sanitise + forced refresh land): risk_label includes 20 full suitability
> sentences, "free rate assumed to be 5.34%…", and OCR shrapnel (live dev counts; query and
> cite them); declared_benchmark_name has 212 values >120 chars incl. holdings-bleed;
> fund_manager has 253 values >200 chars. Add pure display guards in src/utils (e.g. extend
> mfdataGuards.ts): `readRiskLabel` returns one of the 6 canonical riskometer labels
> (case-insensitively normalised: "Low to Moderate"=="Low To Moderate"), else null;
> `readBenchmarkName` trims and returns null when >120 chars or matching the bleed patterns
> (`% of|top 10|holdings|portfolio|aum` — tune against live junk rows and include real
> fixtures); `readFundManager` returns null when >160 chars. Use them at every render site:
> Compare (risk chip, benchmark row, manager row — ClearLensCompareFundsScreen.tsx) and
> Fund Detail (app/fund/[id].tsx riskLabel line ~1107 and metadata card). Null renders as
> the existing "—"/hidden-row path. >95 % branch coverage on the new guards with the real
> junk strings as fixtures. No payload shape changes → `[cache-shape-stable]`.

### P8 (FL) `feat(meta): close the active-category gap (1,033 schemes)`

> 1,033 of 8,351 active schemes have neither scheme_category nor sebi_category (dev,
> verified). Diagnose the distribution first (read-only SQL: group the null-category actives
> by amc_name and name patterns; many are plan-alias rows whose sibling plan HAS a category).
> Fix in layers, cheapest first: (1) sibling inheritance — a one-time + sync-time rule:
> if another scheme_master row shares the same family/base scheme name (use the same
> base-name normalisation the search/dedup path uses) and has scheme_category/sebi_category,
> copy it (categories are family-level facts; document this assumption); (2) re-run the
> existing resolveSebiCategory name-heuristics over the remainder (they already map "Liquid",
> "ELSS", "Overnight" etc. from names); (3) for the residue, a one-off mfdata sweep script
> (scripts/, rate-limited like sync-fund-meta's 300 ms delay) for just those codes. Ship (1)
> and (2) as a migration-free edge-function patch or one-off script — justify the choice;
> wire (1) into universe-backfill's metadata phase so future plan aliases inherit at sync
> time. Acceptance SQL in the PR: active null-category count before/after; target < 300.
> Unit tests for the inheritance rule (must never overwrite an existing category, must skip
> ambiguous multi-category families).

### P9 (FL) `fix(holdings): held-fund edge cases — NAV-less scheme + matured schemes`

> Two held-fund anomalies from the OP1 report, still live (verify both read-only first):
> (1) held scheme 130503 has ZERO nav_history rows — trace why: is it in OpenFolio's
> registry/nav.db (probe /v1/schemes/130503 and /v1/nav)? in mfapi? If upstream has no NAV
> (RTA-only scheme or code remap), Fund Detail currently renders a broken/empty chart —
> implement the honest state: "NAV unavailable for this scheme" with the units/cost data we
> DO have (per feedback_trust_numbers: always show known values), and exclude it from
> portfolio aggregates that require NAV with a visible exclusion note rather than silently
> treating it as ₹0 (audit how XIRR/portfolio totals handle a NAV-less holding today and
> fix any zero-assumption). (2) Matured schemes (e.g. 142499, matured 2021-06-28, name
> contains "Mat Dt.28-Jun-2021"): scheme_active=false + frozen NAV is *correct* data — the
> app should model it as a "Matured/Closed" state: badge on Fund Detail + holdings list,
> stop counting it against NAV-freshness checks (freshness-check held-NAV-age must exclude
> inactive schemes — today it only passes because other holdings are fresh), and suppress
> "stale data" affordances. Detection: scheme_active=false OR maturity-date pattern in
> name; implement as a pure helper with tests. Validate on dev with the two real schemes
> and paste screenshots/SQL.

---

## 13. Final recommendation

**Hold public beta for one focused week of fixes; the gap is small and sharply defined.**

The remediation machine is real: 14/14 FolioLens items verifiably landed, OP1 completed, the
held-fund product is trustworthy today, and degradation for missing data is honest
everywhere. What stands between this and 100 beta users is not coverage or architecture —
it is five small correctness items (P1–P5: a hung health endpoint, a monitor that must
survive it, a broken AUM source, an unmerged sanitise layer, and a missing monthly refresh
to carry all of it to users) plus one product decision (P6: stop presenting payout-distorted
numbers for half the universe as if they were fund performance).

Sequencing: P1+P2 today (each ~hours; the monitor breaks tomorrow 08:00 UTC otherwise);
P4+P3 upstream next (P3 is the only M-sized item); P5 once P3/P4 deploy, then one forced
full refresh; P6–P9 in parallel app-side. After P5's refresh completes, re-run the §4
sample audit — compare-ready should hold ≥ 75 % with AUM > 90 % and junk strings ≈ 0 — and
ship the beta.

**What NOT to do:** no schema changes, no new sync stamps, no universe-NAV tier, no Compare
math rewrite (growth-plan numbers verified sane live), no re-architecture of the backfill —
the driver is proven; it just needs a calendar.
