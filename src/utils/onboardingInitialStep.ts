/**
 * pickOnboardingInitialStep — picks where the wizard should land on mount.
 *
 * The wizard reads three inputs:
 *   1. The step the user was on last time (from the local draft, if any).
 *   2. What's already saved on `user_profile` (PAN / DOB).
 *   3. A `?mode=` deep-link from a Settings entry-point.
 *
 * The rules:
 *   - `mode=identity` always shows Identity so the user can review locked
 *     fields and request a correction.
 *   - `mode=auto-refresh` jumps straight to Import (where the AutoRefresh
 *     sub-screen lives) as long as PAN is saved. DOB is only needed for
 *     CDSL/NSDL imports, not for Gmail/Outlook auto-forward setup, so we
 *     intentionally do NOT gate this branch on DOB.
 *   - `mode=request-cas` jumps to Import only when both PAN and DOB are
 *     saved — a fresh CAS request from CAMS / KFintech needs both.
 *   - With no mode, fall back to the draft step. The Welcome screen is the
 *     primary entry-point (drop-zone hero), so we don't auto-skip past it
 *     when PAN is already saved — a returning user picks a PDF on Welcome
 *     and the wizard fast-paths the upload itself without showing Identity.
 */

import type { OnboardingStep } from '@/src/utils/onboardingDraft';

export type OnboardingMode = 'auto-refresh' | 'request-cas' | 'identity';

export interface InitialStepInputs {
  draftStep: OnboardingStep;
  pan: string | null | undefined;
  dob: string | null | undefined;
  requestedMode: OnboardingMode | null;
}

export function pickOnboardingInitialStep({
  draftStep,
  pan,
  dob,
  requestedMode,
}: InitialStepInputs): OnboardingStep {
  if (requestedMode === 'identity') {
    return 'identity';
  }
  if (requestedMode === 'auto-refresh' && pan) {
    return 'import';
  }
  if (requestedMode === 'request-cas' && pan && dob) {
    return 'import';
  }
  return draftStep;
}

export function isOnboardingMode(value: unknown): value is OnboardingMode {
  return value === 'auto-refresh' || value === 'request-cas' || value === 'identity';
}
