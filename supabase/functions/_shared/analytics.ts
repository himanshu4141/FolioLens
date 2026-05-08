/**
 * Server-side PostHog event capture for Edge Functions.
 *
 * Uses PostHog's `/capture/` HTTP API directly rather than the Node SDK so
 * we don't pull in `npm:` deps that bloat cold-start. Calls are
 * fire-and-forget by default — the caller can `await` if they need delivery
 * confirmation, but most cron paths don't.
 *
 * Configuration is read from Edge Function runtime env vars:
 *   POSTHOG_PROJECT_KEY   project token (`phc_...`); same value as the
 *                         client SDKs use. Absent → every call is a no-op.
 *   POSTHOG_HOST          API host; defaults to https://us.i.posthog.com.
 *                         Set to https://eu.i.posthog.com for EU projects.
 *   APP_ENVIRONMENT       'production' | 'dev' — added as a property to every
 *                         event so dashboards can filter prod from dev when
 *                         one PostHog project ingests both.
 */

const POSTHOG_KEY = Deno.env.get('POSTHOG_PROJECT_KEY') ?? '';
const POSTHOG_HOST = Deno.env.get('POSTHOG_HOST') ?? 'https://us.i.posthog.com';
const APP_ENVIRONMENT = Deno.env.get('APP_ENVIRONMENT') ?? 'unknown';

interface CaptureBody {
  api_key: string;
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

/**
 * Sends a single event to PostHog. Returns immediately — the underlying
 * fetch is detached so the caller can return their HTTP response without
 * waiting on the analytics POST. Errors are swallowed and logged; an
 * analytics outage must never break a user-visible function.
 *
 * Pass `system:<function-name>` as the distinct id for events that have no
 * authenticated user (cron jobs, webhooks pre-auth). Pass the auth user id
 * for user-attributed events.
 */
export function trackServerEvent(
  event: string,
  properties: Record<string, unknown> = {},
  distinctId: string = 'system:unknown',
): void {
  if (!POSTHOG_KEY) return;

  const body: CaptureBody = {
    api_key: POSTHOG_KEY,
    event,
    distinct_id: distinctId,
    properties: {
      $lib: 'foliolens-edge-fn',
      environment: APP_ENVIRONMENT,
      ...properties,
    },
    timestamp: new Date().toISOString(),
  };

  // Fire-and-forget. The Edge Function runtime keeps detached promises alive
  // long enough for a single HTTP round-trip on the way to shutdown.
  fetch(`${POSTHOG_HOST}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then((res) => {
      if (!res.ok) {
        console.warn('[analytics] capture non-2xx: %d %s', res.status, event);
      }
    })
    .catch((err) => {
      console.warn('[analytics] capture failed for %s: %s', event, err);
    });
}

/**
 * Awaitable variant — use when the caller is on a long-lived path (a cron
 * function ending) and wants to be sure the event is on the wire before
 * Deno tears the isolate down. Same swallow-and-log behaviour on error.
 */
export async function trackServerEventAwait(
  event: string,
  properties: Record<string, unknown> = {},
  distinctId: string = 'system:unknown',
): Promise<void> {
  if (!POSTHOG_KEY) return;

  const body: CaptureBody = {
    api_key: POSTHOG_KEY,
    event,
    distinct_id: distinctId,
    properties: {
      $lib: 'foliolens-edge-fn',
      environment: APP_ENVIRONMENT,
      ...properties,
    },
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(`${POSTHOG_HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn('[analytics] capture non-2xx: %d %s', res.status, event);
    }
  } catch (err) {
    console.warn('[analytics] capture failed for %s: %s', event, err);
  }
}
