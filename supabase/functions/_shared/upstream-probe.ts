/**
 * Single-shot health probe for a third-party HTTP upstream.
 *
 * Edge-function cron jobs that fan out to an external API (mfdata.in, etc.)
 * use this to decide whether to skip the fan-out entirely when the upstream
 * is hard-down. Without this, an upstream outage looks like a fleet-wide
 * failure in our telemetry — every per-item call times out, the cron emits
 * `sync_failed`, and on-call gets paged for something we can't fix.
 *
 * Classification:
 *   - HTTP 2xx/3xx/4xx → 'up'.  4xx is "their bug or auth issue" but the
 *     origin is reachable; per-item handlers still see the same response.
 *   - HTTP 5xx         → 'down'. Includes Cloudflare 522 (origin connection
 *     timeout) and 524 (origin response timeout) which are the canonical
 *     "your upstream is offline" signals.
 *   - AbortError       → 'down' / timeout. The probe controller aborted
 *     because the upstream never returned headers within `timeoutMs`.
 *   - Any other error  → 'down' / network. DNS failure, TCP reset, TLS
 *     handshake failure, etc.
 *
 * The probe is intentionally a single attempt with no retry — its job is
 * to be a fast yes/no, not to drive the actual sync.
 */

export type UpstreamProbeReason = 'http_5xx' | 'timeout' | 'network';

export type UpstreamProbeResult =
  | { status: 'up' }
  | { status: 'down'; reason: UpstreamProbeReason; httpStatus?: number };

export interface ProbeOptions {
  /** Hard ceiling on how long the probe is allowed to take. Default 8s. */
  timeoutMs?: number;
  /** Injected fetcher for tests. Defaults to the global `fetch`. */
  fetcher?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export async function probeUpstream(
  url: string,
  opts: ProbeOptions = {},
): Promise<UpstreamProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const f = opts.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await f(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'FundLens/1.0' },
    });
    if (res.status >= 500) {
      return { status: 'down', reason: 'http_5xx', httpStatus: res.status };
    }
    return { status: 'up' };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'down', reason: 'timeout' };
    }
    return { status: 'down', reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
