#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly DEV_PROJECT_REF='imkgazlrxtlhkfptkzjc'
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf 'missing required environment variable: %s\n' "$name" >&2
    exit 2
  fi
}

require_var Q5_DEV_DB_URL
require_var Q5_TARGET_IMPORT_ID

if [[ "$Q5_DEV_DB_URL" != *"$DEV_PROJECT_REF"* ]]; then
  printf 'refusing non-dev database target\n' >&2
  exit 3
fi

readonly MODE="${1:-}"
readonly PSQL_BASE=(
  psql "$Q5_DEV_DB_URL" --no-psqlrc --tuples-only --no-align
  --set="target_import_id=$Q5_TARGET_IMPORT_ID"
)

case "$MODE" in
  dry-run)
    "${PSQL_BASE[@]}" --file="$SCRIPT_DIR/exact-target-dry-run.sql"
    ;;

  backup)
    require_var Q5_BACKUP_PATH
    require_var Q5_BACKUP_KEY_FILE
    if [[ ! -f "$Q5_BACKUP_KEY_FILE" ]]; then
      openssl rand -hex 32 >"$Q5_BACKUP_KEY_FILE"
      chmod 600 "$Q5_BACKUP_KEY_FILE"
    fi
    "${PSQL_BASE[@]}" --file="$SCRIPT_DIR/exact-target-backup.sql" \
      | openssl enc -aes-256-cbc -pbkdf2 -salt \
          -pass "file:$Q5_BACKUP_KEY_FILE" -out "$Q5_BACKUP_PATH"
    chmod 600 "$Q5_BACKUP_PATH"
    printf '{"backup_sha256":"%s"}\n' "$(shasum -a 256 "$Q5_BACKUP_PATH" | awk '{print $1}')"
    ;;

  apply)
    require_var Q5_EXPECTED_TARGET_COUNT
    require_var Q5_EXPECTED_TARGET_DIGEST
    require_var Q5_EXPECTED_UNRELATED_COUNT
    require_var Q5_EXPECTED_UNRELATED_DIGEST
    require_var Q5_BACKUP_SHA256
    require_var Q5_APPROVE_EXACT_TARGET_DELETE
    "${PSQL_BASE[@]}" \
      --set="expected_target_count=$Q5_EXPECTED_TARGET_COUNT" \
      --set="expected_target_digest=$Q5_EXPECTED_TARGET_DIGEST" \
      --set="expected_unrelated_count=$Q5_EXPECTED_UNRELATED_COUNT" \
      --set="expected_unrelated_digest=$Q5_EXPECTED_UNRELATED_DIGEST" \
      --set="backup_sha256=$Q5_BACKUP_SHA256" \
      --set="approve_exact_target_delete=$Q5_APPROVE_EXACT_TARGET_DELETE" \
      --file="$SCRIPT_DIR/exact-target-apply.sql"
    ;;

  rollback)
    require_var Q5_BACKUP_PATH
    require_var Q5_BACKUP_KEY_FILE
    require_var Q5_EXPECTED_RESTORE_COUNT
    plaintext_path="$(mktemp "${TMPDIR:-/tmp}/foliolens-q5-restore.XXXXXX")"
    cleanup_plaintext() {
      rm -f -- "$plaintext_path"
    }
    trap cleanup_plaintext EXIT INT TERM
    openssl enc -d -aes-256-cbc -pbkdf2 \
      -pass "file:$Q5_BACKUP_KEY_FILE" -in "$Q5_BACKUP_PATH" -out "$plaintext_path"
    chmod 600 "$plaintext_path"
    export Q5_BACKUP_PLAINTEXT_PATH="$plaintext_path"
    "${PSQL_BASE[@]}" \
      --set="expected_restore_count=$Q5_EXPECTED_RESTORE_COUNT" \
      --file="$SCRIPT_DIR/exact-target-rollback.sql"
    ;;

  *)
    printf 'usage: %s {dry-run|backup|apply|rollback}\n' "$0" >&2
    exit 2
    ;;
esac
