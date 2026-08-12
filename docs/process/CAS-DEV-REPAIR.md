# CAS Shared-Dev Exact-Target Repair

This runbook repairs one known bad CAS import in the authorized shared-dev database. It is intentionally unusable against production and intentionally contains no import ID, user ID, statement filename, credential, scheme identity, extracted transaction, date, amount, units, or folio.

The repair is not part of a normal deployment. Do not put runtime values in shell history, source files, pull requests, comments, CI, logs, analytics, or a model transcript. Run the helper from a private local terminal with environment variables populated by a non-echoing credential source. The database URL and exact import ID are secrets for this procedure even if parts of their shape are otherwise known.

## Preconditions

- Q1-Q4 are merged into `origin/main`.
- The exact Q4 merge is green in both `Deploy Supabase (Dev)` and `Main Deploy` on the authorized `foliolens-main` channel.
- The deployed malformed-layout proof rejects before financial/domain writes.
- The target resolves to exactly one `cas_import` row in shared dev.
- The target transaction count and touched-scheme count match the accepted incident aggregates.
- Production is not connected, queried, deployed, or mutated.
- A human owner is available to review the dry-run manifest and approve immediately before deletion.

## Safety model

The only deletion predicate is `transaction.cas_import_id = target`. The dry run first proves the target audit exists and every attributed row belongs to that audit's owner, then hashes the complete exact-target row set and every unrelated transaction row. The apply step takes a short table lock, repeats the ownership proof, recomputes the approved counts and hashes, requires the literal immediate-approval phrase, deletes only the exact provenance target, and proves the unrelated count and digest are unchanged before commit. Any mismatch aborts the database transaction.

The encrypted backup contains the complete target rows and is private. The helper pipes database output directly to AES-256 encryption, writes both backup and key with mode 0600, and prints only the encrypted file's SHA-256 digest. Never run the backup SQL by itself because its standard output is intentionally the recoverable row stream.

## Private local setup

Install the PostgreSQL client (`libpq`) locally, or set `Q5_PSQL_BIN` to an executable `psql` path. Populate these values without echoing them:

    Q5_DEV_DB_HOST
    Q5_DEV_DB_PORT          # optional; defaults to 5432
    Q5_DEV_DB_NAME          # optional; defaults to postgres
    Q5_DEV_DB_USER
    Q5_DEV_DB_PASSWORD
    Q5_TARGET_IMPORT_ID
    Q5_BACKUP_PATH
    Q5_BACKUP_KEY_FILE

The wrapper passes the password, exact import ID, approved manifest, and approval phrase only through the child process environment, never in command arguments. It accepts either the exact direct shared-dev database host/user pair or an official Supabase pooler host with the exact shared-dev project-scoped user and refuses every other target. Keep the encrypted backup and key at different local paths outside the repository. Do not place either in a cloud-synchronized directory.

## Read-only dry run

Run:

    scripts/cas-repair/run-exact-target-repair.sh dry-run

The only permitted output is one JSON object containing:

- `target_count`
- `touched_scheme_count`
- `unrelated_count`
- `target_digest`
- `unrelated_digest`

Stop if the exact target and touched-scheme counts do not match the accepted program values. Do not investigate a mismatch by printing rows; diagnose with count-only predicates or stop for the owner.

## Recoverable backup

Run:

    scripts/cas-repair/run-exact-target-repair.sh backup

The only permitted output is `backup_sha256`. Confirm the encrypted backup and key both exist, are non-empty, are mode 0600, and are not inside the repository. Perform a recovery rehearsal against a disposable local database before requesting live mutation approval. The rehearsal must prove the complete target digest is restored and that a duplicate primary key aborts the rollback.

The wrapper creates the encrypted backup through a same-directory temporary file and renames it only after both database export and encryption succeed. It refuses to overwrite an existing backup.

## Immediate approval gate

Present the human owner only:

- environment: shared dev
- exact target count
- touched-scheme count
- unrelated count and digest
- target digest
- encrypted backup SHA-256
- recovery rehearsal pass/fail
- statement that the only predicate is exact `cas_import_id`

Do not present the import ID, user ID, row data, scheme identities, statement names, or financial values. Ask for explicit approval to delete exactly the resolved target now. Approval from an earlier milestone, review, plan, or conversation does not count.

After approval, populate the approved manifest without echoing values:

    Q5_EXPECTED_TARGET_COUNT
    Q5_EXPECTED_TARGET_DIGEST
    Q5_EXPECTED_UNRELATED_COUNT
    Q5_EXPECTED_UNRELATED_DIGEST
    Q5_BACKUP_SHA256
    Q5_APPROVE_EXACT_TARGET_DELETE=APPROVE_Q5_EXACT_TARGET_DELETE

Then run immediately:

    scripts/cas-repair/run-exact-target-repair.sh apply

Before contacting the database, the wrapper recomputes the encrypted file digest and proves the supplied key can decrypt it. Inside the same serializable transaction as the deletion, the apply SQL loads the backup into a temporary table and proves its exact row count, import scope, and complete-row digest match the approved target manifest. The plaintext temporary file is mode 0600 and is deleted on every exit. Permitted output is only the deleted count and `unrelated_unchanged: true`. Any other result is a stop condition.

## Recovery

Rollback is for a verified repair failure, not routine testing. Populate `Q5_EXPECTED_RESTORE_COUNT` and the approved `Q5_BACKUP_SHA256`, then run:

    scripts/cas-repair/run-exact-target-repair.sh rollback

The helper decrypts to a mode-0600 temporary file, restores all columns in one serializable transaction only when every backed-up primary key is absent and every row still belongs to the target audit owner, and deletes the plaintext on exit. It reports only restored count and conflict status.

## Post-repair proof

After deletion:

1. Repeat the dry run. It must report zero target rows and the previously approved unrelated count/digest.
2. Invoke `sync-fund-meta` through its existing provider-owned path for the touched shared schemes. Do not supply CAS metadata and do not log scheme identifiers.
3. Record only aggregate hydrated and explicitly unresolved counts. Review the previously broad-category subset against provider output without posting names.
4. Run the private CDSL statement alone through parser-only transient validation, destroy its process and scratch, then run the private NSDL statement alone only after its separate approved repaired-account mutation gate.
5. Run the sanitized synthetic CDSL insert/re-import proof in an isolated dev test account.
6. Verify web reload, persisted-cache restore, native foreground/SQLite sync, Portfolio value/gain/XIRR, transaction count, Money Trail, Funds, and timelines against the repaired transaction source.
7. Retain the encrypted backup and key only for the owner-approved rollback window. Delete both when that window closes and record only their deletion and prior digest.

## Stop conditions

Stop without mutation if any prerequisite, environment check, expected count, digest, backup check, recovery rehearsal, or immediate approval is absent or changed. Stop the entire program as a correctness interrupt if unrelated data changes, authoritative hydration writes CAS-derived metadata, either private statement crosses its allowed boundary, or any production surface is contacted.
