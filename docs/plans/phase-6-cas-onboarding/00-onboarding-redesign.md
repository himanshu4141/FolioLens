# Phase 6 — CAS Onboarding Redesign (Overview)

> Shared reference for **M1** (`M1-friendly-upload-onboarding.md`) and **M2** (`M2-resend-inbound-auto-refresh.md`). Read this first; each milestone plan only describes the implementation slice it owns.

## Why This Phase

The CAS onboarding shipped with Phase 1 was a single linear page with three numbered steps (PAN → inbound address → request CAS). It worked but it threw three decisions at the user before the portfolio appeared, hid the simplest path (PDF upload) under "alternative", and never explained what a CAS is. Phase 6 replaces it with a friendly four-step wizard that leads with the fastest option (upload), explains the jargon in plain language, and treats the email-forwarding inbox as an optional advanced setup rather than the default route.

## What "CAS" Means In Plain Language

CAS stands for Consolidated Account Statement. India has two registrar-and-transfer agents (RTAs): CAMS and KFintech. Between them they run accounting for ~95% of mutual fund AMCs. A CAS is a free PDF a user can request from either RTA (or from MFCentral / CDSL / NSDL) that lists every mutual fund holding the user owns across every AMC, plus every transaction.

The PDF is password-protected. CAMS/KFintech use the user's PAN as the password. CDSL/NSDL use PAN + DDMMYYYY of birth.

There is no API for CAS. The user must request it through one of the portals and it lands in their email a minute or two later.

## The User Journey (target end state)

> **2026-05-20 refresh.** The original M1 wizard shipped a 4-step linear flow (Welcome → Identity → Import → Done) with copy that exposed CAS / RTA / CAMS / KFintech / CDSL / NSDL acronyms and asked for a "CAS request email" up front. Beta feedback was that the screens still felt confusing and wordy. The journey below is the Direction A redesign that landed via the Claude Design handoff (`onboarding-journey-redesign`) — same four-state state machine underneath, fundamentally different surface. The legacy journey is preserved in `M1-friendly-upload-onboarding.md` under the 2026-05-20 amendment.

### First-run user (no `pan` saved)

1. User opens FolioLens, signs in.
2. **Welcome (A1)** — drop-zone hero. "Let's find your mutual funds." Single primary action: drop a PDF (or tap to browse). Secondary door: "Don't have one yet? Get it in 2 mins →". Top-right "Skip" exits to the empty dashboard. Privacy footer: "Read-only · Encrypted · Never shared".
3. The user takes one of three paths:
   - **Drops a PDF** → advances to Identity (A3).
   - **Taps "Get it in 2 mins"** → advances to Import (A2).
   - **Taps Skip** → exits to the dashboard.
4. **Identity / Unlock (A3)** — "One last detail to unlock your statement." PAN (required, used as the default PDF password), DOB (optional, "Some demat statements need this too"), and a "My PDF uses a different password" reveal that overrides PAN-as-password when checked. Once saved, **PAN and DOB become immutable** (see "PAN / DOB are write-once" below). On submit: upserts the profile, uploads the PDF, advances to Done.
5. **Import / Get-a-statement (A2)** — only reached when the user doesn't have a PDF on hand. "Which apps do you use?" with three tiles:
   - **Zerodha, Angel One, ICICI Direct, HDFC Sec…** (demat — routes to CDSL/NSDL portals). Pre-selected by default.
   - **Groww, Kuvera, INDmoney, or fund house apps** (non-demat — routes to CAMS/KFintech portals).
   - **A bit of both** (combined portal list).
   A soft callout below the tiles confirms what we inferred ("Got it — your funds are in a demat account."). Primary CTA "Open the form ↗" advances to the portal list; secondary "I'll upload one I already have" returns to Welcome.
6. **Done (A4)** — "You're in." with imported fund / transaction counts, a top-4 fund preview pulled from the live portfolio (real names + per-fund XIRR), and an honest auto-forward nudge ("Skip the upload next time. Every time a new statement lands in your email, forward it to your private FolioLens address — we'll pull in the new transactions automatically.").

The user never sees CAS / RTA / CAMS / KFintech / CDSL / NSDL / SOA / Demat anywhere on the wizard surface. Internal routing decisions are made from the app-family tile.

### Returning user (Settings → Refresh portfolio)

When a user with `pan` already saved enters the wizard from Settings → Refresh portfolio:

- **Welcome (A1) still renders** — it is the meaningful action (drop-zone), not an intro. The user picks a PDF and the wizard fast-paths past Identity directly to upload (the server uses saved PAN + DOB as the default password).
- Identity (A3) is reached only when the user explicitly deep-links via Settings → Edit identity (`?mode=identity`) — that renders the locked PAN / DOB fields with the existing "Request correction" path. There's no password reveal in review mode and the action button is "Done".
- Done (A4) on success returns to the Portfolio tab; if auto-forward isn't set up yet, the success-screen nudge routes the user to the AutoRefreshSetup screen (Direction B).

The Identity step never re-prompts for a saved PAN. Editing PAN / DOB is intentionally not exposed in the UI: PAN is the password to the user's CAS PDF, and a wrong PAN silently breaks every future import. If a user genuinely needs to change either field (rare — different family member, data-entry typo), we handle that via a pre-filled bug-report sheet routed through the user-feedback table for human review. The previously-captured "CAS request email" field has been dropped from the onboarding surface — the auth email is what users supply to portal forms anyway.

### PAN / DOB are write-once

- PAN: required during first-run Identity step; rendered as a locked read-only display thereafter (with a "Saved" badge), in both the wizard and Settings → Account.
- DOB: optional during first-run; if saved, locked thereafter; if skipped, can still be added later (write-once, not edit-once). Settings → Account shows an "Add" button only when `dob is null`; once set, the row becomes a read-only display.
- The wizard auto-completes Step 2 when both fields are already populated and routes the user to Step 3.

No WebView wrapping a third-party portal at any point. The Phase 4 attempt at that (PR #75) was closed. We use `expo-web-browser` (SFSafariViewController on iOS, Chrome Custom Tab on Android) for portals on native, and `Linking.openURL` for web — both return the user to FolioLens cleanly.

## Visual Hierarchy

- Each onboarding step is a full-bleed `ClearLensScreen`.
- Top bar: back chevron + progress + right-side action. Progress only renders on Identity (A3) and Done (A4) as a 3-pill indicator — Welcome (A1) and Import (A2) are unframed entry points (no progress) per the wireframe. Welcome's right-side action is a "Skip" link; on every other step it's an empty slot.
- Body: one focused decision per screen (no walls of text). Eyebrow (label, emerald, ALL CAPS) + H1 + short body where applicable, matching the Clear Lens title-block pattern documented in `DESIGN.md`.
- Bottom: primary CTA (filled emerald), secondary CTA when applicable (subdued text link).
- Soft callouts: dashed mint border on a `positiveBg` surface — used for "Got it — your funds are in…" on A2 and the auto-forward nudge on A4.

## Theme & Layout Reality (post-PR #95 + #97)

The wizard ships into a codebase that now has **dark mode** and a **desktop shell**. Both M1 and M2 must honour:

### Theming (PR #97 — dark mode, classic theme retired)

- The token source of truth is `src/constants/clearLensTheme.ts`. It exports `ClearLensLightTokens`, `ClearLensDarkTokens`, and a `getClearLensTokens(scheme)` factory.
- Components consume tokens via `useClearLensTokens()` (or `useTheme()` for the full context) from `src/context/ThemeContext`.
- **No hardcoded color literals.** Reaching for `ClearLensColors.X` (the legacy light-only constant) breaks dark mode silently — the import still resolves but the value is fixed to the light scheme. Use `tokens.colors.X` instead.
- Module-level `StyleSheet.create({...})` captures tokens once and cannot react to a scheme flip. Wrap styles in `function makeStyles(tokens)` and call via `useMemo(() => makeStyles(tokens), [tokens])`. The route stack already remounts on toggle via `key={resolvedScheme}`, so any module-scope styles still in flight will reset cleanly — but the wizard should not rely on that.
- Test every screen in light, dark, and system mode before raising the PR. Watch for: progress pills (active vs idle), portal cards on the dark scheme (`heroSurface` instead of `navy`), hero badge backgrounds, error banners, success banners, the green CTA.

### Desktop layout (PR #95 — desktop shell)

- At ≥1024 px the app renders a Clear Lens sidebar instead of bottom tabs. New responsive primitives live in `src/components/responsive/`.
- The wizard wraps in `<DesktopFormFrame>`. On desktop this centers the wizard in a 720 px column inside the sidebar shell; on mobile it renders the children unchanged.
- `app/onboarding/_layout.tsx` already suppresses the Stack header on desktop (the wizard provides its own hero). No change needed there.
- The wizard's `KeyboardAvoidingView` is a no-op above 1024 px. Confirm no layout regression at the breakpoint crossing.

## Copy Catalog (canonical)

The 2026-05-20 refresh moves the wizard onto plain-English copy that hides every acronym (CAS, RTA, CAMS, KFintech, CDSL, NSDL, SOA, Demat). The strings below are the shipped surface; treat them as the source of truth and update this catalog whenever the in-app copy changes.

**Welcome (A1)**

- Eyebrow: "Welcome"
- Title: "Let's find your mutual funds."
- Body: "We just need one document — your portfolio statement. It's a free, official PDF that lists every fund you own."
- Drop-zone title: "Drop your statement here"
- Drop-zone hint: "PDF · or tap to browse"
- Secondary link: "Don't have one yet? Get it in 2 mins →"
- Privacy footer: "Read-only · Encrypted · Never shared"

**Import / Get-a-statement (A2)**

- Title: "Get your statement"
- Body: "One question, then we'll send you to the right form."
- Section label: "Which apps do you use?"
- Tile 1 — title: "Zerodha, Angel One, ICICI Direct, HDFC Sec…" / detail: "Apps where you also buy stocks"
- Tile 2 — title: "Groww, Kuvera, INDmoney, or fund house apps" / detail: "Mutual funds only — no stock account"
- Tile 3 (dashed) — title: "A bit of both" / detail: "We'll help you get both statements"
- Soft callout: "Got it — your funds are in `<a demat account | a folio / SOA account | a mix — we'll show you both forms>`. We'll open the right form for you next."
- Primary CTA: "Open the form ↗"
- Secondary CTA: "I'll upload one I already have"

**Identity / Unlock (A3)**

- Eyebrow: "Almost there" (review mode: "Your details")
- Title: "One last detail to unlock your statement." (review mode: "PAN and date of birth on file.")
- Body: "We'll try your PAN as the password first — that works 99% of the time."
- Field 1 label: "PAN", hint: "10 characters · used to unlock the PDF."
- Field 2 label: "Date of birth · optional", hint: "Some demat statements need this too."
- Password reveal: "My PDF uses a different password" / "If you set a custom one while requesting it (CAMS / KFintech allow this)."
- Privacy line: "Encrypted at rest. Never shared with third parties."
- Primary CTA: "Unlock my statement" (review mode: "Done")
- Correction links (when PAN/DOB are locked): "Wrong PAN? Request correction" / "Wrong date? Request correction"

**Done (A4)**

- Title: "You're in." (skip path: "We'll be here when you're ready" · auto-forward-only path: "Auto-refresh is ready")
- Body (imported): "We pulled in `<N>` funds across `<M>` transactions."
- Auto-forward nudge title: "Skip the upload next time"
- Auto-forward nudge body: "Every time a new statement lands in your email, forward it to your private FolioLens address — we'll pull in the new transactions automatically."
- Auto-forward nudge link: "Set it up →"
- Primary CTA: "See my dashboard" (skip path: "Open FolioLens")

**Auto-refresh setup (Direction B / `AutoRefreshSetup`)**

- Eyebrow: "Your portfolio inbox"
- Title: "Skip the upload from now on."
- Subtitle: "Whenever a new statement lands in your email, forward it to the address below. We'll pull in the new transactions automatically — no need to download or upload anything."
- Address label: "Your private FolioLens address"
- Step 1: "One-time: set up a Gmail or Outlook filter that auto-forwards CAMS / KFintech statement emails to this address."
- Step 2: "From then on, every new statement flows in by itself — we'll add anything new to your portfolio."

The framing here resolves the auto-forward feasibility question from the original draft: setup is one-time (the filter), but **the user does not need to do anything to forward each subsequent statement** — the filter handles it. The earlier "Open question (M2)" about Gmail's destination verification is now answered by `AutoRefreshSetup`'s Gmail tab, which surfaces the verification link captured by the Resend Inbound webhook back to the user.

## Analytics Events (PostHog)

The 2026-05-20 refresh keeps the four original funnel events stable so existing PostHog funnels keep working, and adds nine more to cover the new decisions, failure modes, and design-validation signals. Event names and dimension values are stable — adding a new bucket is fine, renaming an existing one invalidates historical filters, so don't.

| Event | Where it fires | Properties |
|---|---|---|
| `onboarding_started` | first non-done step rendered | `entry_point: 'fresh_install' \| 'returning_anon'` |
| `onboarding_step_completed` | leaving any step | `step, step_index` |
| `onboarding_completed` | entering done | — |
| `portfolio_imported` | upload server returns 2xx | `source: 'cas_pdf', funds_count, transactions_count` |
| `onboarding_skip_clicked` | top-right Skip on Welcome | `step, step_index, is_returning_user` |
| `onboarding_pdf_picker_dismissed` | OS file picker closed without a file | `is_returning_user` |
| `onboarding_path_chosen` | first commit on Welcome (one-shot per session) | `path: 'upload' \| 'request_cas', is_returning_user` |
| `portfolio_import_failed` | upload throws | `source: 'cas_pdf', error_kind: 'read_error' \| 'auth_error' \| 'network_error' \| 'parser_error', had_password_override, elapsed_ms` |
| `onboarding_password_override_used` | upload attempted with a custom PDF password | `succeeded`, plus `error_kind, elapsed_ms` on failure |
| `onboarding_app_family_selected` | "Open the form ↗" tapped on A2 | `family: 'demat' \| 'nonDemat' \| 'both', was_default: boolean` |
| `onboarding_portal_opened` | portal tile tapped on A2's sub-screen | `portal_id, portal_kind: 'rta' \| 'depository', app_family` |
| `onboarding_auto_refresh_setup_completed` | user marks auto-forward ready | `is_returning_user` |
| `onboarding_done_nudge_clicked` | "Set it up →" tapped on A4 | — |

Error categorisation for `portfolio_import_failed` is centralised in `categorizeUploadError(message)` in `app/onboarding/index.tsx` — extend the helper rather than inlining new buckets so the dimension stays consistent across the analytics event, the user-facing error fallback, and console logs.

## Out of Scope

- Native push notifications when a CAS arrives in the inbound webhook (post-Phase 6 nice-to-have).
- Tax-statement parsing or capital-gains reporting.
- Broker / demat integration.
- Re-introducing a WebView around any portal.
- Onboarding-only A/B testing — the wizard ships as the only path.

## Cross-References

- **M1** implements Steps 1–4 minus auto-refresh (Upload + Request paths only). The 2026-05-20 amendment in `M1-friendly-upload-onboarding.md` documents the Direction A redesign on top of M1's state machine.
- **M2** implements the auto-refresh card, the post-import nudge, the per-user inbox token, and the Resend Inbound webhook. The Direction B repaint of `AutoRefreshSetup` ships alongside the M1 amendment.
