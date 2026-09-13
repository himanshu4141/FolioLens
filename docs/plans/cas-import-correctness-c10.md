# C10 Manual CAS Password Access

## Goal

Make the existing optional custom PDF password available to every manual CAS upload, including returning users whose PAN is already saved, while preserving the current password attempts when the field is left blank.

## User Value

CAMS can issue statements whose password is not the user's PAN. A returning FolioLens user must be able to enter that password before the first upload attempt instead of having the app immediately submit the PDF with the saved PAN. Users whose statements still use the existing password rules should see no parsing or password-order change.

## Context

The client helper in `src/utils/casPdfUpload.ts` already accepts an optional password and sends it to the dev Edge Function only when the trimmed value is non-empty. The Edge Function in `supabase/functions/parse-cas-pdf/index.ts` already treats that override as exclusive; without it, the existing saved-PAN and eligible PAN-plus-date-of-birth attempts remain unchanged.

Both `app/onboarding/index.tsx` and the legacy standalone `app/onboarding/pdf.tsx` render a custom-password input. The active Settings manual-upload route uses the onboarding wizard. In that wizard, `handlePdfPicked` immediately uploads when `user_profile.pan` exists, so returning users never reach the unlock step that contains the custom-password control. This is the C10 defect.

## Assumptions

- C10 changes the manual direct-upload experience only.
- Inbound email import has no interactive password field and remains unchanged.
- The custom password is sensitive transient input. It is never persisted, logged, added to analytics, included in error text, or committed.
- All deployment and field validation is dev-only. Production remains out of scope.
- The current direct-upload parser contract and password fallback behavior are correct when no override is supplied.

## Definitions

- **Manual upload:** a signed-in user selects a CAS PDF from the onboarding import flow.
- **Unlock step:** the wizard screen that shows saved identity details and the optional custom-password control before upload.
- **Password override:** a non-empty custom PDF password supplied by the user for one upload attempt.
- **Default attempts:** the current server behavior used when no override is supplied: saved PAN first and an eligible PAN-plus-date-of-birth attempt where supported.

## Scope

- Route every selected manual-upload PDF through the unlock step before network upload, even when PAN is already saved.
- Keep saved PAN and date of birth locked for returning users; do not make identity fields editable as part of C10.
- Preserve the optional reveal control and blank-field fallback behavior.
- Clear the transient custom password after successful upload and when the user backs out of the unlock step.
- Correct manual-upload copy that currently states or strongly implies that PAN always unlocks CAMS statements.
- Add focused regression coverage for fresh and returning users selecting a PDF.
- Update the CAS upload architecture documentation to describe the mandatory pre-upload unlock step and transient override boundary.

## Out of Scope

- Any parser, Edge Function, database, import reconciliation, repair, deletion, rollback, hydration, NAV, or inbound-email change.
- Persisting a custom password for future statements.
- Automatic password fallback after a supplied override fails.
- Production deployment or use of the user's private statement during implementation or review.
- The transferred NAV freshness work tracked outside the CAS program.

## Approach

Add a small pure transition helper in `src/utils/onboardingInitialStep.ts` that always selects `identity` after a PDF is chosen. Use it from `app/onboarding/index.tsx` instead of the saved-PAN fast path. Tests will pin that both a fresh user and a returning user reach the unlock step before any upload can begin.

Keep the existing `uploadCasPdf(asset, passwordOverride)` boundary unchanged. The unlock handler will continue to pass `undefined` for an empty or disabled custom-password field, so the server performs the same default attempts as today. A non-empty trimmed value remains the only condition that sends the existing override header.

Clear the password state immediately after a successful import. Update both manual-upload surfaces with accurate issuer-neutral copy and an accessibility label on the password input. Document that the password is transient and that returning users cannot bypass the unlock step.

## Alternatives Considered

- Add a second password input to the welcome drop zone. Rejected because the unlock step already owns identity and password inputs, keyboard behavior, validation, and privacy copy.
- Retry automatically with default attempts after a custom override fails. Rejected because an explicit override is already an exclusive reviewed contract and automatic fallback would broaden password attempts without user intent.
- Change only the standalone `/onboarding/pdf` screen. Rejected because Settings routes manual uploads through `/onboarding`, where the returning-user fast path causes the reported gap.

## Milestones

### Milestone 1: Make the existing password control reachable

Change the post-selection transition so every manual upload reaches the unlock step. Add focused tests for users with and without a saved PAN.

Expected outcome: selecting a PDF performs no upload until the user confirms the unlock step; returning users can reveal and enter a custom password.

Acceptance criteria: the focused transition tests pass, saved identity remains locked, and blank custom-password state still produces `undefined` at the upload helper boundary.

### Milestone 2: Tighten privacy and copy

Clear custom-password state on successful import, retain it only for an immediate failed-attempt correction, add password-input accessibility labels, and replace obsolete PAN-only copy.

Expected outcome: the app accurately explains default versus custom passwords and does not retain the password after completion or navigation away.

Acceptance criteria: no password value appears in persistence, logs, analytics, tests, documentation examples, or diffs; existing diagnostics expose only a boolean override flag.

### Milestone 3: Validate and review

Run focused password/upload/onboarding tests, the full Jest suite, typecheck, zero-warning lint, and diff/privacy checks. Open a frozen-head C10 PR and require independent exact-SHA Codex and Claude convergence, a green Dual-review convergence gate, all required checks, and no actionable reviewer thread before merge.

Expected outcome: the change is proven across native/web helper behavior and the governed CAS review gate.

Acceptance criteria: every listed command exits zero and both reviewers converge on the same full head SHA.

### Milestone 4: Dev field proof and observation

Merge C10, verify the authorized dev/main deployment, and let the owner use the newly received statement through the manual-upload path with a custom password. Record only privacy-safe aggregate outcome/telemetry. Do not use the private statement during code review and do not deploy production.

Expected outcome: the direct-upload path has a non-zero post-fix observation denominator without exposing private statement material.

Acceptance criteria: the dev upload reaches a terminal aggregate result, the password and statement remain private, and the remaining inbound-email observation requirement is reported separately.

## Validation

Run:

    npm test -- --runInBand src/utils/__tests__/onboardingInitialStep.test.ts src/utils/__tests__/casPdfUpload.test.ts src/utils/__tests__/casPdfPasswordHelp.test.ts src/utils/__tests__/onboardingCasUploadDiagnostics.test.ts
    npm test -- --runInBand
    npm run typecheck
    npm run lint
    git diff --check

Expected: all commands exit zero. Focused tests prove that PDF selection always leads to the unlock step, whitespace-only overrides are omitted, non-empty overrides are trimmed and forwarded, diagnostics contain no private input, and existing password-recovery behavior remains unchanged.

Review the base-to-head diff for any literal password, document name, holder data, PAN, folio, account identifier, private path, raw parser response, or exact personal financial value. None may be present.

## Risks And Mitigations

- An extra confirmation step could slow returning users. Their identity remains prefilled and locked, so the step is one explicit tap when no custom password is needed; the added step is necessary to expose the optional password before upload.
- A password could leak through diagnostics. Existing events carry only boolean use and success/failure classification; focused tests and diff review preserve that boundary.
- Changing client flow could accidentally change server attempts. C10 does not modify the upload helper or backend contract, and focused tests pin omission of blank overrides.
- A successful upload could leave sensitive input in component memory. Success and back navigation explicitly clear both the value and reveal state.

## Decision Log

- 2026-09-13: Name this milestone C10 because C9 is already assigned to the separately transferred NAV freshness incident.
- 2026-09-13: Correct the active wizard route instead of adding backend support because the optional override already exists end-to-end.
- 2026-09-13: Require the unlock step for returning users rather than moving password input into the file-selection screen.
- 2026-09-13: Preserve the existing exclusive-override contract and forbid automatic fallback after an explicit password fails.
- 2026-09-13: Focused validation passed 4 suites / 53 tests; full validation passed 115 suites / 2,317 tests, typecheck, zero-warning lint, and diff checks.

## Progress

- [x] Confirm the existing client and backend override contract.
- [x] Identify the returning-user saved-PAN fast path that hides the control.
- [x] Implement the pre-upload unlock transition and focused regression tests.
- [x] Update privacy cleanup, copy, accessibility, and architecture documentation.
- [x] Complete focused and full validation.
- [x] Open C10 implementation PR #313.
- [ ] Complete frozen exact-head Codex and Claude convergence.
- [ ] Merge, verify dev deployment, and complete privacy-safe direct-upload field proof.
