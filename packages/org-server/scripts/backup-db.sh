#!/usr/bin/env bash
# Encrypted Postgres dump for staka-org-server prod compose.
# Streams pg_dump | gpg; never writes a plaintext dump.
# Config via env file (default: ../backup.env next to this script, or BACKUP_ENV).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

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
BACKUP_KEY_ID="${BACKUP_KEY_ID:?BACKUP_KEY_ID required (GPG fingerprint or key id)}"
BACKUP_DIR="${BACKUP_DIR:-$PKG_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
OFFSITE_DIR="${OFFSITE_DIR:-}"
GNUPGHOME="${GNUPGHOME:-${BACKUP_GNUPGHOME:-}}"

if [[ -n "${GNUPGHOME:-}" ]]; then
  export GNUPGHOME
fi

die() {
  echo "backup-db: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

need docker
need gpg
need date

[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
[[ -f "$PG_USER_FILE" ]] || die "postgres user file not found: $PG_USER_FILE"
[[ -f "$PG_PASSWORD_FILE" ]] || die "postgres password file not found: $PG_PASSWORD_FILE"

if ! gpg --batch --list-keys "$BACKUP_KEY_ID" >/dev/null 2>&1; then
  die "GPG public key not found for BACKUP_KEY_ID=$BACKUP_KEY_ID (import pubkey first)"
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/staka-pg-${TS}.sql.gpg"
TMP_GPG="$(mktemp -p "$BACKUP_DIR" ".staka-pg-${TS}.XXXXXX.gpg.partial")"
cleanup() {
  rm -f "$TMP_GPG"
}
trap cleanup EXIT

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
[[ -n "$PG_USER" ]] || die "empty postgres user file"

# Password via env into container only (not argv).
export PGPASSWORD
PGPASSWORD="$(tr -d '\n' <"$PG_PASSWORD_FILE")"
[[ -n "$PGPASSWORD" ]] || die "empty postgres password file"

set +e
compose exec -T \
  -e PGPASSWORD \
  "$POSTGRES_SERVICE" \
  pg_dump -U "$PG_USER" -d "$PG_DB" --no-owner --no-acl \
  | gpg --batch --yes --trust-model always \
    --encrypt --recipient "$BACKUP_KEY_ID" \
    --output "$TMP_GPG"
pipe_status=("${PIPESTATUS[@]}")
status="${pipe_status[0]:-1}"
gpg_status="${pipe_status[1]:-1}"
set -e
unset PGPASSWORD

if [[ "$status" -ne 0 ]]; then
  die "pg_dump failed (exit $status)"
fi
if [[ "$gpg_status" -ne 0 ]]; then
  die "gpg encrypt failed (exit $gpg_status)"
fi
if [[ ! -s "$TMP_GPG" ]]; then
  die "encrypted output empty"
fi

mv -f "$TMP_GPG" "$OUT"
chmod 600 "$OUT"
trap - EXIT

if [[ -n "$OFFSITE_DIR" ]]; then
  mkdir -p "$OFFSITE_DIR"
  chmod 700 "$OFFSITE_DIR"
  cp -a "$OUT" "$OFFSITE_DIR/"
  chmod 600 "$OFFSITE_DIR/$(basename "$OUT")"
fi

# Retention: delete local encrypted dumps older than RETENTION_DAYS.
if [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && [[ "$RETENTION_DAYS" -gt 0 ]]; then
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'staka-pg-*.sql.gpg' -mtime "+$RETENTION_DAYS" -delete
  if [[ -n "$OFFSITE_DIR" && -d "$OFFSITE_DIR" ]]; then
    find "$OFFSITE_DIR" -maxdepth 1 -type f -name 'staka-pg-*.sql.gpg' -mtime "+$RETENTION_DAYS" -delete
  fi
fi

echo "backup-db: wrote $OUT ($(wc -c <"$OUT" | tr -d ' ') bytes)"
if [[ -n "$OFFSITE_DIR" ]]; then
  echo "backup-db: offsite copy $OFFSITE_DIR/$(basename "$OUT")"
fi
