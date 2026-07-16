import fs from 'fs';
import path from 'path';

/**
 * Backend-proxy program (D2, finding 1): the client's backend base URL
 * must stay single-sourced from EXPO_PUBLIC_SUPABASE_URL so the proxy
 * cutover is a one-variable repoint. This guards against a future
 * regression — a call site hardcoding a literal `*.supabase.co` host
 * instead of reading the shared env var.
 *
 * Test fixtures legitimately reference supabase.co as mock env values,
 * so `.test.ts`/`.test.tsx` files are excluded from the scan.
 */

const ROOT = path.resolve(__dirname, '../../../');
const SCAN_DIRS = ['src', 'app'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const FORBIDDEN_HOST_PATTERN = /supabase\.co/i;

function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(fullPath);
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) return [];
    if (/\.test\.tsx?$/.test(entry.name)) return [];
    return [fullPath];
  });
}

describe('no hardcoded supabase.co host', () => {
  it('never builds a client request URL from a literal supabase.co host', () => {
    const files = SCAN_DIRS.flatMap((dir) => collectSourceFiles(path.join(ROOT, dir)));
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((file) =>
      FORBIDDEN_HOST_PATTERN.test(fs.readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
