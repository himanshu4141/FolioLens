import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

describe('Supabase schema-sensitive deployment order', () => {
  it('deploys DEV functions before migrations', () => {
    const workflow = fs.readFileSync(
      path.join(ROOT, '.github/workflows/supabase-deploy-dev.yml'),
      'utf8',
    );
    expect(workflow.indexOf('- name: Deploy all Edge Functions')).toBeGreaterThan(-1);
    expect(workflow.indexOf('- name: Push migrations')).toBeGreaterThan(
      workflow.indexOf('- name: Deploy all Edge Functions'),
    );
  });

  it('makes PROD migrations depend on successful function deployment', () => {
    const workflow = fs.readFileSync(
      path.join(ROOT, '.github/workflows/supabase-deploy-prod.yml'),
      'utf8',
    );
    const migrationJob = workflow.slice(workflow.indexOf('  run-migrations:'));
    expect(migrationJob).toContain('      - deploy-functions');
    expect(migrationJob.indexOf('      - deploy-functions')).toBeLessThan(
      migrationJob.indexOf('      - name: Push migrations'),
    );
  });
});
