/**
 * Lightweight performance instrumentation.
 *
 * Every mark emits two signals:
 *   1. A `console.warn` line like `[perf] label 234ms (t+1812ms)` — easy
 *      to grep in `adb logcat` (warn appears with a yellow `W` tag in
 *      Android logcat, so it stands out from background noise).
 *   2. A `perf_mark` analytics event so we can read aggregate timing in
 *      PostHog even when no one is tailing the device logs.
 *
 * The module-level `APP_BOOT_AT` is captured the first time this file is
 * imported — close enough to "app start" for our purposes, since the
 * import graph pulls this in via `app/_layout.tsx` on bundle execution.
 *
 * Two flavours:
 *   - `const spanId = perfStart(label)` + `perfEnd(spanId, extra?)` —
 *     concurrency-safe span timing.
 *   - `perfNow(label, extra?)` — one-shot timestamp (records elapsed
 *     time since boot).
 */
import { analytics } from '@/src/lib/analytics';

const APP_BOOT_AT = Date.now();
let nextSpanId = 0;
const MAX_ACTIVE_SPANS = 500;
const SPAN_TTL_MS = 5 * 60 * 1000;

export type PerfSpanId = string & { readonly __perfSpanId: unique symbol };

interface PerfSpan {
  label: string;
  startedAt: number;
}

const marks = new Map<PerfSpanId, PerfSpan>();

export function perfStart(label: string): PerfSpanId {
  cleanupExpiredSpans();
  while (marks.size >= MAX_ACTIVE_SPANS) {
    const oldestSpanId = marks.keys().next().value as PerfSpanId | undefined;
    if (oldestSpanId === undefined) break;
    marks.delete(oldestSpanId);
  }
  nextSpanId += 1;
  const spanId = `perf-${nextSpanId}` as PerfSpanId;
  marks.set(spanId, { label, startedAt: Date.now() });
  return spanId;
}

export function perfEnd(spanId: PerfSpanId, extra?: Record<string, unknown>): number {
  cleanupExpiredSpans();
  const span = marks.get(spanId);
  marks.delete(spanId);
  if (span === undefined) return -1;
  const elapsedMs = Date.now() - span.startedAt;
  const sinceBootMs = Date.now() - APP_BOOT_AT;
  console.warn(`[perf] ${span.label} ${elapsedMs}ms (t+${sinceBootMs}ms)`, extra ?? {});
  analytics.track('perf_mark', {
    label: span.label,
    elapsed_ms: elapsedMs,
    since_boot_ms: sinceBootMs,
    ...(extra ?? {}),
  });
  return elapsedMs;
}

/** Drop a span that can no longer complete without emitting a false metric. */
export function perfCancel(spanId: PerfSpanId): void {
  marks.delete(spanId);
}

function cleanupExpiredSpans(now = Date.now()): void {
  for (const [spanId, span] of marks) {
    if (now - span.startedAt > SPAN_TTL_MS) {
      marks.delete(spanId);
    }
  }
}

export function perfNow(label: string, extra?: Record<string, unknown>): void {
  const sinceBootMs = Date.now() - APP_BOOT_AT;
  console.warn(`[perf] ${label} (t+${sinceBootMs}ms)`, extra ?? {});
  analytics.track('perf_mark', {
    label,
    since_boot_ms: sinceBootMs,
    ...(extra ?? {}),
  });
}

export function getAppBootAt(): number {
  return APP_BOOT_AT;
}
