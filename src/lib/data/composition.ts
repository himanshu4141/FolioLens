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

export interface OpenFolioComposition {
  scheme_code: number;
  isin?: string | null;
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

export const compositionApi = { getComposition, listComposition };
