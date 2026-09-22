#!/usr/bin/env bash
# Generate Docker secret files for docker-compose.prod.yml (local or /opt layout).
# Does not print secret values. Refuses to overwrite existing files unless FORCE=1.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS_DIR="${SECRETS_DIR:-$ROOT/secrets}"
PG_USER="${STAKA_PG_USER:-staka}"
PG_HOST="${STAKA_PG_HOST:-postgres}"
PG_DB="${STAKA_PG_DB:-staka}"

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

REQUIRED_FILES=(
  postgres_user
  postgres_password
  staka_app_password
  staka_admin_password
  database_url
  database_app_url
  database_admin_url
  staka_jwt_keys
  staka_kb_engine_key
)

existing=()
for name in "${REQUIRED_FILES[@]}"; do
  if [[ -e "$SECRETS_DIR/$name" ]]; then
    existing+=("$name")
  fi
done

if ((${#existing[@]} > 0)) && [[ "${FORCE:-0}" != "1" ]]; then
  echo "Refusing to overwrite existing secret files under $SECRETS_DIR:" >&2
  printf '  %s\n' "${existing[@]}" >&2
  echo "Re-running would mint new DB/JWT secrets while an existing volume still" >&2
  echo "has the old owner password (lockout). Set FORCE=1 only after you intend" >&2
  echo "to rotate secrets and re-init or re-align the database." >&2
  exit 1
fi

rand() {
  openssl rand -base64 32 | tr -d '\n' | tr '+/' '-_'
}

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl required" >&2
  exit 1
fi

PG_PASSWORD="$(rand)"
APP_PASSWORD="$(rand)"
ADMIN_PASSWORD="$(rand)"

# Ed25519 PKCS8 PEM base64 via openssl + node/bun if available
JWT_JSON=""
if command -v bun >/dev/null 2>&1; then
  JWT_JSON="$(
    bun -e '
      import { generateKeyPairSync } from "node:crypto";
      const { privateKey } = generateKeyPairSync("ed25519");
      const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      process.stdout.write(JSON.stringify([{
        kid: "prod-1",
        private_key_base64: Buffer.from(pem, "utf8").toString("base64"),
      }]));
    '
  )"
elif command -v node >/dev/null 2>&1; then
  JWT_JSON="$(
    node -e '
      const { generateKeyPairSync } = require("node:crypto");
      const { privateKey } = generateKeyPairSync("ed25519");
      const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      process.stdout.write(JSON.stringify([{
        kid: "prod-1",
        private_key_base64: Buffer.from(pem, "utf8").toString("base64"),
      }]));
    '
  )"
else
  echo "bun or node required to mint STAKA_JWT_KEYS" >&2
  exit 1
fi

enc_pw() {
  # URL-encode password for postgres URLs (openssl rand is url-safe-ish; still encode)
  python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

PG_PW_ENC="$(enc_pw "$PG_PASSWORD")"
APP_PW_ENC="$(enc_pw "$APP_PASSWORD")"
ADMIN_PW_ENC="$(enc_pw "$ADMIN_PASSWORD")"

write() {
  local name="$1"
  local value="$2"
  local path="$SECRETS_DIR/$name"
  # umask so file is never world/group readable even briefly
  (umask 077 && printf '%s' "$value" >"$path")
  chmod 600 "$path"
}

write postgres_user "$PG_USER"
write postgres_password "$PG_PASSWORD"
write staka_app_password "$APP_PASSWORD"
write staka_admin_password "$ADMIN_PASSWORD"
write database_url "postgres://${PG_USER}:${PG_PW_ENC}@${PG_HOST}:5432/${PG_DB}"
write database_app_url "postgres://staka_app:${APP_PW_ENC}@${PG_HOST}:5432/${PG_DB}"
write database_admin_url "postgres://staka_admin:${ADMIN_PW_ENC}@${PG_HOST}:5432/${PG_DB}"
write staka_jwt_keys "$JWT_JSON"

# Knowledge base engine key. The engine auto-generates its own API key on
# first boot; this placeholder is overwritten from the engine data volume
# (see the knowledge base section in README.md).
write staka_kb_engine_key "$(rand)"

echo "Wrote secret files under $SECRETS_DIR (files mode 600; dir 0700). Values not printed."
echo "Next: docker compose -f docker-compose.prod.yml up -d --build"
