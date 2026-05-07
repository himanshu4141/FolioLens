# Release Pipeline — PR / main / tag

Three GitHub-triggered workflows shape the release path. The contract:

- **Every PR** runs CI checks + publishes an EAS Update to the `foliolens-pr` channel + Vercel auto-creates a preview URL.
- **Every push to `main`** publishes an EAS Update to the `foliolens-main` channel (DEV Supabase) + Vercel auto-deploys `foliolens-dev`.
- **Production deploys are gated on a `v*` git tag.** Tagging triggers EAS publish to `foliolens-production` channel + Vercel CLI deploy to the prod project + a GitHub release.

Production database migrations and edge-function deploys are NOT automatic on tag — those run via `supabase-deploy-prod.yml` workflow_dispatch as a deliberate operator step.

## Surfaces

```mermaid
graph TB
  subgraph PR["Pull Request"]
    pr_branch["Pushes on any PR branch"]
  end

  subgraph Main["main branch"]
    main_push["Push / squash-merge to main"]
  end

  subgraph Tag["Tag v*"]
    tag_push["git tag v0.0.x && git push --tags"]
  end

  subgraph Workflows["GitHub workflows"]
    pr_w["pr-preview.yml<br/>──────────────<br/>• checks (typecheck/lint/test)<br/>• supabase-validate<br/>• EAS publish to foliolens-pr"]
    main_w["main-deploy.yml<br/>──────────────<br/>• checks<br/>• EAS publish to foliolens-main"]
    sup_dev_w["supabase-deploy-dev.yml<br/>──────────────<br/>(triggered by changes under supabase/**)<br/>• functions deploy<br/>• db push (DEV)"]
    prod_w["production-release.yml<br/>──────────────<br/>• checks (incl. tag↔app.config version match)<br/>• EAS publish to foliolens-production<br/>• vercel deploy --prod<br/>• gh release create"]
    sup_prod_w["supabase-deploy-prod.yml<br/>──────────────<br/>workflow_dispatch only (manual)<br/>• functions deploy (PROD)<br/>• db push (PROD)"]
  end

  subgraph EAS["EAS Update channels"]
    ch_pr["foliolens-pr"]
    ch_main["foliolens-main"]
    ch_prod["foliolens-production"]
  end

  subgraph Vercel["Vercel projects"]
    v_dev["foliolens-dev<br/>(preview + dev prod)"]
    v_prod["foliolens<br/>(production)"]
  end

  subgraph SupabaseProj["Supabase projects"]
    sb_dev["DEV<br/>(imkgazlrxtlhkfptkzjc)"]
    sb_prod["PROD<br/>(ohcaaioabjvzewfysqgh)"]
  end

  pr_branch --> pr_w
  main_push --> main_w
  main_push -- "if supabase/** changed" --> sup_dev_w
  tag_push --> prod_w

  pr_w --> ch_pr
  pr_branch -. "Vercel git integration" .-> v_dev
  main_w --> ch_main
  main_push -. "Vercel git integration" .-> v_dev
  prod_w --> ch_prod
  prod_w -- "vercel CLI" --> v_prod

  sup_dev_w --> sb_dev
  sup_prod_w -. "manual operator dispatch" .-> sb_prod

  ch_pr -. "OTA on launch" .-> apk_pr["preview-pr APK"]
  ch_main -. "OTA on launch" .-> apk_main["preview-main APK / TestFlight"]
  ch_prod -. "OTA on launch" .-> apk_prod["production APK / TestFlight"]
```

## Trigger sequences

### PR opened

```mermaid
sequenceDiagram
  participant Dev as Developer
  participant GH as GitHub
  participant CI as pr-preview.yml
  participant EAS as EAS Update
  participant V as Vercel

  Dev->>GH: open PR / push commit
  GH->>CI: trigger
  CI->>CI: checks (typecheck, lint, jest, python unittest)
  CI->>CI: supabase-validate (local reset + drift check)
  CI->>EAS: publish to foliolens-pr channel
  GH->>V: Vercel git integration<br/>builds preview deployment
  V-->>Dev: preview URL in PR comment
  EAS-->>Dev: update available on next preview-pr APK launch
```

### Merge to main

```mermaid
sequenceDiagram
  participant Dev as Developer
  participant GH as GitHub
  participant Main as main-deploy.yml
  participant SupDev as supabase-deploy-dev.yml
  participant EAS as EAS Update
  participant V as Vercel
  participant SB as Supabase DEV

  Dev->>GH: squash-merge PR
  GH->>Main: trigger (push to main)
  Main->>Main: checks
  Main->>EAS: publish to foliolens-main channel<br/>(DEV Supabase URL embedded)
  GH->>V: Vercel git integration<br/>deploys foliolens-dev production
  alt supabase/** changed in this push
    GH->>SupDev: trigger
    SupDev->>SB: link to DEV project
    SupDev->>SB: deploy edge functions
    SupDev->>SB: supabase db push
  end
```

### Tag v\* (production release)

```mermaid
sequenceDiagram
  participant Op as Operator
  participant GH as GitHub
  participant Prod as production-release.yml
  participant EAS as EAS Update
  participant V as Vercel
  participant Rel as GitHub Releases

  Op->>Op: bump version in app.config.js
  Op->>Op: git tag v0.0.3 && git push --tags
  GH->>Prod: trigger (refs/tags/v*)
  Prod->>Prod: checks job<br/>verifies tag == app.config.js version
  Prod->>EAS: publish to foliolens-production<br/>(PROD Supabase URL embedded)
  Prod->>V: vercel deploy --prod<br/>(via VERCEL_TOKEN, foliolens project)
  Prod->>Rel: gh release create v0.0.3<br/>--generate-notes --verify-tag
  Note over Op: PROD migrations + edge-function deploys<br/>do NOT run automatically
  Op->>Op: when DB needs deploying:<br/>workflow_dispatch supabase-deploy-prod.yml<br/>(takes a backup first)
```

## Channel × profile × Supabase project

| Channel | Build profile | Supabase project | Vercel project | Notes |
|---|---|---|---|---|
| `foliolens-pr` | `preview-pr` | DEV | `foliolens-dev` (preview) | Internal APK distribution; per-PR preview URL |
| `foliolens-main` | `preview-main` | DEV | `foliolens-dev` (production) | Internal APK / TestFlight; tracks main branch |
| `foliolens-production` | `production` | PROD | `foliolens` (production) | TestFlight + Play Internal; tag-gated |

Three separate native binaries with distinct bundle IDs, schemes, and OAuth client IDs. `eas update` only ships JS — anything that changes native deps requires a new EAS build.

## Why production is tag-gated

Before this branching scheme was set up, every push to `main` auto-deployed the web app to production Vercel. Two real bugs in 2026 (one was the Phase 8 TRI cutover, one was the inbound webhook architecture) shipped to prod within minutes of merging because the gate was implicit ("don't merge until you're confident"). Tag-gating makes the gate explicit and the ship moment intentional. The `vX.Y.Z` tag now has to be:

1. Pushed deliberately
2. Match `app.config.js` version (the `verify-tag` step in `production-release.yml`)
3. Followed by a manual `supabase-deploy-prod.yml` dispatch if the release includes migrations (backed up beforehand)

If something needs to ship to prod without a tag (emergency hotfix), `production-release.yml` also accepts `workflow_dispatch` and the version-match check is skipped on dispatch runs.
