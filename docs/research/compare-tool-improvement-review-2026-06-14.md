# Compare Funds — Quality & Performance Review (2026-06-14)

> **STATUS — ✅ COMPLETE (2026-06-27).** All planned items shipped and verified:
> CD-OD (OpenFolio), C1 (#238), C6 (#240, fallback-label fix #244), C2 (#241), C3 (#242),
> C4 (#243); C5 subsumed by C6. The dev backfill deadlock that blocked the C1 family sync was
> fixed separately in #239. See the Status note under §7 for the per-item breakdown.

Triggered by hands-on testing of the Compare tool with **three Large & Mid Cap Direct plans**.
Reported symptoms: (1) some names show "Direct", some don't; (2) same-category funds flagged as
different categories; (3) the chart renders but some numbers are missing; (4) a few seconds of
"crunching" after selection before results appear. This review reproduces each against the
current code (`origin/main` `06185fd`) and live dev data (`imkgazlrxtlhkfptkzjc`), root-causes
them, and adds issues found along the way, with a prioritised plan and implementation prompts.

> Note: the screenshots referenced in the request did not reach this analysis (text only), so
> every finding below is reproduced independently from code + dev data. Confirm against the
> screenshots; the symptoms match exactly.

---

## 1. Executive summary

All four symptoms reproduce and have clear, mostly-cheap fixes. None are deep architecture
problems — they're a too-narrow name normaliser, dirty `sebi_category` data, an as-reported
tier that's missing two risk metrics, and an eager hydrate-then-recompute flow.

| # | Symptom | Root cause | Class | Fix size |
|---|---|---|---|---|
| 1 | "Direct" shows on some names, not others | `shortSchemeName` regex only matches the canonical `" - Direct Plan - Growth"` shape; AMFI's many variants (no spaced dashes, no "Plan", glued option, caps) slip through | Client display | S |
| 2 | Same-category funds flagged "different category" | `fundCategory` reads `sebi_category`, which is **dirty** for some schemes (a Large-Midcap index fund is tagged `mid cap fund`); the cross-category banner then fires on a false difference | Upstream data + client | S–M |
| 3 | Graph shows, numbers missing | The as-reported fallback returns `sharpe:null, sortino:null` (only computable from NAV), and `fund_manager` is genuinely null for some funds; "computed wins" can also blank periods longer than the loaded series | Client + data gaps | S–M |
| 4 | "Few seconds" after selection | On every pick, two cold edge-function hydrations fire (`fetch-fund-snapshot` + `fetch-fund-nav`) **even when `scheme_master` already has the data**, then a 5y **daily** NAV series (~1,250 pts/fund) is fetched and the metrics recomputed on the JS thread | Perf / over-fetch | M |

Plus four issues found while reproducing (§7): unreliable `plan_type`/`option_type` parsing,
Growth-vs-IDCW plan twins looking like distinct funds (with wildly different AUM), full-daily
NAV used where month-end suffices, and hydration firing unconditionally.

**Bottom line:** Compare is functionally good but feels rough on exactly the kind of
side-by-side a user actually does (plan twins / same category). Items 1, 2, and 3 are trust
papercuts; item 4 is the felt-latency. All are addressable in a focused sprint.

---

## 2. Issue 1 — inconsistent "Direct" / plan label in names

**Where:** `fundDisplayName` → `shortSchemeName` ([src/utils/schemeName.ts:11-16](../../src/utils/schemeName.ts#L11-L16)).

```ts
return name
  .replace(/\s+-\s+(Direct|Regular)\s+Plan(\s+-\s+(Growth|IDCW)(\s+(Option|Reinvest|Payout))?)?$/i, '')
  .replace(/\s+-\s+(Growth|IDCW)(\s+(Option|Reinvest|Payout))?$/i, '')
```

It requires a **spaced dash** (`\s+-\s+`) and the literal word **"Plan"**. AMFI names don't
honour that. Reproduced against the live Large & Mid Cap Direct rows:

| scheme_code | raw `scheme_name` | `shortSchemeName` output | OK? |
|---|---|---|---|
| 145110 | `Axis Large & Mid Cap Fund - Direct Plan - Growth` | `Axis Large & Mid Cap Fund` | ✅ |
| 119436 | `Aditya Birla Sun Life Large & Mid Cap Fund - Growth - Direct Plan` | `Aditya Birla Sun Life Large & Mid Cap Fund` | ✅ |
| **119350** | `BANK OF INDIA Large & Mid Cap Fund Direct Plan-Growth` | `BANK OF INDIA Large & Mid Cap Fund Direct Plan-Growth` | ❌ **"Direct Plan-Growth" kept** |
| **119433** | `Aditya Birla Sun Life Large & Mid Cap Fund -Direct - IDCW` | `…Fund -Direct - IDCW` (no space before `-Direct`) | ❌ |
| 140175 | `Edelweiss Large & Mid Cap Fund - Direct Plan - Growth Option` | `Edelweiss Large & Mid Cap Fund` | ✅ |

So names like BANK OF INDIA's `Fund Direct Plan-Growth` (no dashes, glued option) and ABSL's
`-Direct` (no leading space) keep the plan/option text — exactly "some show Direct, some don't".

**Compounding:** `plan_type`/`option_type` are also unreliable (119433 `plan_type=null`,
`option_type=null` despite "Direct/IDCW" in the name; most rows have `option_type=null`), so the
UI can't fall back to structured fields to render a clean, consistent plan chip.

**Fix (sync from OpenFolio, do not parse names in FolioLens):** OpenFolio already owns scheme
identity and already runs the `base_scheme_name` normaliser internally
(`src/mfholdings/scheme_master/normalize.py:143`) — FolioLens should **sync** a clean
family/display name + structured plan/option, not re-derive them client-side (the same principle
the category path already follows: "no client-side name parsing — the data pipeline is the
single source of truth"). The display should never show the plan inline in the title for one
fund and not another. See §6.5 for the identity-from-OpenFolio design and the small upstream gap
that needs closing; the brittle `shortSchemeName` regex is retired (kept only as a thin fallback
for inactive registry shells OpenFolio doesn't cover).

---

## 3. Issue 2 — same category flagged as "different category"

**Where:** `fundCategory` → `fundComparisonCategory(sebiCategory, schemeCategory)`
([…CompareFundsScreen.tsx:275-277](../../src/components/clearLens/screens/tools/ClearLensCompareFundsScreen.tsx#L275-L277)),
and the banner at [line 2245](../../src/components/clearLens/screens/tools/ClearLensCompareFundsScreen.tsx#L2245):
`uniqueCategories = [...new Set(fundData.map(f => fundCategory(f.scheme)))]`. If the set has >1
entry, the "comparing across categories" banner fires.

The label is read straight from `sebi_category` (correct design — no client name-parsing). But
`sebi_category` is **dirty for some schemes**. Reproduced live:

| scheme_code | name | `sebi_category` | `scheme_category` | label shown |
|---|---|---|---|---|
| 145110 | Axis Large & Mid Cap | `large & mid cap fund` | `Large & Mid Cap Fund` | Large & Mid Cap |
| 119218 | DSP Large & Mid Cap | `large & mid cap fund` | **`Equity`** (broad) | Large & Mid Cap (sebi wins) |
| **149343** | Edelweiss NIFTY Large Midcap 250 **Index** Fund | **`mid cap fund`** ❌ | `Large & Mid Cap Fund` | **Mid Cap** |

If a user lines up Axis + DSP + the Edelweiss Large-Midcap **index** fund (all "large & mid
cap" to a human), the index fund reports `mid cap fund` → label "Mid Cap" → the cross-category
banner fires on a **false** difference. (An index fund tracking NIFTY LargeMidcap 250 is
arguably an Index Fund or Large & Mid Cap — `mid cap fund` is simply wrong.)

**Two fixes, layered:**
1. **Data**: tighten upstream/`scheme_master` category resolution so index funds and
   large-mid-cap funds aren't mis-tagged (the P8 sibling-inheritance + name heuristics already
   exist; extend them to catch "Large Midcap"/"Large & Mid"/"…250 Index" → the right SEBI key,
   and don't let an index-tracking name resolve to a bare cap bucket).
2. **Client**: make the cross-category banner tolerant — treat a small set of
   near-equivalent SEBI keys (e.g. large-&-mid vs the corresponding index, or broad fallback
   `Equity`) as "same family" before warning, and never warn purely because one fund's
   `sebi_category` is null/broad while a sibling's is specific.

---

## 4. Issue 3 — graph renders, some numbers missing

Two distinct causes:

**(a) Risk card: Sharpe/Sortino are NAV-only.** In the as-reported branch of
`selectCompareMetrics` ([computedFundMetrics.ts:405-409](../../src/utils/computedFundMetrics.ts#L405-L409))
`sharpe` and `sortino` are hard-`null` (and `stdDev` comes from mfdata only when present).
So in the window between paint and NAV-hydration-complete — or whenever NAV hydration is slow
or fails for a cold fund — the Risk card shows "—" for Sharpe/Sortino while the **chart
(which only needs the NAV series for its own fetch) renders**. This is the most likely "graph
shows, numbers missing" the tester saw.

**(b) Genuine null fields + "computed wins" with a short series.** `fund_manager` is null for
several live funds (Bandhan 118419, BANK OF INDIA 119350 — `has_mgr=false`), and newer funds
have null 5y (Edelweiss index 149343 `r5y=null`). Separately, once the NAV series loads,
`hasComputed` is true if *any* trailing return computes; if the loaded series is younger than a
window, that period shows "—" even though the as-reported blob had a value — because computed
wins wholesale (no per-field mixing, by design).

**Fixes:**
- Compute **Sharpe/Sortino as-reported too** where the inputs exist (OpenFolio `risk_ratios`
  already carries volatility + max_drawdown_5y; if Sharpe/Sortino aren't upstream, show stdDev
  + maxDrawdown in as-reported state and label Sharpe/Sortino "needs full history" rather than a
  bare "—"), so the Risk card isn't half-blank before hydration.
- Make missing fields **explicitly labelled** ("Not disclosed" for null manager, "Too new" for
  a fund younger than the period) per `feedback_trust_numbers`, not a bare "—".
- Reconsider strict computed-wins: when computed yields a period but as-reported has a longer
  one the series can't cover, prefer showing the as-reported longer period with a provenance
  marker rather than "—" (carefully — don't mix within a single period).

---

## 5. Issue 4 — "few seconds" after selection

**The flow on each pick** (non-held fund):

1. `hydrationQueries` (useQueries) fires **two cold edge-function invokes per fund** —
   `fetch-fund-snapshot` (composition/metadata, official-first → can hit OpenFolio) and
   `fetch-fund-nav` (NAV into Supabase + SQLite top-up)
   ([…CompareFundsScreen.tsx:2008-2055](../../src/components/clearLens/screens/tools/ClearLensCompareFundsScreen.tsx#L2008-L2055)).
   These are the dominant latency (~0.5–2 s each, network).
2. On success they invalidate `scheme-master`, `compositions`, `compare:navhistory` → refetch.
3. `navHistoryQuery` fetches a **5-year daily** NAV window per fund (`compareSinceDate()` = −5y),
   in parallel ([line 209-249](../../src/components/clearLens/screens/tools/ClearLensCompareFundsScreen.tsx#L209-L249)).
4. `metricsByCode` recomputes `selectCompareMetrics` over **~1,250 daily points × N funds** on
   the JS thread (trailing CAGRs + month-end build + monthly σ + Sharpe/Sortino + max-DD).

The as-reported fallback already lets numbers paint before step 4 — but the user still feels
(a) the hydration round-trips and (b) the visible as-reported→computed "recompute" flip.

**Key over-fetch:** post-resync, **most active funds already have `period_returns`,
`risk_ratios`, `composition`, and `aum_cr` in `scheme_master`** — yet hydration fires
unconditionally on every pick. And the chart only needs the NAV series; the **metrics don't
need daily granularity** — month-end points (~60 vs ~1,250) compute near-identical trailing
returns and monthly σ at ~20× less data and CPU.

**Fixes (highest-leverage first):**
1. **Gate hydration on missing data** — skip `fetch-fund-snapshot` when `scheme_master` +
   composition are already present/fresh for the code (they are, for active funds post-resync);
   skip `fetch-fund-nav` when a recent local NAV series exists. Turns the common case from
   "2 network calls × N funds" into "0".
2. **Compute metrics from month-end NAV** — reuse the `month_end_nav` RPC (shipped for Past-SIP,
   P14) or sample the series to month-end before `selectCompareMetrics`. ~20× less data to
   fetch and crunch; trailing CAGR/σ unchanged.
3. **Don't block the chart on metrics / don't re-jank** — keep as-reported numbers stable and
   only swap to computed when it's a *material* improvement (e.g. adds Sharpe/Sortino), to avoid
   a visible flip for identical values.
4. **(If still janky) move compute off the main thread** or memoise per (code, since) so
   re-selecting funds doesn't recompute. The existing `perfStart/perfEnd` marks
   (`query:compare:navHistory`, etc.) already let you measure each stage — use them to confirm
   the win.

---

## 6. Additional issues found (not in the original report)

| # | Issue | Evidence | Why it matters |
|---|---|---|---|
| A | **`plan_type`/`option_type` unreliable** | 119433 `plan_type=null,option_type=null` for a "-Direct - IDCW" fund; most rows `option_type=null` | Weakens P6 `isPayoutPlan` (forced to name fallback), the plan chip, and any plan-aware UI |
| B | **Growth vs IDCW plan twins look like separate funds** | 119436 (Growth, AUM ₹726 Cr) vs 119433 (IDCW, AUM ₹20 Cr) — same fund, same returns, wildly different AUM | A user can unknowingly compare two plans of the *same* fund; AUM differs ~36×, making the AUM row misleading. The picker should de-dupe/label plan twins, or Compare should warn |
| C | **Full daily NAV where month-end suffices** | `compareSinceDate()` = −5y daily (~1,250 pts) feeding metric compute | Egress + CPU; see §5.2 |
| D | **Hydration fires unconditionally** | `hydrationQueries` always invokes both edge fns on selection | Wasted round-trips for the now-common case where data already exists |

---

## 6.5 Search & Select redesign — family-first picker (the headline change)

This came out of testing: the picker shows **one row per plan** (Direct/Regular × Growth/IDCW ×
Daily/Weekly/Monthly variants), so a search like "axis large mid" returns a dozen near-identical
rows, every pick triggers heavy hydration, and a user can accidentally compare two plans of the
*same* fund (issue B). The ask: **search/select on the base fund, with plan/option as a second
level, and fewer options / less loading.** Agreed — and the family key should be **synced from
OpenFolio, not derived in FolioLens** (OpenFolio owns scheme identity; FolioLens shouldn't
re-implement name parsing it doesn't own).

### Identity belongs to OpenFolio — sync it, don't derive it (data reality)

There is **no existing column that groups plans into a fund** on the FolioLens side. Verified
live: `family_name` is NULL for **8,235 / 8,347** active rows (and where present it's the AMC,
only 84 distinct); `mfdata_family_id` is all-null.

But OpenFolio **already models this properly** (verified in its contract): a stable
`family_id` (`OF-…`, the documented join key) groups every plan (Regular/Direct × Growth/IDCW),
each `Plan` carries `plan_code` + `isins`, and OpenFolio already runs the `base_scheme_name`
normaliser internally (`normalize.py:143`). `family_id` is already exposed on `/v1/schemes`
(`SchemeSummary`), holdings, composition, and ISIN endpoints.

**The only gap:** the `/v1/metadata` endpoint (the one the FolioLens `universe-backfill` consumes
to populate `scheme_master`) does **not** carry `family_id`, a clean family **display name**, or
structured `plan_type`/`option_type` — `FundMetadata` has `scheme_code`, `name`, `amc`, … but no
family. So the correct fix is a **small upstream addition + a sync**, not client-side derivation:

1. **OpenFolio** adds `family_id`, a clean `family_name` (run its existing `base_scheme_name` on a
   representative plan), and structured `plan_type`/`option_type` (parse `plan_name` once
   upstream) to `FundMetadata` / the metadata endpoints. The normaliser already exists upstream —
   this just exposes its output.
2. **FolioLens** syncs those into `scheme_master` (new columns, written by `universe-backfill`).
   The picker groups by the synced `family_id`, shows the synced `family_name`, and the plan
   toggle uses the synced `plan_type`/`option_type`. **Zero name parsing in FolioLens.** (This
   also fixes issue A — today's unreliable `plan_type`/`option_type` come from mfdata.)

This collapses 8,347 plan rows to OpenFolio's real **~2,046 families** authoritatively (a naive
client strip only reaches ~6,043 — another reason not to derive client-side). A thin FolioLens
display fallback is acceptable only for inactive registry shells OpenFolio doesn't index.

### Recommended UX (you asked for a suggestion)

**Family-first search + smart default plan + a global plan toggle.** Compare is inherently
apples-to-apples — you almost always compare the *same* plan type across funds — so lean into
that instead of making plan a per-fund chore:

```
Search: "axis large mid"
┌───────────────────────────────────────────┐
│ Axis Large & Mid Cap Fund                 │  ← ONE row per fund (~2,046, not 8,347)
│ Axis Mutual Fund · Large & Mid Cap        │
├───────────────────────────────────────────┤
│ Axis Growth Opportunities Fund            │
│ Axis Mutual Fund · Large & Mid Cap        │
└───────────────────────────────────────────┘

Comparing:  [ Direct ▾ ]   [ Growth ▾ ]        ← ONE global plan context for all funds

┌───────────┐ ┌───────────┐ ┌───────────┐
│ A  Axis   │ │ B  DSP    │ │ C  Bandhan│
│ L&M Cap   │ │ L&M Cap   │ │ L&M Cap   │
│ Direct·Gr │ │ Direct·Gr │ │ Direct·Gr │     ← chip; tap to override ONE fund (rare)
└───────────┘ └───────────┘ └───────────┘
```

1. **Search returns funds, not plans** — one row per derived family (AMC + base name + category).
   ~2,046 active funds vs 8,347 plan rows → far less scroll/noise, faster query, and the
   Growth-vs-IDCW twin confusion (issue B) disappears by construction.
2. **One tap selects the fund, defaulted to Direct · Growth** — the plan the vast majority want.
   No second step in the common case.
3. **A single global "Comparing: Direct · Growth" toggle** resolves *all* selected funds to that
   plan/option (Direct/Regular × Growth/IDCW). Flip it → every fund re-resolves. This matches how
   people actually compare (like-for-like) and prevents accidental Direct-vs-Regular mixes.
4. **Per-fund override** is a small chip on a card for the rare case one fund needs a different
   plan.

**Why this over the alternatives:** a two-step "pick fund → pick plan" modal adds a tap for
everyone; per-fund plan pickers everywhere are more taps and let you compare apples-to-oranges;
the current plan-level list is the noisy status quo. The global-default-plus-toggle is the
fewest taps for the common case and the safest for correctness. It also **subsumes C5** (plan
twins) and pairs with **C2** (you hydrate/compute one canonical series per fund, not several).

### Data approach — sync OpenFolio's family identity (no client derivation)

1. **OpenFolio (CD-OD):** add `family_id`, a clean `family_name`, and structured
   `plan_type`/`option_type` to `FundMetadata` / the `/v1/metadata` endpoints (reusing the
   existing `base_scheme_name` + family/plan resolution — output already exists internally).
2. **FolioLens sync (C1):** add `of_family_id`, `family_name`, and reliable
   `plan_type`/`option_type` columns to `scheme_master` (migration), mapped by
   `universe-backfill`/`sync-fund-meta`. Index `of_family_id`.
3. **Picker (C6):** search/group by the synced `of_family_id`, display the synced `family_name`,
   and resolve the plan toggle via the synced `plan_type`/`option_type` (graceful, labelled
   fallback when a family lacks the chosen plan — Regular-only / IDCW-only). A search RPC/view
   returns DISTINCT families (representative row + available-plan flags) so the picker stays fast
   over the full 37,595-row catalog.

No `base_scheme_name` logic in FolioLens — the normalisation stays in OpenFolio where the code and
the family model already live. (A thin FL display fallback remains only for inactive shells OF
doesn't index.)

This is the centerpiece of the "fewer options / less loading" ask, tracked as **CD-OD** (upstream
expose) + **C1** (sync) + **C6** (picker); pairs with **C2**.

---

## 7. Plan (prioritised)

| ID | Title | Repo | Addresses | Priority | Status |
|---|---|---|---|---|---|
| CD-OD | Expose `family_id` + clean `family_name` + structured `plan_type`/`option_type` on `/v1/metadata` | **OD** | §6.5, #1, A, B | **Must** (foundation) | ✅ Shipped (OpenFolio) — verified live: dev `of_family_id`/`family_name` 100% |
| C1 | Sync family identity into `scheme_master`; display synced name + plan chip; retire `shortSchemeName` | FL | #1, A | **Must** | ✅ Shipped — **#238** |
| C6 | **Family-first search & select (two-level picker + global plan toggle)** | FL | §6.5, B, "fewer options/less loading" | **Must** | ✅ Shipped — **#240** (inverted fallback-chip label fixed in **#244**) |
| C2 | Compare perf: gate hydration + month-end compute + stable as-reported | FL | #4, C, D | **Must** | ✅ Shipped — **#241** |
| C3 | Category data hardening + tolerant cross-category banner | OD+FL | #2 | **Should** | ✅ Shipped — **#242** (35 dev schemes corrected) |
| C4 | Risk-card as-reported completeness + honest missing-field labels | FL | #3 | **Should** | ✅ Shipped — **#243** (per-period provenance, "Too new"/"Not disclosed" labels) |
| ~~C5~~ | ~~Picker: de-dupe / label plan twins~~ → **subsumed by C6** | — | B | folded into C6 | ✅ Subsumed by **#240** (family grouping de-dupes twins by construction) |

> **Status (2026-06-27): ✅ All items shipped and verified.** Every item landed in dependency
> order (CD-OD → C1 → C6 → C2 → C4 → C3) plus the C6 fallback-label fix (#244). All four reported
> symptoms are resolved; gates green in CI; the dev backfill that blocked the C1 sync was
> separately unblocked (#239). No open Compare bugs remain.

**Identity is synced from OpenFolio, never derived in FolioLens.** Dependency order:
**CD-OD** (upstream exposes family_id/name/plan-option — it already has the normaliser + family
model) → **C1** (FolioLens syncs them into `scheme_master`, retires the brittle name regex) →
**C6** (family-first picker over the synced family_id — the headline UX win) → **C2** (perf,
pairs with C6: one canonical series per fund). C3/C4 are trust polish. C5 folds into C6.
Suggested order: **CD-OD → C1 → C6 → C2 → C4 → C3**.

---

## 8. Implementation prompts

Standard FolioLens preamble applies (branch from `origin/main`; `npm run typecheck` zero,
`npm run lint --max-warnings 0`, `npx jest --coverage` ≥95% for `src/utils/`; mock at wrapper
boundaries; migrations via `supabase db push` to dev only; verify live claims yourself; update
docs + `__BUSTER__`/`[cache-shape-stable]` as needed; validate every test-plan item before PR).

### CD-OD (OpenFolio-Data) `feat(api): expose family_id + family_name + structured plan/option on /v1/metadata`

> Use the OpenFolio-Data preamble. OpenFolio already owns scheme identity: a stable `family_id`
> (`OF-…`) groups every plan, the family/plan model is in `contract.py`, and the base-name
> normaliser already exists (`src/mfholdings/scheme_master/normalize.py:143` `base_scheme_name`).
> But the `/v1/metadata` endpoints (`FundMetadata` — the per-scheme + bulk metadata FolioLens
> consumes) do NOT carry family identity — verify: `FundMetadata` has `scheme_code, name, amc, …`
> but no `family_id`/family name/plan-option (it's only on `/v1/schemes`, holdings, composition).
> Add to `FundMetadata` (and the bulk page): (1) `family_id` (resolve the plan_code → family via
> the existing registry/alias mapping); (2) `family_name` — a clean human-readable fund name from
> `base_scheme_name(representative_plan_name)` (the family's shared name, no plan/option tail);
> (3) structured `plan_type` ('direct'|'regular'|null) and `option_type`
> ('growth'|'idcw'|'reinvest'|…|null) parsed once upstream from the plan name/identity (don't make
> FolioLens parse strings). Keep both endpoints byte-consistent (the §P11 read-time path). Update
> `docs/openapi.yaml`, add fixture tests asserting the new fields for a multi-plan family, and a
> `DECISIONS.md` entry. ruff/pyright/pytest green. Note for the FolioLens PR (C1): these become
> `scheme_master` columns synced by `universe-backfill`.

### C1 (FL) `feat(scheme-master): sync OpenFolio family identity; retire client name parsing`

> Depends on **CD-OD** (confirm `/v1/metadata` now returns `family_id`, `family_name`,
> `plan_type`, `option_type`). Today FolioLens has no family key (`family_name` NULL for
> 8,235/8,347 actives, `mfdata_family_id` all-null) and `shortSchemeName`
> (src/utils/schemeName.ts:11-16) parses names client-side but only matches the canonical
> `" - Direct Plan - Growth"` shape — verify it fails for `BANK OF INDIA … Fund Direct Plan-Growth`
> and `… Fund -Direct - IDCW` ("some show Direct, some don't"). Changes (no name parsing in
> FolioLens): (1) migration adds `of_family_id text`, `family_name text`, `plan_type text`,
> `option_type text` to `scheme_master`, with an index on `of_family_id`; regenerate
> `database.types.ts`. (2) Map the four new OF fields in the metadata writers (`universe-backfill`
> metadata phase + `sync-fund-meta` OF leg) via the twins' `FundMetadata` type. (3) Compare
> displays `family_name` for the title and a `plan_type · option_type` chip for ALL funds
> uniformly; **retire `shortSchemeName`** — keep at most a thin fallback (clearly marked) only for
> inactive registry shells OF doesn't index. (4) Run a forced metadata re-sync on dev and verify
> `family_name`/`plan_type` populate for the §2 funds and the title no longer shows inline
> "Direct". Tests: writer mapping, display fallback. `[cache-shape-stable]` if the picker/Compare
> select head is unchanged; otherwise bump `__BUSTER__` (see cache-surfaces.md).

### C6 (FL) `feat(compare): family-first search & select (two-level picker + global plan toggle)`

> Depends on **CD-OD + C1** (confirm `scheme_master` now has synced `of_family_id`, `family_name`,
> `plan_type`, `option_type`, populated by a re-sync). Today the picker
> (`src/utils/fundSearch.ts` `searchSchemes` + the Compare picker UI) returns **one row per
> plan**, so "axis large mid" yields a dozen near-identical rows, every pick triggers heavy
> hydration, and users can compare two plans of the same fund (issue B). Build the
> **family-first picker** per §6.5, grouping on the **synced `of_family_id`** (no client name
> derivation): (1) search returns **one row per family** (`family_name` + AMC + category label;
> ~2,046 active vs 8,347 plan rows), carrying the available plans/options per family; (2) tapping
> a fund selects it defaulted to **Direct · Growth**; (3) a single **global "Comparing: Direct ·
> Growth" toggle** (Direct/Regular × Growth/IDCW) resolves every selected family to a concrete
> `scheme_code` via the synced `plan_type`/`option_type`, with a labelled graceful fallback when a
> family lacks the chosen plan (Regular-only / IDCW-only); (4) a per-fund chip overrides one fund.
> This subsumes C5 (twins de-dupe by construction) and pairs with C2 (one canonical series per
> fund). For full-catalog (37,595-row) search performance, add a search RPC/view returning
> DISTINCT families (representative row + available-plan flags) keyed on the indexed
> `of_family_id`; measure latency before/after with `EXPLAIN ANALYZE`. Keep matured/inactive
> families findable (don't drop; demote per the FL13 ranking). Unit-test grouping, plan resolution
> + fallback, and the toggle. Update `docs/SCREENS.md` for the new picker flow. cache-surfaces.md:
> the search/select payload shape changes → bump the relevant `__BUSTER__` or justify
> `[cache-shape-stable]`. This is the user's primary ask ("fewer options / less loading") — get
> the empty/loading/zero-result states right, and validate the full select → compare flow on dev
> with 3 Large & Mid Cap funds.

### C2 (FL) `perf(compare): gate hydration + compute metrics from month-end NAV`

> Compare feels slow for a few seconds after each pick. Trace (verify with the existing
> `perfStart/perfEnd` marks): on selection, `hydrationQueries`
> (…CompareFundsScreen.tsx:2008-2055) fires TWO cold edge-function invokes per fund
> (`fetch-fund-snapshot` + `fetch-fund-nav`) unconditionally, then `navHistoryQuery` pulls a 5y
> **daily** series (~1,250 pts/fund) and `metricsByCode` recomputes `selectCompareMetrics` over
> it on the JS thread. Two wins: (1) **Gate hydration on missing data** — before invoking
> `fetch-fund-snapshot`, check whether `scheme_master` (period_returns/risk_ratios/aum) AND an
> `official` composition row already exist and are fresh for the code (post-resync most active
> funds do); before `fetch-fund-nav`, check for a recent local SQLite series. Skip the invoke
> when present (both edge fns are already idempotent no-ops, but the round-trip itself is the
> cost). (2) **Compute from month-end NAV** — fetch/sample month-end points (reuse the
> `month_end_nav` RPC shipped for Past-SIP, or sample the windowed series to month-end before
> `selectCompareMetrics`); assert trailing CAGR / σ / max-DD are within tolerance of the
> daily-series result in a unit test, and that the chart still uses whatever series it needs.
> Keep the as-reported→computed swap from visibly flipping identical values (only recompute-swap
> when computed adds a field, e.g. Sharpe/Sortino). Measure before/after with the perf marks and
> paste the numbers. Mock at wrapper boundaries; `[cache-shape-stable]` unless the cached series
> shape changes (then bump `__BUSTER__`). Validation: pick 3 cold Large & Mid Cap Direct funds,
> show wall-time to numbers + chart before/after.

### C3 (FL + OD) `fix(category): harden sebi_category resolution + tolerant cross-category banner`

> Comparing same-category funds can falsely trigger the "different category" banner because
> `sebi_category` is dirty for some schemes — verify live: `Edelweiss NIFTY Large Midcap 250
> Index Fund` (scheme 149343) has `sebi_category='mid cap fund'` (wrong) while real large-mid
> funds have `large & mid cap fund`; `uniqueCategories`
> (…CompareFundsScreen.tsx:2245) then sees >1 category. Two parts: (1) **Data** — extend the
> category resolver (`_shared/portfolio-utils.ts` `resolveSebiCategory`/`deriveSchemeCategoryFromName`
> and the OpenFolio side if it's the source) so an index-tracking name ("…Large Midcap 250
> Index", "Large & Mid", "LargeMidcap") resolves to the correct SEBI key and never to a bare
> `mid cap fund`; re-run the relevant backfill path for affected actives and cite the corrected
> count. (2) **Client** — make the banner tolerant: define a small equivalence set so
> near-identical SEBI buckets (and a null/broad `Equity` fallback vs a specific sibling) don't
> trip the warning; only warn on genuinely different fund families. Unit-test the equivalence
> logic with the §3 rows. `[cache-shape-stable]`.

### C4 (FL) `fix(compare): complete the as-reported Risk card + honest missing-field labels`

> In the as-reported branch of `selectCompareMetrics` (computedFundMetrics.ts:405-409)
> `sharpe`/`sortino` are hard-null, so the Risk card is half-blank ("—") until the NAV series
> hydrates — which reads as "graph shows, numbers missing". Also `fund_manager` is genuinely
> null for some funds (verify: Bandhan 118419, BANK OF INDIA 119350) and newer funds lack 5y.
> Changes: (1) in as-reported state, surface every metric OpenFolio already provides (stdDev +
> max-drawdown from `risk_ratios`) and, where Sharpe/Sortino can't be shown, render an explicit
> "needs full history" affordance instead of a bare "—"; (2) replace bare "—" for genuinely
> null fields with honest labels per `feedback_trust_numbers` ("Not disclosed" for null manager,
> "Too new" for a period the fund hasn't existed through); (3) avoid the computed-wins blanking
> of a longer period the loaded series can't cover — prefer the as-reported longer period with a
> provenance marker (never mixing sources within one period). Unit-test the as-reported Risk
> shape and the labels. `[cache-shape-stable]`.

### C5 (FL) `feat(compare/picker): de-dupe and label Growth-vs-IDCW plan twins`

> The picker lets a user compare two plans of the *same* fund unknowingly — e.g. 119436
> (Growth, AUM ₹726 Cr) and 119433 (IDCW, AUM ₹20 Cr): same scheme, same returns, AUM differs
> ~36×, so the AUM row is misleading. **Folded into C6** — family-first grouping de-dupes plan
> twins by construction. Kept here only as the explicit requirement C6 must satisfy: when two
> selected funds resolve to the same family, never present them as distinct, and never compare
> their AUM as if they were different funds.

---

## 9. Final recommendation

The headline change is **family-first search & select (C6)** — exactly the user's ask. Crucially,
the fund/family identity is **synced from OpenFolio, not derived in FolioLens**: OpenFolio already
owns scheme identity, already has the `base_scheme_name` normaliser and the `family_id` model, and
already exposes `family_id` on most endpoints — it just isn't on the `/v1/metadata` endpoint that
populates `scheme_master`. So the foundation is **CD-OD** (expose `family_id` + clean `family_name`
+ structured `plan_type`/`option_type` upstream) → **C1** (FolioLens syncs them into
`scheme_master` and retires its brittle client-side name regex) → **C6** (family-first picker over
the synced `of_family_id`). Then **C2** (perf) compounds the win — one canonical series per fund.
**C3/C4** are trust polish.

**Suggested order: CD-OD → C1 → C6 → C2 → C4 → C3.** CD-OD/C1/C6/C2 should land as a coherent set
(they reshape the same identity → select → compare flow). Schema/data touches: CD-OD (OF contract),
C1 (`scheme_master` columns + re-sync), C3 (category data); the rest is client + edge. Get the
family-picker empty/loading/zero-result states right — that's where "too much loading" is felt
today.

---

### Outcome (2026-06-27)

Executed exactly in the recommended order. CD-OD (OpenFolio) → C1 (#238) → C6 (#240) → C2 (#241)
→ C4 (#243) → C3 (#242), with C5 subsumed by C6. One follow-up fix corrected an inverted
fallback-chip label in C6's plan resolution (#244). A pre-existing universe-backfill deadlock that
silently blocked the C1 family sync from reaching dev was found and fixed during verification
(#239), then the dev re-sync was driven to completion (`of_family_id`/`family_name` 100%). Final
verification confirmed all four reported symptoms resolved, all gates green in CI, and no open
Compare bugs. **Plan complete.**
