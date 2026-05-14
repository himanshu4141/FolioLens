# FolioLens QA Plugin

Structured QA testing for FolioLens, the Indian mutual fund portfolio tracker.

## Skills

| Skill | Trigger | What It Does |
|-------|---------|--------------|
| **qa-pr** | "QA PR #X", "test this PR", "validate the preview" | Full QA against a Vercel preview + production comparison |
| **qa-smoke** | "smoke test production", "check the release" | Fast critical-path check on production after a deploy |
| **qa-regression** | "full regression", "test everything", "deep QA" | Most thorough mode — every screen, state, theme, cache flow, breakpoint |

## What's Tested

- **Every screen** — Portfolio, Funds, Fund Detail, Money Trail, Wealth Journey, Portfolio Insights, Tools Hub, Settings, Data Sync, and more
- **Cross-screen consistency** — Portfolio value, XIRR, and gain match across screens
- **Theming** — Light, dark, and system themes via the Clear Lens design system
- **UX principles** — Lead with the answer, dejargonify, delta formatting, no colour-only meaning
- **Cache architecture** — Warm cache, cold start, post-sync invalidation, key integrity
- **Responsive layout** — Mobile (<1024px) and desktop (≥1024px) breakpoints
- **Console health** — React errors, persister status, unhandled rejections

## Requirements

- Claude in Chrome extension (for browser automation)
- Access to `app.foliolens.in` (production) and Vercel preview URLs

## Reports

Reports are saved to `~/Desktop/FoliolensQA/` with mode-specific subdirectories.
