#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly POSTGRES_IMAGE='postgres:17-alpine'

if [[ -z "${PGPASSWORD:-}" ]]; then
  printf 'PGPASSWORD is required by the ephemeral psql container\n' >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  printf 'Docker is required by the CLI-authenticated psql adapter\n' >&2
  exit 2
fi

docker_args=(
  run --rm -i
  --volume "$SCRIPT_DIR:$SCRIPT_DIR:ro"
  --env PGPASSWORD
  --env PGSSLMODE
  --env PGCONNECT_TIMEOUT
  --env PGAPPNAME
)

for name in \
  Q5_TARGET_IMPORT_ID \
  Q5_EXPECTED_TARGET_COUNT \
  Q5_EXPECTED_TARGET_DIGEST \
  Q5_EXPECTED_UNRELATED_COUNT \
  Q5_EXPECTED_UNRELATED_DIGEST \
  Q5_BACKUP_SHA256 \
  Q5_APPROVE_EXACT_TARGET_DELETE \
  Q5_EXPECTED_RESTORE_COUNT \
  Q5_BACKUP_PLAINTEXT_PATH
do
  if [[ -n "${!name:-}" ]]; then
    docker_args+=(--env "$name")
  fi
done

if [[ -n "${Q5_BACKUP_PLAINTEXT_PATH:-}" ]]; then
  if [[ ! "$Q5_BACKUP_PLAINTEXT_PATH" =~ ^/tmp/foliolens-q5-restore\.[A-Za-z0-9]+$ \
    || ! -f "$Q5_BACKUP_PLAINTEXT_PATH" \
    || -L "$Q5_BACKUP_PLAINTEXT_PATH" ]]
  then
    printf 'refusing unexpected plaintext backup mount\n' >&2
    exit 2
  fi
  docker_args+=(--volume "$Q5_BACKUP_PLAINTEXT_PATH:$Q5_BACKUP_PLAINTEXT_PATH:ro")
fi

exec docker "${docker_args[@]}" "$POSTGRES_IMAGE" psql "$@"
