import { readFileSync } from 'fs';
import { resolve } from 'path';

const migration = readFileSync(
  resolve(__dirname, '../../../migrations/20260811000000_cas_catalog_atomic_import.sql'),
  'utf8',
);
const q5Migration = readFileSync(
  resolve(__dirname, '../../../migrations/20260815000000_cas_import_outcomes.sql'),
  'utf8',
);
const importer = readFileSync(resolve(__dirname, '../import-cas.ts'), 'utf8');
const directEntry = readFileSync(resolve(__dirname, '../../parse-cas-pdf/index.ts'), 'utf8');
const inboundEntry = readFileSync(resolve(__dirname, '../../cas-webhook-resend/index.ts'), 'utf8');
const metadataWriter = readFileSync(resolve(__dirname, '../../sync-fund-meta/index.ts'), 'utf8');

describe('Q4 CAS catalog and atomic-write boundary', () => {
  it('keeps both database functions service-role-only and security-invoker', () => {
    expect(migration).toContain('security invoker');
    expect(migration).not.toContain('security definer');
    expect(migration).toContain(
      'revoke all on function public.apply_cas_import_plans_v2(uuid, uuid, jsonb) from anon, authenticated',
    );
    expect(migration).toContain(
      'grant execute on function public.apply_cas_import_plans_v2(uuid, uuid, jsonb) to service_role',
    );
    expect(q5Migration).toContain('security invoker');
    expect(q5Migration).not.toContain('security definer');
    expect(q5Migration).toContain(
      'revoke all on function public.apply_cas_import_plans_v3(uuid, uuid, jsonb) from anon, authenticated',
    );
    expect(q5Migration).toContain(
      'grant execute on function public.apply_cas_import_plans_v3(uuid, uuid, jsonb) to service_role',
    );
  });

  it('allows only a minimal insert and never updates an existing catalog row', () => {
    const catalogInsert = migration.match(
      /insert into public\.scheme_master[\s\S]*?on conflict \(scheme_code\) do nothing/,
    )?.[0];
    expect(catalogInsert).toBeDefined();
    expect(catalogInsert).toContain('scheme_code');
    expect(catalogInsert).toContain('scheme_name');
    expect(catalogInsert).toContain('cas_identity_created_at');
    expect(catalogInsert).not.toContain('scheme_category');
    expect(catalogInsert).not.toContain('benchmark_index');
    expect(migration).not.toMatch(/update public\.scheme_master/);
  });

  it('removes direct catalog, benchmark, holding, and transaction writes from the importer', () => {
    expect(importer).not.toContain(".from('scheme_master')");
    expect(importer).not.toContain(".from('benchmark_mapping')");
    expect(importer).not.toMatch(/\.from\('user_fund'\)[\s\S]{0,160}\.upsert/);
    expect(importer).toContain("supabase.rpc('apply_cas_import_plans_v3'");
  });

  it('invokes authoritative metadata hydration from both import entry points', () => {
    for (const source of [directEntry, inboundEntry]) {
      expect(source).toContain('catalogHydrationRequested');
      expect(source).toContain('/functions/v1/sync-fund-meta');
    }
  });

  it('selects pending identities internally and hydrates them from canonical mfapi identity', () => {
    expect(metadataWriter).toContain(".not('cas_identity_created_at', 'is', null)");
    expect(metadataWriter).toContain(".is('cas_identity_hydrated_at', null)");
    expect(metadataWriter).toContain('payload.scheme_name = mfapiIdentity.schemeName');
    expect(metadataWriter).toContain('payload.cas_identity_hydrated_at = syncedAt');
    expect(metadataWriter).toContain('payload.cas_identity_hydration_attempted_at = syncedAt');
    expect(metadataWriter).toContain("mode === 'exact-target-repair'");
    expect(metadataWriter).toContain(
      "req.headers.get('Authorization') !== `Bearer ${serviceRoleKey}`",
    );
    expect(metadataWriter).toContain('success: !exactTargetRepair || failed === 0');
    expect(metadataWriter).not.toContain('console.log(schemeCode');
  });

  it('keeps disjoint email attachments atomic but rejects cross-attachment scheme overlap', () => {
    expect(inboundEntry).toContain('hasCrossAttachmentSchemeOverlap(parsedPayloads)');
    expect(inboundEntry).toContain('parsedPayloads.flatMap((payload) => payload.mutual_funds)');
    expect(inboundEntry.match(/await importCASData\(/g)).toHaveLength(1);
  });

  it('probes Q4 capability before reading migration-owned identity columns', () => {
    const capability = metadataWriter.indexOf("supabase.rpc('cas_import_schema_version_v2')");
    const pendingRead = metadataWriter.indexOf(".not('cas_identity_created_at', 'is', null)");
    expect(capability).toBeGreaterThan(-1);
    expect(pendingRead).toBeGreaterThan(capability);
  });

  it('hydrates benchmark identity and keeps raw scheme codes out of metadata logs', () => {
    expect(metadataWriter).toContain(".from('benchmark_mapping')");
    expect(metadataWriter).toContain('payload.benchmark_index = benchmark.benchmarkIndex');
    expect(metadataWriter).toContain(
      'payload.benchmark_index_symbol = benchmark.benchmarkIndexSymbol',
    );
    expect(metadataWriter).not.toContain('scheme %d');
  });
});
