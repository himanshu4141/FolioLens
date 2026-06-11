/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/src/utils/**/*.test.ts',
    '<rootDir>/src/hooks/**/*.test.ts',
    '<rootDir>/src/lib/**/*.test.ts',
    '<rootDir>/src/store/**/*.test.ts',
    '<rootDir>/src/constants/**/*.test.ts',
    '<rootDir>/supabase/functions/_shared/**/*.test.ts',
    '<rootDir>/scripts/__tests__/**/*.test.ts',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  setupFiles: ['<rootDir>/jest.env.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { strict: true } }],
  },
  // Collect coverage from all src files so untested files show as 0%
  collectCoverageFrom: [
    'src/**/*.ts',            // .ts only — .tsx files contain JSX that breaks Node instrumenter
    'supabase/functions/_shared/import-cas.ts', // edge-function logic with dedicated tests
    'supabase/functions/_shared/portfolio-utils.ts', // pure composition helpers with dedicated tests
    'supabase/functions/_shared/gmail-verification.ts', // pure Gmail-forwarding helpers with dedicated tests
    'supabase/functions/_shared/upstream-probe.ts', // third-party health probe with dedicated tests
    'supabase/functions/_shared/openfolio.ts', // OpenFolio client + pure mapping/matching/sync core with dedicated tests
    'supabase/functions/_shared/period-returns.ts', // mfdata→canonical normalisation + merge helpers with dedicated tests
    '!src/**/*.test.ts',
    '!src/types/**',          // pure type declarations — nothing executable to cover
    '!src/lib/supabase.ts',   // React Native + Supabase bootstrap — not runnable in Node
    '!src/lib/analytics.web.ts',  // browser-only impl; covered by manual smoke
    '!src/lib/analytics.native.ts', // RN-only impl; covered by manual smoke
    '!src/lib/installGlobalErrorHandlers.ts', // RN/window globals; covered by manual smoke
    '!src/utils/fundSearch.ts', // thin supabase query wrappers; not runnable in Node
    // Exit-readiness wrappers (#153) — pass-through Proxies / one-line
    // `from()` shims around `supabase.{auth,functions,storage,from}`.
    // Tests mock these directly (jest.mock at the wrapper boundary), so
    // the wrappers themselves never execute in unit tests. Their job is
    // to be the swap-point if we ever move off Supabase; correctness is
    // verified by every consumer test passing while the wrapper is
    // mocked, not by direct coverage.
    '!src/lib/auth/**',
    '!src/lib/functions/**',
    '!src/lib/storage/**',
    '!src/lib/data/**',
  ],
  coverageThreshold: {
    // Functions threshold is the lowest of the four because the global
    // denominator includes hook-internal arrow callbacks (queryFn, useEffect
    // bodies) that we can't exercise without renderHook — and the codebase
    // doesn't pull in @testing-library/react. The strict utils/ + edge-fn
    // overrides below keep the per-file rigor that matters.
    global: { lines: 70, statements: 70, branches: 60, functions: 54 },
    // Pure utils (no RN/Supabase deps) must stay near full coverage
    './src/utils/': { lines: 95, statements: 95, branches: 85, functions: 100 },
    // CAS import edge-function logic has dedicated tests
    './supabase/functions/_shared/': { lines: 100, statements: 100, branches: 80, functions: 100 },
  },
  coverageReporters: ['text', 'lcov'],
};

module.exports = config;
