/**
 * OpenFolio-Data client + pure mapping/matching/precedence helpers.
 *
 * OpenFolio-Data (https://github.com/himanshu4141/OpenFolio-Data) is our own
 * MF holdings service: it parses AMCs' SEBI-mandated monthly portfolio
 * disclosures into a clean REST API. This module is the SOLE owner (Deno side)
 * of the OpenFolio base URL + `X-API-Key`; edge functions call through it and
 * never read the credentials directly. The app-side twin is
 * `src/lib/data/composition.ts`.
 *
 * Everything except `createOpenFolioClient` (the thin HTTP wrapper) is pure
 * and unit-tested in `__tests__/openfolio.test.ts` to the `_shared/` coverage
 * bar — the mapping, scheme matching, source precedence, and the
 * dependency-injected sync core all run without network or Supabase.
 *
 * Contract: docs/openapi.yaml in the OpenFolio-Data repo (verified live
 * against the deployed API on 2026-05-31).
 */

// BEGIN OPENFOLIO SHARED CONTRACT (guarded — see twin-contract.test.ts)
// ---------------------------------------------------------------------------
// API response types (mirror OpenFolio-Data's CompositionResponse)
// ---------------------------------------------------------------------------

export interface OpenFolioAssetMix {
  equity_pct?: number;
  arbitrage_pct?: number;
  debt_pct?: number;
  cash_pct?: number;
  other_pct?: number;
  derivatives_pct?: number;
}

export interface OpenFolioCapMix {
  large_pct?: number | null;
  mid_pct?: number | null;
  small_pct?: number | null;
  unclassified_pct?: number;
}

export interface OpenFolioSector {
  sector: string;
  weight_pct: number;
}

export interface OpenFolioTopHolding {
  instrument_name: string;
  isin?: string | null;
  weight_pct: number;
  sector?: string | null;
  /** large | mid | small | unclassified */
  cap_bucket?: string | null;
}

export interface OpenFolioDebtHolding {
  instrument_name: string;
  isin?: string | null;
  credit_rating?: string | null;
  weight_pct: number;
  maturity_date?: string | null;
  ytm?: number | null;
}

export interface OpenFolioProvenance {
  disclosure_date: string;
  source_url?: string | null;
  source_type?: string | null;
  fetched_at?: string | null;
}

/**
 * One AMFI plan within a scheme family (Regular/Direct × Growth/IDCW…). Every
 * plan shares the family's portfolio but has its own AMFI code + ISIN(s)
 * (growth + IDCW payout/reinvest). A plan with no ISIN is still listed with
 * `isins: []` (honest — never a borrowed ISIN). OpenFolio-Data v2.0.0.
 */
export interface OpenFolioPlan {
  plan_code: number;
  plan_name?: string | null;
  isins: string[];
}

export interface OpenFolioComposition {
  /** `OF-` + 12 hex — the family (shared portfolio) identity. v2 join key. */
  family_id: string;
  /** Every AMFI plan in the family, each with its own code + ISIN(s). */
  plans: OpenFolioPlan[];
  amc: string;
  scheme_name: string;
  sebi_category?: string | null;
  code_source?: string;
  disclosure_date: string;
  provenance?: OpenFolioProvenance;
  asset_mix?: OpenFolioAssetMix;
  cap_mix?: OpenFolioCapMix;
  sectors?: OpenFolioSector[];
  top_holdings?: OpenFolioTopHolding[];
  debt_holdings?: OpenFolioDebtHolding[];
}

export interface OpenFolioCompositionPage {
  count: number;
  page: number;
  page_size: number;
  items: OpenFolioComposition[];
}

export interface ListCompositionArgs {
  page?: number;
  pageSize?: number;
  updatedSince?: string | null;
  amc?: string | null;
  top?: number;
}

export interface GetCompositionArgs {
  date?: string | null;
  top?: number;
}

// ---------------------------------------------------------------------------
// NAV API response types (OpenFolio-Data v2.0.0)
// ---------------------------------------------------------------------------

/** Single data point in a NAV time-series. */
export interface NavSeriesPoint {
  /** ISO date YYYY-MM-DD. */
  date: string;
  nav: number;
}

/**
 * Response from GET /v1/nav/{scheme_code} — the full or date-bounded NAV
 * series for one AMFI plan. `scheme_code` is the integer AMFI plan code.
 */
export interface NavSeries {
  scheme_code: number;
  from_date?: string | null;
  to_date?: string | null;
  points: NavSeriesPoint[];
}

/**
 * Response from GET /v1/nav/{scheme_code}/latest — the single most-recent
 * NAV for one AMFI plan.
 */
export interface NavLatestEntry {
  scheme_code: number;
  /** ISO date YYYY-MM-DD. */
  date: string;
  nav: number;
}

/**
 * One item in the bulk NAV page — one scheme's most-recent NAV entry.
 * `date` is ISO YYYY-MM-DD; maps to `nav_history.nav_date`.
 */
export interface NavBulkItem {
  scheme_code: number;
  /** ISO date YYYY-MM-DD → nav_history.nav_date. */
  date: string;
  nav: number;
}

/** Response from GET /v1/nav?since=|date= — paginated bulk NAV. */
export interface NavBulkPage {
  count: number;
  page: number;
  page_size: number;
  items: NavBulkItem[];
}

/** Args for the per-scheme series endpoint. */
export interface GetNavSeriesArgs {
  /** Lower bound — ISO date YYYY-MM-DD. */
  since?: string | null;
  /** Upper bound — ISO date YYYY-MM-DD. */
  until?: string | null;
}

/** Args for the bulk NAV listing endpoint. */
export interface ListNavArgs {
  /** All schemes with a NAV on/after this ISO date. */
  since?: string | null;
  /** All schemes with a NAV on exactly this ISO date. */
  date?: string | null;
  page?: number;
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// Fund Metadata API types (OpenFolio-Data v2.0.0)
// GET /v1/schemes/{scheme_code}/metadata  → FundMetadata
// GET /v1/metadata?updated_since=         → MetadataPage
// ---------------------------------------------------------------------------

/**
 * Per-field provenance + status from OpenFolio's B1 extraction pipeline.
 * The field VALUES live as flat properties on FundMetadata; b1_field_meta
 * holds the diagnostic metadata for each.
 */
export type B1FieldStatus =
  | 'value' // OpenFolio has a value — use it
  | 'officially_absent' // Source explicitly has no value — honest null, skip backup
  | 'not_applicable' // Field doesn't apply to this fund type — honest null
  | 'unresolved' // Not yet processed — fall back to mfdata
  | 'parse_failed' // Extraction attempted but failed — fall back to mfdata
  | 'source_failed'; // Source fetch failed — fall back to mfdata

export interface B1FieldMeta {
  status: B1FieldStatus;
  source?: string | null;
  source_url?: string | null;
  observed_at?: string | null;
  reason?: string | null;
  source_quality?: string | null;
}

/** Computed returns — all values are decimal CAGRs (0.125 = 12.5%). */
export interface FundMetadataReturns {
  ret_1y?: number | null;
  ret_3y?: number | null;
  ret_5y?: number | null;
  /** Since-inception CAGR. */
  ret_incep?: number | null;
}

/** Computed analytics from OpenFolio's NAV series. */
export interface FundMetadataMetrics {
  /** AUM in crores (already in crores — no conversion needed). */
  aum_cr?: number | null;
  aum_date?: string | null;
  returns?: FundMetadataReturns | null;
  /** Annualised σ (decimal). */
  volatility?: number | null;
  /** Worst peak-to-trough drawdown over trailing 5y (decimal ≤ 0). */
  max_drawdown_5y?: number | null;
  computed_from_nav_date?: string | null;
}

/** Per-field status map — keys match the B1 flat fields on FundMetadata. */
export interface FundMetadataB1FieldMeta {
  ter?: B1FieldMeta;
  ter_date?: B1FieldMeta;
  fund_manager?: B1FieldMeta;
  inception_date?: B1FieldMeta;
  exit_load?: B1FieldMeta;
  min_investment?: B1FieldMeta;
  min_sip?: B1FieldMeta;
  benchmark?: B1FieldMeta;
  riskometer?: B1FieldMeta;
  portfolio_turnover?: B1FieldMeta;
}

/**
 * One scheme's full metadata record from OpenFolio.
 * B1 fields are flat properties; b1_field_meta carries the status for each.
 */
export interface FundMetadata {
  scheme_code: number;
  name?: string | null;
  amc?: string | null;
  active?: boolean | null;
  // B1 fields (flat):
  ter?: number | null;
  ter_date?: string | null;
  fund_manager?: string | null;
  inception_date?: string | null;
  exit_load?: string | null;
  min_investment?: number | null;
  min_sip?: number | null;
  benchmark?: string | null;
  riskometer?: string | null;
  portfolio_turnover?: number | null;
  // Computed metrics:
  metrics?: FundMetadataMetrics | null;
  // Per-field extraction metadata:
  b1_field_meta?: FundMetadataB1FieldMeta | null;
  b1_source?: string | null;
  b1_source_url?: string | null;
  b1_synced_at?: string | null;
}

/** Paginated response from GET /v1/metadata. */
export interface MetadataPage {
  count: number;
  page: number;
  page_size: number;
  items: FundMetadata[];
}

/** Args for GET /v1/metadata (bulk). */
export interface ListMetadataArgs {
  /** ISO-8601 datetime — return schemes updated on/after this time. */
  updatedSince?: string | null;
  page?: number;
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// Scheme registry API types (OpenFolio-Data v2.0.0)
// GET /v1/schemes?amc=&category=&q=  → SchemeListPage
// Family-keyed (like composition) — reuse resolveSchemeCodes for matching.
// ---------------------------------------------------------------------------

/**
 * One family entry from the scheme registry — same identity shape as
 * composition but without the portfolio payload. Used as a backstop source for
 * scheme_category / amc_name / ISINs for schemes that lack a composition
 * disclosure (e.g. new launches, debt-only AMCs with no monthly obligation).
 */
export interface SchemeFamily {
  family_id: string;
  plans: OpenFolioPlan[];
  amc: string;
  scheme_name: string;
  sebi_category?: string | null;
  code_source?: string;
}

export interface SchemeListPage {
  count: number;
  page: number;
  page_size: number;
  items: SchemeFamily[];
}

export interface ListSchemesArgs {
  amc?: string | null;
  category?: string | null;
  q?: string | null;
  page?: number;
  pageSize?: number;
}
// ---------------------------------------------------------------------------
// OpenFolio credentials + request paths
// ---------------------------------------------------------------------------

export const OPENFOLIO_API_BASE_ENV = 'OPENFOLIO_API_BASE';
export const OPENFOLIO_API_BASE_URL_ENV = 'OPENFOLIO_API_BASE_URL';
export const OPENFOLIO_API_KEY_ENV = 'OPENFOLIO_API_KEY';

export interface OpenFolioEnv {
  get(key: string): string | undefined;
}

export interface OpenFolioCredentials {
  baseUrl: string;
  apiKey: string;
}

/**
 * Read the OpenFolio base URL + key from an env source. Accepts either
 * `OPENFOLIO_API_BASE` (the function-secret name) or `OPENFOLIO_API_BASE_URL`
 * (the local `.env.local` name). Throws if either is missing so a
 * misconfigured deploy fails loudly instead of silently fetching nothing.
 */
export function resolveOpenFolioCredentials(env: OpenFolioEnv): OpenFolioCredentials {
  const baseUrl = (env.get(OPENFOLIO_API_BASE_ENV) ?? env.get(OPENFOLIO_API_BASE_URL_ENV) ?? '')
    .trim()
    .replace(/\/+$/, '');
  const apiKey = (env.get(OPENFOLIO_API_KEY_ENV) ?? '').trim();
  if (!baseUrl || !apiKey) {
    throw new Error(
      'OpenFolio not configured: set OPENFOLIO_API_BASE (or OPENFOLIO_API_BASE_URL) and OPENFOLIO_API_KEY',
    );
  }
  return { baseUrl, apiKey };
}

export function buildOpenFolioQuery(
  params: Record<string, string | number | null | undefined>,
): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') usp.set(k, String(v));
  }
  const q = usp.toString();
  return q ? `?${q}` : '';
}

export function openFolioCompositionPath(
  schemeCode: number,
  args: GetCompositionArgs = {},
): string {
  return `/v1/schemes/${schemeCode}/composition${buildOpenFolioQuery({ date: args.date, top: args.top })}`;
}

export function openFolioCompositionListPath(args: ListCompositionArgs = {}): string {
  return `/v1/composition${buildOpenFolioQuery({
    page: args.page,
    page_size: args.pageSize,
    updated_since: args.updatedSince,
    amc: args.amc,
    top: args.top,
  })}`;
}

export function openFolioNavSeriesPath(schemeCode: number, args: GetNavSeriesArgs = {}): string {
  return `/v1/nav/${schemeCode}${buildOpenFolioQuery({ since: args.since, until: args.until })}`;
}

export function openFolioNavLatestPath(schemeCode: number): string {
  return `/v1/nav/${schemeCode}/latest`;
}

export function openFolioNavListPath(args: ListNavArgs = {}): string {
  return `/v1/nav${buildOpenFolioQuery({
    since: args.since,
    date: args.date,
    page: args.page,
    page_size: args.pageSize,
  })}`;
}

export function openFolioMetadataPath(schemeCode: number): string {
  return `/v1/schemes/${schemeCode}/metadata`;
}

export function openFolioMetadataListPath(args: ListMetadataArgs = {}): string {
  return `/v1/metadata${buildOpenFolioQuery({
    updated_since: args.updatedSince,
    page: args.page,
    page_size: args.pageSize,
  })}`;
}

export function openFolioSchemesPath(args: ListSchemesArgs = {}): string {
  return `/v1/schemes${buildOpenFolioQuery({
    amc: args.amc,
    category: args.category,
    q: args.q,
    page: args.page,
    page_size: args.pageSize,
  })}`;
}
// END OPENFOLIO SHARED CONTRACT (guarded — see twin-contract.test.ts)

// ---------------------------------------------------------------------------
// Row shape we upsert into fund_portfolio_composition
// ---------------------------------------------------------------------------

export interface CompositionDebtHolding {
  name: string;
  isin: string | null;
  credit_rating: string | null;
  maturity_date: string | null;
  weight_pct: number;
  ytm: number | null;
}

export interface CompositionTopHolding {
  name: string;
  isin: string;
  sector: string;
  marketCap: 'Large Cap' | 'Mid Cap' | 'Small Cap' | 'Other';
  pctOfNav: number;
}

export interface CompositionRow {
  scheme_code: number;
  portfolio_date: string;
  equity_pct: number;
  debt_pct: number;
  cash_pct: number;
  other_pct: number;
  large_cap_pct: number | null;
  mid_cap_pct: number | null;
  small_cap_pct: number | null;
  not_classified_pct: number | null;
  sector_allocation: Record<string, number> | null;
  top_holdings: CompositionTopHolding[] | null;
  raw_debt_holdings: CompositionDebtHolding[] | null;
  source: 'official';
  source_url: string | null;
  disclosure_date: string | null;
  synced_at: string;
}

// ---------------------------------------------------------------------------
// Source precedence — highest wins
// ---------------------------------------------------------------------------

export const COMPOSITION_SOURCE_RANK: Record<string, number> = {
  official: 3,
  amfi: 2,
  category_fallback: 1,
  category_rules: 0,
};

/** Numeric rank for a source string; unknown / null sources rank below all. */
export function compositionSourceRank(source: string | null | undefined): number {
  if (source == null) return -1;
  return COMPOSITION_SOURCE_RANK[source] ?? -1;
}

// ---------------------------------------------------------------------------
// Pure mapping: OpenFolio composition → fund_portfolio_composition row
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Finite number or 0 — for fields that must always carry a value. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Finite number (rounded to 2dp) or null — preserves "unknown", never zero-fills. */
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? round2(v) : null;
}

function capBucketToMarketCap(
  bucket: string | null | undefined,
): CompositionTopHolding['marketCap'] {
  switch ((bucket ?? '').toLowerCase()) {
    case 'large':
      return 'Large Cap';
    case 'mid':
      return 'Mid Cap';
    case 'small':
      return 'Small Cap';
    default:
      return 'Other';
  }
}

/**
 * Map one OpenFolio CompositionResponse to a fund_portfolio_composition row.
 *
 * - `arbitrage_pct` (hedged long equity) folds into `equity_pct` to match the
 *   existing app convention (category_rules already treat arbitrage funds as
 *   equity); `derivatives_pct` is an off-balance memo and is dropped.
 * - Cap-mix maps 1:1 — OpenFolio's large/mid/small/unclassified are already
 *   "% of NAV" (they sum to the equity sleeve), the same convention the
 *   mfdata classifier produces. Nulls are preserved, never zero-filled.
 * - `portfolio_date` ← disclosure_date (month-end); `disclosure_date` column
 *   ← provenance.disclosure_date (falls back to the top-level date).
 */
export function mapCompositionToRow(
  item: OpenFolioComposition,
  schemeCode: number,
  syncedAt: string,
): CompositionRow {
  const am = item.asset_mix ?? {};
  const equityPct = round2(num(am.equity_pct) + num(am.arbitrage_pct));
  const debtPct = round2(num(am.debt_pct));
  const cashPct = round2(num(am.cash_pct));
  const otherPct = round2(num(am.other_pct));

  const cm = item.cap_mix ?? {};

  const sectors = Array.isArray(item.sectors) ? item.sectors : [];
  const sectorAllocation: Record<string, number> = {};
  for (const s of [...sectors].sort((a, b) => num(b?.weight_pct) - num(a?.weight_pct))) {
    if (s && typeof s.sector === 'string' && typeof s.weight_pct === 'number') {
      sectorAllocation[s.sector] = round2(s.weight_pct);
    }
  }

  const rawTop = Array.isArray(item.top_holdings) ? item.top_holdings : [];
  const topHoldings: CompositionTopHolding[] = rawTop
    .filter((h) => h && typeof h.instrument_name === 'string' && typeof h.weight_pct === 'number')
    .map((h) => ({
      name: h.instrument_name,
      isin: h.isin ?? '',
      sector: h.sector ?? 'Other',
      marketCap: capBucketToMarketCap(h.cap_bucket),
      pctOfNav: round2(h.weight_pct),
    }));

  const rawDebt = Array.isArray(item.debt_holdings) ? item.debt_holdings : [];
  const debtHoldings: CompositionDebtHolding[] = rawDebt
    .filter((d) => d && typeof d.instrument_name === 'string' && typeof d.weight_pct === 'number')
    .map((d) => ({
      name: d.instrument_name,
      isin: d.isin ?? null,
      credit_rating: d.credit_rating ?? null,
      maturity_date: d.maturity_date ?? null,
      weight_pct: round2(d.weight_pct),
      ytm: typeof d.ytm === 'number' && Number.isFinite(d.ytm) ? round4(d.ytm) : null,
    }));

  return {
    scheme_code: schemeCode,
    portfolio_date: item.disclosure_date,
    equity_pct: equityPct,
    debt_pct: debtPct,
    cash_pct: cashPct,
    other_pct: otherPct,
    large_cap_pct: numOrNull(cm.large_pct),
    mid_cap_pct: numOrNull(cm.mid_pct),
    small_cap_pct: numOrNull(cm.small_pct),
    not_classified_pct: numOrNull(cm.unclassified_pct),
    sector_allocation: Object.keys(sectorAllocation).length > 0 ? sectorAllocation : null,
    top_holdings: topHoldings.length > 0 ? topHoldings : null,
    raw_debt_holdings: debtHoldings.length > 0 ? debtHoldings : null,
    source: 'official',
    source_url: item.provenance?.source_url ?? null,
    disclosure_date: item.provenance?.disclosure_date ?? item.disclosure_date ?? null,
    synced_at: syncedAt,
  };
}

// ---------------------------------------------------------------------------
// Scheme matching: AMFI scheme_code primary, ISIN secondary
// ---------------------------------------------------------------------------

export interface SchemeUniverse {
  /** Real AMFI scheme codes we track (from scheme_master). */
  knownCodes: Set<number>;
  /** Upper-cased ISIN → the scheme_code we track it under. */
  isinToCode: Map<string, number>;
}

export interface SchemeMatch {
  schemeCode: number;
  matchedBy: 'plan_code' | 'isin';
}

/**
 * Resolve an OpenFolio v2 composition to EVERY scheme_code we track that the
 * family covers. A family's portfolio is shared across all its plans, so for
 * each plan we (a) match the `plan_code` against our universe and (b) match any
 * of the plan's ISINs against scheme_master. We write one `official` row per
 * matched held plan code — so a user holding the Regular plan and another
 * holding the Direct plan of the same fund both get pre-seeded from one bulk
 * item (closes the plan-variant pre-seed gap). Returns [] when the family
 * touches none of our schemes — the caller skips it (mfdata/category fallback).
 */
export function resolveSchemeCodes(
  item: OpenFolioComposition,
  universe: SchemeUniverse,
): SchemeMatch[] {
  const byCode = new Map<number, SchemeMatch>();
  for (const plan of Array.isArray(item.plans) ? item.plans : []) {
    if (typeof plan?.plan_code === 'number' && universe.knownCodes.has(plan.plan_code)) {
      byCode.set(plan.plan_code, { schemeCode: plan.plan_code, matchedBy: 'plan_code' });
    }
    for (const rawIsin of Array.isArray(plan?.isins) ? plan.isins : []) {
      const isin = (rawIsin ?? '').trim().toUpperCase();
      if (!isin) continue;
      const code = universe.isinToCode.get(isin);
      // A direct plan_code match outranks an ISIN match for the same scheme.
      if (code != null && !byCode.has(code)) {
        byCode.set(code, { schemeCode: code, matchedBy: 'isin' });
      }
    }
  }
  return [...byCode.values()];
}

/**
 * Guard against implausible disclosure dates. `disclosure_date` becomes the
 * row's `portfolio_date`, and the read selector tie-breaks on most-recent
 * date — so a garbage date would silently win over every real row.
 *
 * A portfolio disclosure is always a PAST month-end, so accept only a valid
 * `YYYY-MM-DD` in `[2000-01-01, today]` — no future dates. `today` is passed
 * in (YYYY-MM-DD) so the check stays deterministic for tests. We compare as
 * strings: ISO `YYYY-MM-DD` sorts lexicographically the same as chronologically.
 *
 * Observed upstream artifacts this rejects: "2055-08-18", and "2027-05-28"
 * (a ~1-year-future date from an April-2026 build — the earlier year+1 slack
 * wrongly let that through).
 */
export function isPlausibleDisclosureDate(date: string | null | undefined, today: string): boolean {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date >= '2000-01-01' && date <= today;
}

// ---------------------------------------------------------------------------
// HTTP client (thin wrapper — the one place that holds base URL + API key)
// ---------------------------------------------------------------------------

export interface OpenFolioClient {
  getComposition(
    schemeCode: number,
    args?: GetCompositionArgs,
  ): Promise<OpenFolioComposition | null>;
  listComposition(args?: ListCompositionArgs): Promise<OpenFolioCompositionPage>;
  /** Full or date-bounded NAV series for one AMFI plan. Null on 404. */
  getNavSeries(schemeCode: number, args?: GetNavSeriesArgs): Promise<NavSeries | null>;
  /** Most-recent NAV entry for one AMFI plan. Null on 404. */
  getNavLatest(schemeCode: number): Promise<NavLatestEntry | null>;
  /** Bulk paginated NAV — one latest entry per scheme, filtered by date/since. */
  listNav(args?: ListNavArgs): Promise<NavBulkPage>;
  /** Full metadata (metrics + B1 fields) for one AMFI plan. Null on 404. */
  getMetadata(schemeCode: number): Promise<FundMetadata | null>;
  /** Bulk paginated metadata — all schemes, optionally filtered by updated_since. */
  listMetadata(args?: ListMetadataArgs): Promise<MetadataPage>;
  /**
   * Paginated scheme registry — family-keyed list with sebi_category, amc,
   * and plan codes/ISINs but no portfolio payload. Used by the universe
   * backfill (FL-P6) to enrich scheme_master for schemes outside the
   * composition universe (new launches, debt-only AMCs, etc.).
   */
  listSchemes(args?: ListSchemesArgs): Promise<SchemeListPage>;
}

export interface OpenFolioClientConfig extends OpenFolioCredentials {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Construct an OpenFolio HTTP client. `fetchImpl` is injectable for tests. */
export function createOpenFolioClient(config: OpenFolioClientConfig): OpenFolioClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 20_000;

  async function request(path: string): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${config.baseUrl}${path}`, {
        signal: controller.signal,
        headers: { 'X-API-Key': config.apiKey, Accept: 'application/json' },
      });
      const status = res.status;
      if (status === 404) return { status, body: null };
      if (!res.ok) throw new Error(`OpenFolio HTTP ${status} for ${path}`);
      return { status, body: await res.json() };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getComposition(schemeCode, args = {}) {
      const path = openFolioCompositionPath(schemeCode, args);
      const { body } = await request(path);
      return body as OpenFolioComposition | null;
    },
    async listComposition(args = {}) {
      const path = openFolioCompositionListPath(args);
      const { body } = await request(path);
      return body as OpenFolioCompositionPage;
    },
    async getNavSeries(schemeCode, args = {}) {
      const path = openFolioNavSeriesPath(schemeCode, args);
      const { body } = await request(path);
      return body as NavSeries | null;
    },
    async getNavLatest(schemeCode) {
      const { body } = await request(openFolioNavLatestPath(schemeCode));
      return body as NavLatestEntry | null;
    },
    async listNav(args = {}) {
      const path = openFolioNavListPath(args);
      const { body } = await request(path);
      return body as NavBulkPage;
    },
    async getMetadata(schemeCode) {
      const { body } = await request(openFolioMetadataPath(schemeCode));
      return body as FundMetadata | null;
    },
    async listMetadata(args = {}) {
      const path = openFolioMetadataListPath(args);
      const { body } = await request(path);
      return body as MetadataPage;
    },
    async listSchemes(args = {}) {
      const path = openFolioSchemesPath(args);
      const { body } = await request(path);
      return body as SchemeListPage;
    },
  };
}

// ---------------------------------------------------------------------------
// Dependency-injected bulk-sync core (testable without network / Supabase)
// ---------------------------------------------------------------------------

export interface UpsertResult {
  error?: string | null;
}

/**
 * Extracted registry fields from an OpenFolio composition/scheme item —
 * used to enrich `scheme_master` with sebi_category + amc_name.
 * Only fields with non-null values from OpenFolio are written (callers
 * skip the row when both are null so existing DB values are preserved).
 */
export interface SchemeRegistryRow {
  scheme_code: number;
  /** sebi_category → scheme_master.scheme_category */
  scheme_category: string | null;
  /** amc → scheme_master.amc_name */
  amc_name: string | null;
}

export interface OpenFolioSyncDeps {
  client: Pick<OpenFolioClient, 'listComposition'>;
  universe: SchemeUniverse;
  /**
   * Sink for a batch of mapped rows — the edge function wires this to a single
   * Supabase array-upsert. Batching (one call per page instead of one per row)
   * keeps the full sweep well under the synchronous-invocation wall-clock; a
   * per-row sweep of ~hundreds of upserts blew past the 60s gateway timeout and
   * left coverage partial.
   */
  upsertRows(rows: CompositionRow[]): Promise<UpsertResult>;
  /**
   * Optional sink for scheme registry rows extracted from each composition
   * page. Called once per page (after composition upsert). Allows the edge
   * function to write sebi_category + amc_name into scheme_master without
   * a second API pass.
   */
  upsertSchemeRegistry?(rows: SchemeRegistryRow[]): Promise<UpsertResult>;
  syncedAt: string;
  log?: (msg: string) => void;
  pageSize?: number;
  top?: number;
  updatedSince?: string | null;
  amc?: string | null;
  /** Hard cap on pages walked — runaway guard. */
  maxPages?: number;
}

export interface OpenFolioSyncStats {
  pagesFetched: number;
  itemsFetched: number;
  totalCount: number;
  matchedByCode: number;
  matchedByIsin: number;
  unmatched: number;
  /** Matched our universe but skipped — disclosure_date was implausible. */
  skippedBadDate: number;
  upserted: number;
  failed: number;
  /** True when the sweep stopped before covering the reported totalCount. */
  truncated: boolean;
  errors: string[];
}

/**
 * Extract scheme registry rows (sebi_category + amc_name) from a matched
 * composition item + its resolved scheme codes. One row per matched code.
 * Rows where both fields are null are excluded — no point overwriting a
 * potentially richer existing DB value with two nulls.
 */
export function mapCompositionToRegistryRows(
  item: OpenFolioComposition,
  matches: SchemeMatch[],
): SchemeRegistryRow[] {
  const sebi = item.sebi_category?.trim() || null;
  const amc = item.amc?.trim() || null;
  if (sebi === null && amc === null) return [];
  return matches.map(({ schemeCode }) => ({
    scheme_code: schemeCode,
    scheme_category: sebi,
    amc_name: amc,
  }));
}

/**
 * Walk OpenFolio's bulk /v1/composition endpoint, match each scheme to our
 * universe, and upsert an `official` row per match. Per-record failures
 * (malformed payloads, upsert errors) are caught and counted — one bad
 * record never aborts the sweep.
 */
export async function runOpenFolioSync(deps: OpenFolioSyncDeps): Promise<OpenFolioSyncStats> {
  const pageSize = deps.pageSize ?? 100;
  const top = deps.top ?? 50;
  const maxPages = deps.maxPages ?? 100;
  const log = deps.log ?? (() => {});

  // "Today" for the disclosure-date plausibility guard, taken from the
  // caller-supplied syncedAt so the core stays deterministic for tests.
  const today = deps.syncedAt.slice(0, 10);

  const stats: OpenFolioSyncStats = {
    pagesFetched: 0,
    itemsFetched: 0,
    totalCount: 0,
    matchedByCode: 0,
    matchedByIsin: 0,
    unmatched: 0,
    skippedBadDate: 0,
    upserted: 0,
    failed: 0,
    truncated: false,
    errors: [],
  };

  // Flush a page's mapped rows in one array-upsert. On a batch error, isolate
  // per-row so a single bad row never loses the whole page (preserves the
  // "one bad record never aborts the sweep" guarantee).
  async function flushRows(rows: CompositionRow[]): Promise<void> {
    if (rows.length === 0) return;
    let res: UpsertResult;
    try {
      res = await deps.upsertRows(rows);
    } catch (err) {
      res = { error: err instanceof Error ? err.message : String(err) };
    }
    if (!res?.error) {
      stats.upserted += rows.length;
      return;
    }
    for (const row of rows) {
      try {
        const r = await deps.upsertRows([row]);
        if (r?.error) {
          stats.failed += 1;
          stats.errors.push(`${row.scheme_code}: ${r.error}`);
        } else {
          stats.upserted += 1;
        }
      } catch (err) {
        stats.failed += 1;
        stats.errors.push(
          `${row.scheme_code}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  for (let page = 1; page <= maxPages; page++) {
    const result = await deps.client.listComposition({
      page,
      pageSize,
      updatedSince: deps.updatedSince ?? null,
      amc: deps.amc ?? null,
      top,
    });
    const items = Array.isArray(result?.items) ? result.items : [];
    stats.pagesFetched += 1;
    stats.itemsFetched += items.length;
    stats.totalCount = typeof result?.count === 'number' ? result.count : stats.totalCount;
    log(
      `[openfolio-sync] page ${page} fetched ${items.length} items ` +
        `(count=${stats.totalCount}, pageSize=${pageSize})`,
    );

    const pageRows: CompositionRow[] = [];
    const pageRegistryRows: SchemeRegistryRow[] = [];
    for (const item of items) {
      if (!item) {
        stats.unmatched += 1;
        continue;
      }
      const matches = resolveSchemeCodes(item, deps.universe);
      if (matches.length === 0) {
        stats.unmatched += 1;
        log(
          `[openfolio-sync] skip family=${item.family_id ?? 'none'} ` +
            `(${(item.plans ?? []).length} plans, none in our universe)`,
        );
        continue;
      }

      // Date guard is item-level — one disclosure_date per family — so a bad
      // date skips the whole family, not each plan.
      if (!isPlausibleDisclosureDate(item.disclosure_date, today)) {
        stats.skippedBadDate += 1;
        log(
          `[openfolio-sync] skip family=${item.family_id ?? 'none'} ` +
            `implausible disclosure_date=${item.disclosure_date ?? 'none'}`,
        );
        continue;
      }

      for (const match of matches) {
        if (match.matchedBy === 'plan_code') stats.matchedByCode += 1;
        else stats.matchedByIsin += 1;
        try {
          pageRows.push(mapCompositionToRow(item, match.schemeCode, deps.syncedAt));
        } catch (err) {
          stats.failed += 1;
          stats.errors.push(
            `${match.schemeCode}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Registry write-back: extract sebi_category + amc_name from this item
      // for all matched codes (date-guard passed = the item is usable).
      if (deps.upsertSchemeRegistry) {
        for (const regRow of mapCompositionToRegistryRows(item, matches)) {
          pageRegistryRows.push(regRow);
        }
      }
    }

    await flushRows(pageRows);

    // Write registry rows (best-effort: a failure here doesn't abort the sync).
    if (deps.upsertSchemeRegistry && pageRegistryRows.length > 0) {
      try {
        const regResult = await deps.upsertSchemeRegistry(pageRegistryRows);
        if (regResult?.error) {
          log(`[openfolio-sync] registry write-back error: ${regResult.error}`);
        }
      } catch (err) {
        log(
          `[openfolio-sync] registry write-back threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Stop when the last page is short or we've covered the reported count.
    if (items.length < pageSize) break;
    if (stats.totalCount > 0 && page * pageSize >= stats.totalCount) break;
  }

  // No silent caps: if we stopped (hit maxPages) before covering the reported
  // total, say so loudly so coverage gaps aren't mistaken for "synced
  // everything".
  if (stats.totalCount > 0 && stats.itemsFetched < stats.totalCount) {
    stats.truncated = true;
    log(
      `[openfolio-sync] WARN truncated — fetched ${stats.itemsFetched} of ${stats.totalCount} ` +
        `schemes after ${stats.pagesFetched} pages (maxPages=${maxPages}); raise maxPages/pageSize`,
    );
  }

  log(
    `[openfolio-sync] done — pages=${stats.pagesFetched} fetched=${stats.itemsFetched} ` +
      `matched_code=${stats.matchedByCode} matched_isin=${stats.matchedByIsin} ` +
      `unmatched=${stats.unmatched} skipped_bad_date=${stats.skippedBadDate} ` +
      `upserted=${stats.upserted} failed=${stats.failed} truncated=${stats.truncated}`,
  );

  return stats;
}
