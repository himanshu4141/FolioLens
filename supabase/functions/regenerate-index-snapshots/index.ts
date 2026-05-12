/**
 * regenerate-index-snapshots — daily projection of `index_history` rows
 * into static JSON files in the `static-snapshots` Supabase Storage
 * bucket. Each tracked benchmark gets its own file:
 *
 *   static-snapshots/index/nseitri.json
 *   static-snapshots/index/nifty100tri.json
 *   static-snapshots/index/nifty500tri.json
 *
 * Files are served via Supabase's public CDN with `Cache-Control:
 * public, max-age=3600, stale-while-revalidate=86400`. The app reads
 * them via plain `fetch()` instead of paginating `index_history`,
 * collapsing a 2–8 round-trip cold load into one.
 *
 * Schedule: 14:00 UTC weekdays (7:30 PM IST, 15 min after sync-index).
 * Deployed with `--no-verify-jwt` so pg_cron can call it.
 *
 * Failure mode: per-symbol — a single bad symbol does not block the
 * others. Each gets a summary row in the response; the previous file
 * stays in place for any failure, so the worst case is stale-but-valid
 * data.
 *
 * Phase 9 M5 — Layer 2 of "CDN snapshots for benchmark index history".
 */

import { createServiceClient } from '../_shared/supabase-client.ts';
import { CORS, json } from '../_shared/cors.ts';
import { trackServerEventAwait } from '../_shared/analytics.ts';

const TRACKED_SYMBOLS: readonly string[] = [
  '^NSEITRI',
  '^NIFTY100TRI',
  '^NIFTY500TRI',
];

const BUCKET = 'static-snapshots';
const PAGE_SIZE = 1000;

interface IndexHistoryRow {
  index_date: string;
  close_value: number;
}

interface SnapshotPoint {
  date: string;
  value: number;
}

interface SnapshotFile {
  symbol: string;
  generated_at: string;
  points: SnapshotPoint[];
}

interface SymbolResult {
  symbol: string;
  ok: boolean;
  rows: number;
  bytes: number;
  path?: string;
  error?: string;
}

async function fetchAllRows(
  supabase: ReturnType<typeof createServiceClient>,
  symbol: string,
): Promise<IndexHistoryRow[]> {
  const rows: IndexHistoryRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('index_history')
      .select('index_date, close_value')
      .eq('index_symbol', symbol)
      .order('index_date', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as IndexHistoryRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

function objectPathFor(symbol: string): string {
  // `^NSEITRI` → `index/nseitri.json`. Strip the leading caret and
  // lowercase so the URL is human-readable and `^` doesn't need
  // URL-encoding in fetch() callers.
  return `index/${symbol.replace(/^\^/, '').toLowerCase()}.json`;
}

async function uploadSnapshot(
  supabase: ReturnType<typeof createServiceClient>,
  symbol: string,
  payload: SnapshotFile,
): Promise<{ path: string; bytes: number }> {
  const body = JSON.stringify(payload);
  const path = objectPathFor(symbol);
  const { error } = await supabase.storage.from(BUCKET).upload(path, body, {
    contentType: 'application/json; charset=utf-8',
    upsert: true,
    cacheControl: 'public, max-age=3600, stale-while-revalidate=86400',
  });
  if (error) throw error;
  return { path, bytes: body.length };
}

async function regenerateOne(
  supabase: ReturnType<typeof createServiceClient>,
  symbol: string,
): Promise<SymbolResult> {
  try {
    console.log(`[regenerate-index-snapshots] start symbol=${symbol}`);
    const rows = await fetchAllRows(supabase, symbol);
    console.log(`[regenerate-index-snapshots] data-loaded symbol=${symbol} rows=${rows.length}`);
    if (rows.length === 0) {
      return { symbol, ok: false, rows: 0, bytes: 0, error: 'no rows in index_history' };
    }
    const payload: SnapshotFile = {
      symbol,
      generated_at: new Date().toISOString(),
      points: rows.map((r) => ({ date: r.index_date, value: r.close_value })),
    };
    const { path, bytes } = await uploadSnapshot(supabase, symbol, payload);
    console.log(`[regenerate-index-snapshots] uploaded symbol=${symbol} path=${path} bytes=${bytes}`);
    return { symbol, ok: true, rows: rows.length, bytes, path };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[regenerate-index-snapshots] failed symbol=${symbol} err=${message}`);
    return { symbol, ok: false, rows: 0, bytes: 0, error: message };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  console.log('[regenerate-index-snapshots] invoke');
  const supabase = createServiceClient();
  const started = Date.now();

  const results: SymbolResult[] = [];
  for (const symbol of TRACKED_SYMBOLS) {
    results.push(await regenerateOne(supabase, symbol));
  }

  const okCount = results.filter((r) => r.ok).length;
  const totalBytes = results.reduce((acc, r) => acc + r.bytes, 0);
  const elapsedMs = Date.now() - started;

  console.log(
    `[regenerate-index-snapshots] done ok=${okCount}/${results.length} bytes=${totalBytes} elapsed_ms=${elapsedMs}`,
  );

  await trackServerEventAwait('snapshot_regenerated', {
    ok_count: okCount,
    total_count: results.length,
    total_bytes: totalBytes,
    elapsed_ms: elapsedMs,
    failures: results.filter((r) => !r.ok).map((r) => ({ symbol: r.symbol, error: r.error })),
  });

  return json({
    ok: okCount === results.length,
    ok_count: okCount,
    total_count: results.length,
    total_bytes: totalBytes,
    elapsed_ms: elapsedMs,
    results,
  });
});
