#!/usr/bin/env node
/**
 * check-cache-shape.mjs — CI guard for the React Query persisted cache.
 *
 * **What it does.** When a PR touches any file under `src/lib/queryClient.ts`,
 * `src/lib/queryStaleTimes.ts`, `src/hooks/`, or `src/lib/data/`, this
 * script requires either:
 *   (a) `__BUSTER__` in `src/lib/queryClient.ts` to have been bumped, or
 *   (b) the PR title to contain `[cache-shape-stable]` to assert the
 *       change doesn't affect the shape of any cached payload.
 *
 * **Why.** PR #133 shipped twice because the first attempt added new
 * fields to a query but didn't bump `__BUSTER__`, so persisted client
 * caches kept serving the old shape until they expired (24h) and the
 * UI rendered `undefined` in places it should not have. The May 2026
 * cache audit (see `docs/architecture/cache-surfaces.md` finding #12)
 * called for an automated guard; this script is it.
 *
 * **Mental model.** Most edits to query files don't change cached
 * shapes — comment fixes, refactors, log tweaks. The marker is how
 * the developer affirms that. The buster bump is how the developer
 * declares "yes, the cached shape changed; old persisted entries
 * must be discarded on next launch." Either action is one line; the
 * goal is to force a conscious choice rather than rely on review
 * vigilance.
 *
 * **Usage (CI).**
 *     node scripts/check-cache-shape.mjs <baseSha> <headSha>
 *
 *   Reads `PR_TITLE` from env. Exits 0 on OK, 1 on failure with a
 *   clear remediation message.
 *
 * **Usage (local).**
 *     node scripts/check-cache-shape.mjs --help
 */

const { execSync } = require('node:child_process');

const TRACKED_PATH_PREFIXES = [
  'src/lib/queryClient.ts',
  'src/lib/queryStaleTimes.ts',
  'src/hooks/',
  'src/lib/data/',
];

const SKIP_MARKER = '[cache-shape-stable]';
const BUSTER_FILE = 'src/lib/queryClient.ts';
const BUSTER_RE = /__BUSTER__\s*=\s*['"]([^'"]+)['"]/;

// ---------------------------------------------------------------------------
// Pure decision function — exported for testing.
// ---------------------------------------------------------------------------

/**
 * Decides whether the cache-shape check passes. Pure: takes the inputs
 * a CI run would gather, returns `{ ok: boolean, reason: string }`.
 */
function decideCacheShapeCheck({ touchedTracked, baseBuster, headBuster, prTitle }) {
  if (!touchedTracked) {
    return { ok: true, reason: 'No tracked cache-shape files were changed.' };
  }
  if (baseBuster !== headBuster) {
    return { ok: true, reason: `__BUSTER__ bumped: ${baseBuster} → ${headBuster}.` };
  }
  if (typeof prTitle === 'string' && prTitle.includes(SKIP_MARKER)) {
    return { ok: true, reason: `PR title contains ${SKIP_MARKER} — cache-shape-stable assertion accepted.` };
  }
  return {
    ok: false,
    reason:
      `Cache-shape files were touched but __BUSTER__ wasn't bumped and PR title does not contain ${SKIP_MARKER}.`,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function help() {
  console.log(`check-cache-shape.mjs — CI guard for the React Query persisted cache.

Usage:
  node scripts/check-cache-shape.mjs <baseSha> <headSha>

Environment:
  PR_TITLE    The PR title (used to look for the ${SKIP_MARKER} marker).

Tracked paths:
${TRACKED_PATH_PREFIXES.map((p) => `  - ${p}`).join('\n')}

Pass criteria:
  - No tracked file changed between baseSha and headSha, OR
  - __BUSTER__ in ${BUSTER_FILE} was bumped, OR
  - PR title contains "${SKIP_MARKER}".

See docs/architecture/cache-surfaces.md for the rationale.`);
}

function fileAtRev(rev, path) {
  try {
    return execSync(`git show ${rev}:${path}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // File may not exist on this rev (new file, or removed).
    return null;
  }
}

function busterAt(rev) {
  const content = fileAtRev(rev, BUSTER_FILE);
  if (content == null) return null;
  const m = content.match(BUSTER_RE);
  return m ? m[1] : null;
}

function changedFilesBetween(baseRev, headRev) {
  const out = execSync(`git diff --name-only ${baseRev}...${headRev}`, {
    encoding: 'utf-8',
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    help();
    process.exit(0);
  }
  const [baseRev, headRev] = args;
  if (!baseRev || !headRev) {
    console.error('error: usage: node scripts/check-cache-shape.mjs <baseSha> <headSha>');
    console.error('Run with --help for details.');
    process.exit(2);
  }

  const changed = changedFilesBetween(baseRev, headRev);
  const touchedTracked = changed.some((file) =>
    TRACKED_PATH_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );

  const baseBuster = busterAt(baseRev);
  const headBuster = busterAt(headRev);
  const prTitle = process.env.PR_TITLE ?? '';

  const result = decideCacheShapeCheck({ touchedTracked, baseBuster, headBuster, prTitle });

  if (result.ok) {
    console.log(`[cache-shape] OK — ${result.reason}`);
    process.exit(0);
  }

  console.error(`[cache-shape] FAIL — ${result.reason}

You touched one of these cache-shape files:
${changed.filter((f) => TRACKED_PATH_PREFIXES.some((p) => f.startsWith(p))).map((f) => `  - ${f}`).join('\n')}

These files hold the shapes of cached React Query payloads. Pick one:

  1. **If your change altered any cached payload shape** (added/removed/
     renamed a select() column, changed a query-key tuple element,
     switched a hook between scalar and array input):

         Bump __BUSTER__ in ${BUSTER_FILE} so persisted client caches
         are discarded on next launch. Current value: ${headBuster}

  2. **If your change is shape-stable** (comments, refactor, internal
     helper rename, logging tweak, anything that doesn't affect the
     serialized cached payload):

         Add ${SKIP_MARKER} to your PR title.

PR #133 shipped twice because of a missed buster bump (the persisted
caches kept serving the old shape until they expired, ~24h). This
guard exists so we don't repeat it. Full rationale in
docs/architecture/cache-surfaces.md (audit finding #12).
`);
  process.exit(1);
}

module.exports = { decideCacheShapeCheck };

// Skip CLI when imported by jest (jest sets `JEST_WORKER_ID`).
if (!process.env.JEST_WORKER_ID) {
  main();
}
