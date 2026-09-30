import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('production release runtime', () => {
  const workflow = readFileSync(
    join(process.cwd(), '.github/workflows/production-release.yml'),
    'utf8',
  );

  it('uses a Node version supported by current EAS CLI dependencies', () => {
    expect(workflow).not.toContain('node-version: 20');
    expect(workflow.match(/node-version: 22/g)).toHaveLength(3);
  });

  it('installs EAS CLI with npm to match package-lock.json', () => {
    expect(workflow).toContain('uses: expo/expo-github-action@v8');
    expect(workflow).toContain('packager: npm');
  });
});
