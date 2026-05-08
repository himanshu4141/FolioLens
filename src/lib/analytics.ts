/**
 * Analytics facade — no-op fallback used by Jest (Node testEnvironment).
 *
 * Metro picks `analytics.web.ts` for the web bundle and `analytics.native.ts`
 * for iOS/Android bundles. This bare file is what Node-side code (tests,
 * scripts) imports — every method is a deliberate no-op so test fixtures
 * never accidentally hit a real PostHog endpoint.
 *
 * The platform implementations preserve this exact shape; treat this file
 * as the contract.
 */

export interface AnalyticsClient {
  /** True only when a PostHog API key is set at build time. */
  readonly isEnabled: boolean;
  track(event: string, properties?: Record<string, unknown>): void;
  identify(distinctId: string, properties?: Record<string, unknown>): void;
  reset(): void;
  captureException(error: unknown, properties?: Record<string, unknown>): void;
}

export const analytics: AnalyticsClient = {
  isEnabled: false,
  track: () => {},
  identify: () => {},
  reset: () => {},
  captureException: () => {},
};

export default analytics;
