/**
 * The one place in the app that imports `supabase.functions` directly.
 *
 * Every call to a backend handler (sync-nav, sync-fund-portfolios,
 * delete-account, fetch-fund-nav, etc.) goes through `functionsClient`.
 * If we ever move those handlers off Supabase Edge Functions to Vercel /
 * Cloudflare / fly.io, this file becomes a thin `fetch()` wrapper and
 * call sites are unchanged.
 *
 * Methods resolve lazily — see comment in `src/lib/auth/index.ts` for
 * why (test mock compatibility + preserving overloaded signatures).
 *
 * See `docs/EXIT-RUNBOOK.md` for the broader exit-readiness posture.
 */
import { supabase } from '@/src/lib/supabase';

type Functions = typeof supabase.functions;

export const functionsClient = new Proxy({} as Pick<Functions, 'invoke'>, {
  get(_target, prop) {
    if (prop !== 'invoke') return undefined;
    const method = supabase.functions.invoke;
    if (typeof method !== 'function') return method;
    return method.bind(supabase.functions);
  },
});
