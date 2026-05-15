/**
 * Test-time env stubs.
 *
 * Loaded via `setupFiles` in jest.config.js, before any test module is
 * imported. Sets the env vars `src/lib/supabase.ts` reads at module
 * load so the supabase client constructs with valid-format values
 * (the test wrappers — `authClient`, `functionsClient`, repos —
 * intercept all real I/O via `jest.mock` calls in the test files,
 * so these values are never used over the wire).
 *
 * Before this file existed, every test transitively importing the
 * supabase client had to `jest.mock('@/src/lib/supabase')` just to
 * stop `createClient` from throwing "supabaseUrl is required" at
 * import time. With the wrappers (#153) intercepting auth / functions
 * / storage and the per-table repos owning `from(...)`, mocking the
 * underlying supabase module is no longer the test boundary — these
 * stubs let tests mock the right layer instead.
 */
process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://test-project.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
