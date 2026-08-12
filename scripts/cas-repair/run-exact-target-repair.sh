#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly DEV_PROJECT_REF='imkgazlrxtlhkfptkzjc'
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf 'missing required environment variable: %s\n' "$name" >&2
    exit 2
  fi
}

resolve_psql() {
  local candidate="${Q5_PSQL_BIN:-}"
  if [[ -n "$candidate" ]]; then
    if [[ ! -x "$candidate" ]]; then
      printf 'Q5_PSQL_BIN is not executable\n' >&2
      exit 2
    fi
    printf '%s\n' "$candidate"
    return
  fi

  if command -v psql >/dev/null 2>&1; then
    command -v psql
    return
  fi

  for candidate in \
    /opt/homebrew/opt/libpq/bin/psql \
    /usr/local/opt/libpq/bin/psql \
    /Applications/Postgres.app/Contents/Versions/latest/bin/psql
  do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  printf 'psql is required; install libpq or set Q5_PSQL_BIN\n' >&2
  exit 2
}

resolved_path() {
  local path="$1"
  local parent
  parent="$(cd "$(dirname "$path")" && pwd -P)"
  printf '%s/%s\n' "$parent" "$(basename "$path")"
}

require_private_artifact_path() {
  local name="$1"
  local path="${!name}"
  local resolved
  if [[ -L "$path" ]]; then
    printf '%s must not be a symbolic link\n' "$name" >&2
    exit 2
  fi
  resolved="$(resolved_path "$path")"
  if [[ "$resolved" == "$REPO_ROOT" || "$resolved" == "$REPO_ROOT/"* ]]; then
    printf '%s must be outside the repository\n' "$name" >&2
    exit 2
  fi
}

require_backup_material() {
  require_var Q5_BACKUP_PATH
  require_var Q5_BACKUP_KEY_FILE
  require_private_artifact_path Q5_BACKUP_PATH
  require_private_artifact_path Q5_BACKUP_KEY_FILE
  if [[ ! -f "$Q5_BACKUP_PATH" || ! -s "$Q5_BACKUP_PATH" \
    || ! -f "$Q5_BACKUP_KEY_FILE" || ! -s "$Q5_BACKUP_KEY_FILE" ]]
  then
    printf 'encrypted backup and key must both be non-empty\n' >&2
    exit 2
  fi
  chmod 600 "$Q5_BACKUP_PATH" "$Q5_BACKUP_KEY_FILE"
}

verify_backup_digest() {
  require_var Q5_BACKUP_SHA256
  local actual
  local -r expected_header='id,user_id,fund_id,transaction_date,transaction_type,units,nav_at_transaction,amount,folio_number,cas_import_id,cas_event_ordinal,created_at'
  actual="$(shasum -a 256 "$Q5_BACKUP_PATH" | awk '{print $1}')"
  if [[ "$actual" != "$Q5_BACKUP_SHA256" ]]; then
    printf 'encrypted backup digest mismatch\n' >&2
    exit 4
  fi
  if ! openssl enc -d -aes-256-cbc -pbkdf2 \
    -pass "file:$Q5_BACKUP_KEY_FILE" -in "$Q5_BACKUP_PATH" \
    | {
        IFS= read -r header
        [[ "$header" == "$expected_header" ]]
        cat >/dev/null
      }
  then
    printf 'encrypted backup cannot be verified with the supplied key\n' >&2
    exit 4
  fi
}

decrypt_backup_to_temp() {
  # The SQL uses this generated path inside a \copy PROGRAM command. Keep the
  # directory and filename grammar fixed rather than accepting a caller-owned
  # TMPDIR containing shell metacharacters.
  plaintext_path="$(mktemp /tmp/foliolens-q5-restore.XXXXXX)"
  cleanup_plaintext() {
    rm -f -- "$plaintext_path"
  }
  trap cleanup_plaintext EXIT INT TERM
  openssl enc -d -aes-256-cbc -pbkdf2 \
    -pass "file:$Q5_BACKUP_KEY_FILE" -in "$Q5_BACKUP_PATH" -out "$plaintext_path"
  chmod 600 "$plaintext_path"
  export Q5_BACKUP_PLAINTEXT_PATH="$plaintext_path"
}

require_var Q5_DEV_DB_HOST
require_var Q5_DEV_DB_USER
require_var Q5_DEV_DB_PASSWORD
require_var Q5_TARGET_IMPORT_ID

if [[ ! ( "$Q5_DEV_DB_HOST" == "db.$DEV_PROJECT_REF.supabase.co" \
    && "$Q5_DEV_DB_USER" == 'postgres' ) \
  && ! ( "$Q5_DEV_DB_HOST" == *.pooler.supabase.com \
    && "$Q5_DEV_DB_USER" == "postgres.$DEV_PROJECT_REF" ) ]]
then
  printf 'refusing non-dev database target\n' >&2
  exit 3
fi

readonly MODE="${1:-}"
readonly PSQL_BIN="$(resolve_psql)"
readonly DB_PORT="${Q5_DEV_DB_PORT:-5432}"
readonly DB_NAME="${Q5_DEV_DB_NAME:-postgres}"
export PGPASSWORD="$Q5_DEV_DB_PASSWORD"
export PGSSLMODE=require
export PGCONNECT_TIMEOUT=15
export PGAPPNAME=foliolens-q5-exact-target-repair
readonly PSQL_BASE=(
  "$PSQL_BIN"
  --host="$Q5_DEV_DB_HOST"
  --port="$DB_PORT"
  --dbname="$DB_NAME"
  --username="$Q5_DEV_DB_USER"
  --no-psqlrc --tuples-only --no-align
)

case "$MODE" in
  dry-run)
    "${PSQL_BASE[@]}" --file="$SCRIPT_DIR/exact-target-dry-run.sql"
    ;;

  backup)
    require_var Q5_BACKUP_PATH
    require_var Q5_BACKUP_KEY_FILE
    require_private_artifact_path Q5_BACKUP_PATH
    require_private_artifact_path Q5_BACKUP_KEY_FILE
    if [[ "$(resolved_path "$Q5_BACKUP_PATH")" == "$(resolved_path "$Q5_BACKUP_KEY_FILE")" ]]; then
      printf 'backup and key paths must be different\n' >&2
      exit 2
    fi
    if [[ -e "$Q5_BACKUP_PATH" ]]; then
      printf 'refusing to overwrite an existing encrypted backup\n' >&2
      exit 2
    fi
    if [[ ! -f "$Q5_BACKUP_KEY_FILE" ]]; then
      openssl rand -hex 32 >"$Q5_BACKUP_KEY_FILE"
    fi
    if [[ ! -s "$Q5_BACKUP_KEY_FILE" ]]; then
      printf 'backup key must be non-empty\n' >&2
      exit 2
    fi
    chmod 600 "$Q5_BACKUP_KEY_FILE"
    encrypted_temp="$(mktemp "$(dirname "$Q5_BACKUP_PATH")/.foliolens-q5-backup.XXXXXX")"
    cleanup_encrypted_temp() {
      rm -f -- "$encrypted_temp"
    }
    trap cleanup_encrypted_temp EXIT INT TERM
    "${PSQL_BASE[@]}" --file="$SCRIPT_DIR/exact-target-backup.sql" \
      | openssl enc -aes-256-cbc -pbkdf2 -salt \
          -pass "file:$Q5_BACKUP_KEY_FILE" -out "$encrypted_temp"
    chmod 600 "$encrypted_temp"
    mv "$encrypted_temp" "$Q5_BACKUP_PATH"
    trap - EXIT INT TERM
    printf '{"backup_sha256":"%s"}\n' "$(shasum -a 256 "$Q5_BACKUP_PATH" | awk '{print $1}')"
    ;;

  apply)
    require_var Q5_EXPECTED_TARGET_COUNT
    require_var Q5_EXPECTED_TARGET_DIGEST
    require_var Q5_EXPECTED_UNRELATED_COUNT
    require_var Q5_EXPECTED_UNRELATED_DIGEST
    require_var Q5_BACKUP_SHA256
    require_var Q5_APPROVE_EXACT_TARGET_DELETE
    require_backup_material
    verify_backup_digest
    decrypt_backup_to_temp
    "${PSQL_BASE[@]}" --file="$SCRIPT_DIR/exact-target-apply.sql"
    ;;

  rollback)
    require_var Q5_EXPECTED_RESTORE_COUNT
    require_backup_material
    verify_backup_digest
    decrypt_backup_to_temp
    "${PSQL_BASE[@]}" --file="$SCRIPT_DIR/exact-target-rollback.sql"
    ;;

  *)
    printf 'usage: %s {dry-run|backup|apply|rollback}\n' "$0" >&2
    exit 2
    ;;
esac
