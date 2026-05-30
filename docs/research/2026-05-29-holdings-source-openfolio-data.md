# Holdings data source — decision: build OpenFolio-Data

Date: 2026-05-29

Author: Claude (with Himanshu)

## Decision

Build our own Indian MF **portfolio holdings** data source as a **separate project**,
[OpenFolio-Data](https://github.com/himanshu4141/OpenFolio-Data), that parses AMCs'
SEBI-mandated monthly portfolio disclosures into a clean SQLite dump + a REST API.
FolioLens becomes its first consumer.

This supersedes the "keep mfdata.in for holdings" stance in the M12 planning docs
(`docs/plans/phase-2-design-integration/M12-composition-data-acquisition.md`, PRs #56/#67):
mfdata.in is too unreliable, and the research below shows official disclosures are the only
trustworthy, ISIN-bearing source.

## Why (source landscape, summarized)

The app uses five independent data domains: NAV history, fund metadata, benchmark indices,
stock market-cap classification, and CAS transactions. On the holdings/composition domain:

- **mfdata.in is unfit as canonical.** Live probes (PRs #56/#67): `/families/{id}/allocation`
  is null; holdings totals exceed 100%; **ISINs are null on the free tier** (so cap-split can
  never be real from it); `debt_holdings` are corrupted for pure-equity funds.
- **No free holdings dataset/API exists.** A broad GitHub search (incl. captn3m0's repos,
  mftool, folioman) found none. `captn3m0/historical-mf-data` covers NAV only; **Kuvera**
  (`api.kuvera.in`) covers metadata well but **not holdings**.
- **Official AMC monthly disclosures are the answer.** SEBI standardizes the format
  (verified by dissecting PPFAS's Jan-2025 .xls): one sheet per scheme, every row carries an
  ISIN, with sector (equity) / rating (debt), weight, and section headers that classify asset
  class. A single core parser + thin per-AMC adapters is tractable.
- **AMFI does NOT publish a consolidated portfolio** (spike confirmed — `/otherdata/` has only
  stock categorisation, fund performance, industry data, tracking error). Per-AMC adapters
  are required. But the **AMFI market-cap list** (ISIN→Large/Mid/Small) is live and already
  used by our `sync-stock-market-cap` — so once a source provides ISINs, our cap-split works.

## Why a separate project

- **Runtime fit:** holdings parsing is an Excel/PDF problem that wants Python; our Supabase
  Edge backend is Deno-only — the same constraint that pushed us to mfdata.in/CASParser
  originally. A Python data product is the right home.
- **Two deliverables from one pipeline:** a free SQLite dump and a REST API.
- **Real market gap / optional product:** no reliable free holdings API exists.
- **Decoupling + community:** FolioLens stays a consumer behind a wrapper; an open dataset
  invites contributed AMC adapters for the long tail.

## How it integrates into FolioLens

OpenFolio-Data's **API contract is defined first, from FolioLens's needs** (see the new repo's
`docs/FOLIOLENS-NEEDS.md`), so the data is built to satisfy what `fund_portfolio_composition`
and the composition UI actually render. Integration plan:

- Add a data wrapper (e.g. `src/lib/data/composition` or a thin edge function) that calls
  OpenFolio-Data's `/v1/schemes/{scheme_code}/composition`. No Python enters FolioLens.
- Extend `sync-fund-portfolios` precedence: add `source='official'` as the top tier.
  Field-level precedence:

  | Field | Primary | Backup | Fallback |
  |---|---|---|---|
  | Asset allocation | OpenFolio-Data (official) | — | category_rules |
  | Holdings (equity+debt) | OpenFolio-Data | mfdata (enrichment) | — |
  | Sectors | OpenFolio-Data | mfdata | — |
  | Cap split | OpenFolio-Data ISIN → `stock_market_cap` | — | category_rules |
  | Metadata (risk/rating/benchmark/variants) | Kuvera / mfdata | — | — |

- Surface debt holdings (currently discarded) once available; keep "trust the numbers" rules
  (unknowns explicit, never zero-filled).

## Sequencing

- **Phase 0 (FolioLens, now):** M12 Phase-A code-quality fixes still apply — stop discarding
  `debt_holdings`, add the index-row corruption guard, add fetch retry/backoff. Independent of
  the new project.
- **Phase 1–2 (OpenFolio-Data):** contract-first build of parser → adapters → store →
  validation against the contract → dump → API. Tier-1 AMCs first
  (PPFAS, HDFC, DSP, Motilal, Mirae, ICICI), then the active long tail incl. Quant, Edelweiss,
  PGIM, Canara Robeco, Bajaj Finserv, 360 ONE, WhiteOak.
- **Phase 3 (FolioLens cutover):** consume the API as primary; demote mfdata.in to backup.

## References
- New repo: https://github.com/himanshu4141/OpenFolio-Data (see its `docs/RESEARCH.md`)
- Prior research: `docs/research/2026-04-21-composition-source-validation.md` (PR #56),
  `docs/research/2026-04-27-composition-independent-review.md` (PR #67)
- `docs/plans/phase-2-design-integration/M12-composition-data-acquisition.md`
