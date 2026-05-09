import PostHog from 'posthog-react-native';
import type { PostHogEventProperties } from '@posthog/core';
import type { AnalyticsClient } from './analytics';

const KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY;
const HOST = process.env.EXPO_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';

/**
 * Native PostHog client. Constructed once at module init when an API key is
 * present, otherwise null — every facade call short-circuits via `isEnabled`.
 *
 * Defaults are tuned for cost and bundle weight:
 *   - flushAt: 20 / flushInterval: 30s   → batches network into one POST per
 *                                           ~30s, avoiding chatty connections
 *   - captureAppLifecycleEvents: false   → we emit `app_started` /
 *                                          `app_returned` ourselves with
 *                                          richer properties
 *   - enableSessionReplay: false         → replay is heavy on mobile and
 *                                          fragments user trust on a finance app
 *   - disableSurveys: true               → surveys aren't part of this milestone
 */
const client = KEY
  ? new PostHog(KEY, {
      host: HOST,
      flushAt: 20,
      flushInterval: 30000,
      captureAppLifecycleEvents: false,
      enableSessionReplay: false,
      disableSurveys: true,
    })
  : null;

// PostHog's PostHogEventProperties is a JSON-shaped type. The facade uses
// Record<string, unknown> at its public boundary because callers shouldn't
// have to import a vendor-specific type to track an event. We cast at the
// SDK call sites — non-JSON values would be silently dropped by PostHog's
// own serializer, which is the same behaviour the cast preserves.
function toEventProps(properties: Record<string, unknown> | undefined): PostHogEventProperties | undefined {
  return properties as PostHogEventProperties | undefined;
}

export const analytics: AnalyticsClient = {
  isEnabled: client !== null,
  track(event, properties) {
    client?.capture(event, toEventProps(properties));
  },
  identify(distinctId, properties) {
    client?.identify(distinctId, toEventProps(properties));
  },
  reset() {
    client?.reset();
  },
  captureException(error, properties) {
    if (!client) return;
    if (error instanceof Error) {
      client.captureException(error, toEventProps(properties));
      return;
    }
    client.capture('$exception', toEventProps({
      $exception_message: typeof error === 'string' ? error : JSON.stringify(error),
      ...properties,
    }));
  },
};

export default analytics;
