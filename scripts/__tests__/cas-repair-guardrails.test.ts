import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(process.cwd(), 'scripts', 'cas-repair');

function read(name: string): string {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

describe('Q5 exact-target repair guardrails', () => {
  it('keeps the target runtime-only and uses provenance as the only delete selector', () => {
    const source = [
      read('exact-target-dry-run.sql'),
      read('exact-target-backup.sql'),
      read('exact-target-apply.sql'),
      read('exact-target-rollback.sql'),
    ].join('\n');

    expect(source).toContain("where t.cas_import_id = approved.import_id");
    expect(source).not.toMatch(/delete[\s\S]{0,300}(transaction_date|amount|fund_id|user_id)\s*=/i);
    expect(source).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('rechecks the approved manifest under a lock and aborts on any drift', () => {
    const source = read('exact-target-apply.sql');

    expect(source).toContain('transaction isolation level serializable');
    expect(source).toContain('lock table public.transaction in share row exclusive mode');
    expect(source).toContain('q5_immediate_approval_missing');
    expect(source).toContain('q5_approved_manifest_changed');
    expect(source).toContain('q5_unrelated_rows_changed');
    expect(source).toContain("'APPROVE_Q5_EXACT_TARGET_DELETE'");
  });

  it('encrypts backups, rejects non-dev URLs, and deletes rollback plaintext', () => {
    const source = read('run-exact-target-repair.sh');

    expect(source).toContain("DEV_PROJECT_REF='imkgazlrxtlhkfptkzjc'");
    expect(source).toContain('refusing non-dev database target');
    expect(source).toContain('openssl enc -aes-256-cbc -pbkdf2 -salt');
    expect(source).toContain('chmod 600 "$Q5_BACKUP_PATH"');
    expect(source).toContain('trap cleanup_plaintext EXIT INT TERM');
    expect(source).toContain('rm -f -- "$plaintext_path"');
  });

  it('requires an exact-count rollback with no primary-key conflicts', () => {
    const source = read('exact-target-rollback.sql');

    expect(source).toContain('q5_restore_count_mismatch');
    expect(source).toContain('q5_restore_primary_key_conflict');
    expect(source).toContain('q5_restore_scope_invalid');
  });
});
