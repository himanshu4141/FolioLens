# Pre-PR Android Evidence Dispatch

## Goal

Allow an implementation branch to publish an exact-commit Android PR-preview OTA before its pull request exists, so required device evidence is present when independent review begins.

## User Value

Reviewers can assess code and acceptance evidence in one pass instead of reviewing a draft, waiting for Android evidence, and repeating the review.

## Context

The `pr-preview.yml` workflow previously triggered only when a pull request opened or received a commit. That forced the execution owner to open a draft before the exact `foliolens-pr` OTA could be published. Automated reviewers then spent tokens on an evidence-incomplete review and had to return after evidence arrived. The existing local OTA trace action already supports runs without a PR number and writes update IDs to the job summary.

## Assumptions

- The feature branch is pushed to GitHub before evidence capture.
- GitHub repository secrets remain the authoritative DEV environment source.
- The installed `preview-pr` app continues to consume the shared `foliolens-pr` channel.

## Definitions

- **Manual branch dispatch:** a `workflow_dispatch` run selected against a named feature branch.
- **Evidence OTA:** the exact branch commit applied to the paired Android device for acceptance capture.

## Scope

- Add `workflow_dispatch` to `pr-preview.yml` with an optional evidence label.
- Preserve existing pull-request behavior and PR OTA comments.
- On manual runs, trace `github.sha` and omit the PR number so OTA IDs appear in the job summary without trying to write a nonexistent PR comment.
- Document the pre-PR evidence sequence and shared-channel collision check.

## Out of Scope

- New EAS channels, native build variants, secret changes, or production deployment behavior.
- Automatic PR creation or automatic device control.

## Approach

Use one workflow for both event types. Pull-request runs continue to label the update with PR metadata and comment the IDs. Manual runs use the selected branch SHA, a caller-supplied or generated pre-PR label, and the existing optional-PR behavior in `.github/actions/ota-trace`.

## Alternatives Considered

- Local `eas update` was rejected because the required DEV values live in GitHub Secrets and should not be copied onto developer machines.
- A second workflow would duplicate dependency setup, environment wiring, and OTA trace logic.
- Opening a hidden or draft PR would preserve the review-token waste this change is intended to remove.

## Milestones

1. Add the manual trigger while preserving pull-request expressions.
2. Update the infrastructure runbook with the exact command and evidence sequence.
3. Validate YAML formatting, repository checks, and a real manual branch dispatch after merge.

## Validation

- `npx prettier --check .github/workflows/pr-preview.yml` passes.
- `npm run typecheck`, `npm run lint`, and `git diff --check` pass.
- Pull-request expressions still resolve PR title, head SHA, and comment target.
- A manual dispatch on a feature branch publishes to `foliolens-pr`, records the selected branch SHA, and completes without a PR comment target.

## Risks And Mitigations

- The shared channel can be overwritten by another PR run. The runbook requires verifying the About prefix immediately before measurement and republishing when necessary.
- Manual dispatch could target the wrong ref. The trace summary records `github.sha`, which must match the local implementation SHA before evidence is accepted.

## Decision Log

- 2026-07-05: Reused `pr-preview.yml` because its OTA trace action already supports an empty PR number.
- 2026-07-05: Kept full checks on manual dispatch so the evidence OTA is not published without the same static/test gates as a PR run.

## Progress

- [x] Add manual branch dispatch and event-aware metadata.
- [x] Document the pre-PR Android evidence flow.
- [x] Run repository validation: workflow Prettier check, typecheck, zero-warning lint, and diff check pass.
- [ ] Open a ready infrastructure PR with all evidence present.
- [ ] Verify a real manual dispatch after merge.
