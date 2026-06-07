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
// NAV API response types (mirror of _shared/openfolio.ts — OpenFolio v2.0.0)
// ---------------------------------------------------------------------------

/** Single data point in a NAV time-series. */
export interface NavSeriesPoint {
  /** ISO date YYYY-MM-DD. */
  date: string;
  nav: number;
}

/**
 * Response from GET /v1/nav/{scheme_code}. `scheme_code` is the integer AMFI
 * plan code — direct join to scheme_master.scheme_code.
 */
export interface NavSeries {
  scheme_code: number;
  from_date?: string | null;
  to_date?: string | null;
  points: NavSeriesPoint[];
}

/** Response from GET /v1/nav/{scheme_code}/latest. */
export interface NavLatestEntry {
  scheme_code: number;
  /** ISO date YYYY-MM-DD. */
  date: string;
  nav: number;
}

/** One item in GET /v1/nav bulk page. `date` maps to nav_history.nav_date. */
export interface NavBulkItem {
  scheme_code: number;
  /** ISO date YYYY-MM-DD → nav_history.nav_date. */
  date: string;
  nav: number;
}

/** Response from GET /v1/nav?since=|date= */
export interface NavBulkPage {
  count: number;
  page: number;
  page_size: number;
  items: NavBulkItem[];
}

export interface GetNavSeriesArgs {
  since?: string | null;
  until?: string | null;
}

export interface ListNavArgs {
  since?: string | null;
  date?: string | null;
  page?: number;
  pageSize?: number;
}

// ---------------------------------------------------------------------------
// Credentials (single source of truth, app side)
// ---------------------------------------------------------------------------

function resolveCredentials(): { baseUrl: string; apiKey: string } {
  const baseUrl = (
    process.env.OPENFOLIO_API_BASE ??
    process.env.OPENFOLIO_API_BASE_URL ??
    ''
  )
    .trim()
    .replace(/\/+$/, '');
  const apiKey = (process.env.OPENFOLIO_API_KEY ?? '').trim();
  if (!baseUrl || !apiKey) {
    throw new Error(
      'OpenFolio not configured: set OPENFOLIO_API_BASE (or OPENFOLIO_API_BASE_URL) and OPENFOLIO_API_KEY',
    );
  }
  return { baseUrl, apiKey };
}

function buildQuery(params: Record<string, string | number | null | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') usp.set(k, String(v));
  }
  const q = usp.toString();
  return q ? `?${q}` : '';
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
  const { body } = await request<OpenFolioComposition>(
    `/v1/schemes/${schemeCode}/composition${buildQuery({ date: args.date, top: args.top })}`,
  );
  return body;
}

/** Paginated bulk compositions for the monthly sync. */
export async function listComposition(
  args: ListCompositionArgs = {},
): Promise<OpenFolioCompositionPage> {
  const { body } = await request<OpenFolioCompositionPage>(
    `/v1/composition${buildQuery({
      page: args.page,
      page_size: args.pageSize,
      updated_since: args.updatedSince,
      amc: args.amc,
      top: args.top,
    })}`,
  );
  return body as OpenFolioCompositionPage;
}

/** Full or date-bounded NAV series for one AMFI plan. Null on 404. */
export async function getNavSeries(
  schemeCode: number,
  args: GetNavSeriesArgs = {},
): Promise<NavSeries | null> {
  const { body } = await request<NavSeries>(
    `/v1/nav/${schemeCode}${buildQuery({ since: args.since, until: args.until })}`,
  );
  return body;
}

/** Most-recent NAV entry for one AMFI plan. Null on 404. */
export async function getNavLatest(schemeCode: number): Promise<NavLatestEntry | null> {
  const { body } = await request<NavLatestEntry>(`/v1/nav/${schemeCode}/latest`);
  return body;
}

/** Bulk paginated NAV — one latest entry per scheme, filtered by date/since. */
export async function listNav(args: ListNavArgs = {}): Promise<NavBulkPage> {
  const { body } = await request<NavBulkPage>(
    `/v1/nav${buildQuery({ since: args.since, date: args.date, page: args.page, page_size: args.pageSize })}`,
  );
  return body as NavBulkPage;
}

export const compositionApi = { getComposition, listComposition, getNavSeries, getNavLatest, listNav };
