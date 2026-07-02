import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const POSTHOG_KEY_WIRING = 'EXPO_PUBLIC_POSTHOG_KEY: ${{ secrets.POSTHOG_PROJECT_KEY }}';
const POSTHOG_HOST_WIRING = "EXPO_PUBLIC_POSTHOG_HOST: ${{ vars.POSTHOG_HOST || 'https://us.i.posthog.com' }}";

describe.each([
  ['preview-pr', '.github/workflows/pr-preview.yml'],
  ['preview-main', '.github/workflows/main-deploy.yml'],
  ['production', '.github/workflows/production-release.yml'],
])('%s native OTA analytics configuration', (variant, relativePath) => {
  it('wires both the PostHog key and ingest host at bundle time', () => {
    const workflow = readFileSync(join(process.cwd(), relativePath), 'utf8');

    expect(workflow).toContain(`APP_VARIANT: ${variant}`);
    expect(workflow).toContain(POSTHOG_KEY_WIRING);
    expect(workflow).toContain(POSTHOG_HOST_WIRING);
  });
});
