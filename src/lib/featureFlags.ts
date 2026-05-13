/**
 * Feature flags — build-time resolution.
 *
 * Each flag is read once at JS bundle time from an `EXPO_PUBLIC_*` env
 * var. The EAS channel (production / preview-main / preview-pr) decides
 * which env values get baked into the bundle via `eas.json`. To toggle a
 * flag in prod, change `eas.json` for the relevant channel and republish
 * the OTA update.
 *
 * Why build-time rather than runtime: at this scale (one consumer per
 * flag, low cadence) the simplicity wins. No runtime fetch, no PostHog
 * round-trip on the critical auth path, no RLS to reason about. The
 * trade-off is that toggling requires a rebuild + OTA — acceptable for
 * "ship-readiness" gates like this one.
 *
 * --- Graduation path (when build-time stops being enough) -----------
 *
 * If a flag ever needs to be toggled at runtime — e.g. "enable preview
 * for a specific user once they ask" — layer PostHog feature flags on
 * top WITHOUT removing the build-time floor:
 *
 *   import { PostHog } from 'posthog-react-native';  // already in the app
 *
 *   const buildTimeDefault = process.env.EXPO_PUBLIC_FEATURE_PREVIEW_MODE === 'true';
 *
 *   export function isPreviewModeEnabled(posthog?: PostHog): boolean {
 *     // PostHog override wins when defined; otherwise build-time default.
 *     const override = posthog?.getFeatureFlag('preview_mode_enabled');
 *     if (override === true) return true;
 *     if (override === false) return false;
 *     return buildTimeDefault;
 *   }
 *
 * Keep the build-time default `false` in prod so a missing / misconfigured
 * PostHog flag can never *enable* a feature that prod isn't ready for —
 * the PostHog flag can only override the build-time decision for a
 * targeted cohort. Then identify users in PostHog by email or distinct_id
 * via the existing `analytics.identify()` calls and target the flag at
 * those distinct IDs from the PostHog dashboard.
 */

/**
 * "Preview the app" mode — the demo-signup gated walkthrough using
 * synthetic portfolio fixtures. Off in production until there's real
 * demand or evidence a no-CAS landing is needed.
 */
const previewModeEnabled = process.env.EXPO_PUBLIC_FEATURE_PREVIEW_MODE === 'true';

export const featureFlags = {
  previewMode: previewModeEnabled,
} as const;
