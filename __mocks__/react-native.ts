/**
 * Jest mock for `react-native`.
 *
 * Jest's default ts-jest preset can't transform `react-native`'s flow-
 * typed entry (`index.js.flow`), so any test that pulls in a file
 * importing `react-native` blows up with `SyntaxError: Cannot use import
 * statement outside a module`.
 *
 * Adjacent-to-node_modules `__mocks__/<package>.ts` is auto-applied by
 * jest for every test that resolves the package — same pattern that
 * `__mocks__/expo-sqlite.ts` uses for the SQLite shim.
 *
 * The shim exports the slice of the API our non-test code touches. The
 * Platform default is `'ios'` so the SQLite read-cache path stays alive
 * in tests (web tests that need to assert the `Platform.OS === 'web'`
 * branch still override via `jest.mock('react-native', ...)` in-file).
 */

export const Platform = { OS: 'ios' as 'ios' | 'android' | 'web' };

export const Share = {
  share: jest.fn(),
};
