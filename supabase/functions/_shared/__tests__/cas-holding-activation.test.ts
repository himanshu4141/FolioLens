import { readFileSync } from 'fs';
import { resolve } from 'path';

const migration = readFileSync(
  resolve(__dirname, '../../../migrations/20260814000000_cas_holding_activation_recency.sql'),
  'utf8',
);
const q5Migration = readFileSync(
  resolve(__dirname, '../../../migrations/20260815000000_cas_import_outcomes.sql'),
  'utf8',
);
const importer = readFileSync(resolve(__dirname, '../import-cas.ts'), 'utf8');

describe('C1 authoritative CAS holding activation', () => {
  it('keeps the resolver and atomic writer service-role-only and security-invoker', () => {
    expect(migration).toContain('security invoker');
    expect(migration).not.toContain('security definer');
    expect(migration).toContain(
      'revoke all on function public.resolve_user_fund_activation_v1(',
    );
    expect(migration).toContain(
      ') from anon, authenticated;',
    );
    expect(migration).toContain(
      ') to service_role;',
    );
    expect(migration).toContain(
      'grant execute on function public.apply_cas_import_plans_v2(uuid, uuid, jsonb) to service_role',
    );
  });

  it('keeps recency ahead of balance interpretation and the post-plan ledger as an activation floor', () => {
    const recencyGuard = migration.indexOf(
      'if p_holding_existed and not p_closing_balance_is_current then',
    );
    const numericBalance = migration.indexOf(
      "if jsonb_typeof(p_closing_units) = 'number' then",
    );
    const transactionFallback = migration.indexOf('return p_has_transactions;');

    expect(recencyGuard).toBeGreaterThan(-1);
    expect(numericBalance).toBeGreaterThan(recencyGuard);
    expect(transactionFallback).toBeGreaterThan(numericBalance);
    expect(migration).toContain(
      'return p_existing_is_active and p_has_transactions;',
    );
  });

  it('delegates persisted activation to the shared policy owner after transaction mutation', () => {
    const insertedRows = migration.indexOf('with inserted_rows as (');
    const activationResolution = migration.indexOf(
      'final_is_active := public.resolve_user_fund_activation_v1(',
    );
    const activationWrite = migration.indexOf('set is_active = final_is_active');

    expect(insertedRows).toBeGreaterThan(-1);
    expect(activationResolution).toBeGreaterThan(insertedRows);
    expect(activationWrite).toBeGreaterThan(activationResolution);
    expect(migration).not.toContain(
      "jsonb_typeof(plan_row -> 'closing_units') = 'number'\n      and (plan_row ->> 'closing_units')::numeric = 0",
    );
  });

  it('keeps C1 as the v2 policy core while Q5 adds only an outcome wrapper', () => {
    expect(importer).toContain("supabase.rpc('apply_cas_import_plans_v3'");
    expect(importer).toContain('closing_balance_is_current:');
    expect(migration).toContain(
      'create or replace function public.apply_cas_import_plans_v2(',
    );
    expect(q5Migration).toContain(
      'create or replace function public.apply_cas_import_plans_v3(',
    );
    expect(q5Migration).toContain(
      'mutation_result := public.apply_cas_import_plans_v2(p_user_id, p_import_id, p_plans);',
    );
    expect(q5Migration).toContain("'holding_changed_count', holding_changed_count");
    expect(migration).toContain("'fund_count', fund_count");
    expect(migration).toContain("'inserted_count', inserted_count");
    expect(migration).toContain("'deleted_count', deleted_count");
    expect(migration).toContain("'provisional_scheme_count', provisional_scheme_count");
  });

  it('validates activation evidence before making a decision', () => {
    expect(migration).toContain("message = 'cas_invalid_activation_evidence'");
    expect(migration).toContain(
      "jsonb_typeof(p_closing_units) not in ('number', 'null')",
    );
    expect(migration).toContain(
      'p_holding_existed and p_existing_is_active is null',
    );
  });
});
