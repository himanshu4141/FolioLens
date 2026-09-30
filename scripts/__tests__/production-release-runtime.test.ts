import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const EAS_WORKFLOWS = [
  '.github/workflows/main-deploy.yml',
  '.github/workflows/play-store-submit.yml',
  '.github/workflows/pr-preview.yml',
  '.github/workflows/production-release.yml',
];

describe.each(EAS_WORKFLOWS)('%s runtime', (relativePath) => {
  const workflow = readFileSync(join(process.cwd(), relativePath), 'utf8');

  it('uses a Node version supported by current EAS CLI dependencies', () => {
    expect(workflow).not.toContain('node-version: 20');
    expect(workflow).toContain('node-version: 22');
  });

  it('installs EAS CLI with npm to match package-lock.json', () => {
    expect(workflow).toContain('uses: expo/expo-github-action@v8');
    expect(workflow).toContain('packager: npm');
  });
});
