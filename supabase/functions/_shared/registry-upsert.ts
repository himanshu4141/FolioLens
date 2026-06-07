/**
 * Shared factory for the `upsertSchemeRegistry` callback used by both
 * `openfolio-sync` (per-page, monthly) and `universe-backfill` (one-time).
 *
 * Returns a function that UPDATE-only patches `scheme_master.scheme_category`
 * and `scheme_master.amc_name` for matched schemes:
 *   - Only writes non-null fields — preserves richer existing values
 *   - Never INSERTs phantom rows (UPDATE + WHERE scheme_code)
 *   - Errors are logged but never thrown (callers treat this as best-effort)
 */

import type { createServiceClient } from './supabase-client.ts';
import type { SchemeRegistryRow, UpsertResult } from './openfolio.ts';

export function makeRegistryUpsert(
  supabase: ReturnType<typeof createServiceClient>,
  logPrefix: string,
): (rows: SchemeRegistryRow[]) => Promise<UpsertResult> {
  return async (rows: SchemeRegistryRow[]): Promise<UpsertResult> => {
    for (const row of rows) {
      const patch: Record<string, string | null> = {};
      if (row.scheme_category !== null) patch.scheme_category = row.scheme_category;
      if (row.amc_name !== null) patch.amc_name = row.amc_name;
      if (Object.keys(patch).length === 0) continue;
      const { error } = await supabase
        .from('scheme_master')
        .update(patch)
        .eq('scheme_code', row.scheme_code);
      if (error) {
        console.error(
          '%s registry update failed scheme=%d: %s',
          logPrefix,
          row.scheme_code,
          error.message,
        );
      }
    }
    return { error: null };
  };
}
