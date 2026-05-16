// Pure decision function from check-cache-shape.js. The script is .js
// (CommonJS) so jest can `require` it without transform — the CLI
// portion ships as plain Node, no TypeScript runtime needed.

interface DecisionInput {
  touchedTracked: boolean;
  baseBuster: string | null;
  headBuster: string | null;
  prTitle?: string;
}

interface DecisionResult {
  ok: boolean;
  reason: string;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { decideCacheShapeCheck } = require('../check-cache-shape.js') as {
  decideCacheShapeCheck: (input: DecisionInput) => DecisionResult;
};

describe('decideCacheShapeCheck', () => {
  it('passes when no tracked file changed (most PRs)', () => {
    const r = decideCacheShapeCheck({
      touchedTracked: false,
      baseBuster: 'v4',
      headBuster: 'v4',
      prTitle: 'fix(unrelated): some bug',
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/No tracked cache-shape files/);
  });

  it('passes when __BUSTER__ was bumped (developer asserted shape changed)', () => {
    const r = decideCacheShapeCheck({
      touchedTracked: true,
      baseBuster: 'v4',
      headBuster: 'v5',
      prTitle: 'feat(usePortfolio): add return_30d field',
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/__BUSTER__ bumped: v4 → v5/);
  });

  it('passes when PR title contains [cache-shape-stable] (developer asserted no shape change)', () => {
    const r = decideCacheShapeCheck({
      touchedTracked: true,
      baseBuster: 'v4',
      headBuster: 'v4',
      prTitle: 'refactor(usePortfolio): extract helper [cache-shape-stable]',
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/cache-shape-stable/);
  });

  it('fails when tracked files changed and neither escape hatch was used (the load-bearing case)', () => {
    // Direct repro of the PR #133 scenario: query shape changed, buster
    // not bumped, no marker. CI should block the PR.
    const r = decideCacheShapeCheck({
      touchedTracked: true,
      baseBuster: 'v4',
      headBuster: 'v4',
      prTitle: 'feat(usePortfolio): add return_30d field',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/wasn't bumped/);
  });

  it('fails on empty PR title when tracked files changed', () => {
    const r = decideCacheShapeCheck({
      touchedTracked: true,
      baseBuster: 'v4',
      headBuster: 'v4',
      prTitle: '',
    });
    expect(r.ok).toBe(false);
  });

  it('fails on missing PR title (undefined)', () => {
    const r = decideCacheShapeCheck({
      touchedTracked: true,
      baseBuster: 'v4',
      headBuster: 'v4',
      prTitle: undefined,
    });
    expect(r.ok).toBe(false);
  });

  it('passes when buster goes from null → vN (case: queryClient.ts is brand-new)', () => {
    const r = decideCacheShapeCheck({
      touchedTracked: true,
      baseBuster: null,
      headBuster: 'v1',
      prTitle: 'feat: introduce React Query persistence',
    });
    expect(r.ok).toBe(true);
  });

  it('marker case-sensitive — capitalised marker does not match', () => {
    const r = decideCacheShapeCheck({
      touchedTracked: true,
      baseBuster: 'v4',
      headBuster: 'v4',
      prTitle: 'refactor: cleanup [Cache-Shape-Stable]',
    });
    expect(r.ok).toBe(false);
  });

  it('marker can appear anywhere in the PR title', () => {
    const r = decideCacheShapeCheck({
      touchedTracked: true,
      baseBuster: 'v4',
      headBuster: 'v4',
      prTitle: '[cache-shape-stable] docs(usePortfolio): jsdoc updates',
    });
    expect(r.ok).toBe(true);
  });
});
