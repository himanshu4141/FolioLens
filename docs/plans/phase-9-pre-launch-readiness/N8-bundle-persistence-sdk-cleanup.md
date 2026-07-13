# Navigation N8 — Bundle, persistence, and SDK cleanup

## Goal

Trim first-route evaluation and restore work after the earlier navigation fixes by reducing avoidable bundle imports, narrowing native React Query persistence to data that is not already owned by SQLite, and aligning Expo SDK 55 patch versions.

## User Value

Users should get a smaller release payload, faster cold-route evaluation, and less native cache-restore pressure without losing the signed-in session, Portfolio, Funds, Fund Detail, Money Trail, or Settings behavior proven by the previous milestones.

## Context

The accepted navigation audit lives on `origin/codex/app-navigation-performance-audit` and is read-only for this program. Sections 7, 8, and 11 identify the final optimization layer:

- bundle weight from barrel imports, eager About feedback code, chart imports, and a Portfolio mobile/desktop require cycle;
- a native React Query persister that duplicates raw arrays already stored in SQLite;
- SDK 55 patch versions behind Expo's recommended set.

This branch is `program/n8-bundle-persistence-sdk-cleanup`, created from `origin/main` after the N7 merge `684675515522019d882c428c19d96490e94f6ce8`. PR #250 is the mutable program control plane. The research report must not be edited during N8.

## Assumptions

- Native SQLite remains the durable source for raw transaction, NAV, and index-history data.
- React Query persistence may keep small derived summaries needed for instant first paint, but native should not persist large raw `user-transactions` arrays that SQLite already owns.
- Import-only changes should not alter screen behavior.
- Expo patch alignment must be validated through local gates and PR-preview, because framework patch updates can affect native routing and updates.
- Android exact-OTA evidence on the paired Pixel 8a is required for runtime acceptance. Physical iOS field evidence remains unavailable for this program.

## Definitions

- Bundle reduction: source-level import changes that reduce exported JavaScript/Hermes bytes or asset count without changing behavior.
- Native persister diet: changing the native React Query persistence contract so restored data excludes large SQLite-backed raw arrays.
- Buster: the `__BUSTER__` value in `src/lib/queryClient.ts` that invalidates incompatible persisted React Query blobs.
- Docs-only evidence commit: a final plan/PR-body documentation update after runtime evidence is accepted; it does not change app runtime code and does not require native evidence to be rerun.

## Scope

- Replace broad Ionicons, Inter, and chart barrel imports with supported direct imports.
- Lazy-load the About feedback sheet only when the feedback action is used.
- Remove the Portfolio desktop/mobile require cycle by moving shared shell behavior into a third module.
- On native, exclude raw `user-transactions` from persisted React Query blobs and add restore/persist summary telemetry plus debug per-prefix byte data.
- Bump the React Query persistence buster and update `docs/architecture/cache-surfaces.md`.
- Run `npx expo install --fix`, review package and lockfile changes, and keep the aligned SDK patch set.
- Measure before/after Android and web exports for bundle bytes, asset count, TTF count, and gifted-charts contribution.
- Validate Settings/About, Portfolio, Funds, Fund Detail, and Money Trail on the exact Android PR-preview OTA.

## Out of Scope

- Editing `docs/research/app-navigation-performance-audit-2026-06-30.md`.
- Changing financial formulas, route layout, visual design, auth flows, database schema, or backend data contracts.
- Reworking N5/N6/N7 scheduling, virtualization, Fund Detail transition, or Portfolio benchmark logic.
- Physical iOS field validation, which remains unavailable.

## Approach

The bundle work is kept in a first commit and is limited to import boundaries and module loading. Ionicons imports now use `@expo/vector-icons/Ionicons`; Inter fonts load from direct package subpaths; Fund Detail chart modules import direct `react-native-gifted-charts` entries; About defers `FeedbackSheet`; and Portfolio route selection imports a shared shell instead of creating a desktop/mobile require cycle.

The persistence work is kept in a second commit. Native persistence now skips raw `user-transactions`, while web persistence keeps the previous shape. The buster moves to `v11` because the native persisted contract changed. Restore telemetry records blob bytes, query count, per-prefix estimated bytes, duration, and buster; the cache debug data model exposes serialized bytes per prefix.

The SDK alignment work is kept in a third commit. `npx expo install --fix` aligns SDK 55 patch versions, adds the required config plugins, and keeps `babel-preset-expo` explicit so production export works without depending on hoisting.

## Alternatives Considered

- Replacing chart libraries entirely was rejected for N8 because supported direct chart subpaths produced measurable source-map reduction without a behavior rewrite.
- Removing all React Query persistence was rejected because small derived summaries still help first paint and prior milestones rely on warm caches.
- Keeping the old buster was rejected because native persistence no longer accepts the same raw transaction payload.
- Folding SDK alignment into the import commit was rejected because framework patch updates need separate attribution if a regression appears.

## Milestones

### 1. Safe bundle/import reductions

Replace supported barrel imports, lazy-load About feedback UI, remove the Portfolio require cycle, and verify exports still build.

Expected outcome: Android/web export size and asset counts drop without changing route behavior.

### 2. Native persister diet and telemetry

Exclude native raw transaction arrays already backed by SQLite, bump the buster, add restore/debug byte summaries, and update tests and cache documentation.

Expected outcome: native persisted React Query payload is smaller and measurable without losing warm derived summaries.

### 3. SDK patch alignment

Run Expo's SDK fix command, review package/lockfile changes, keep required config plugins, and verify local plus PR-preview validation.

Expected outcome: SDK 55 patch recommendations are applied intentionally and production exports still succeed.

### 4. Evidence and PR setup

Capture before/after export metrics, exact Android OTA evidence, and local validation. Add this ExecPlan evidence commit, open the implementation PR, and move N8 to review through PR #250.

Expected outcome: N8 is ready for dual review with exact runtime evidence and no research-report edit.

## Validation

Local validation at runtime commit `38df543dac7d17604c9c47983136d2d676e11bce`:

- `npx expo install --check` passed.
- `npx jest scripts/__tests__/navigation-n6-config.test.ts --runInBand` passed, 1 suite / 9 tests.
- Full Jest passed, 91 suites / 1,946 tests.
- `npm run typecheck` passed.
- `npm run lint` passed with zero warnings.
- `git diff --check` passed.
- Android and web production exports completed before and after N8.
- PR-preview workflow run `29140822276` passed for runtime commit `38df543dac7d17604c9c47983136d2d676e11bce`.

Round-1 review response:

- Claude and Codex both requested the same test-coverage fix for the web-only `user-transactions` persistence branch.
- The batched fix adds a `shouldPersistQueryKey()` regression proving `['user-transactions', userId]` is persisted on web, where there is no SQLite read-through, while the existing native test continues to prove the same key is not persisted on native.
- Focused validation after the review fix: `npx jest src/lib/__tests__/queryClient.test.ts --runInBand` passed, 1 suite / 34 tests.
- Full validation after the review fix: full Jest passed, 91 suites / 1,947 tests; `npm run typecheck` passed; `npm run lint` passed with zero warnings; `git diff --check` passed.
- This review fix changes tests and evidence documentation only. Runtime app code remains the measured implementation `38df543dac7d17604c9c47983136d2d676e11bce`, so the accepted Pixel 8a OTA evidence remains current.

Export measurements:

| Metric | Baseline at `6846755` | N8 at `38df543` | Change |
|---|---:|---:|---:|
| Android Hermes bytes | 6,323,979 | 5,865,690 | -458,289 |
| Android assets | 70 / 17,041,824 bytes | 39 / 8,915,404 bytes | -31 assets / -8,126,420 bytes |
| Android TTF assets | 44 | 13 | -31 |
| Android gifted-charts/core source-map bytes | 856,152 across 52 sources | 668,987 across 32 sources | -187,165 / -20 sources |
| Web JS bytes | 3,380,734 | 2,861,524 | -519,210 |
| Web assets | 59 / 10,372,759 bytes | 28 / 2,185,951 bytes | -31 assets / -8,186,808 bytes |
| Web TTF assets | 37 | 6 | -31 |
| Web gifted-charts/core source-map bytes | 856,152 across 52 sources | 668,987 across 32 sources | -187,165 / -20 sources |

## Exact Android Evidence

- Device: physical Pixel 8a (`akita`), Android 16 / API 36.
- App/channel: `in.foliolens.app.prpreview`, channel `foliolens-pr`.
- Runtime implementation: `38df543dac7d17604c9c47983136d2d676e11bce`.
- PR-preview workflow: green run `29140822276`.
- Android OTA/update ID: `019f4f99-506f-74a9-92ee-4bc0ea601c25`.
- iOS OTA from the same workflow: `019f4f99-506f-7706-b13a-c1c57dd92e7c`.
- In-app About verification: prefix `019f4f99-506`, version `0.0.4`, channel `foliolens-pr`.
- Settings/About rendered after update application.
- Portfolio rendered after clean restart with the signed-in session restored, totals visible, benchmark selector present, and chart content rendered.
- Funds rendered the active-funds list with allocation/search/sort controls.
- Fund Detail opened from a warm Funds row with back action, hero metrics, Performance content, NAV & Facts, and Mix & Weight switching correctly.
- Money Trail rendered summary, filters/search/sort/export controls, and transaction rows.
- Cache debug deep link remained protected by the debug unlock gate; persister byte output is therefore validated by code/tests rather than claimed as field-visible evidence.
- App-scoped log scan after the route evidence found `APP_ERROR_SIGNATURE_COUNT=0` for auth lifecycle, SQLite, storage, React Native fatal, JS application, `TypeError`, `ReferenceError`, and unhandled-promise signatures. A broad `unhandled` scan excluding Android Bluetooth system chatter also returned zero.
- Device screen timeout was restored to its original `120000` ms.

## Risks And Mitigations

- Import subpaths may rely on package internals. N8 uses supported package entry points where available and backs this with production exports plus Jest mapping for the Ionicons test environment.
- Native persistence could drop data needed for first paint. N8 removes only raw `user-transactions` on native; derived summaries and web persistence remain intact, and tests assert the allowlist behavior.
- Buster changes can evict warm data on first launch. This is intentional because the native persisted contract changed; SQLite remains the durable source for raw data.
- SDK patch updates can introduce framework-level regressions. N8 keeps them isolated in a separate commit and validates with local gates, exports, PR-preview, and Android route evidence.
- Debug cache UI requires an unlock gesture. N8 records this as a field-evidence limitation and relies on deterministic tests for the new debug byte model.

## Decision Log

- 2026-07-11: Use direct imports and lazy About feedback loading instead of replacing chart rendering.
- 2026-07-11: Bump React Query persistence buster to `v11` because native no longer persists raw `user-transactions`.
- 2026-07-11: Keep web `user-transactions` persistence unchanged because web does not have the same SQLite-backed native restore path.
- 2026-07-11: Treat the final ExecPlan addition as docs-only evidence after accepted runtime evidence at `38df543dac7d17604c9c47983136d2d676e11bce`.

## Progress

- [x] Read VISION, INFRASTRUCTURE, cache-surfaces, report sections 7/8/11, and Prompt 8.
- [x] Create N8 branch from current `origin/main` after N7 merge and mark PR #250 In progress.
- [x] Implement safe bundle/import reductions.
- [x] Implement native persister diet, telemetry/debug bytes, buster, and tests.
- [x] Align Expo SDK 55 patch versions and review package changes.
- [x] Capture before/after Android and web export measurements.
- [x] Run local validation and green PR-preview workflow.
- [x] Capture exact Android OTA evidence on the Pixel 8a.
- [x] Add this docs-only evidence commit before opening the implementation PR.
