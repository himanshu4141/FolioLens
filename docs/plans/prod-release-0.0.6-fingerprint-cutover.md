# Production Release 0.0.6 Fingerprint Cutover

## Goal

Ship the current main branch to production as the `0.0.6` native release train, switch Expo Updates from app-version runtimes to fingerprint runtimes, and keep future JS-only production tags deliverable to users who install the `0.0.6` build.


## User Value

Users get the Tool Hub redesign, data-reliability fixes, and performance work without another silent OTA stranding event. After installing the `0.0.6` build, users should continue receiving later JS-only production releases, such as a `v0.0.7` tag, as long as the native fingerprint does not change.


## Context

The app previously used `runtimeVersion: { policy: 'appVersion' }`. With that policy, changing `app.config.js`'s `version` also changed the EAS Update runtime. Devices only receive updates whose runtime matches the native binary installed on the device, so version-only release bumps could strand existing installs.

PR #148 switched to `fingerprint`, then PR #150 temporarily reverted that change because no fresh native build was available. The intended long-term model is to restore fingerprinting together with a fresh native production build.

On July 13, 2026, production Supabase was behind DEV by 26 local migrations and production Edge Functions were still the May 13 versions. Production Supabase was also missing `OPENFOLIO_API_BASE` and `OPENFOLIO_API_KEY`. Those must be fixed before publishing the app release.


## Assumptions

- The release SHA is the current `origin/main` plus the release-prep change that sets `app.config.js` version to `0.0.6` and runtime policy to `fingerprint`.
- Android internal distribution is the immediate production native target.
- iOS/TestFlight follows the same runtime rule when paid Apple setup is ready.
- Vercel CLI and EAS CLI are authenticated for the operator account.


## Definitions

- Native build: an APK, AAB, or iOS build created by `eas build`.
- OTA update: a JavaScript/assets update published by `eas update`.
- Runtime version: the compatibility value EAS uses to decide whether a native build can run an OTA update.
- Fingerprint: a hash of native-impacting project inputs, including native dependencies, Expo plugins, native-facing app config, and native assets.
- Native train: the installed app version and fingerprint baseline, for example `0.0.6`.


## Scope

- Set the `0.0.6` release config.
- Apply production Supabase migrations and Edge Functions before app rollout.
- Run production universe backfill.
- Build and distribute a new production binary that establishes the fingerprint baseline.
- Tag and publish the production OTA/web release.
- Document the future release invariant.


## Out of Scope

- App Store or Play Store public submission.
- Changing the Supabase deployment workflow topology.
- Cleaning legacy non-blocking env vars.


## Approach

Use a two-gate release:

1. Infrastructure gate: production Supabase schema, functions, secrets, and backfill must be current.
2. App gate: the `0.0.6` native production build must be built from the release config and installed/distributed before relying on tag-triggered OTAs.

After this cutover, do not bump `app.config.js`'s `version` for JS-only production tags. A future `v0.0.7` tag can publish an OTA to `0.0.6` installs only if the fingerprint is unchanged. If the fingerprint changes, bump the native app version and build a new native train first.


## Alternatives Considered

- Keep `appVersion` policy: rejected because it preserves the release-tag/runtime coupling that caused stranded installs.
- Publish `v0.0.6` as OTA only: rejected because existing production builds use app-version runtimes and cannot receive fingerprinted updates.
- Bump `app.config.js` version on every git tag: rejected because local fingerprint testing showed changing only `version` from `0.0.6` to `0.0.7` changes the Android fingerprint.


## Milestones

1. Prepare release config.

   Expected outcome: `app.config.js` has `version: '0.0.6'` and `runtimeVersion.policy: 'fingerprint'`.

   Commands:

       npm exec --yes expo config -- --type public --json | jq -r '.version, .runtimeVersion.policy'
       npx fingerprint fingerprint:generate --platform android | jq -r '.hash'

   Acceptance criteria: output shows `0.0.6`, `fingerprint`, and a recorded fingerprint hash for the release notes.

2. Bring production Supabase current.

   Expected outcome: production has all migrations through `20260624000000`, current Edge Functions, and required OpenFolio secrets.

   Commands:

       supabase secrets list --project-ref ohcaaioabjvzewfysqgh
       supabase link --project-ref ohcaaioabjvzewfysqgh
       python3 scripts/check_supabase_migration_parity.py
       supabase db push --yes
       supabase functions deploy --project-ref ohcaaioabjvzewfysqgh --no-verify-jwt --use-api

   Acceptance criteria: `OPENFOLIO_API_BASE` and `OPENFOLIO_API_KEY` are present, migration parity has no remote drift, and production functions include `demo-signup`, `openfolio-sync`, `universe-backfill`, `nav-retention`, and `freshness-check`.

3. Run production universe backfill.

   Expected outcome: production fund universe metadata and compositions are populated for the current app.

   Commands:

       gh workflow run universe-backfill.yml --ref main -f environment=prod -f phase=both -f force=true

   If work remains, repeat with:

       gh workflow run universe-backfill.yml --ref main -f environment=prod -f phase=both -f force=false

   Acceptance criteria: the workflow completes successfully and follow-up runs report no remaining required work.

4. Build the `0.0.6` native production baseline.

   Expected outcome: EAS has a successful production Android build with app version `0.0.6`, channel `foliolens-production`, and runtime equal to the new fingerprint runtime.

   Commands:

       eas build --profile production --platform android --non-interactive
       eas build:list --platform android --status finished --limit 5 --json |
         jq -r '.[] | select(.buildProfile=="production") | [.createdAt, .appVersion, .runtimeVersion, .fingerprint.hash, .gitCommitHash[0:8], .id] | @tsv' |
         head -1

   Acceptance criteria: the latest production build is from the release SHA, shows app version `0.0.6`, and is installed on the test device before smoke testing.

5. Tag and publish the production release.

   Expected outcome: GitHub Actions publishes the production OTA update and Vercel production deployment for `v0.0.6`.

   Commands:

       git fetch origin --tags
       git tag v0.0.6 origin/main
       git push origin v0.0.6
       gh run list --workflow production-release.yml --limit 1
       gh run watch <run-id>

   Acceptance criteria: `production-release.yml` is green, EAS production update appears on `foliolens-production`, Vercel production serves the new web app, and GitHub Release `v0.0.6` exists.

6. Smoke test and prove future OTA continuity.

   Expected outcome: the installed `0.0.6` production build runs the `v0.0.6` update and can receive a later same-fingerprint update.

   Commands:

       eas update:list --branch foliolens-production --platform android --limit 3

   Acceptance criteria: Settings About shows the new update ID, core app flows work against production, Supabase logs are clean, and the recorded fingerprint matches the installed production build.


## Validation

- `npm run typecheck`
- `npm run lint`
- `npm exec --yes expo config -- --type public --json | jq -r '.version, .runtimeVersion.policy'`
- `npx fingerprint fingerprint:generate --platform android | jq -r '.hash'`
- `eas build:list --platform android --status finished --limit 5 --json` after the production build
- `eas update:list --branch foliolens-production --platform android --limit 3` after the tag release


## Risks And Mitigations

- Risk: existing `0.0.4` production installs cannot receive the fingerprinted `0.0.6` OTA. Mitigation: distribute/install the new `0.0.6` native build as the cutover artifact.
- Risk: a future JS-only tag bumps `app.config.js` version and changes the fingerprint. Mitigation: leave `app.config.js` version unchanged for JS-only tags and compare fingerprints before tagging.
- Risk: app JS ships before production database/functions are ready. Mitigation: complete Supabase migration, function deploy, and universe backfill before tag.
- Risk: production migrations are not easily reversible. Mitigation: take a Supabase production backup before `db push`.


## Decision Log

- 2026-07-13: Restore fingerprint runtime policy for the `0.0.6` cutover because a fresh native build is now part of the rollout.
- 2026-07-13: Treat `app.config.js` version as a native-train version, not a per-tag release number. Local fingerprint testing showed a version-only change from `0.0.6` to `0.0.7` changes the Android fingerprint.


## Progress

- [x] Inspected PR #196, PR #148, and PR #150 release-policy history.
- [x] Confirmed latest production Android build is still app/runtime `0.0.4`.
- [x] Updated release config to `0.0.6` plus fingerprint runtime policy.
- [x] Documented the fingerprint release invariant.
- [ ] Set missing production OpenFolio Supabase secrets.
- [ ] Apply production Supabase migrations and Edge Functions.
- [ ] Run production universe backfill.
- [ ] Build and install the `0.0.6` production Android binary.
- [ ] Tag and publish `v0.0.6`.
- [ ] Smoke test production and record rollback artifacts.
