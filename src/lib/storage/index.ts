/**
 * The one place in the app that imports `supabase.storage` directly.
 *
 * Today this is a thin pass-through to supabase-js. If we ever migrate
 * buckets to S3 / R2 / Vercel Blob, swap the implementation here and
 * call sites stay put.
 *
 * Methods resolve lazily — see comment in `src/lib/auth/index.ts` for
 * why (test mock compatibility + preserving overloaded signatures).
 *
 * See `docs/EXIT-RUNBOOK.md` for the broader exit-readiness posture.
 */
import { supabase } from '@/src/lib/supabase';

type Storage = typeof supabase.storage;

export const storageClient = new Proxy({} as Pick<Storage, 'from'>, {
  get(_target, prop) {
    if (prop !== 'from') return undefined;
    const method = supabase.storage.from;
    if (typeof method !== 'function') return method;
    return method.bind(supabase.storage);
  },
});
