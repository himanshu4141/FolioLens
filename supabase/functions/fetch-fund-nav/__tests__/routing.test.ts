/**
 * Handler-level tests for fetch-fund-nav's OpenFolio-staleness routing.
 *
 * PR #312 review: a pure-function test of checkOpenFolioResultFreshness()
 * alone doesn't catch a regression at the actual call sites in index.ts — a
 * handler that stops calling it, ignores `.fresh`, checks the wrong date, or
 * never falls through to mfapi would still pass. This loads the real
 * Deno.serve handler from index.ts (via a captured callback — Deno.serve
 * itself is stubbed so the module doesn't try to start a server under Node)
 * and drives it through real HTTP-shaped mocks (fetch, Supabase) to assert
 * the actual incident invariant: a stale OpenFolio result — empty points
 * against a stale `since`, or non-empty points whose latest date is itself
 * stale — falls through to mfapi, while a fresh result returns early without
 * ever calling mfapi.
 *
 * The Supabase client is mocked at the wrapper boundary (createServiceClient
 * from _shared/supabase-client.ts), matching this repo's convention — that
 * module's own `https://esm.sh/...` import can't resolve under Node anyway,
 * so jest.mock replaces the whole module before it's ever evaluated.
 */

const envVars: Record<string, string> = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  OPENFOLIO_API_BASE: 'https://openfolio.test',
  OPENFOLIO_API_KEY: 'openfolio-key',
};

type Handler = (req: Request) => Promise<Response>;
let capturedHandler: Handler | null = null;

(globalThis as unknown as { Deno: unknown }).Deno = {
  serve: (handler: Handler) => {
    capturedHandler = handler;
  },
  env: { get: (key: string) => envVars[key] },
};

let latestNavRows: { nav_date: string }[] = [];
let schemeMasterUpdateError: { message: string } | null = null;
const upsertedRows: { scheme_code: number; nav_date: string; nav: number }[] = [];

jest.mock('../../_shared/supabase-client.ts', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'nav_history') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: latestNavRows, error: null }),
              }),
            }),
          }),
          upsert: (rows: { scheme_code: number; nav_date: string; nav: number }[]) => ({
            select: () => {
              upsertedRows.push(...rows);
              return Promise.resolve({ data: rows, error: null });
            },
          }),
        };
      }
      if (table === 'scheme_master') {
        return {
          update: () => ({
            eq: () => Promise.resolve({ error: schemeMasterUpdateError }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

let openFolioResponse: { status: number; body: unknown } = { status: 200, body: { points: [] } };
let mfapiResponse: { status: number; body: unknown } = { status: 200, body: { data: [] } };
let fetchCalls: string[] = [];

global.fetch = jest.fn((url: string) => {
  fetchCalls.push(url);
  if (url.includes('openfolio.test')) {
    return Promise.resolve(new Response(JSON.stringify(openFolioResponse.body), { status: openFolioResponse.status }));
  }
  if (url.includes('api.mfapi.in')) {
    return Promise.resolve(new Response(JSON.stringify(mfapiResponse.body), { status: mfapiResponse.status }));
  }
  return Promise.reject(new Error(`unexpected fetch url: ${url}`));
}) as unknown as typeof fetch;

beforeAll(() => {
  require('../index.ts');
});

beforeEach(() => {
  latestNavRows = [];
  schemeMasterUpdateError = null;
  upsertedRows.length = 0;
  openFolioResponse = { status: 200, body: { points: [] } };
  mfapiResponse = { status: 200, body: { data: [] } };
  fetchCalls = [];
});

afterEach(() => {
  jest.useRealTimers();
});

function post(schemeCode: number): Promise<Response> {
  if (!capturedHandler) throw new Error('handler not captured — Deno.serve was not invoked');
  return capturedHandler(
    new Request('http://localhost/fetch-fund-nav', {
      method: 'POST',
      body: JSON.stringify({ scheme_code: schemeCode }),
    }),
  );
}

function setSystemTime(iso: string) {
  // Only Date is faked (real timers keep running) — index.ts's own
  // AbortController/setTimeout fetch-timeout logic must still function
  // normally against the mocked fetch promises resolving immediately.
  jest.useFakeTimers({
    doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'nextTick', 'setImmediate', 'clearImmediate'],
  });
  jest.setSystemTime(new Date(iso));
}

const openFolioCalled = () => fetchCalls.some((u) => u.includes('openfolio.test'));
const mfapiCalled = () => fetchCalls.some((u) => u.includes('api.mfapi.in'));

describe('fetch-fund-nav routing', () => {
  it('declares cache_hit immediately when the local series is within the 3-calendar-day cache window, without calling OpenFolio or mfapi', async () => {
    latestNavRows = [{ nav_date: '2026-06-14' }];
    setSystemTime('2026-06-15T08:00:00.000Z'); // 1 calendar day old

    const res = await post(119551);
    const json = (await res.json()) as { status: string };

    expect(json.status).toBe('cache_hit');
    expect(openFolioCalled()).toBe(false);
    expect(mfapiCalled()).toBe(false);
  });

  it('falls through to mfapi when OpenFolio returns no new points against a stale since', async () => {
    // 2026-08-18 -> 2026-09-10: 17 trading days old (the incident window),
    // well past the 3-calendar-day early gate too.
    latestNavRows = [{ nav_date: '2026-08-18' }];
    setSystemTime('2026-09-10T08:00:00.000Z');
    openFolioResponse = { status: 200, body: { points: [] } };
    mfapiResponse = {
      status: 200,
      body: { data: [{ date: '09-09-2026', nav: '123.45' }] },
    };

    const res = await post(119551);
    const json = (await res.json()) as { status: string; last_nav_date: string };

    expect(openFolioCalled()).toBe(true);
    expect(mfapiCalled()).toBe(true);
    expect(json.status).toBe('fetched');
    expect(json.last_nav_date).toBe('2026-09-09');
  });

  it('does not call mfapi when OpenFolio reports no new points and the local series is itself fresh', async () => {
    // Thursday -> following Monday: 4 calendar days (past the 3-day early
    // gate) but only 2 trading days (Fri, Mon) — within the OF-freshness
    // threshold.
    latestNavRows = [{ nav_date: '2026-06-11' }];
    setSystemTime('2026-06-15T08:00:00.000Z');
    openFolioResponse = { status: 200, body: { points: [] } };

    const res = await post(119551);
    const json = (await res.json()) as { status: string };

    expect(openFolioCalled()).toBe(true);
    expect(mfapiCalled()).toBe(false);
    expect(json.status).toBe('cache_hit');
  });

  it('falls through to mfapi when OpenFolio returns points but the resulting last_nav_date is still stale', async () => {
    // OpenFolio answers with a non-empty series (the incident: OF stayed
    // "healthy" and kept returning catch-up points) that still stops at the
    // same stale 2026-08-18 date — must not be declared 'fetched' on that.
    latestNavRows = [{ nav_date: '2026-08-01' }];
    setSystemTime('2026-09-10T08:00:00.000Z');
    openFolioResponse = {
      status: 200,
      body: { points: [{ date: '2026-08-18', nav: 55.5 }] },
    };
    mfapiResponse = {
      status: 200,
      body: { data: [{ date: '09-09-2026', nav: '77.70' }] },
    };

    const res = await post(119551);
    const json = (await res.json()) as { status: string; last_nav_date: string };

    expect(openFolioCalled()).toBe(true);
    // OpenFolio's stale point is still upserted (upserts are idempotent).
    expect(upsertedRows.some((r) => r.nav_date === '2026-08-18')).toBe(true);
    expect(mfapiCalled()).toBe(true);
    expect(json.status).toBe('fetched');
    expect(json.last_nav_date).toBe('2026-09-09');
  });

  it('declares fetched from OpenFolio alone, without calling mfapi, when the returned points are fresh', async () => {
    latestNavRows = [{ nav_date: '2026-06-11' }];
    setSystemTime('2026-06-15T08:00:00.000Z');
    openFolioResponse = {
      status: 200,
      body: { points: [{ date: '2026-06-11', nav: 42.1 }] },
    };

    const res = await post(119551);
    const json = (await res.json()) as { status: string; last_nav_date: string };

    expect(openFolioCalled()).toBe(true);
    expect(mfapiCalled()).toBe(false);
    expect(json.status).toBe('fetched');
    expect(json.last_nav_date).toBe('2026-06-11');
  });
});
