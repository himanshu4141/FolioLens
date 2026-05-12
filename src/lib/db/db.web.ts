/**
 * Web shim for the SQLite read cache (Phase 9 M4).
 *
 * `expo-sqlite`'s web build pulls in a `wa-sqlite.wasm` binary that the
 * Metro web bundler can't resolve cleanly — the bundle fails with
 * `Unable to resolve module ./wa-sqlite/wa-sqlite.wasm`. Even if it
 * resolved, the web app has no use for an on-disk SQLite — the React
 * Query persister already covers the reload-from-disk story via
 * `window.localStorage`.
 *
 * Metro picks this `.web.ts` file when bundling for web, and `db.ts`
 * for native targets. Every consumer (repo modules, sync orchestrator)
 * imports from `'./db'` without specifying a platform — Metro's
 * resolver does the right thing.
 *
 * Behaviour on web: every `getDb()` call throws. The repo modules
 * (`tx.ts`, `nav.ts`, `idx.ts`, `syncState.ts`) and the read-through
 * fetchers (`fetchUserTransactions`, `fetchPortfolioData`,
 * `fetchFundDetail`, `fetchFundNavHistory`) already wrap every SQLite
 * call in a `try/catch` and fall through to the Supabase / CDN
 * snapshot path on failure. So a thrown stub here triggers the
 * fallback cleanly without any web-specific branching in the
 * consumers.
 */

export const SCHEMA_VERSION = 2;
export const DB_NAME = 'foliolens.db';

const NOT_SUPPORTED_ERROR = new Error(
  '[db.web] SQLite read cache is not available on web; fall back to network.',
);

export function getDb(): Promise<never> {
  return Promise.reject(NOT_SUPPORTED_ERROR);
}

export async function dropAndRecreate(): Promise<void> {
  // No-op on web — nothing to drop. The React Query persister handles
  // sign-out cache wipes for the web build.
}

// Test hook kept signature-compatible with `db.ts`. Web tests never
// exercise SQLite paths so this is a no-op.
export function __setDbForTests(_promise: unknown): void {
  // intentionally empty
}
