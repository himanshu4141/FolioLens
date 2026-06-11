import { readFileSync } from 'fs';
import path from 'path';
import { diff } from 'jest-diff';

const BEGIN_MARKER = '// BEGIN OPENFOLIO SHARED CONTRACT (guarded — see twin-contract.test.ts)';
const END_MARKER = '// END OPENFOLIO SHARED CONTRACT (guarded — see twin-contract.test.ts)';

function extractSharedContract(filePath: string): string {
  const source = readFileSync(filePath, 'utf8');
  const begin = source.indexOf(BEGIN_MARKER);
  const end = source.indexOf(END_MARKER);

  if (begin === -1 || end === -1 || end <= begin) {
    throw new Error(`Missing or misordered OpenFolio shared contract markers in ${filePath}`);
  }

  return source
    .slice(begin, end + END_MARKER.length)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n');
}

function firstDifferenceLine(left: string, right: string): number {
  const leftLines = left.split('\n');
  const rightLines = right.split('\n');
  const max = Math.max(leftLines.length, rightLines.length);

  for (let index = 0; index < max; index += 1) {
    if (leftLines[index] !== rightLines[index]) return index + 1;
  }

  return -1;
}

describe('OpenFolio shared contract twins', () => {
  it('keeps the app and edge contract regions byte-identical except trailing whitespace', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const appPath = path.join(repoRoot, 'src/lib/data/composition.ts');
    const edgePath = path.join(repoRoot, 'supabase/functions/_shared/openfolio.ts');

    const appContract = extractSharedContract(appPath);
    const edgeContract = extractSharedContract(edgePath);
    const diffLine = firstDifferenceLine(appContract, edgeContract);

    if (diffLine !== -1) {
      throw new Error(
        `OpenFolio shared contract drift at extracted contract line ${diffLine}. ` +
          `Update both ${appPath} and ${edgePath}; the guarded regions must stay byte-identical.\n\n` +
          (diff(appContract, edgeContract, { expand: false }) ?? 'No printable diff available.'),
      );
    }

    expect(appContract).toEqual(edgeContract);
  });
});
