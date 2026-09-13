import fs from 'fs';
import path from 'path';

/**
 * CAS import correctness (C10 review finding P2): selecting a PDF must always
 * pause at the unlock step, so a returning user can supply a statement-specific
 * password before any network upload starts.
 *
 * The defect C10 fixed lived at the call site, not in a helper. `handlePdfPicked`
 * short-circuited with `if (profile?.pan) { await runUpload(asset); return; }`,
 * so a user with a saved PAN never reached the unlock screen. Asserting that
 * `pickOnboardingStepAfterPdfSelection()` returns `'identity'` cannot catch that
 * regression — the helper takes no arguments, so the assertion only restates its
 * body. Reinstating the removed fast path leaves the whole suite green.
 *
 * What C10 actually buys is a structural property of the screen, so pin it
 * directly: `runUpload` has exactly one call site and that call site is inside
 * `handleUnlock`.
 */

const ONBOARDING_SCREEN = path.resolve(__dirname, '../../../app/onboarding/index.tsx');
const RUN_UPLOAD_MENTION = /\brunUpload\s*\(/;
const RUN_UPLOAD_CALL_SITE = /(?<!function\s)\brunUpload\s*\(/g;

/**
 * Drop block comments and whole-line `//` comments so prose that mentions
 * `runUpload()` is not mistaken for a call. Trailing `//` is left alone to avoid
 * truncating string literals that contain a URL.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*$/gm, '');
}

/** Slice one component-scoped `function name() { ... }` declaration by indentation. */
function innerFunctionBody(code: string, name: string): string {
  const body = code.match(
    new RegExp(String.raw`^  (?:async )?function ${name}\([\s\S]*?^  \}$`, 'm'),
  )?.[0];
  if (!body) throw new Error(`${name}() not found in app/onboarding/index.tsx`);
  return body;
}

const source = fs.readFileSync(ONBOARDING_SCREEN, 'utf8');
const code = stripComments(source);

describe('onboarding manual upload passes through the unlock step', () => {
  it('reaches runUpload from exactly one call site', () => {
    expect(code.match(/^  async function runUpload\(/m)).not.toBeNull();
    expect(code.match(RUN_UPLOAD_CALL_SITE) ?? []).toHaveLength(1);
  });

  it('places that call site inside handleUnlock', () => {
    expect(innerFunctionBody(code, 'handleUnlock')).toMatch(RUN_UPLOAD_MENTION);
  });

  it('never starts an upload straight from PDF selection', () => {
    const handlePdfPicked = innerFunctionBody(code, 'handlePdfPicked');
    expect(handlePdfPicked).not.toMatch(RUN_UPLOAD_MENTION);
    expect(handlePdfPicked).toContain('pickOnboardingStepAfterPdfSelection()');
  });

  it('keeps handlePdfPicked synchronous so it cannot await an upload', () => {
    expect(source).toMatch(/^  function handlePdfPicked\(/m);
    expect(source).not.toMatch(/^  async function handlePdfPicked\(/m);
  });
});
