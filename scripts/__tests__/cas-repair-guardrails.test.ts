import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.join(process.cwd(), 'scripts', 'cas-repair');
const RUNNER = path.join(ROOT, 'run-exact-target-repair.sh');
const HYDRATION_JSON_HELPER = path.join(ROOT, 'hydration-batch-json.cjs');
const PROJECT_REF = 'imkgazlrxtlhkfptkzjc';

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
    expect(source).toContain('lock table public.user_fund in share row exclusive mode');
    expect(source).toContain('lock table public.transaction in share row exclusive mode');
    expect(source).toContain('q5_immediate_approval_missing');
    expect(source).toContain('q5_target_count_invalid');
    expect(source).toContain('q5_target_ownership_mismatch');
    expect(source).toContain('q5_backup_manifest_mismatch');
    expect(source).toContain('q5_approved_manifest_changed');
    expect(source).toContain('q5_unrelated_rows_changed');
    expect(source).toContain("'APPROVE_Q5_EXACT_TARGET_DELETE'");
    expect(source).toContain('q5_holding_activation_mismatch');
    expect(source).toContain('public.resolve_user_fund_activation_v1(');
    expect(source).toContain('backed_up_holding.prior_is_active');
    expect(source).not.toContain('set is_active = exists (');
  });

  it('pins the shared-dev digest dependency instead of relying on session search_path', () => {
    const digestSql = [read('exact-target-dry-run.sql'), read('exact-target-apply.sql')].join('\n');

    expect(digestSql).toContain("extensions.digest('', 'sha256')");
    expect(digestSql).not.toMatch(/(?<!extensions\.)\bdigest\(/);
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
    expect(backupSql).toContain('prior_holding_is_active');
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
    expect(source).toContain('q5_restore_holding_state_invalid');
    expect(source).toContain('q5_restore_holding_state_changed');
    expect(source).toContain('q5_restore_holding_activation_mismatch');
    expect(source).toContain('set is_active = backed_up_holding.prior_is_active');
    expect(source).toContain('public.resolve_user_fund_activation_v1(');
    expect(source).not.toContain('set is_active = exists (');
  });

  it('derives authoritative hydration scope only from the encrypted exact-target backup', () => {
    const runner = read('run-exact-target-repair.sh');
    const scope = read('exact-target-hydration-scope.sql');
    const guard = scope.match(/do \$\$([\s\S]*?)\$\$;/)?.[1];

    expect(scope).toContain('create temporary table q5_hydration_expected');
    expect(scope).toContain("select * into strict expected from q5_hydration_expected");
    expect(scope).toContain('q5_hydration_scope_mismatch');
    expect(scope).toContain('q5_hydration_owner_mismatch');
    expect(scope).toContain("'mode', 'exact-target-repair'");
    expect(scope).toContain("'scheme_codes'");
    expect(guard).toBeDefined();
    expect(guard).not.toContain(":'target_import_id'");
    expect(guard).not.toContain(":'expected_target_count'");
    expect(guard).toContain('expected.import_id');
    expect(guard).toContain('expected.target_count');
    expect(scope).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(runner).toContain('refusing non-dev function target');
    expect(runner).toContain('trap cleanup_plaintext EXIT INT TERM');
    expect(runner).not.toContain('--header "Authorization: Bearer');
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

  it('uses the intended CLI-target refusal when the session port is unset', () => {
    const env = baseEnv('/must-not-run');
    env.Q5_REPAIR_AUTH_MODE = 'cli-temporary';
    env.Q5_CLI_ROLE_EXPIRES_AT_EPOCH = String(Math.floor(Date.now() / 1000) + 300);
    env.Q5_DEV_DB_HOST = 'aws-0-eu-west-1.pooler.supabase.com';
    env.Q5_DEV_DB_USER = `cli_login_postgres.${PROJECT_REF}`;
    delete env.Q5_DEV_DB_PORT;

    const result = spawnSync(RUNNER, ['dry-run'], { env, encoding: 'utf8' });

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('refusing invalid or expired Supabase CLI database target');
    expect(result.stderr).not.toContain('unbound variable');
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
      const header = 'id,user_id,fund_id,transaction_date,transaction_type,units,nav_at_transaction,amount,folio_number,cas_import_id,cas_event_ordinal,created_at,prior_holding_is_active\n';
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

  it('rejects an encrypted backup with the wrong CSV header before psql', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'q5-runner-header-'));
    try {
      const fakePsql = path.join(temp, 'psql');
      const marker = path.join(temp, 'psql-invoked');
      const backup = path.join(temp, 'rows.enc');
      const key = path.join(temp, 'rows.key');
      writeExecutable(fakePsql, `#!/usr/bin/env bash
touch "$Q5_FAKE_PSQL_MARKER"
`);
      fs.writeFileSync(key, 'synthetic-local-key\n', { mode: 0o600 });
      const encrypted = spawnSync(
        'openssl',
        ['enc', '-aes-256-cbc', '-pbkdf2', '-salt', '-pass', `file:${key}`, '-out', backup],
        { input: 'wrong,header\n', encoding: 'utf8' },
      );
      expect(encrypted.status).toBe(0);
      const backupSha = crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex');

      const result = spawnSync(RUNNER, ['apply'], {
        env: {
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
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(4);
      expect(result.stderr).toContain('encrypted backup cannot be verified');
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('strictly prepares one ordered authoritative hydration scope', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'q5-hydration-json-'));
    try {
      const scope = path.join(temp, 'scope.json');
      const plan = path.join(temp, 'plan.jsonl');
      fs.writeFileSync(
        scope,
        '{"mode":"exact-target-repair","scheme_codes":[123,456,789]}\n',
        { mode: 0o600 },
      );
      const valid = spawnSync(HYDRATION_JSON_HELPER, ['prepare', scope, plan], {
        encoding: 'utf8',
      });
      expect(valid.status).toBe(0);
      expect(valid.stdout).toBe('3\n');
      expect(fs.statSync(plan).mode & 0o777).toBe(0o600);
      expect(
        fs.readFileSync(plan, 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
      ).toEqual([
        { mode: 'exact-target-repair', scheme_codes: [123] },
        { mode: 'exact-target-repair', scheme_codes: [456] },
        { mode: 'exact-target-repair', scheme_codes: [789] },
      ]);

      for (const invalidScope of [
        '{"mode":"exact-target-repair","scheme_codes":[]}',
        '{"mode":"exact-target-repair","scheme_codes":[123,123]}',
        '{"mode":"exact-target-repair","scheme_codes":[456,123]}',
        '{"mode":"exact-target-repair","scheme_codes":[123.5]}',
        '{"mode":"exact-target-repair","scheme_codes":[123],"extra":true}',
        '{"mode":"other","scheme_codes":[123]}',
      ]) {
        fs.writeFileSync(scope, invalidScope, { mode: 0o600 });
        const invalid = spawnSync(HYDRATION_JSON_HELPER, ['prepare', scope, plan], {
          encoding: 'utf8',
        });
        expect(invalid.status).toBe(4);
        expect(invalid.stdout).toBe('');
        expect(invalid.stderr).toBe('authoritative hydration scope was invalid\n');
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('runs strict single-scheme hydration batches and stops before later work on failure', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'q5-runner-hydrate-'));
    const tempPrefixes = [
      'foliolens-q5-restore.',
      'foliolens-q5-hydration-scope.',
      'foliolens-q5-hydration-plan.',
      'foliolens-q5-hydration-payload.',
      'foliolens-q5-hydration-response.',
      'foliolens-q5-hydration-curl.',
    ];
    const privateTemps = () => new Set(
      fs.readdirSync('/tmp').filter((name) => tempPrefixes.some((prefix) => name.startsWith(prefix))),
    );
    const before = privateTemps();
    try {
      const fakePsql = path.join(temp, 'psql');
      const fakeCurl = path.join(temp, 'curl');
      const curlArgs = path.join(temp, 'curl-args');
      const curlState = path.join(temp, 'curl-state');
      const responses = path.join(temp, 'responses');
      const statuses = path.join(temp, 'statuses');
      const requests = path.join(temp, 'requests');
      const backup = path.join(temp, 'rows.enc');
      const key = path.join(temp, 'rows.key');
      const serviceKey = 'synthetic-service-key-never-print';
      writeExecutable(fakePsql, `#!/usr/bin/env bash
printf '{"mode":"exact-target-repair","scheme_codes":[123,456,789]}\n'
`);
      writeExecutable(fakeCurl, `#!/usr/bin/env bash
set -euo pipefail
count=0
if [[ -f "$Q5_FAKE_CURL_STATE" ]]; then
  count="$(<"$Q5_FAKE_CURL_STATE")"
fi
count=$((count + 1))
printf '%s' "$count" > "$Q5_FAKE_CURL_STATE"
printf '%s\n' "$@" >> "$Q5_FAKE_CURL_ARGS"
config="$2"
grep -qx 'connect-timeout = 10' "$config"
grep -qx 'max-time = 90' "$config"
payload="$(awk -F'"' '/^data-binary = / {print $2}' "$config")"
payload="\${payload#@}"
output="$(awk -F'"' '/^output = / {print $2}' "$config")"
cp "$payload" "$Q5_FAKE_REQUESTS/$count.json"
if [[ -n "\${Q5_FAKE_SLEEP_MARKER:-}" ]]; then
  touch "$Q5_FAKE_SLEEP_MARKER"
  sleep 30
fi
status="$(sed -n "\${count}p" "$Q5_FAKE_STATUSES")"
if [[ "$status" == 'TIMEOUT' ]]; then
  exit 28
fi
sed -n "\${count}p" "$Q5_FAKE_RESPONSES" > "$output"
printf '%s' "$status"
`);
      fs.writeFileSync(key, 'synthetic-local-key\n', { mode: 0o600 });
      const header = 'id,user_id,fund_id,transaction_date,transaction_type,units,nav_at_transaction,amount,folio_number,cas_import_id,cas_event_ordinal,created_at,prior_holding_is_active\n';
      const encrypted = spawnSync(
        'openssl',
        ['enc', '-aes-256-cbc', '-pbkdf2', '-salt', '-pass', `file:${key}`, '-out', backup],
        { input: header, encoding: 'utf8' },
      );
      expect(encrypted.status).toBe(0);
      const backupSha = crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex');

      const hydrationEnv = {
        ...baseEnv(fakePsql),
        PATH: `${temp}:${process.env.PATH ?? ''}`,
        Q5_FAKE_CURL_ARGS: curlArgs,
        Q5_FAKE_CURL_STATE: curlState,
        Q5_FAKE_RESPONSES: responses,
        Q5_FAKE_STATUSES: statuses,
        Q5_FAKE_REQUESTS: requests,
        Q5_BACKUP_PATH: backup,
        Q5_BACKUP_KEY_FILE: key,
        Q5_BACKUP_SHA256: backupSha,
        Q5_EXPECTED_TARGET_COUNT: '1',
        Q5_APPROVE_EXACT_TARGET_DELETE: 'APPROVE_Q5_EXACT_TARGET_DELETE',
        Q5_DEV_FUNCTIONS_URL:
          'https://imkgazlrxtlhkfptkzjc.supabase.co/functions/v1/sync-fund-meta',
        Q5_DEV_SERVICE_ROLE_KEY: serviceKey,
      };
      const runHydration = (responseLines: string[], statusLines: string[]) => {
        fs.rmSync(curlState, { force: true });
        fs.rmSync(curlArgs, { force: true });
        fs.rmSync(requests, { recursive: true, force: true });
        fs.mkdirSync(requests);
        fs.writeFileSync(responses, `${responseLines.join('\n')}\n`, { mode: 0o600 });
        fs.writeFileSync(statuses, `${statusLines.join('\n')}\n`, { mode: 0o600 });
        return spawnSync(RUNNER, ['hydrate'], {
          env: hydrationEnv,
          encoding: 'utf8',
        });
      };

      const successResponse = '{"success":true,"updated":1,"failed":0,"skipped":0}';
      const result = runHydration(
        [successResponse, successResponse, successResponse],
        ['200', '200', '200'],
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('{"updated":3,"failed":0,"skipped":0}\n');
      for (const privateValue of [serviceKey, '123', '456', '789']) {
        expect(result.stdout).not.toContain(privateValue);
        expect(result.stderr).not.toContain(privateValue);
        expect(fs.readFileSync(curlArgs, 'utf8')).not.toContain(privateValue);
      }
      expect(
        fs.readdirSync(requests).sort().map((name) =>
          JSON.parse(fs.readFileSync(path.join(requests, name), 'utf8')).scheme_codes[0]
        ),
      ).toEqual([123, 456, 789]);

      const unresolved = runHydration(
        [
          successResponse,
          '{"success":false,"updated":0,"failed":1,"skipped":0}',
          successResponse,
        ],
        ['200', '200', '200'],
      );
      expect(unresolved.status).toBe(4);
      expect(unresolved.stdout).toBe('');
      expect(unresolved.stderr).toContain('response was unresolved');
      expect(fs.readFileSync(curlState, 'utf8')).toBe('2');

      const non200 = runHydration(
        [successResponse, '{"error":"synthetic"}', successResponse],
        ['200', '503', '200'],
      );
      expect(non200.status).toBe(4);
      expect(non200.stdout).toBe('');
      expect(non200.stderr).toContain('request failed');
      expect(fs.readFileSync(curlState, 'utf8')).toBe('2');

      const contradictory = runHydration(
        [
          successResponse,
          '{"success":true,"updated":0,"failed":0,"skipped":0}',
          successResponse,
        ],
        ['200', '200', '200'],
      );
      expect(contradictory.status).toBe(4);
      expect(contradictory.stdout).toBe('');
      expect(contradictory.stderr).toContain('response was unresolved');
      expect(fs.readFileSync(curlState, 'utf8')).toBe('2');

      const malformed = runHydration(
        [
          successResponse,
          '{"success":true,"updated":1,"failed":0,"skipped":0,"extra":true}',
          successResponse,
        ],
        ['200', '200', '200'],
      );
      expect(malformed.status).toBe(4);
      expect(malformed.stdout).toBe('');
      expect(malformed.stderr).toContain('response was unresolved');
      expect(fs.readFileSync(curlState, 'utf8')).toBe('2');

      const timeout = runHydration(
        [successResponse, successResponse, successResponse],
        ['200', 'TIMEOUT', '200'],
      );
      expect(timeout.status).toBe(4);
      expect(timeout.stdout).toBe('');
      expect(timeout.stderr).toContain('request failed');
      expect(fs.readFileSync(curlState, 'utf8')).toBe('2');

      fs.rmSync(curlState, { force: true });
      fs.rmSync(curlArgs, { force: true });
      fs.rmSync(requests, { recursive: true, force: true });
      fs.mkdirSync(requests);
      fs.writeFileSync(responses, `${successResponse}\n`, { mode: 0o600 });
      fs.writeFileSync(statuses, '200\n', { mode: 0o600 });
      const signalMarker = path.join(temp, 'signal-marker');
      const child = spawn(RUNNER, ['hydrate'], {
        env: { ...hydrationEnv, Q5_FAKE_SLEEP_MARKER: signalMarker },
        detached: true,
        stdio: 'ignore',
      });
      try {
        for (let attempt = 0; attempt < 100 && !fs.existsSync(signalMarker); attempt += 1) {
          await sleep(20);
        }
        expect(fs.existsSync(signalMarker)).toBe(true);
        process.kill(-child.pid!, 'SIGTERM');
        await new Promise<void>((resolve) => child.once('close', () => resolve()));
      } finally {
        if (child.exitCode === null) {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            // The detached process group has already exited.
          }
        }
      }

      const after = privateTemps();
      expect([...after].filter((name) => !before.has(name))).toEqual([]);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 15_000);
});
