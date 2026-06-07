import {
  COMPOSITION_SOURCE_RANK,
  compositionSourceRank,
  isPlausibleDisclosureDate,
  mapCompositionToRow,
  mapCompositionToRegistryRows,
  resolveSchemeCodes,
  resolveOpenFolioCredentials,
  createOpenFolioClient,
  runOpenFolioSync,
  type CompositionRow,
  type NavBulkPage,
  type NavLatestEntry,
  type NavSeries,
  type OpenFolioComposition,
  type OpenFolioCompositionPage,
  type SchemeFamily,
  type SchemeListPage,
  type SchemeMatch,
  type SchemeRegistryRow,
  type SchemeUniverse,
} from '../openfolio';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function comp(overrides: Partial<OpenFolioComposition> = {}): OpenFolioComposition {
  return {
    family_id: 'OF-ed707265ce8a',
    plans: [{ plan_code: 122639, plan_name: 'Direct Growth', isins: ['INF879O01027'] }],
    amc: 'PPFAS Mutual Fund',
    scheme_name: 'Parag Parikh Flexi Cap Fund',
    sebi_category: 'Flexi Cap Fund',
    code_source: 'hardcoded',
    disclosure_date: '2026-04-30',
    provenance: {
      disclosure_date: '2026-04-30',
      source_url: 'https://amc.ppfas.com/ppfas_2026_04.xls',
      source_type: 'amc_xls',
      fetched_at: '2026-05-31T00:00:00Z',
    },
    asset_mix: {
      equity_pct: 80.41,
      arbitrage_pct: 0.4,
      debt_pct: 10.42,
      cash_pct: 4.23,
      other_pct: 4.54,
      derivatives_pct: -0.4,
    },
    cap_mix: { large_pct: 52.31, mid_pct: 9.4, small_pct: 5.12, unclassified_pct: 13.73 },
    sectors: [
      { sector: 'Banks', weight_pct: 19.89 },
      { sector: 'IT', weight_pct: 9.254 },
    ],
    top_holdings: [
      { instrument_name: 'HDFC Bank Limited', isin: 'INE040A01034', weight_pct: 7.945, sector: 'Banks', cap_bucket: 'large' },
      { instrument_name: 'Mid Co', isin: 'INEMID', weight_pct: 3.0, sector: 'X', cap_bucket: 'mid' },
      { instrument_name: 'Small Co', isin: 'INESML', weight_pct: 2.0, sector: 'Y', cap_bucket: 'small' },
      { instrument_name: 'Foreign Co', isin: null, weight_pct: 1.0, sector: null, cap_bucket: 'unclassified' },
    ],
    debt_holdings: [
      { instrument_name: 'Bank CD', isin: 'INE028A16GR2', credit_rating: 'IND A1+', weight_pct: 0.654, maturity_date: '2026-05-15', ytm: 7.5612345 },
      { instrument_name: 'No YTM CD', isin: null, credit_rating: null, weight_pct: 0.1, maturity_date: null },
    ],
    ...overrides,
  };
}

const SYNCED_AT = '2026-05-31T12:00:00.000Z';

// Build a composition whose family carries the given plans (plan_code + ISINs).
function withPlans(
  plans: { plan_code: number; isins?: string[] }[],
  overrides: Partial<OpenFolioComposition> = {},
): OpenFolioComposition {
  return comp({
    family_id: `OF-fam${plans[0]?.plan_code ?? 0}`,
    plans: plans.map((p) => ({ plan_code: p.plan_code, plan_name: 'Plan', isins: p.isins ?? [] })),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Source precedence
// ---------------------------------------------------------------------------

describe('compositionSourceRank', () => {
  it('ranks official > amfi > category_fallback > category_rules', () => {
    expect(COMPOSITION_SOURCE_RANK.official).toBeGreaterThan(COMPOSITION_SOURCE_RANK.amfi);
    expect(compositionSourceRank('official')).toBe(3);
    expect(compositionSourceRank('amfi')).toBe(2);
    expect(compositionSourceRank('category_fallback')).toBe(1);
    expect(compositionSourceRank('category_rules')).toBe(0);
  });

  it('ranks unknown and null sources below all known sources', () => {
    expect(compositionSourceRank('mfdata')).toBe(-1);
    expect(compositionSourceRank(null)).toBe(-1);
    expect(compositionSourceRank(undefined)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

describe('mapCompositionToRow', () => {
  it('maps a full composition with arbitrage folded into equity and decimals rounded', () => {
    const row = mapCompositionToRow(comp(), 122639, SYNCED_AT);

    // arbitrage_pct (0.4) folds into equity → 80.81; derivatives memo dropped.
    expect(row.equity_pct).toBe(80.81);
    expect(row.debt_pct).toBe(10.42);
    expect(row.cash_pct).toBe(4.23);
    expect(row.other_pct).toBe(4.54);
    // equity + debt + cash + other ≈ 100
    expect(row.equity_pct + row.debt_pct + row.cash_pct + row.other_pct).toBeCloseTo(100, 1);

    // cap mix maps 1:1 (already % of NAV)
    expect(row.large_cap_pct).toBe(52.31);
    expect(row.mid_cap_pct).toBe(9.4);
    expect(row.small_cap_pct).toBe(5.12);
    expect(row.not_classified_pct).toBe(13.73);

    // sectors → sorted-desc record, rounded
    expect(row.sector_allocation).toEqual({ Banks: 19.89, IT: 9.25 });
    expect(Object.keys(row.sector_allocation!)).toEqual(['Banks', 'IT']);

    // top holdings → cap_bucket mapped, weight rounded
    expect(row.top_holdings).toEqual([
      { name: 'HDFC Bank Limited', isin: 'INE040A01034', sector: 'Banks', marketCap: 'Large Cap', pctOfNav: 7.95 },
      { name: 'Mid Co', isin: 'INEMID', sector: 'X', marketCap: 'Mid Cap', pctOfNav: 3.0 },
      { name: 'Small Co', isin: 'INESML', sector: 'Y', marketCap: 'Small Cap', pctOfNav: 2.0 },
      { name: 'Foreign Co', isin: '', sector: 'Other', marketCap: 'Other', pctOfNav: 1.0 },
    ]);

    // debt holdings → normalized; ytm rounded to 4dp; null ytm preserved
    expect(row.raw_debt_holdings).toEqual([
      { name: 'Bank CD', isin: 'INE028A16GR2', credit_rating: 'IND A1+', maturity_date: '2026-05-15', weight_pct: 0.65, ytm: 7.5612 },
      { name: 'No YTM CD', isin: null, credit_rating: null, maturity_date: null, weight_pct: 0.1, ytm: null },
    ]);

    // provenance
    expect(row.source).toBe('official');
    expect(row.portfolio_date).toBe('2026-04-30');
    expect(row.disclosure_date).toBe('2026-04-30');
    expect(row.source_url).toBe('https://amc.ppfas.com/ppfas_2026_04.xls');
    expect(row.synced_at).toBe(SYNCED_AT);
    expect(row.scheme_code).toBe(122639);
  });

  it('preserves null cap buckets (never zero-fills) and zero-fills missing asset mix', () => {
    const row = mapCompositionToRow(
      comp({ asset_mix: undefined, cap_mix: { large_pct: null, mid_pct: undefined, small_pct: null, unclassified_pct: 80.81 } }),
      1,
      SYNCED_AT,
    );
    expect(row.equity_pct).toBe(0);
    expect(row.debt_pct).toBe(0);
    expect(row.large_cap_pct).toBeNull();
    expect(row.mid_cap_pct).toBeNull();
    expect(row.small_cap_pct).toBeNull();
    expect(row.not_classified_pct).toBe(80.81);
  });

  it('returns null for empty / missing sectors, holdings and debt arrays', () => {
    const row = mapCompositionToRow(
      comp({ sectors: [], top_holdings: undefined, debt_holdings: [], cap_mix: undefined }),
      1,
      SYNCED_AT,
    );
    expect(row.sector_allocation).toBeNull();
    expect(row.top_holdings).toBeNull();
    expect(row.raw_debt_holdings).toBeNull();
    expect(row.large_cap_pct).toBeNull();
    expect(row.not_classified_pct).toBeNull();
  });

  it('maps an unknown cap_bucket to Other and sorts sectors by weight desc', () => {
    const row = mapCompositionToRow(
      comp({
        sectors: [
          { sector: 'Small', weight_pct: 1.1 },
          { sector: 'Big', weight_pct: 40.2 },
          { sector: 'Mid', weight_pct: 12.5 },
        ],
        top_holdings: [{ instrument_name: 'X', weight_pct: 5, cap_bucket: 'mega' }],
      }),
      1,
      SYNCED_AT,
    );
    expect(Object.keys(row.sector_allocation!)).toEqual(['Big', 'Mid', 'Small']);
    expect(row.top_holdings![0]).toMatchObject({ name: 'X', isin: '', sector: 'Other', marketCap: 'Other' });
  });

  it('filters malformed sector / holding rows without throwing', () => {
    const row = mapCompositionToRow(
      comp({
        sectors: [{ sector: 'Banks', weight_pct: 'x' as unknown as number }, { sector: 'IT', weight_pct: 5 }],
        top_holdings: [
          { instrument_name: 'Good', weight_pct: 3, cap_bucket: 'large' },
          { instrument_name: 'BadWeight', weight_pct: 'nope' as unknown as number },
          { instrument_name: undefined as unknown as string, weight_pct: 2 },
        ],
        debt_holdings: [
          { instrument_name: 'GoodDebt', weight_pct: 1 },
          { instrument_name: 'BadDebt', weight_pct: null as unknown as number },
        ],
      }),
      1,
      SYNCED_AT,
    );
    expect(row.sector_allocation).toEqual({ IT: 5 });
    expect(row.top_holdings).toHaveLength(1);
    expect(row.top_holdings![0].name).toBe('Good');
    expect(row.raw_debt_holdings).toHaveLength(1);
    expect(row.raw_debt_holdings![0].name).toBe('GoodDebt');
  });

  it('falls back to the top-level disclosure_date and null source_url when provenance is absent', () => {
    const row = mapCompositionToRow(comp({ provenance: undefined, disclosure_date: '2026-03-31' }), 1, SYNCED_AT);
    expect(row.disclosure_date).toBe('2026-03-31');
    expect(row.portfolio_date).toBe('2026-03-31');
    expect(row.source_url).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scheme matching
// ---------------------------------------------------------------------------

describe('resolveSchemeCodes', () => {
  const universe: SchemeUniverse = {
    knownCodes: new Set([122639, 122640, 100100]),
    isinToCode: new Map([['INF879O01027', 122639], ['INESECONDARY01', 555555]]),
  };

  it('matches a held plan_code directly', () => {
    expect(resolveSchemeCodes(withPlans([{ plan_code: 122639 }]), universe)).toEqual([
      { schemeCode: 122639, matchedBy: 'plan_code' },
    ]);
  });

  it('returns one match per held plan in a multi-plan family (Regular + Direct)', () => {
    const item = withPlans([
      { plan_code: 122639 }, // held
      { plan_code: 122640 }, // held (other plan, same family)
      { plan_code: 999999 }, // not held
    ]);
    expect(resolveSchemeCodes(item, universe).map((m) => m.schemeCode).sort()).toEqual([122639, 122640]);
  });

  it('matches by any plan ISIN when the plan_code is not held (skipping blank ISINs)', () => {
    // '' is a blank NAVAll cell — skipped; the real ISIN still resolves.
    const item = withPlans([{ plan_code: 4242, isins: ['', 'inesecondary01'] }]); // code unknown, ISIN known
    expect(resolveSchemeCodes(item, universe)).toEqual([{ schemeCode: 555555, matchedBy: 'isin' }]);
  });

  it('prefers a plan_code match over an ISIN match for the same scheme (no dupes)', () => {
    const item = withPlans([{ plan_code: 122639, isins: ['INF879O01027'] }]); // both resolve to 122639
    expect(resolveSchemeCodes(item, universe)).toEqual([{ schemeCode: 122639, matchedBy: 'plan_code' }]);
  });

  it('resolves a plan with no ISIN by its code only', () => {
    expect(resolveSchemeCodes(withPlans([{ plan_code: 100100, isins: [] }]), universe)).toEqual([
      { schemeCode: 100100, matchedBy: 'plan_code' },
    ]);
  });

  it('returns [] when the family touches none of our schemes', () => {
    expect(resolveSchemeCodes(withPlans([{ plan_code: 4242, isins: ['INEUNKNOWN'] }]), universe)).toEqual([]);
    expect(resolveSchemeCodes(comp({ plans: [] }), universe)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Disclosure-date plausibility guard
// ---------------------------------------------------------------------------

describe('isPlausibleDisclosureDate', () => {
  const TODAY = '2026-06-01';

  it('accepts a valid past month-end YYYY-MM-DD in [2000-01-01, today]', () => {
    expect(isPlausibleDisclosureDate('2026-04-30', TODAY)).toBe(true);
    expect(isPlausibleDisclosureDate('2000-01-01', TODAY)).toBe(true);
    expect(isPlausibleDisclosureDate(TODAY, TODAY)).toBe(true); // boundary: today is allowed
  });

  it('rejects any future date (a disclosure is always a past month-end)', () => {
    expect(isPlausibleDisclosureDate('2027-05-28', TODAY)).toBe(false); // ~1yr-future build artifact
    expect(isPlausibleDisclosureDate('2055-08-18', TODAY)).toBe(false); // wild artifact
    expect(isPlausibleDisclosureDate('2026-06-02', TODAY)).toBe(false); // one day future
  });

  it('rejects too-old / malformed / missing dates', () => {
    expect(isPlausibleDisclosureDate('1999-12-31', TODAY)).toBe(false);
    expect(isPlausibleDisclosureDate('30-04-2026', TODAY)).toBe(false);
    expect(isPlausibleDisclosureDate('', TODAY)).toBe(false);
    expect(isPlausibleDisclosureDate(null, TODAY)).toBe(false);
    expect(isPlausibleDisclosureDate(undefined, TODAY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function envFrom(map: Record<string, string | undefined>) {
  return { get: (k: string) => map[k] };
}

describe('resolveOpenFolioCredentials', () => {
  it('reads OPENFOLIO_API_BASE + OPENFOLIO_API_KEY and strips a trailing slash', () => {
    const creds = resolveOpenFolioCredentials(
      envFrom({ OPENFOLIO_API_BASE: 'https://api.example.com/', OPENFOLIO_API_KEY: 'secret' }),
    );
    expect(creds).toEqual({ baseUrl: 'https://api.example.com', apiKey: 'secret' });
  });

  it('falls back to OPENFOLIO_API_BASE_URL', () => {
    const creds = resolveOpenFolioCredentials(
      envFrom({ OPENFOLIO_API_BASE_URL: 'https://run.app', OPENFOLIO_API_KEY: 'k' }),
    );
    expect(creds.baseUrl).toBe('https://run.app');
  });

  it('throws when the base URL is missing', () => {
    expect(() => resolveOpenFolioCredentials(envFrom({ OPENFOLIO_API_KEY: 'k' }))).toThrow(/not configured/);
  });

  it('throws when the API key is missing', () => {
    expect(() => resolveOpenFolioCredentials(envFrom({ OPENFOLIO_API_BASE: 'https://x' }))).toThrow(/not configured/);
  });
});

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

function fakeResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

describe('createOpenFolioClient', () => {
  it('getComposition sends X-API-Key, builds the path with date+top, and returns the body', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(200, comp())) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'KEY123', fetchImpl });

    const result = await client.getComposition(122639, { date: '2026-04-30', top: 10 });
    expect(result?.family_id).toBe('OF-ed707265ce8a');

    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.x/v1/schemes/122639/composition?date=2026-04-30&top=10');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('KEY123');
  });

  it('getComposition returns null on 404', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(404, { detail: 'none' })) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    expect(await client.getComposition(1)).toBeNull();
  });

  it('throws on a non-OK, non-404 response', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(500, {})) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    await expect(client.getComposition(1)).rejects.toThrow(/HTTP 500/);
  });

  it('listComposition builds the bulk query with page/page_size/updated_since/amc/top', async () => {
    const page: OpenFolioCompositionPage = { count: 1, page: 2, page_size: 5, items: [comp()] };
    const fetchImpl = jest.fn(async () => fakeResponse(200, page)) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });

    const result = await client.listComposition({ page: 2, pageSize: 5, updatedSince: '2026-04-01', amc: 'PPFAS', top: 50 });
    expect(result.items).toHaveLength(1);
    const [url] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.x/v1/composition?page=2&page_size=5&updated_since=2026-04-01&amc=PPFAS&top=50');
  });

  it('listComposition with no args omits the query string', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(200, { count: 0, page: 1, page_size: 100, items: [] })) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    await client.listComposition();
    const [url] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.x/v1/composition');
  });

  it('aborts and rejects when the request exceeds the timeout', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl, timeoutMs: 5 });
    await expect(client.getComposition(1)).rejects.toThrow(/aborted/);
  });
});

// ---------------------------------------------------------------------------
// DI sync core
// ---------------------------------------------------------------------------

function pageOf(items: OpenFolioComposition[], count?: number, pageSize = 100): OpenFolioCompositionPage {
  return { count: count ?? items.length, page: 1, page_size: pageSize, items };
}

function clientServing(pages: OpenFolioCompositionPage[]) {
  let i = 0;
  return {
    listComposition: jest.fn(async () => pages[i++] ?? { count: 0, page: 0, page_size: 0, items: [] }),
  };
}

const UNI: SchemeUniverse = {
  knownCodes: new Set([100, 200, 300]),
  isinToCode: new Map([['INEISIN200', 200]]),
};

describe('runOpenFolioSync', () => {
  it('matches by code + ISIN, skips unmatched and null items, and upserts each match', async () => {
    const rows: CompositionRow[] = [];
    const client = clientServing([
      pageOf([
        withPlans([{ plan_code: 100 }]), // code match
        withPlans([{ plan_code: 9, isins: ['ineisin200'] }]), // ISIN match → 200
        withPlans([{ plan_code: 7, isins: ['INEUNKNOWN'] }]), // unmatched
        null as unknown as OpenFolioComposition, // defensive null
      ]),
    ]);

    const stats = await runOpenFolioSync({
      client,
      universe: UNI,
      syncedAt: SYNCED_AT,
      upsertRows: async (batch) => {
        rows.push(...batch);
        return { error: null };
      },
    });

    expect(stats.matchedByCode).toBe(1);
    expect(stats.matchedByIsin).toBe(1);
    expect(stats.unmatched).toBe(2);
    expect(stats.upserted).toBe(2);
    expect(stats.failed).toBe(0);
    expect(stats.pagesFetched).toBe(1);
    expect(rows.map((r) => r.scheme_code).sort()).toEqual([100, 200]);
    expect(rows.every((r) => r.source === 'official')).toBe(true);
  });

  it('is idempotent — re-running upserts the same rows on the conflict key', async () => {
    const seen = new Map<string, CompositionRow>();
    const upsertRows = async (batch: CompositionRow[]) => {
      for (const row of batch) seen.set(`${row.scheme_code}|${row.portfolio_date}|${row.source}`, row);
      return { error: null };
    };
    const pages = () => clientServing([pageOf([withPlans([{ plan_code: 100 }])])]);
    await runOpenFolioSync({ client: pages(), universe: UNI, syncedAt: SYNCED_AT, upsertRows });
    await runOpenFolioSync({ client: pages(), universe: UNI, syncedAt: SYNCED_AT, upsertRows });
    expect(seen.size).toBe(1); // same conflict key both runs
  });

  it('isolates a failed batch per-row (return-error + thrown errors) without aborting the sweep', async () => {
    const logs: string[] = [];
    const stats = await runOpenFolioSync({
      client: clientServing([
        pageOf([withPlans([{ plan_code: 100 }]), withPlans([{ plan_code: 200 }]), withPlans([{ plan_code: 300 }])]),
      ]),
      universe: UNI,
      syncedAt: SYNCED_AT,
      log: (m) => logs.push(m),
      // Batch (>1 row) fails → per-row fallback exercises return-error + both throw paths.
      upsertRows: async (batch) => {
        if (batch.length > 1) return { error: 'batch write failed' };
        const code = batch[0].scheme_code;
        if (code === 100) return { error: 'duplicate key' };
        if (code === 200) throw new Error('connection reset');
        throw 'string failure';
      },
    });
    expect(stats.upserted).toBe(0);
    expect(stats.failed).toBe(3);
    expect(stats.errors).toHaveLength(3);
    expect(stats.errors.some((e) => e.includes('duplicate key'))).toBe(true);
    expect(stats.errors.some((e) => e.includes('connection reset'))).toBe(true);
    expect(stats.errors.some((e) => e.includes('string failure'))).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('counts a per-record mapping failure without dropping the rest of the page', async () => {
    // A matched item that passes the date guard but throws while mapping
    // (e.g. a pathological payload) must be counted, not abort the page.
    const bad = {
      family_id: 'OF-bad',
      plans: [{ plan_code: 100, plan_name: 'P', isins: [] }],
      disclosure_date: '2026-04-30',
      get asset_mix(): never {
        throw new Error('map boom');
      },
    } as unknown as OpenFolioComposition;
    const written: number[] = [];
    const stats = await runOpenFolioSync({
      client: clientServing([pageOf([bad, withPlans([{ plan_code: 200 }])])]),
      universe: UNI,
      syncedAt: SYNCED_AT,
      upsertRows: async (batch) => {
        written.push(...batch.map((r) => r.scheme_code));
        return { error: null };
      },
    });
    expect(stats.failed).toBe(1);
    expect(stats.errors.some((e) => e.includes('map boom'))).toBe(true);
    expect(stats.upserted).toBe(1); // the good row still written
    expect(written).toEqual([200]);
  });

  it('recovers a thrown batch via per-row retry (per-row success path)', async () => {
    const written: number[] = [];
    const stats = await runOpenFolioSync({
      client: clientServing([
        pageOf([withPlans([{ plan_code: 100 }]), withPlans([{ plan_code: 200 }])]),
      ]),
      universe: UNI,
      syncedAt: SYNCED_AT,
      // The batch call throws; each single-row retry succeeds.
      upsertRows: async (batch) => {
        if (batch.length > 1) throw new Error('payload too large');
        written.push(batch[0].scheme_code);
        return { error: null };
      },
    });
    expect(stats.upserted).toBe(2);
    expect(stats.failed).toBe(0);
    expect(written.sort()).toEqual([100, 200]);
  });

  it('walks multiple pages until a short page ends the sweep', async () => {
    const rows: CompositionRow[] = [];
    const client = clientServing([
      pageOf([withPlans([{ plan_code: 100 }]), withPlans([{ plan_code: 200 }])], 3, 2),
      pageOf([withPlans([{ plan_code: 300 }])], 3, 2),
    ]);
    const stats = await runOpenFolioSync({
      client,
      universe: UNI,
      syncedAt: SYNCED_AT,
      pageSize: 2,
      updatedSince: '2026-04-01',
      amc: 'PPFAS',
      upsertRows: async (batch) => {
        rows.push(...batch);
        return { error: null };
      },
    });
    expect(stats.pagesFetched).toBe(2);
    expect(stats.upserted).toBe(3);
    expect(client.listComposition).toHaveBeenCalledTimes(2);
  });

  it('stops once page * pageSize covers the reported count', async () => {
    const client = clientServing([
      pageOf([withPlans([{ plan_code: 100 }]), withPlans([{ plan_code: 200 }])], 2, 2),
      pageOf([withPlans([{ plan_code: 300 }])], 2, 2), // should never be requested
    ]);
    const stats = await runOpenFolioSync({
      client,
      universe: UNI,
      syncedAt: SYNCED_AT,
      pageSize: 2,
      upsertRows: async () => ({ error: null }),
    });
    expect(stats.pagesFetched).toBe(1);
    expect(client.listComposition).toHaveBeenCalledTimes(1);
  });

  it('honours the maxPages runaway guard', async () => {
    const client = clientServing([
      pageOf([withPlans([{ plan_code: 100 }]), withPlans([{ plan_code: 200 }])], 999, 2),
      pageOf([withPlans([{ plan_code: 300 }])], 999, 2),
    ]);
    const stats = await runOpenFolioSync({
      client,
      universe: UNI,
      syncedAt: SYNCED_AT,
      pageSize: 2,
      maxPages: 1,
      upsertRows: async () => ({ error: null }),
    });
    expect(stats.pagesFetched).toBe(1);
  });

  it('skips matched schemes whose disclosure_date is implausible (no bogus future row)', async () => {
    const rows: CompositionRow[] = [];
    const stats = await runOpenFolioSync({
      client: clientServing([
        pageOf([
          withPlans([{ plan_code: 100 }], { disclosure_date: '2055-08-18' }), // upstream artifact → skip
          withPlans([{ plan_code: 200 }], { disclosure_date: '2026-04-30' }), // good
        ]),
      ]),
      universe: UNI,
      syncedAt: SYNCED_AT, // 2026 → referenceYear 2026
      upsertRows: async (batch) => {
        rows.push(...batch);
        return { error: null };
      },
    });
    expect(stats.skippedBadDate).toBe(1);
    expect(stats.upserted).toBe(1);
    expect(rows.map((r) => r.scheme_code)).toEqual([200]);
  });

  it('flags truncation (no silent cap) when maxPages stops short of the reported count', async () => {
    const logs: string[] = [];
    const stats = await runOpenFolioSync({
      client: clientServing([
        pageOf([withPlans([{ plan_code: 100 }]), withPlans([{ plan_code: 200 }])], 999, 2),
      ]),
      universe: UNI,
      syncedAt: SYNCED_AT,
      pageSize: 2,
      maxPages: 1,
      log: (m) => logs.push(m),
      upsertRows: async () => ({ error: null }),
    });
    expect(stats.truncated).toBe(true);
    expect(stats.itemsFetched).toBeLessThan(stats.totalCount);
    expect(logs.some((m) => m.includes('truncated'))).toBe(true);
  });

  it('does not flag truncation on a clean full sweep', async () => {
    const stats = await runOpenFolioSync({
      client: clientServing([pageOf([withPlans([{ plan_code: 100 }])], 1, 100)]),
      universe: UNI,
      syncedAt: SYNCED_AT,
      upsertRows: async () => ({ error: null }),
    });
    expect(stats.truncated).toBe(false);
  });

  it('tolerates a malformed page with no items array and a non-numeric count', async () => {
    const client = {
      listComposition: jest.fn(async () => ({}) as unknown as OpenFolioCompositionPage),
    };
    const stats = await runOpenFolioSync({
      client,
      universe: UNI,
      syncedAt: SYNCED_AT,
      upsertRows: async () => ({ error: null }),
    });
    expect(stats.itemsFetched).toBe(0);
    expect(stats.totalCount).toBe(0);
    expect(stats.pagesFetched).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// NAV client methods
// ---------------------------------------------------------------------------

describe('createOpenFolioClient — NAV methods', () => {
  function fakeNavLatest(): NavLatestEntry {
    return { scheme_code: 122639, date: '2026-06-05', nav: 89.1488 };
  }

  function fakeNavSeries(): NavSeries {
    return {
      scheme_code: 122639,
      from_date: '2026-06-01',
      to_date: '2026-06-05',
      points: [
        { date: '2026-06-01', nav: 89.6775 },
        { date: '2026-06-02', nav: 89.7887 },
        { date: '2026-06-05', nav: 89.1488 },
      ],
    };
  }

  function fakeNavBulkPage(): NavBulkPage {
    return {
      count: 8560,
      page: 1,
      page_size: 2,
      items: [
        { scheme_code: 100033, date: '2026-06-05', nav: 894.89 },
        { scheme_code: 122639, date: '2026-06-05', nav: 89.1488 },
      ],
    };
  }

  it('getNavLatest sends X-API-Key, calls /v1/nav/{code}/latest, and returns the body', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(200, fakeNavLatest())) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'KEY', fetchImpl });

    const result = await client.getNavLatest(122639);
    expect(result?.scheme_code).toBe(122639);
    expect(result?.nav).toBe(89.1488);
    expect(result?.date).toBe('2026-06-05');

    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.x/v1/nav/122639/latest');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('KEY');
  });

  it('getNavLatest returns null on 404', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(404, { detail: 'not found' })) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    expect(await client.getNavLatest(999999)).toBeNull();
  });

  it('getNavLatest throws on a non-OK, non-404 response', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(500, {})) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    await expect(client.getNavLatest(1)).rejects.toThrow(/HTTP 500/);
  });

  it('getNavSeries calls /v1/nav/{code} with since + until params and returns points', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(200, fakeNavSeries())) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });

    const result = await client.getNavSeries(122639, { since: '2026-06-01', until: '2026-06-05' });
    expect(result?.scheme_code).toBe(122639);
    expect(result?.points).toHaveLength(3);
    expect(result?.points[0]).toEqual({ date: '2026-06-01', nav: 89.6775 });

    const [url] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.x/v1/nav/122639?since=2026-06-01&until=2026-06-05');
  });

  it('getNavSeries with no args calls /v1/nav/{code} with no query string', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(200, fakeNavSeries())) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    await client.getNavSeries(122639);
    const [url] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.x/v1/nav/122639');
  });

  it('getNavSeries returns null on 404', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(404, {})) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    expect(await client.getNavSeries(999)).toBeNull();
  });

  it('getNavSeries throws on non-OK, non-404 response', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(503, {})) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    await expect(client.getNavSeries(1)).rejects.toThrow(/HTTP 503/);
  });

  it('listNav builds the bulk query with since + page + page_size', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(200, fakeNavBulkPage())) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });

    const result = await client.listNav({ since: '2026-06-05', page: 1, pageSize: 2 });
    expect(result.count).toBe(8560);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual({ scheme_code: 100033, date: '2026-06-05', nav: 894.89 });

    const [url] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.x/v1/nav?since=2026-06-05&page=1&page_size=2');
  });

  it('listNav with date param builds the correct query', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(200, { count: 0, page: 1, page_size: 100, items: [] })) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    await client.listNav({ date: '2026-06-05' });
    const [url] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.x/v1/nav?date=2026-06-05');
  });

  it('listNav with no args omits the query string', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(200, { count: 0, page: 1, page_size: 100, items: [] })) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    await client.listNav();
    const [url] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.x/v1/nav');
  });

  it('listNav throws on non-OK response', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(500, {})) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    await expect(client.listNav()).rejects.toThrow(/HTTP 500/);
  });
});

// ---------------------------------------------------------------------------
// getMetadata / listMetadata
// ---------------------------------------------------------------------------

describe('getMetadata / listMetadata', () => {
  function fakeMetadata(overrides: Record<string, unknown> = {}) {
    return {
      scheme_code: 119544,
      name: 'ABSL ELSS Direct Growth',
      amc: 'Aditya Birla Sun Life Mutual Fund',
      ter: 0.98,
      ter_date: '2026-05-31',
      fund_manager: 'Mr. Dhaval Shah',
      inception_date: '1996-03-29',
      exit_load: null,
      min_investment: 500,
      min_sip: null,
      benchmark: null,
      riskometer: null,
      portfolio_turnover: 0.25,
      metrics: {
        aum_cr: null,
        aum_date: null,
        returns: { ret_1y: 0.006, ret_3y: 0.135, ret_5y: 0.091, ret_incep: 0.136 },
        volatility: 0.148,
        computed_from_nav_date: '2026-06-05',
      },
      b1_field_meta: {
        ter: { status: 'value', source: 'amfi_ter', source_url: 'https://amfiindia.com/ter' },
        ter_date: { status: 'value', source: 'amfi_ter', source_url: 'https://amfiindia.com/ter' },
        benchmark: { status: 'officially_absent', source: 'factsheet', source_url: 'https://example.com' },
        exit_load: { status: 'officially_absent', source: 'factsheet', source_url: 'https://example.com' },
        fund_manager: { status: 'value', source: 'factsheet', source_url: 'https://example.com' },
        inception_date: { status: 'value', source: 'factsheet', source_url: 'https://example.com' },
        min_investment: { status: 'value', source: 'factsheet', source_url: 'https://example.com' },
        min_sip: { status: 'officially_absent', source: 'factsheet', source_url: 'https://example.com' },
        portfolio_turnover: { status: 'value', source: 'factsheet', source_url: 'https://example.com' },
        riskometer: { status: 'officially_absent', source: 'factsheet', source_url: 'https://example.com' },
      },
      b1_synced_at: '2026-06-07T09:10:26Z',
      ...overrides,
    };
  }

  it('getMetadata calls /v1/schemes/{code}/metadata with X-API-Key', async () => {
    const meta = fakeMetadata();
    const fetchImpl = jest.fn(async () => fakeResponse(200, meta)) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'mykey', fetchImpl });
    const result = await client.getMetadata(119544);
    expect(result).toEqual(meta);
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.x/v1/schemes/119544/metadata');
    expect((init as RequestInit).headers).toMatchObject({ 'X-API-Key': 'mykey' });
  });

  it('getMetadata returns null on 404', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(404, null)) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    expect(await client.getMetadata(999999)).toBeNull();
  });

  it('getMetadata throws on non-OK, non-404 response', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(500, {})) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    await expect(client.getMetadata(1)).rejects.toThrow(/HTTP 500/);
  });

  it('getMetadata round-trips nested b1_field_meta including status values', async () => {
    const meta = fakeMetadata();
    const fetchImpl = jest.fn(async () => fakeResponse(200, meta)) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    const result = await client.getMetadata(119544);
    expect(result?.b1_field_meta?.ter?.status).toBe('value');
    expect(result?.b1_field_meta?.benchmark?.status).toBe('officially_absent');
    expect(result?.metrics?.returns?.ret_1y).toBeCloseTo(0.006);
    expect(result?.metrics?.volatility).toBeCloseTo(0.148);
  });

  it('listMetadata builds /v1/metadata with updated_since + page + page_size', async () => {
    const page: Record<string, unknown> = { count: 14374, page: 2, page_size: 10, items: [] };
    const fetchImpl = jest.fn(async () => fakeResponse(200, page)) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    await client.listMetadata({ updatedSince: '2026-06-01T00:00:00Z', page: 2, pageSize: 10 });
    const [url] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toContain('/v1/metadata');
    expect(url).toContain('updated_since=2026-06-01T00%3A00%3A00Z');
    expect(url).toContain('page=2');
    expect(url).toContain('page_size=10');
  });

  it('listMetadata with no args calls /v1/metadata with no query string', async () => {
    const page: Record<string, unknown> = { count: 0, page: 1, page_size: 50, items: [] };
    const fetchImpl = jest.fn(async () => fakeResponse(200, page)) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    await client.listMetadata();
    const [url] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.x/v1/metadata');
  });

  it('listMetadata throws on non-OK response', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(500, {})) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    await expect(client.listMetadata()).rejects.toThrow(/HTTP 500/);
  });

  it('getMetadata handles schemes with null metrics gracefully', async () => {
    const meta = fakeMetadata({ metrics: null });
    const fetchImpl = jest.fn(async () => fakeResponse(200, meta)) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    const result = await client.getMetadata(119544);
    expect(result?.metrics).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// M3: mapCompositionToRegistryRows
// ---------------------------------------------------------------------------

describe('mapCompositionToRegistryRows', () => {
  const matches: SchemeMatch[] = [
    { schemeCode: 100, matchedBy: 'plan_code' },
    { schemeCode: 200, matchedBy: 'isin' },
  ];

  it('returns one row per match with sebi_category + amc when both are present', () => {
    const item = comp({ sebi_category: 'Flexi Cap Fund', amc: 'PPFAS Mutual Fund' });
    const rows = mapCompositionToRegistryRows(item, matches);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ scheme_code: 100, scheme_category: 'Flexi Cap Fund', amc_name: 'PPFAS Mutual Fund' });
    expect(rows[1]).toEqual({ scheme_code: 200, scheme_category: 'Flexi Cap Fund', amc_name: 'PPFAS Mutual Fund' });
  });

  it('returns rows when only amc is non-null (partial data)', () => {
    const item = comp({ sebi_category: null, amc: 'HDFC Mutual Fund' });
    const rows = mapCompositionToRegistryRows(item, matches);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ scheme_category: null, amc_name: 'HDFC Mutual Fund' });
  });

  it('returns rows when only sebi_category is non-null', () => {
    const item = comp({ sebi_category: 'Debt: Corporate Bond Fund', amc: '' });
    const rows = mapCompositionToRegistryRows(item, matches);
    // amc is empty string → trimmed to '' → null; sebi_category is non-null → still write
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ scheme_category: 'Debt: Corporate Bond Fund', amc_name: null });
  });

  it('returns [] when both sebi_category and amc are null/empty — preserves existing DB values', () => {
    const item = comp({ sebi_category: null, amc: '' });
    expect(mapCompositionToRegistryRows(item, matches)).toEqual([]);
  });

  it('returns [] when matches array is empty', () => {
    expect(mapCompositionToRegistryRows(comp(), [])).toEqual([]);
  });

  it('trims whitespace from sebi_category and amc', () => {
    const item = comp({ sebi_category: '  Equity  ', amc: '  Axis  ' });
    const rows = mapCompositionToRegistryRows(item, [{ schemeCode: 100, matchedBy: 'plan_code' }]);
    expect(rows[0]).toEqual({ scheme_code: 100, scheme_category: 'Equity', amc_name: 'Axis' });
  });
});

// ---------------------------------------------------------------------------
// M3: runOpenFolioSync with upsertSchemeRegistry
// ---------------------------------------------------------------------------

describe('runOpenFolioSync — upsertSchemeRegistry', () => {
  const UNI2: SchemeUniverse = {
    knownCodes: new Set([100, 200]),
    isinToCode: new Map(),
  };

  it('calls upsertSchemeRegistry with non-null rows extracted from matched items', async () => {
    const registryRows: SchemeRegistryRow[] = [];
    await runOpenFolioSync({
      client: clientServing([
        pageOf([
          comp({ plans: [{ plan_code: 100, plan_name: 'P', isins: [] }], sebi_category: 'Flexi Cap', amc: 'PPFAS' }),
          comp({ plans: [{ plan_code: 200, plan_name: 'P', isins: [] }], sebi_category: null, amc: '' }),
          comp({ plans: [{ plan_code: 999, plan_name: 'P', isins: [] }], sebi_category: 'Equity', amc: 'X' }), // unmatched
        ]),
      ]),
      universe: UNI2,
      syncedAt: SYNCED_AT,
      upsertRows: async () => ({ error: null }),
      upsertSchemeRegistry: async (rows) => {
        registryRows.push(...rows);
        return { error: null };
      },
    });
    // Scheme 100 → has category + amc → produces row
    // Scheme 200 → both null/empty → excluded by mapCompositionToRegistryRows
    // Scheme 999 → unmatched → not written
    expect(registryRows).toHaveLength(1);
    expect(registryRows[0]).toEqual({ scheme_code: 100, scheme_category: 'Flexi Cap', amc_name: 'PPFAS' });
  });

  it('does not call upsertSchemeRegistry when the dep is not provided', async () => {
    const registryRows: SchemeRegistryRow[] = [];
    await runOpenFolioSync({
      client: clientServing([
        pageOf([comp({ plans: [{ plan_code: 100, plan_name: 'P', isins: [] }] })]),
      ]),
      universe: UNI2,
      syncedAt: SYNCED_AT,
      upsertRows: async () => ({ error: null }),
      // No upsertSchemeRegistry — must not throw or error.
    });
    expect(registryRows).toHaveLength(0);
  });

  it('continues the sync even when upsertSchemeRegistry throws', async () => {
    const compositionRows: CompositionRow[] = [];
    const stats = await runOpenFolioSync({
      client: clientServing([
        pageOf([comp({ plans: [{ plan_code: 100, plan_name: 'P', isins: [] }], sebi_category: 'Equity', amc: 'X' })]),
      ]),
      universe: UNI2,
      syncedAt: SYNCED_AT,
      upsertRows: async (batch) => { compositionRows.push(...batch); return { error: null }; },
      upsertSchemeRegistry: async () => { throw new Error('registry write timeout'); },
    });
    // Composition write should still succeed
    expect(stats.upserted).toBe(1);
    expect(compositionRows).toHaveLength(1);
  });

  it('continues the sync when upsertSchemeRegistry returns an error (best-effort)', async () => {
    const compositionRows: CompositionRow[] = [];
    const stats = await runOpenFolioSync({
      client: clientServing([
        pageOf([comp({ plans: [{ plan_code: 100, plan_name: 'P', isins: [] }], sebi_category: 'Equity', amc: 'X' })]),
      ]),
      universe: UNI2,
      syncedAt: SYNCED_AT,
      upsertRows: async (batch) => { compositionRows.push(...batch); return { error: null }; },
      upsertSchemeRegistry: async () => ({ error: 'db timeout' }),
    });
    // Composition write still succeeds; registry error is logged but doesn't abort
    expect(stats.upserted).toBe(1);
    expect(compositionRows).toHaveLength(1);
  });

  it('skips registry write for items that fail the disclosure date guard', async () => {
    const registryRows: SchemeRegistryRow[] = [];
    await runOpenFolioSync({
      client: clientServing([
        pageOf([
          comp({ plans: [{ plan_code: 100, plan_name: 'P', isins: [] }], disclosure_date: '2055-08-18', sebi_category: 'Equity', amc: 'X' }),
          comp({ plans: [{ plan_code: 200, plan_name: 'P', isins: [] }], disclosure_date: '2026-04-30', sebi_category: 'Debt', amc: 'Y' }),
        ]),
      ]),
      universe: UNI2,
      syncedAt: SYNCED_AT,
      upsertRows: async () => ({ error: null }),
      upsertSchemeRegistry: async (rows) => { registryRows.push(...rows); return { error: null }; },
    });
    // Scheme 100 has a bad date → skipped before registry write
    expect(registryRows.every((r) => r.scheme_code === 200)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M3: listSchemes client method
// ---------------------------------------------------------------------------

describe('createOpenFolioClient — listSchemes', () => {
  function fakeSchemeFamily(): SchemeFamily {
    return {
      family_id: 'OF-abc123',
      plans: [{ plan_code: 122639, plan_name: 'Direct Growth', isins: ['INF879O01027'] }],
      amc: 'PPFAS Mutual Fund',
      scheme_name: 'Parag Parikh Flexi Cap Fund',
      sebi_category: 'Flexi Cap Fund',
      code_source: 'hardcoded',
    };
  }

  it('listSchemes calls /v1/schemes with amc/category/q/page/page_size', async () => {
    const page: SchemeListPage = { count: 1, page: 1, page_size: 50, items: [fakeSchemeFamily()] };
    const fetchImpl = jest.fn(async () => fakeResponse(200, page)) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'KEY', fetchImpl });
    const result = await client.listSchemes({ amc: 'PPFAS', category: 'Flexi Cap Fund', page: 1, pageSize: 50 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].family_id).toBe('OF-abc123');
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toContain('/v1/schemes');
    expect(url).toContain('amc=PPFAS');
    expect(url).toContain('category=Flexi+Cap+Fund');
    expect((init as RequestInit).headers).toMatchObject({ 'X-API-Key': 'KEY' });
  });

  it('listSchemes with no args calls /v1/schemes with no query string', async () => {
    const page: SchemeListPage = { count: 0, page: 1, page_size: 100, items: [] };
    const fetchImpl = jest.fn(async () => fakeResponse(200, page)) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    await client.listSchemes();
    const [url] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.x/v1/schemes');
  });

  it('listSchemes throws on non-OK response', async () => {
    const fetchImpl = jest.fn(async () => fakeResponse(503, {})) as unknown as typeof fetch;
    const client = createOpenFolioClient({ baseUrl: 'https://api.x', apiKey: 'k', fetchImpl });
    await expect(client.listSchemes()).rejects.toThrow(/HTTP 503/);
  });
});
