#!/bin/sh
# Vercel ignored-build step: exit 0 skips the deploy, exit 1 builds.
# Referenced from vercel.json "ignoreCommand" (its inline value is capped at
# 256 characters, which is why this lives in a script).
#
# Skips docs-only changes. "Docs" = everything under docs/ plus any Markdown
# file anywhere in the repo. Any error path falls through to exit 1 (build);
# skipping must never be the failure mode.

set -- ":(exclude)docs" ":(exclude)*.md"

if [ "$VERCEL_ENV" = "production" ]; then
  # main only receives squash merges, so HEAD^..HEAD is exactly one PR.
  if git diff --quiet HEAD^ HEAD -- "$@" 2>/dev/null; then exit 0; fi
  exit 1
fi

# Preview: the pushed range is unknowable here, so skip only when the whole
# available history window (clone depth, <=10 commits) is docs-only. A batched
# push containing any code commit therefore always builds.
BASE=$(git rev-list --max-count=10 HEAD | tail -n 1) || exit 1
[ "$BASE" = "$(git rev-parse HEAD)" ] && exit 1
if git diff --quiet "$BASE" HEAD -- "$@" 2>/dev/null; then exit 0; fi
exit 1
