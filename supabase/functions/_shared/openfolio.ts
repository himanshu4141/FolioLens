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

export interface OpenFolioComposition {
  scheme_code: number;
  isin?: string | null;
  amc: string;
  scheme_name: string;
  sebi_category?: string | null;
  /** hardcoded | amfi_navall (real AMFI code) | synthetic (placeholder) */
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
  matchedBy: 'scheme_code' | 'isin';
}

/**
 * Resolve an OpenFolio composition to a scheme_code we track.
 *
 * Primary: the AMFI scheme_code, unless OpenFolio flagged it `synthetic`
 * (a placeholder, not a real AMFI code — those never match our universe and
 * skip straight to the ISIN path). Secondary: the scheme's ISIN against
 * scheme_master.isin. Returns null when neither resolves — the caller logs
 * and skips, leaving the scheme on its mfdata/category fallback.
 */
export function resolveSchemeCode(
  item: OpenFolioComposition,
  universe: SchemeUniverse,
): SchemeMatch | null {
  if (
    item.code_source !== 'synthetic' &&
    typeof item.scheme_code === 'number' &&
    universe.knownCodes.has(item.scheme_code)
  ) {
    return { schemeCode: item.scheme_code, matchedBy: 'scheme_code' };
  }

  const isin = (item.isin ?? '').trim().toUpperCase();
  if (isin) {
    const code = universe.isinToCode.get(isin);
    if (code != null) return { schemeCode: code, matchedBy: 'isin' };
  }

  return null;
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
export function isPlausibleDisclosureDate(
  date: string | null | undefined,
  today: string,
): boolean {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date >= '2000-01-01' && date <= today;
}

// ---------------------------------------------------------------------------
// HTTP client (thin wrapper — the one place that holds base URL + API key)
// ---------------------------------------------------------------------------

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
  const baseUrl = (env.get('OPENFOLIO_API_BASE') ?? env.get('OPENFOLIO_API_BASE_URL') ?? '')
    .trim()
    .replace(/\/+$/, '');
  const apiKey = (env.get('OPENFOLIO_API_KEY') ?? '').trim();
  if (!baseUrl || !apiKey) {
    throw new Error(
      'OpenFolio not configured: set OPENFOLIO_API_BASE (or OPENFOLIO_API_BASE_URL) and OPENFOLIO_API_KEY',
    );
  }
  return { baseUrl, apiKey };
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

export interface OpenFolioClient {
  getComposition(schemeCode: number, args?: GetCompositionArgs): Promise<OpenFolioComposition | null>;
  listComposition(args?: ListCompositionArgs): Promise<OpenFolioCompositionPage>;
}

export interface OpenFolioClientConfig extends OpenFolioCredentials {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function buildQuery(params: Record<string, string | number | null | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') usp.set(k, String(v));
  }
  const q = usp.toString();
  return q ? `?${q}` : '';
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
      const path = `/v1/schemes/${schemeCode}/composition${buildQuery({ date: args.date, top: args.top })}`;
      const { body } = await request(path);
      return body as OpenFolioComposition | null;
    },
    async listComposition(args = {}) {
      const path = `/v1/composition${buildQuery({
        page: args.page,
        page_size: args.pageSize,
        updated_since: args.updatedSince,
        amc: args.amc,
        top: args.top,
      })}`;
      const { body } = await request(path);
      return body as OpenFolioCompositionPage;
    },
  };
}

// ---------------------------------------------------------------------------
// Dependency-injected bulk-sync core (testable without network / Supabase)
// ---------------------------------------------------------------------------

export interface UpsertResult {
  error?: string | null;
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
        stats.errors.push(`${row.scheme_code}: ${err instanceof Error ? err.message : String(err)}`);
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
    for (const item of items) {
      if (!item) {
        stats.unmatched += 1;
        continue;
      }
      const match = resolveSchemeCode(item, deps.universe);
      if (!match) {
        stats.unmatched += 1;
        log(
          `[openfolio-sync] skip unmatched scheme_code=${item.scheme_code} ` +
            `isin=${item.isin ?? 'none'} code_source=${item.code_source ?? 'n/a'}`,
        );
        continue;
      }
      if (match.matchedBy === 'scheme_code') stats.matchedByCode += 1;
      else stats.matchedByIsin += 1;

      if (!isPlausibleDisclosureDate(item.disclosure_date, today)) {
        stats.skippedBadDate += 1;
        log(
          `[openfolio-sync] skip scheme_code=${match.schemeCode} ` +
            `implausible disclosure_date=${item.disclosure_date ?? 'none'}`,
        );
        continue;
      }

      try {
        pageRows.push(mapCompositionToRow(item, match.schemeCode, deps.syncedAt));
      } catch (err) {
        stats.failed += 1;
        stats.errors.push(`${match.schemeCode}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await flushRows(pageRows);

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
