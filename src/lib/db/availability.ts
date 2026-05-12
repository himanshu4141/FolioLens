import { Platform } from 'react-native';

/**
 * SQLite read cache is native-only. On web, `db.web.ts` rejects every
 * `getDb()` call with a "not supported" error and consumers fall back to
 * the Supabase / CDN paths. Gate the SQLite branch on this constant so
 * web never pays for the wasted throw+catch cycle (and the console stays
 * clean — no "[hook] sqlite read failed" noise on every page load).
 *
 * The React Query persister itself works on web via
 * `@react-native-async-storage/async-storage`, which proxies to
 * `window.localStorage`. So the only thing missing on web is the
 * input-layer SQLite repo; computed query results are still rehydrated
 * from disk on reload.
 */
export const SQLITE_AVAILABLE = Platform.OS !== 'web';
