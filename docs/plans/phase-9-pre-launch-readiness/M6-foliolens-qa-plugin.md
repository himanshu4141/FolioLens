# FolioLens QA Codex Plugin

## Goal

Create a repo-local Codex plugin that lets an agent run repeatable FolioLens QA workflows for pull request previews, production smoke tests, and full regression passes.

## User Value

FolioLens changes frequently across portfolio data, routing, cache behavior, and Clear Lens UI. A checked-in QA plugin gives future Codex sessions a consistent checklist for validating the app and writing reports without manually reloading ad hoc notes from a desktop folder.

## Context

The source material is in `/Users/hyadav/Desktop/FoliolensQA/`:

- `FolioLens_QA_Script.md` is the broad manual QA checklist.
- `foliolens-qa-skill/qa-pr/SKILL.md` describes PR preview QA.
- `foliolens-qa-skill/qa-smoke/SKILL.md` describes post-release smoke testing.
- `foliolens-qa-skill/qa-regression/SKILL.md` describes full regression testing.
- `foliolens-qa-skill/references/app-reference.md` previously duplicated shared routes, cache keys, theme rules, and report templates.

The repo did not already contain `.agents/plugins/marketplace.json` or a `plugins/` directory.

## Assumptions

- The plugin should be repo-local so it can travel with the FolioLens repository and be reviewed in a PR.
- The first version should package skills only. It does not need custom MCP servers, hooks, app connectors, or bundled browser automation scripts.
- QA reports should continue to be written under `/Users/hyadav/Desktop/FoliolensQA/` to match the existing workflow.
- Web QA cannot claim coverage of native-only behaviors unless a native simulator or device is explicitly tested.

## Definitions

- A Codex plugin is a folder with `.codex-plugin/plugin.json` and optional capabilities such as skills.
- A Codex skill is a folder with `SKILL.md` instructions that Codex loads when the task matches the skill description.
- The canonical QA reference is `docs/qa/foliolens-app-reference.md`. Both the Codex plugin and the external Claude-style skill bundle should point there.
- PR QA means validating a Vercel preview against the PR description and production.
- Smoke QA means a fast production health check after release.
- Full regression means a deep pass across screens, themes, cache, responsive layout, states, and console health.

## Scope

- Add `plugins/foliolens-qa/.codex-plugin/plugin.json`.
- Add repo marketplace metadata at `.agents/plugins/marketplace.json`.
- Convert the three Claude QA skills into namespaced Codex skills under `plugins/foliolens-qa/skills/`.
- Add the original Claude plugin under `qa/claude/foliolens-qa/` with `.claude-plugin/plugin.json`, `README.md`, and its `qa-pr`, `qa-smoke`, and `qa-regression` skill names preserved.
- Add a shared `docs/qa/foliolens-app-reference.md` for routes, expected behavior, cache keys, theme rules, known bug classes, and report templates.
- Update README to mention the new repo-local QA plugin capability.

## Out Of Scope

- Running a real QA session against a PR or production.
- Building custom browser automation scripts.
- Publishing the plugin to a remote marketplace.
- Testing native-only flows such as CAS PDF parsing, push notifications, backgrounding, OTA application, or biometric auth.

## Approach

Use the system `plugin-creator` scaffold to create a repo-local plugin and marketplace entry. Then replace placeholder metadata with FolioLens-specific plugin metadata. Convert the existing Claude workflows into concise Codex skills that:

- Use relative references that resolve from each skill directory.
- Use namespaced Codex skill names so the Codex plugin can coexist with an existing `qa-pr` / `qa-smoke` / `qa-regression` bundle.
- Prefer Browser or Playwright for web QA and GitHub or `gh` for PR context.
- Preserve the existing report destinations.
- Separate actionable skill workflow from detailed app reference material.

## Alternatives Considered

- Home-local plugin under `~/plugins`: rejected because the user asked for a PR and repo review.
- One large `qa` skill: rejected because PR QA, smoke QA, and regression QA have different scope and should trigger independently.
- Copying the full desktop QA script verbatim: rejected because Codex skills should stay concise and use progressive disclosure through a shared reference.
- Renaming the Claude-style skills: rejected because the user asked to include those files as-is; only repo-relative reference pointers were adjusted so they do not embed temporary local paths.

## Milestones

1. Scaffold the plugin and marketplace entry.
   - Expected outcome: `plugins/foliolens-qa` and `.agents/plugins/marketplace.json` exist.
   - Validation: plugin manifest JSON parses.
2. Convert the three QA skills.
   - Expected outcome: `foliolens-qa-pr`, `foliolens-qa-smoke`, and `foliolens-qa-regression` each have valid `SKILL.md` frontmatter and workflow instructions.
   - Validation: run the skill quick validator on each skill directory.
3. Add the shared FolioLens app reference.
   - Expected outcome: all repo plugin skills point to `../../../../docs/qa/foliolens-app-reference.md`.
   - Validation: references resolve from each skill directory.
4. Update repository documentation.
   - Expected outcome: README mentions the plugin in "What works now".
   - Validation: review the documentation diff.
5. Add the Claude plugin.
   - Expected outcome: `qa/claude/foliolens-qa/` contains `.claude-plugin/plugin.json`, `README.md`, `skills/qa-pr`, `skills/qa-smoke`, `skills/qa-regression`, and a reference pointer.
   - Validation: run the skill quick validator on each Claude-style skill directory.

## Validation

Run:

    python3 /Users/hyadav/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/foliolens-qa/skills/foliolens-qa-pr
    python3 /Users/hyadav/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/foliolens-qa/skills/foliolens-qa-smoke
    python3 /Users/hyadav/.codex/skills/.system/skill-creator/scripts/quick_validate.py plugins/foliolens-qa/skills/foliolens-qa-regression
    python3 -m json.tool plugins/foliolens-qa/.codex-plugin/plugin.json >/tmp/foliolens-plugin.json
    python3 -m json.tool .agents/plugins/marketplace.json >/tmp/foliolens-marketplace.json
    python3 /Users/hyadav/.codex/skills/.system/skill-creator/scripts/quick_validate.py qa/claude/foliolens-qa/skills/qa-pr
    python3 /Users/hyadav/.codex/skills/.system/skill-creator/scripts/quick_validate.py qa/claude/foliolens-qa/skills/qa-smoke
    python3 /Users/hyadav/.codex/skills/.system/skill-creator/scripts/quick_validate.py qa/claude/foliolens-qa/skills/qa-regression

Expected output: all quick validators print `Skill is valid!`; both JSON commands exit successfully.

Because this change only adds plugin and documentation files, the app TypeScript and lint checks are not expected to exercise the new behavior. Run them if the PR policy requires every branch to satisfy the full repo checklist before ready-for-review.

## Risks And Mitigations

- Risk: Skills drift from the app as routes or cache keys change. Mitigation: keep shared app facts in one reference file and update it when app behavior changes.
- Risk: Web QA is mistaken for native QA. Mitigation: every workflow and report template calls out native-only exclusions.
- Risk: Codex cannot access an authenticated session. Mitigation: skills instruct the agent to report the auth blocker and ask for a test path.

## Decision Log

- Use a repo-local plugin because the requested output is a PR.
- Keep three separate skills because the trigger phrases and QA depth differ.
- Prefix Codex skill names with `foliolens-` so this plugin can be installed beside an existing Claude-style bundle that uses `qa-pr`, `qa-smoke`, and `qa-regression`.
- Do not add custom MCP servers or scripts in version 0.1.0 because the existing workflows are procedural and can use available browser and GitHub tools.
- Validation initially failed because the worktree had no `node_modules` and the system Python lacked PyYAML. Installed project dependencies with `npm ci` and ran the skill validator through a temporary venv at `/tmp/foliolens-qa-validate`.

## Amendments

- The implemented plugin omits hooks, MCP server config, app config, icons, and screenshots from `plugin.json` because version 0.1.0 only ships skills and a shared reference. This avoids dangling placeholder paths while keeping the plugin installable.
- The shared reference moved from `plugins/foliolens-qa/skills/references/app-reference.md` to `docs/qa/foliolens-app-reference.md` so multiple QA bundles can point at one update location.
- The Claude plugin is now checked in under `qa/claude/foliolens-qa/` with `.claude-plugin/plugin.json`, `README.md`, and `skills/`. Its skill names and QA workflow wording are preserved, while its reference file is a repo-relative pointer to the canonical shared reference.

## Progress

- [x] Read repository guidance and source QA materials.
- [x] Scaffold the plugin and marketplace entry.
- [x] Convert PR, smoke, and regression workflows into Codex skills.
- [x] Add the Claude-style skill bundle to the repo.
- [x] Add shared FolioLens QA reference.
- [x] Update README.
- [x] Run validation commands.
- [ ] Commit, push, and open PR.
