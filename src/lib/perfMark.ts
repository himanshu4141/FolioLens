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
 *   - `perfStart(label)` + `perfEnd(label, extra?)` — span timing.
 *   - `perfNow(label, extra?)` — one-shot timestamp (records elapsed
 *     time since boot).
 */
import { analytics } from '@/src/lib/analytics';

const APP_BOOT_AT = Date.now();
const marks = new Map<string, number>();

export function perfStart(label: string): void {
  marks.set(label, Date.now());
}

export function perfEnd(label: string, extra?: Record<string, unknown>): number {
  const start = marks.get(label);
  marks.delete(label);
  if (start === undefined) return -1;
  const elapsedMs = Date.now() - start;
  const sinceBootMs = Date.now() - APP_BOOT_AT;
  console.warn(`[perf] ${label} ${elapsedMs}ms (t+${sinceBootMs}ms)`, extra ?? {});
  analytics.track('perf_mark', {
    label,
    elapsed_ms: elapsedMs,
    since_boot_ms: sinceBootMs,
    ...(extra ?? {}),
  });
  return elapsedMs;
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
