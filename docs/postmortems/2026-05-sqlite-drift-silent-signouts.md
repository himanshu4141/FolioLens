# Postmortem — "5 transactions in the middle" (May 2026)

A real user-reported bug that touched five of the cache surfaces in [`docs/architecture/cache-surfaces.md`](../architecture/cache-surfaces.md). Worth a dedicated writeup because (a) the symptom looked like a cache bug but the root cause was upstream of every cache, and (b) the investigation produced ~70% of the in-app debug surface and ~all the new sync telemetry we now ship.

## Symptom

User opens the app. Portfolio renders the correct value for ~1 second, then flips to a wrong (lower) value. Money Trail filtered to one fund shows **5 transactions from the middle of the user's history** — neither the oldest rows nor the most recent. Pull-to-refresh doesn't help. Signing out and back in repairs the state, but the bug recurs hours later.

Server data for the user (per a Supabase Studio SQL query at the time): 547 + 3 + 1 = **551 transactions across 3 CAS imports**. Local SQLite, intermittently: **47 / 75 / 168 transactions** depending on when you looked.

## What it looked like

Two surfaces appeared broken:

1. **SQLite `tx` table** (surface #6 in the inventory) was sometimes a strict subset of the server. The watermark-gated sync (max `created_at` from local rows) couldn't see the missing rows because it only filters `created_at >= watermark` — older missing rows fall on the wrong side of the filter, newer missing rows on the wrong side of *anything*.
2. **React Query persisted cache** (surface #1) had the correct portfolio numbers from a prior healthy session. The "correct briefly, then wrong" flicker was the persister rehydrating with the right blob → React Query staleTime ticking past → refetch reading from the partial SQLite → cache overwritten with wrong derived data.

Three hypotheses ranked at investigation start:

- **H1 — 401 → sign-out cascade race.** `clearLocalDb()` fires from SIGNED_OUT *fire-and-forget*; if SIGNED_IN follows quickly the bootstrap reads SQLite mid-wipe. The global 401 handler in `queryClient.ts` is the suspect trigger.
- **H2 — Pre-existing partial state from older builds.** Pre-PR #175 bootstrap skipped tx sync when SQLite had rows; any drift from then could sit silently behind a fresh React Query persisted cache for days.
- **H3 — Pagination / Supabase response edge case.** Unlikely but cheap to rule out via the in-app debug surface.

## Investigation: the data ruled out H1

First PostHog export (7 days, May 12–19): **zero `auth_session_invalidated` events** but **8 `$identify` events with distinct anonymous IDs** — meaning the user was *signed out and back in 8 times in 5 days* without our 401 handler firing. The Supabase SDK was emitting SIGNED_OUT directly, bypassing our query/mutation error handlers entirely.

Cross-referenced `query:userTransactions` row counts at each cold launch:

```
May 16  13:11  $identify   →  cache: 550 from supabase
May 16  13:13  cache: 168 from sqlite          ← DROPPED 2 min later
May 17  00:02  $identify   →  cache: 551 from supabase
May 17  07:07  cache:  47 from sqlite          ← DROPPED ~7h later
May 18  13:58  $identify   →  cache: 551 from supabase
May 18  22:14  cache:  75 from sqlite          ← DROPPED ~8h later
```

That shape — healthy 551 immediately after sign-in, partial subset hours later — is exactly the race in H1. But the SIGNED_OUTs themselves weren't coming through our 401 handler. So the proximate cause was H1, but the **upstream trigger** for it was something else firing SIGNED_OUT silently.

## Root cause

**`src/lib/supabase.ts` was missing the React Native AppState handlers Supabase's docs require for the auth client.** On native, the SDK schedules access-token refreshes via `setTimeout`, which pauses when the JS thread suspends in the background. On foreground, the SDK only attempts to refresh when something touches the auth state — and if that refresh fails for any reason (transient network, refresh-token reuse race against a parallel query, rotated token, clock skew, "Detect Compromised Refresh Tokens" tripping), **the SDK emits SIGNED_OUT directly** instead of throwing into a query handler.

That's why no `auth_session_invalidated` event ever fired: no PostgREST request ever returned a 401 because the SDK signed the user out before any query went out. The 8 silent sign-outs were 8 background-resume refresh failures, each one firing SIGNED_OUT → race → partial SQLite → user sees wrong portfolio next morning.

## The fix chain

| PR | Role | What it does |
|---|---|---|
| #177 | Telemetry-first | New events on the cleanup pipeline: `db_clear_local_db_started/_completed/_failed`, `db_sync_bootstrap_started.local_tx_count_before`. Made the cascade reconstructible end-to-end before changing any behaviour. |
| #179 | **Root cause** | `AppState.addEventListener('change', …)` → `supabase.auth.startAutoRefresh()` on foreground, `stopAutoRefresh()` on background. Per Supabase's own React Native guidance. |
| #181 | Telemetry-first (persister) | Enriched `persister_restore_failed` with `error_name` / `error_message` / `blob_size_bytes`. New `persister_write_failed` event for previously-invisible write failures. |
| #182 | Debug surface | Read-only `/settings/cache-debug` screen behind a 7-tap-on-version unlock. Every cache layer + drift + persister blob inspection in one panel. Mainly useful for the *next* bug in this class. |
| #178 | Proximate race fix (defence in depth) | `pendingSignOutCleanup` promise serialises SIGNED_OUT cleanup before any subsequent SIGNED_IN bootstrap reads SQLite. Cheap, no perf cost when the gate isn't engaged. |
| #176 | Recovery (defence in depth) | Cheap HEAD count check on every cold launch; full pull only when local ≠ server. Repairs any pre-fix users still stuck in partial state. |

## Confirmation in production

Second PostHog export (8 days, May 21–28, after #179 deployed):

| Metric | Pre-fix (5 days) | Post-fix (8 days) |
|---|---|---|
| `$identify` (silent sign-outs proxy) | 8 | **0** |
| `db_clear_local_db_started` | n/a | **0** |
| `db_sync_bootstrap_started.local_tx_count_before` | 47 / 75 / 168 between healthy 551s | **551 every cold launch, 27 events in a row** |
| `db_sync_complete.tx_inserted` | sporadic non-zero | **0 every cold launch** |
| `persister_restore_failed` / `_write_failed` | 5 in 7 days, no payload | **0** |

Complete elimination of the upstream cause. Every downstream symptom went silent.

## Lessons for the bug taxonomy

The cascade exercised one taxonomy class we hadn't really written up:

> **Class M — Upstream SDK firing cache-invalidation events outside our error pipeline.** Our 401 handler covers the *predictable* invalidation path (query rejects with auth error → sign out → cleanup). A SDK-internal SIGNED_OUT bypassed that entirely, and the cleanup it triggered raced with whatever ran in response to the corresponding SIGNED_IN. The next time we integrate any auth/state SDK, add a checklist item: *what events can this SDK emit that don't go through our error handlers, and what cleanups do those events trigger?*

Surface #5 (Supabase auth session) should carry a corresponding watchlist entry: **M — SDK-driven SIGNED_OUT without AppState pairing** (fixed in #179).

## Suggested PostHog alert post-resolution

`db_sync_bootstrap_started` where `local_tx_count_before > 0` AND there exists a `db_sync_complete` event within 60s for the same user with `tx_inserted >= 5`. Fires the moment any new drift appears in the field — we'd see a regression before a user reports it.
