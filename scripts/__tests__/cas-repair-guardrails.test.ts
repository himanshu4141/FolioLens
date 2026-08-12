import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(process.cwd(), 'scripts', 'cas-repair');
const RUNNER = path.join(ROOT, 'run-exact-target-repair.sh');

function read(name: string): string {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

function baseEnv(psqlBin: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    Q5_PSQL_BIN: psqlBin,
    Q5_DEV_DB_HOST: 'db.imkgazlrxtlhkfptkzjc.supabase.co',
    Q5_DEV_DB_USER: 'postgres',
    Q5_DEV_DB_PASSWORD: 'synthetic-password-never-print',
    Q5_TARGET_IMPORT_ID: '00000000-0000-4000-8000-000000000001',
  };
}

function writeExecutable(file: string, source: string): void {
  fs.writeFileSync(file, source, { mode: 0o700 });
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
    expect(source).toContain('q5_target_count_invalid');
    expect(source).toContain('q5_target_ownership_mismatch');
    expect(source).toContain('q5_backup_manifest_mismatch');
    expect(source).toContain('q5_approved_manifest_changed');
    expect(source).toContain('q5_unrelated_rows_changed');
    expect(source).toContain("'APPROVE_Q5_EXACT_TARGET_DELETE'");
  });

  it('keeps database passwords out of argv and rejects non-dev connections', () => {
    const source = read('run-exact-target-repair.sh');

    expect(source).toContain("DEV_PROJECT_REF='imkgazlrxtlhkfptkzjc'");
    expect(source).toContain('refusing non-dev database target');
    expect(source).not.toContain('Q5_DEV_DB_URL');
    expect(source).toContain('export PGPASSWORD="$Q5_DEV_DB_PASSWORD"');
    expect(source).toContain('--host="$Q5_DEV_DB_HOST"');
    expect(source).toContain('--username="$Q5_DEV_DB_USER"');
    expect(source).not.toContain('--password');
    expect(source).not.toContain('--set="target_import_id=');
    expect(read('exact-target-dry-run.sql')).toContain(
      '\\getenv target_import_id Q5_TARGET_IMPORT_ID',
    );
    expect(read('exact-target-apply.sql')).toContain(
      '\\getenv approve_exact_target_delete Q5_APPROVE_EXACT_TARGET_DELETE',
    );
  });

  it('creates backups atomically and verifies them before apply or rollback', () => {
    const source = read('run-exact-target-repair.sh');
    const backupSql = read('exact-target-backup.sql');

    expect(source).toContain('openssl enc -aes-256-cbc -pbkdf2 -salt');
    expect(source).toContain('refusing to overwrite an existing encrypted backup');
    expect(source).toContain('mv "$encrypted_temp" "$Q5_BACKUP_PATH"');
    expect(source).toContain('encrypted backup digest mismatch');
    expect(source).toContain('encrypted backup cannot be verified with the supplied key');
    expect(source).toContain("expected_header='id,user_id,fund_id,transaction_date");
    expect(backupSql).toContain('q5_backup_target_import_not_unique');
    expect(backupSql).toContain('q5_backup_target_empty');
    expect(backupSql).toContain('q5_backup_target_ownership_mismatch');
    expect(source).toMatch(
      /apply\)[\s\S]*?require_backup_material[\s\S]*?verify_backup_digest[\s\S]*?;;/,
    );
    expect(source).toMatch(
      /rollback\)[\s\S]*?require_backup_material[\s\S]*?verify_backup_digest[\s\S]*?;;/,
    );
  });

  it('keeps private artifacts outside the repository and deletes rollback plaintext', () => {
    const source = read('run-exact-target-repair.sh');

    expect(source).toContain('must be outside the repository');
    expect(source).toContain('must not be a symbolic link');
    expect(source).toContain('chmod 600 "$Q5_BACKUP_PATH" "$Q5_BACKUP_KEY_FILE"');
    expect(source).toContain('trap cleanup_plaintext EXIT INT TERM');
    expect(source).toContain('rm -f -- "$plaintext_path"');
  });

  it('requires an exact-count rollback with no primary-key conflicts', () => {
    const source = read('exact-target-rollback.sql');

    expect(source).toContain('q5_restore_count_mismatch');
    expect(source).toContain('q5_restore_primary_key_conflict');
    expect(source).toContain('q5_restore_scope_invalid');
    expect(source).toContain('q5_restore_owner_mismatch');
  });

  it('runs psql without placing the database password in argv', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'q5-runner-argv-'));
    try {
      const fakePsql = path.join(temp, 'psql');
      writeExecutable(fakePsql, `#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  if [[ "$arg" == *"$Q5_DEV_DB_PASSWORD"* ]]; then
    exit 91
  fi
  if [[ "$arg" == *"$Q5_TARGET_IMPORT_ID"* ]]; then
    exit 92
  fi
done
printf '{"target_count":1}\n'
`);

      const result = spawnSync(RUNNER, ['dry-run'], {
        env: baseEnv(fakePsql),
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('{"target_count":1}\n');
      expect(result.stderr).toBe('');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('never publishes a partial encrypted backup when export fails', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'q5-runner-backup-'));
    try {
      const fakePsql = path.join(temp, 'psql');
      const backup = path.join(temp, 'rows.enc');
      const key = path.join(temp, 'rows.key');
      writeExecutable(fakePsql, '#!/usr/bin/env bash\nexit 7\n');

      const result = spawnSync(RUNNER, ['backup'], {
        env: {
          ...baseEnv(fakePsql),
          Q5_BACKUP_PATH: backup,
          Q5_BACKUP_KEY_FILE: key,
        },
        encoding: 'utf8',
      });

      expect(result.status).not.toBe(0);
      expect(fs.existsSync(backup)).toBe(false);
      expect(
        fs.readdirSync(temp).some((name) => name.startsWith('.foliolens-q5-backup.')),
      ).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('verifies the encrypted backup digest and key before apply', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'q5-runner-verify-'));
    try {
      const fakePsql = path.join(temp, 'psql');
      const marker = path.join(temp, 'psql-invoked');
      const backup = path.join(temp, 'rows.enc');
      const key = path.join(temp, 'rows.key');
      writeExecutable(fakePsql, `#!/usr/bin/env bash
set -euo pipefail
[[ -f "$Q5_BACKUP_PLAINTEXT_PATH" ]]
printf '%s' "$Q5_BACKUP_PLAINTEXT_PATH" > "$Q5_FAKE_PSQL_MARKER"
printf '{"deleted_count":1,"unrelated_unchanged":true}\n'
`);
      fs.writeFileSync(key, 'synthetic-local-key\n', { mode: 0o600 });
      const header = 'id,user_id,fund_id,transaction_date,transaction_type,units,nav_at_transaction,amount,folio_number,cas_import_id,cas_event_ordinal,created_at\n';
      const encrypted = spawnSync(
        'openssl',
        ['enc', '-aes-256-cbc', '-pbkdf2', '-salt', '-pass', `file:${key}`, '-out', backup],
        { input: header, encoding: 'utf8' },
      );
      expect(encrypted.status).toBe(0);
      const backupSha = crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex');
      const env = {
        ...baseEnv(fakePsql),
        Q5_FAKE_PSQL_MARKER: marker,
        Q5_BACKUP_PATH: backup,
        Q5_BACKUP_KEY_FILE: key,
        Q5_BACKUP_SHA256: backupSha,
        Q5_EXPECTED_TARGET_COUNT: '1',
        Q5_EXPECTED_TARGET_DIGEST: '0'.repeat(64),
        Q5_EXPECTED_UNRELATED_COUNT: '1',
        Q5_EXPECTED_UNRELATED_DIGEST: '1'.repeat(64),
        Q5_APPROVE_EXACT_TARGET_DELETE: 'APPROVE_Q5_EXACT_TARGET_DELETE',
      };

      const mismatch = spawnSync(RUNNER, ['apply'], {
        env: { ...env, Q5_BACKUP_SHA256: 'f'.repeat(64) },
        encoding: 'utf8',
      });
      expect(mismatch.status).toBe(4);
      expect(mismatch.stderr).toContain('encrypted backup digest mismatch');
      expect(fs.existsSync(marker)).toBe(false);

      const verified = spawnSync(RUNNER, ['apply'], { env, encoding: 'utf8' });
      expect(verified.status).toBe(0);
      expect(verified.stdout).toBe('{"deleted_count":1,"unrelated_unchanged":true}\n');
      expect(fs.existsSync(marker)).toBe(true);
      const plaintextPath = fs.readFileSync(marker, 'utf8');
      expect(fs.existsSync(plaintextPath)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
