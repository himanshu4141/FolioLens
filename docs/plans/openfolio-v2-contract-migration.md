# ExecPlan: adapt to OpenFolio-Data v2.0.0 (family_id + plans[])

Status: Planned — execute when OpenFolio v2.0.0 is live in prod + data rebuilt. Folds into PR #190.
Date: 2026-06-01
Upstream: OpenFolio-Data [PR #27](https://github.com/himanshu4141/OpenFolio-Data/pull/27) (merged — future-date parser fix) + [PR #28](https://github.com/himanshu4141/OpenFolio-Data/pull/28) (`v2.0.0` BREAKING — identity model).

## What changed upstream
- **#27 (data fix, no contract change):** a bond/FMP **maturity** date was leaking into `disclosure_date` (the `2027-05-28`, same class as `2055`). Their parser upper bound is now `today + 7d`. Effect for us: the 23 schemes we `skippedBadDate` get correct dates on their re-ingest → covered on the next backfill. **Our `isPlausibleDisclosureDate` guard stays** as defense-in-depth (harmless once their data is clean).
- **#28 (`v2.0.0`, breaking):** the API conflated *family* (the shared portfolio) with one *plan*. Now:
  - **Removed** top-level `scheme_code` and `isin` from every response.
  - **Added** `family_id` (string, `OF-`+12 hex — never collides with an int plan code) and
    `plans: [{ plan_code: int, plan_name: str, isins: [str] }]` — **every** AMFI plan in the family,
    each with its own code and ISIN(s) (growth + IDCW payout/reinvest). Plans with no ISIN are still
    listed with `isins: []` (honest, never a borrowed ISIN).
  - `GET /v1/schemes/{scheme_id}` resolves a **family_id, any plan code, or any plan ISIN**; malformed → **404** (was 422).
  - Bulk `GET /v1/composition` items each carry `family_id` + full `plans[]`.
  - openapi + app version → `2.0.0`.

This closes our **flag #2** (plan-variant pre-seeding): the bulk feed now exposes all plan codes/ISINs, so the monthly sync can pre-seed every plan a CAS might reference (e.g. both DSP ELSS Regular *and* Direct from one family item).

## Execution trigger
OpenFolio v2.0.0 deployed to prod (Cloud Run service rolled, GCS DB rebuilt, `/health` sane). **First step is always: curl the live v2 API and pin the exact shapes** (`/openapi.json`, a bulk page, single-GET by family_id / plan code / plan ISIN, a 404) — map against reality, not this doc.

## Our changes (all in `feat/openfolio-holdings` / PR #190 — it now targets v2)

### 1. Types — `_shared/openfolio.ts` + `src/lib/data/composition.ts`
- New `OpenFolioPlan = { plan_code: number; plan_name: string; isins: string[] }`.
- `OpenFolioComposition`: **drop** `scheme_code` + `isin`; **add** `family_id: string`, `plans: OpenFolioPlan[]`.

### 2. Matching rewrite — `_shared/openfolio.ts`
Replace `resolveSchemeCode(item, universe): SchemeMatch | null` with
`resolveSchemeCodes(item, universe): SchemeMatch[]`:
- For each `plan` in `item.plans`:
  - if `plan.plan_code ∈ universe.knownCodes` → push `{ schemeCode: plan.plan_code, matchedBy: 'plan_code' }`.
  - for each `isin` in `plan.isins`: if `isinToCode.has(isin.toUpperCase())` → push `{ schemeCode: isinToCode.get(isin), matchedBy: 'isin' }`.
- Dedupe by `schemeCode`. Return all our held codes the family covers (0..N).

Behavioural change: **one family item → one official row per matched held plan code** (the shared
portfolio written under each plan we track). This is the flag-#2 fix.

### 3. `mapCompositionToRow` — unchanged
Already takes `schemeCode` as a param and reads only `asset_mix` / `cap_mix` / `sectors` /
`top_holdings` / `debt_holdings` / `disclosure_date` / `provenance` — **not** `scheme_code`/`isin`.
Verify, no change expected. Called once per matched plan code.

### 4. `runOpenFolioSync` — per-item loop
- `const matches = resolveSchemeCodes(item, universe)`. If empty → `unmatched += 1`.
- Date guard is **item-level**: check `isPlausibleDisclosureDate(item.disclosure_date, today)` once;
  if bad, `skippedBadDate += 1` and skip the whole family.
- Else, for each match: bump `matchedByCode`/`matchedByIsin`, `mapCompositionToRow(item, match.schemeCode, syncedAt)` → push to `pageRows` (batched upsert per page, unchanged).
- `upserted` now ≥ `itemsFetched` for families with multiple held plans.

### 5. On-demand — `fetch-fund-snapshot`
`getComposition(ourSchemeCode)` still works: the v2 path accepts any plan code → resolves to the
family. We keep mapping with our `schemeCode`. Only the response **type** changes. Date guard unchanged.

### 6. Client — `createOpenFolioClient`
Path building unchanged (plan code in path still valid). 404→null already handled (covers the
422→404 change). No code change beyond types.

### 7. Tests — `_shared/__tests__/openfolio.test.ts`
- `comp()` fixture: replace `scheme_code`/`isin` with `family_id` + `plans[]`.
- New matching tests: family with one held plan → 1 match; family with two held plans (Regular +
  Direct) → 2 matches (one official row each); match by plan ISIN; family with held + unheld plans →
  only held matched; unmatched family → 0; plan with `isins: []` resolvable by code only.
- `runOpenFolioSync`: a two-held-plan family yields 2 upserts from 1 item; counters.
- Mapping tests largely unchanged (pass `schemeCode` explicitly). Keep `openfolio.ts` at 100% lines/funcs.

### 8. Docs
Update this plan's outcome, the openfolio-holdings ExecPlan Amendments (contract = family_id/plans),
TECH-DISCOVERY (contract block), and `src/lib/data/README.md` if the wrapper surface notes the shape.

## Backfill + validation (dev `imkgazlrxtlhkfptkzjc`)
1. Redeploy `openfolio-sync` + `fetch-fund-snapshot` (v2 code) to dev.
2. `POST /openfolio-sync {"mode":"backfill"}` — expect HTTP 200, `truncated:false`, `skippedBadDate` ≈ 0
   (their #27 fix), `upserted` ≥ prior (multi-plan families add rows).
3. Verify via read-only MCP:
   - held-fund coverage up (DSP ELSS Regular `104772` now covered via `plans[]`; `119205` covered now
     that its date is fixed; only the matured `142499` remains — legitimately).
   - `future_dated_rows = 0`; real cap splits present; one official row per held plan code.

## Coordination / merge
PR #190 now targets OpenFolio **v2.0.0** and **must deploy in lockstep** with their prod cutover —
merging to `main` auto-deploys edge functions to dev (`supabase-deploy-dev.yml`), so **do not merge
#190 until OpenFolio v2.0.0 is live in prod**, or dev's functions will run v2 code against a v1 API.
PR #191 (stock_market_cap deprecation) is orthogonal and unaffected.
