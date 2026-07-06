# Navigation N5 — virtualize Your Funds and Money Trail

## Goal

Keep Your Funds and Money Trail responsive as portfolios grow by rendering only a bounded window of rows. Preserve the current Clear Lens appearance, financial values, filtering, sorting, expansion, navigation, and export behavior.

## User Value

A user with many funds or hundreds of CAS transactions should be able to open these screens, type in search, expand a fund, and tap a row without waiting for every off-screen row to render on the JavaScript thread.

## Context

The accepted navigation audit is stored on `origin/codex/app-navigation-performance-audit` at `docs/research/app-navigation-performance-audit-2026-06-30.md`. Its confirmed finding 4 shows that `ClearLensFundsScreenMobile`, the desktop Funds screen, and `app/money-trail/index.tsx` render complete arrays inside vertical `ScrollView` containers. Each Funds or Money Trail row also recreates a screen-wide style sheet. PR #250 is the program control plane and records N5 as queue item 9.

The implementation branch is `program/n5-virtualize-funds-money-trail`, created from `origin/main` at Auth A0 merge `07c00df529679fe3bffadf3586e7550131f8fcd4`. The research branch is read-only and must not be merged, cherry-picked, or changed.

## Assumptions

- React Native `FlatList` is sufficient; adding FlashList is unnecessary.
- Money Trail transaction rows are variable-height under Android font scaling, so fabricated fixed-height layout math would be unsafe.
- Mobile fund rows have variable height when expanded, so `getItemLayout` would be incorrect there.
- `removeClippedSubviews` is enabled only where physical-platform verification shows no clipping or expansion defect.
- Search remains local component state and filtering uses `useDeferredValue`.

## Definitions

- Virtualization: keeping only a moving window of list rows mounted near the viewport instead of mounting the complete dataset.
- Frozen review head: the exact commit reviewed after `needs-review` or `re-review` is added. No push is allowed until both reviewers finish that round.
- Render isolation: changing one fund's expanded state does not rerender every unchanged fund row.

## Scope

- Replace the mobile Funds vertical `ScrollView` plus `map` with one `FlatList` using header and footer components.
- Virtualize the desktop Funds cards without nesting a same-direction list.
- Replace the Money Trail vertical `ScrollView` plus transaction `map` with one `FlatList`; keep horizontal chip and modal scroll views.
- Create Funds and Money Trail screen styles once per theme at the parent and pass the row styles/tokens required by memoized rows.
- Use stable ID-based handlers and memoized rows.
- Add deterministic 25-fund and 1,000-transaction fixtures that prove bounded initial windows, fixed transaction layout math, and expansion render isolation.
- Validate mobile/desktop, light/dark, search, sort, filters, expansion, fund/transaction navigation, and exact-SHA Android release-like behavior.

## Out of Scope

- Any financial calculation, query key, persisted payload, cache schema, or data-fetching change.
- Fund Detail transition work (N6), portfolio-core splitting (N7), or bundle/persistence cleanup (N8).
- Visual redesign, new list dependency, pagination, or server changes.
- Altering the research report during N5–N8.

## Approach

Define shared virtualization constants and pure helpers in a small library module so the production lists and deterministic fixtures use the same values. Use module-level key extractors where possible.

For mobile Funds, move the title, overview, search/sort controls, and count into `ListHeaderComponent`; move the disclaimer into `ListFooterComponent`. Render a memoized row receiving stable handlers of the form `(fundId) => void`. The row creates its zero-argument press closures only when that row actually renders. Expansion remains single-select and is passed via `extraData`; the memo comparator allows only the previously expanded and newly expanded rows to rerender.

For desktop Funds, use a two-column `FlatList` inside the 1,200 px dashboard width. Keep the summary and controls in the header and preserve responsive card width constraints.

For Money Trail, make the complete screen body one `FlatList`. Put summary, controls, active chips, and the Transactions heading in the list header; use `ListEmptyComponent` for both no-data and no-match states; put the disclaimer in the footer. Preserve the existing minimum row height and omit `getItemLayout` because font scaling makes row height variable. Preserve the scroll-to-top behavior with `scrollToOffset`.

## Alternatives Considered

- FlashList was rejected because FlatList is already shipped, meets the scale requirement, and avoids a dependency and native rebuild.
- Nested FlatLists inside the existing ScrollViews were rejected because same-direction nesting disables reliable virtualization and produces scroll ownership bugs.
- Pagination was rejected because the requirement is smooth local browsing of already-loaded CAS data, not a product behavior change.
- Fixed-height fund rows were rejected because expansion intentionally changes row height.

## Milestones

### 1. Add the shared virtualization contract and fixtures

Add list-window constants and deterministic tests with 25 fund IDs and 1,000 transaction IDs. Add render-isolation comparison coverage showing that a one-fund expansion change invalidates only two row props.

Expected outcome: focused tests fail if a list initial window equals its full fixture or unchanged row props are treated as changed.

### 2. Virtualize Funds mobile and desktop

Replace full-array maps with FlatList, move surrounding content into list headers/footers, pass stable handlers, and remove screen-wide style creation from rows.

Expected outcome: search, sort, expansion, disclaimer, desktop two-column layout, and fund/transaction navigation remain visually and behaviorally equivalent while the initial mounted row count is bounded.

### 3. Virtualize Money Trail

Move the screen body to FlatList, memoize transaction rows, add fixed layout math, and preserve empty/error/loading, filters, sorting, export, navigation, and scroll-to-top.

Expected outcome: a 1,000-row fixture is represented by a bounded initial window and physical-device scrolling does not show gaps, clipping, or broken taps.

### 4. Validate and publish exact-head evidence

Run focused tests, full Jest, typecheck, zero-warning lint, and `git diff --check`. Open the draft program PR, obtain the exact PR-preview OTA, and verify on the paired Pixel 8a using the exact implementation SHA. Check Funds and Money Trail in light/dark where practical, exercise search/sort/filter/expansion/navigation, and record bounded row-mount evidence plus zero React Native fatal, unhandled-promise, auth-lifecycle, storage, or SQLite errors.

Expected outcome: the PR body names device, channel, update ID, and SHA. After evidence is committed, the PR becomes ready and enters the frozen-head dual-review round.

## Validation

Run:

    npm test -- --runInBand <N5 focused suites>
    npm run typecheck
    npm run lint
    npm test -- --runInBand
    git diff --check

Expected outputs are zero TypeScript errors, zero lint warnings, all focused/full tests passing, and no whitespace errors. Native evidence must name Pixel 8a, `foliolens-pr`, the exact OTA/update ID, and the exact implementation SHA.

## Risks And Mitigations

- Variable-height expanded fund cards can produce incorrect jumps if given fabricated layout math. Do not use `getItemLayout` for Funds.
- Clipped subviews can hide expanded content on some platforms. Enable clipping narrowly and verify expansion plus fast scrolling physically.
- FlatList headers can rerender with search input. Memoize derived arrays/header content where it materially avoids work, and rely on deferred search for expensive filtering.
- Memo comparators can hide legitimate updates. Compare the complete row data object, display primitives, expansion state, tokens/styles, and handler identities; tests cover a real data replacement and a genuine expansion change.
- Desktop columns can become too narrow at the 1,024 px breakpoint. Preserve the existing 360 px minimum and verify the sidebar-adjusted content width.

## Decision Log

- 2026-07-06: Use built-in FlatList rather than adding FlashList.
- 2026-07-06: Preserve variable Money Trail row height because Android font scaling makes fixed layout math unsafe; Funds rows are also variable-height.
- 2026-07-06: Keep Funds search local and deferred; do not add a Zustand field or persisted write.
- 2026-07-06: Treat the current financial data and visual design as immutable N5 inputs.

## Amendments

- Money Trail keeps its existing `minHeight: 86` rather than a fixed height and does not provide `getItemLayout`. Android font scaling can increase row height, so fixed offsets would be incorrect and could clip text. This does not weaken virtualization; the list still uses bounded initial, batch, and viewport-window settings.
- PR-preview-only mount diagnostics report only surface name and aggregate active/peak row counts. They emit no fund, transaction, account, or financial identifiers and remain silent on main preview and production.
- Desktop and mobile browser smoke checks used the existing local demo portfolio. They verified the responsive Funds layouts, deferred search, transaction row navigation, and zero browser console errors; exact-SHA Android evidence remains mandatory before review.
- Initial Android evidence at `66af267` exposed blank space below an expanded fund because clipped subviews did not recompute the variable-height row window safely. Omitting the prop at `90f6f43` was insufficient because React Native defaults it to `true` on Android; both OTAs are superseded. Funds and Money Trail now explicitly set `removeClippedSubviews={false}`. Bounded FlatList windows still prevent full-array rendering without risking hidden rows under expansion or font scaling.
- Corrected-head Android acceptance passed on a Pixel 8a running Android 16/API 36 with PR-preview channel `foliolens-pr`, runtime implementation `9c2cb0036264f6574381c59ff1a4d7aaf30f5e41`, and OTA `019f36ba-2965-725e-bb64-313b2d0a6fe9` (About prefix `019f36ba-296`). The 13-row Funds dataset preserved expansion, search, alphabetical sorting, and Fund Detail navigation in dark and light themes with no post-expansion blank rows. The 566-row Money Trail dataset mounted an initial 12 rows and peaked at 30 active rows while preserving search, oldest-first sorting, transaction-type filtering, transaction-detail navigation, rapid scrolling without blank gaps, and scroll-to-top. The final process-scoped log scan found zero React Native fatal, unhandled-promise, auth-lifecycle, SQLite, or storage errors. The temporary Android screen timeout was restored to its original 120000 ms and the prior dark appearance was restored.

## Progress

- [x] Read the N5 report finding/task prompt, VISION.md, DESIGN.md, and docs/SCREENS.md.
- [x] Add shared list virtualization constants, diagnostics, and deterministic large fixtures.
- [x] Virtualize mobile and desktop Funds with memoized rows and stable callbacks.
- [x] Virtualize Money Trail with variable-height rows and memoized stable-ID handlers.
- [x] Run focused validation and update this plan with implementation amendments.
- [x] Run full repository gates: focused 4 suites / 33 tests, full 89 suites / 1,919 tests, typecheck, zero-warning lint, `git diff --check`, and web export.
- [x] Capture corrected exact-SHA Android evidence on Pixel 8a / `foliolens-pr` / OTA `019f36ba-2965-725e-bb64-313b2d0a6fe9` for runtime `9c2cb0036264f6574381c59ff1a4d7aaf30f5e41`.
- [ ] Enter the frozen-head dual-review round.
