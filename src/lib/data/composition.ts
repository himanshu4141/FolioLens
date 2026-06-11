/**
 * App-side data wrapper for the OpenFolio-Data holdings API.
 *
 * This is the exit-runbook swap point and the SOLE app-side owner of the
 * OpenFolio base URL + `X-API-Key` (see `docs/EXIT-RUNBOOK.md` and
 * `src/lib/data/README.md`). All consumer tests mock `@/src/lib/data/composition`
 * at this boundary — never the network.
 *
 * NOTE: in the current backend (Milestones 1–4) the OpenFolio API is called
 * exclusively server-side from the `openfolio-sync` / `fetch-fund-snapshot`
 * edge functions (the app reads its own Postgres at request time — no runtime
 * dependency on the external API). Because Supabase Edge runs Deno and cannot
 * import from `src/`, the runtime client + mapping live in the Deno twin
 * `supabase/functions/_shared/openfolio.ts`. This module mirrors that contract
 * for the app boundary and any future client-side use (e.g. an admin tool);
 * the two intentionally share the same env-var names and response shapes.
 *
 * Contract: docs/openapi.yaml in the OpenFolio-Data repo.
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

function resolveCredentials(): OpenFolioCredentials {
  return resolveOpenFolioCredentials({ get: (key) => process.env[key] });
}

async function request<T>(path: string): Promise<{ status: number; body: T | null }> {
  const { baseUrl, apiKey } = resolveCredentials();
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
  });
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) throw new Error(`OpenFolio HTTP ${res.status} for ${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

/** Single scheme composition. Returns null on 404 (no snapshot). */
export async function getComposition(
  schemeCode: number,
  args: GetCompositionArgs = {},
): Promise<OpenFolioComposition | null> {
  const { body } = await request<OpenFolioComposition>(openFolioCompositionPath(schemeCode, args));
  return body;
}

/** Paginated bulk compositions for the monthly sync. */
export async function listComposition(
  args: ListCompositionArgs = {},
): Promise<OpenFolioCompositionPage> {
  const { body } = await request<OpenFolioCompositionPage>(openFolioCompositionListPath(args));
  return body as OpenFolioCompositionPage;
}

/** Full or date-bounded NAV series for one AMFI plan. Null on 404. */
export async function getNavSeries(
  schemeCode: number,
  args: GetNavSeriesArgs = {},
): Promise<NavSeries | null> {
  const { body } = await request<NavSeries>(openFolioNavSeriesPath(schemeCode, args));
  return body;
}

/** Most-recent NAV entry for one AMFI plan. Null on 404. */
export async function getNavLatest(schemeCode: number): Promise<NavLatestEntry | null> {
  const { body } = await request<NavLatestEntry>(openFolioNavLatestPath(schemeCode));
  return body;
}

/** Bulk paginated NAV — one latest entry per scheme, filtered by date/since. */
export async function listNav(args: ListNavArgs = {}): Promise<NavBulkPage> {
  const { body } = await request<NavBulkPage>(openFolioNavListPath(args));
  return body as NavBulkPage;
}

/** Full metadata (metrics + B1 fields) for one AMFI plan. Null on 404. */
export async function getMetadata(schemeCode: number): Promise<FundMetadata | null> {
  const { body } = await request<FundMetadata>(openFolioMetadataPath(schemeCode));
  return body;
}

/** Bulk paginated metadata — all schemes, optionally filtered by updated_since. */
export async function listMetadata(args: ListMetadataArgs = {}): Promise<MetadataPage> {
  const { body } = await request<MetadataPage>(openFolioMetadataListPath(args));
  return body as MetadataPage;
}

/**
 * Paginated scheme registry — family-keyed list with sebi_category, amc,
 * and plan codes/ISINs but no portfolio payload.
 */
export async function listSchemes(args: ListSchemesArgs = {}): Promise<SchemeListPage> {
  const { body } = await request<SchemeListPage>(openFolioSchemesPath(args));
  return body as SchemeListPage;
}

export const compositionApi = {
  getComposition,
  listComposition,
  getNavSeries,
  getNavLatest,
  listNav,
  getMetadata,
  listMetadata,
  listSchemes,
};
