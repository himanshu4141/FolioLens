# `src/lib/data/`

The single layer that talks to the Data API. Everything outside this
folder reads/writes user data through one of the `<table>Repo` modules
here — no other module imports `supabase` for `.from(...)` calls.

Why: see `docs/EXIT-RUNBOOK.md`. Today these wrappers thin over
supabase-js; if we ever move off PostgREST (self-hosted, tRPC, REST
service, ...), we rewrite ~10 files in this directory instead of
chasing 50+ `.from(...)` call sites across hooks, screens, and utils.

## Convention

Each table gets one file: `src/lib/data/<camelCaseTable>.ts`.

```ts
import { supabase } from '@/src/lib/supabase';

const TABLE = 'nav_history' as const;

export const navHistoryRepo = {
  /** Typed query builder for one-off queries. Prefer named functions
   *  below when a pattern repeats — keeps swap-day workload bounded. */
  from: () => supabase.from(TABLE),

  /** Named patterns go here as plain async functions. */
  listForSchemeSince: (schemeCode: number, sinceDate: string) => { /* ... */ },
};
```

On swap-day, the implementation of `from()` (or the named functions)
becomes whatever the new backend is — `fetch()`, `trpcClient.foo.query()`,
etc. The consumer code stays put.

## External-API wrappers (not table repos)

A few files here wrap an **external HTTP API** rather than a Supabase table.
They follow the same swap-point + mock-boundary principle but expose typed
functions instead of `from()`:

- `composition.ts` — the OpenFolio-Data holdings API ([docs](../../../docs/plans/openfolio-holdings-integration.md)).
  Sole app-side owner of the OpenFolio base URL + `X-API-Key` (env
  `OPENFOLIO_API_BASE` / `OPENFOLIO_API_KEY`); exposes typed `getComposition` /
  `listComposition`. Tests of consumers mock `@/src/lib/data/composition`, never
  the network. NOTE: in M1–M4 the API is called server-side from edge functions
  (Deno can't import `src/`), so the runtime client + mapping live in the Deno
  twin `supabase/functions/_shared/openfolio.ts`; this file mirrors the same
  contract for the app boundary.

## Tests

Tests of code that uses these repos mock the repo, not the underlying
`supabase` module — same swap-day reasoning as the production rule.

```ts
jest.mock('@/src/lib/data/navHistory', () => ({
  navHistoryRepo: { from: jest.fn() },
}));

import { navHistoryRepo } from '@/src/lib/data/navHistory';

const navFrom = navHistoryRepo.from as jest.Mock;
navFrom.mockReturnValue(makeChain({ data: [...], error: null }));
```

For tests that touch multiple tables, mock each repo separately and
a small `setupRepos({ funds, txs, nav })` helper inside the test file
keeps each test body to one line — see
`src/hooks/__tests__/usePortfolio.test.ts` for the pattern.
