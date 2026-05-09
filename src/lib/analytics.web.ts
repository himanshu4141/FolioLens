import phClient from 'posthog-js';
import type { AnalyticsClient } from './analytics';
import { sanitizeProperties } from './analyticsSanitize';

const KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY;
const HOST = process.env.EXPO_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';

let initialized = false;

/**
 * Web PostHog client. Initialised at module load when an API key is present;
 * otherwise every public method short-circuits.
 *
 * Defaults are tuned for performance and signal-to-noise:
 *   - capture_pageview: false           → we emit `insight_viewed` explicitly
 *                                          per surface, which is more useful
 *                                          for funnels than auto pageviews
 *   - autocapture: false                → tap-by-tap autocapture multiplies
 *                                          event volume by ~10× and pollutes
 *                                          the funnel namespace
 *   - disable_session_recording: true   → recording is optional; we pay for
 *                                          it (network + privacy footprint)
 *                                          only when an investigation needs it
 *   - sanitize_properties               → strips Supabase magic-link tokens
 *                                          out of `$current_url` / `$referrer`
 *                                          before any event is sent. Required
 *                                          because the React tree renders
 *                                          /auth/confirm with the access_token
 *                                          in the hash long enough for the
 *                                          SDK's auto-attached $current_url
 *                                          to pick it up.
 */
if (KEY && typeof window !== 'undefined') {
  phClient.init(KEY, {
    api_host: HOST,
    capture_pageview: false,
    autocapture: false,
    disable_session_recording: true,
    persistence: 'localStorage+cookie',
    sanitize_properties: (properties) =>
      sanitizeProperties(properties as Record<string, unknown>) as typeof properties,
    loaded: () => {
      initialized = true;
    },
  });
  // Optimistic — calls before `loaded` fires are buffered by posthog-js
  // and dispatched once init completes.
  initialized = true;
}

export const analytics: AnalyticsClient = {
  get isEnabled() {
    return Boolean(KEY) && initialized;
  },
  track(event, properties) {
    if (!KEY) return;
    phClient.capture(event, properties);
  },
  identify(distinctId, properties) {
    if (!KEY) return;
    phClient.identify(distinctId, properties);
  },
  reset() {
    if (!KEY) return;
    phClient.reset();
  },
  captureException(error, properties) {
    if (!KEY) return;
    if (error instanceof Error) {
      phClient.captureException(error, properties);
      return;
    }
    phClient.capture('$exception', {
      $exception_message: typeof error === 'string' ? error : JSON.stringify(error),
      ...properties,
    });
  },
};

export default analytics;
