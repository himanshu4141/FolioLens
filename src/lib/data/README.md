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
