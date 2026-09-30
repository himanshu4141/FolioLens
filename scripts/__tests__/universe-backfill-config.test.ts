import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('universe backfill workflow', () => {
  const workflow = readFileSync(
    join(process.cwd(), '.github/workflows/universe-backfill.yml'),
    'utf8',
  );

  it('calls the raw production Functions origin instead of the Cloudflare proxy', () => {
    expect(workflow).toContain(
      'FUNCTIONS_URL: https://${{ secrets.SUPABASE_PROJECT_REF_PROD }}.supabase.co/functions/v1',
    );
    expect(workflow).not.toContain(
      'FUNCTIONS_URL: ${{ secrets.EXPO_PUBLIC_SUPABASE_URL_PROD }}/functions/v1',
    );
  });
});
