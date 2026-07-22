#!/usr/bin/env bash
# Decrypt a staka-pg-*.sql.gpg dump and optionally restore into a target DB.
# Default is dry-run: decrypt to stdout checksum / write SQL only with --write-sql.
# Destructive restore requires --apply and RESTORE_CONFIRM=yes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  restore-db.sh --input PATH.sql.gpg [--write-sql OUT.sql]
  restore-db.sh --input PATH.sql.gpg --apply   # needs RESTORE_CONFIRM=yes

Env:
  BACKUP_ENV           optional path to backup.env
  GNUPGHOME            keyring with private key (or default user keyring)
  COMPOSE_FILE         default: ../docker-compose.prod.yml
  COMPOSE_ENV_FILE     optional compose --env-file
  COMPOSE_PROJECT_DIR  default: package dir
  POSTGRES_SERVICE     default: postgres
  PG_USER_FILE         default: secrets/postgres_user
  PG_PASSWORD_FILE     default: secrets/postgres_password
  PG_DB                default: staka
  RESTORE_CONFIRM      must be "yes" with --apply
EOF
}

INPUT=""
WRITE_SQL=""
APPLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --input)
      INPUT="${2:-}"
      shift 2
      ;;
    --write-sql)
      WRITE_SQL="${2:-}"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

BACKUP_ENV="${BACKUP_ENV:-$PKG_DIR/backup.env}"
if [[ -f "$BACKUP_ENV" ]]; then
  # shellcheck disable=SC1090
  set -a
  # shellcheck disable=SC1090
  source "$BACKUP_ENV"
  set +a
fi

COMPOSE_FILE="${COMPOSE_FILE:-$PKG_DIR/docker-compose.prod.yml}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-}"
COMPOSE_PROJECT_DIR="${COMPOSE_PROJECT_DIR:-$PKG_DIR}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
PG_USER_FILE="${PG_USER_FILE:-$PKG_DIR/secrets/postgres_user}"
PG_PASSWORD_FILE="${PG_PASSWORD_FILE:-$PKG_DIR/secrets/postgres_password}"
PG_DB="${PG_DB:-staka}"
GNUPGHOME="${GNUPGHOME:-${BACKUP_GNUPGHOME:-}}"

if [[ -n "${GNUPGHOME:-}" ]]; then
  export GNUPGHOME
fi

die() {
  echo "restore-db: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

need gpg
[[ -n "$INPUT" ]] || die "--input required"
[[ -f "$INPUT" ]] || die "input not found: $INPUT"

if [[ "$APPLY" -eq 1 ]]; then
  [[ "${RESTORE_CONFIRM:-}" == "yes" ]] || die "set RESTORE_CONFIRM=yes to apply restore"
  need docker
  [[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
  [[ -f "$PG_USER_FILE" ]] || die "postgres user file not found"
  [[ -f "$PG_PASSWORD_FILE" ]] || die "postgres password file not found"
fi

decrypt_stream() {
  gpg --batch --yes --decrypt --output - "$INPUT"
}

if [[ "$APPLY" -eq 0 ]]; then
  if [[ -n "$WRITE_SQL" ]]; then
    umask 077
    decrypt_stream >"$WRITE_SQL"
    chmod 600 "$WRITE_SQL"
    echo "restore-db: wrote decrypted SQL to $WRITE_SQL"
    echo "restore-db: dry-run complete (no database changes)"
  else
    # Prove decrypt works without leaving SQL on disk.
    bytes="$(decrypt_stream | wc -c | tr -d ' ')"
    echo "restore-db: decrypt ok ($bytes bytes plaintext if written)"
    echo "restore-db: dry-run complete (no database changes, no SQL file)"
  fi
  exit 0
fi

compose() {
  local -a args=(docker compose -f "$COMPOSE_FILE")
  if [[ -n "$COMPOSE_ENV_FILE" ]]; then
    args+=(--env-file "$COMPOSE_ENV_FILE")
  fi
  (
    cd "$COMPOSE_PROJECT_DIR"
    "${args[@]}" "$@"
  )
}

PG_USER="$(tr -d '\n' <"$PG_USER_FILE")"
export PGPASSWORD
PGPASSWORD="$(tr -d '\n' <"$PG_PASSWORD_FILE")"

echo "restore-db: applying $INPUT into database $PG_DB (destructive to existing objects as dump defines)" >&2
set +e
decrypt_stream | compose exec -T \
  -e PGPASSWORD \
  "$POSTGRES_SERVICE" \
  psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1
pipe_status=("${PIPESTATUS[@]}")
status="${pipe_status[0]:-1}"
psql_status="${pipe_status[1]:-1}"
set -e
unset PGPASSWORD

if [[ "$status" -ne 0 ]]; then
  die "gpg decrypt failed (exit $status)"
fi
if [[ "$psql_status" -ne 0 ]]; then
  die "psql restore failed (exit $psql_status)"
fi

echo "restore-db: apply finished"
