/**
 * Jest mock for `@react-native-async-storage/async-storage`.
 *
 * `src/lib/supabase.ts` passes AsyncStorage into the supabase-js
 * `auth.storage` option on non-web platforms. The real implementation
 * reaches into `window.localStorage` during init, which crashes in
 * Node tests (`ReferenceError: window is not defined`).
 *
 * In-memory map covers the slice of the API the auth bootstrap calls
 * (`getItem` / `setItem` / `removeItem`). Tests that exercise the
 * underlying storage shouldn't be in src/lib/__tests__/ at all — this
 * shim exists purely to break the import-time crash.
 */
const store = new Map<string, string>();

export default {
  getItem: jest.fn(async (key: string): Promise<string | null> => store.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string): Promise<void> => {
    store.set(key, value);
  }),
  removeItem: jest.fn(async (key: string): Promise<void> => {
    store.delete(key);
  }),
  clear: jest.fn(async (): Promise<void> => {
    store.clear();
  }),
};
