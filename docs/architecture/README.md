# Architecture diagrams

Renderable Mermaid diagrams for the load-bearing flows in FolioLens. Each file has a "where things live" graph, one or more sequence diagrams, and short prose explaining the design choices. GitHub renders them inline.

| Diagram | What it covers |
|---|---|
| [cas-inbound-flow.md](./cas-inbound-flow.md) | CAMS / KFintech CAS forwarded through Resend → Vercel router → Supabase → import. Post-#107 architecture where Resend secrets only live at the router boundary. |
| [cas-upload-flow.md](./cas-upload-flow.md) | Manual PDF upload from the wizard or settings → Supabase parse-cas-pdf edge function → Vercel Python parser → import. Same `importCASData()` helper as the inbound flow. |
| [auth-flow.md](./auth-flow.md) | Magic-link + Google OAuth, web + native. The "native bridge" that lets `https://app.foliolens.in/auth/{confirm,callback}` hand off to the `foliolens://` deep link without breaking email-client and OAuth-whitelist constraints. |
| [data-sync-pipeline.md](./data-sync-pipeline.md) | Four pg_cron-driven edge functions (`sync-nav`, `sync-index`, `sync-fund-portfolios`, `sync-fund-meta`) that keep prices, indices, fund composition, and metadata fresh. |
| [release-pipeline.md](./release-pipeline.md) | PR → main → `v*` tag GitHub-Actions workflow shape. Three EAS channels, two Vercel projects, two Supabase projects. Why prod is tag-gated. |
| [cache-surfaces.md](./cache-surfaces.md) | Every cache layer in the codebase — React Query, edge-function module caches, Zustand, AsyncStorage drafts, SQLite, CDN snapshots. Bug taxonomy + audit findings tracker + checklist for adding new caches. |

## Conventions used in these diagrams

- **Solid arrows** = synchronous request / response.
- **Dashed arrows** = async / fire-and-forget / out-of-band (e.g., OTA propagation).
- **Subgraph boxes** group components by where they run (Vercel / Supabase / external SaaS / client).
- **Env-var names** in node labels indicate which secrets that component reads.

## Adding a new diagram

1. Validate Mermaid locally so GitHub doesn't show a "rich display" error:
   ```bash
   npx --yes -p @mermaid-js/mermaid-cli@10.9.1 mmdc -i path/to/diagram.mmd -o /tmp/check.svg
   ```
2. Avoid raw `<` / `>` inside sequence-diagram message text — Mermaid's parser reads them as arrow tokens. HTML-entity escapes (`&lt;`) don't help. Reword to plain prose.
3. Inside `[...]` node labels, use `<br/>` for line breaks; HTML entities are fine there.
4. Keep nodes small — wide labels stretch the layout and hurt readability on phone screens.
