#!/usr/bin/env bash
# Generate Docker secret files for docker-compose.prod.yml (local or /opt layout).
# Does not print secret values. Overwrites files in SECRETS_DIR.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS_DIR="${SECRETS_DIR:-$ROOT/secrets}"
PG_USER="${STAKA_PG_USER:-staka}"
PG_HOST="${STAKA_PG_HOST:-postgres}"
PG_DB="${STAKA_PG_DB:-staka}"

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

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
  printf '%s' "$value" >"$path"
  chmod 644 "$path"
}

write postgres_user "$PG_USER"
write postgres_password "$PG_PASSWORD"
write staka_app_password "$APP_PASSWORD"
write staka_admin_password "$ADMIN_PASSWORD"
write database_url "postgres://${PG_USER}:${PG_PW_ENC}@${PG_HOST}:5432/${PG_DB}"
write database_app_url "postgres://staka_app:${APP_PW_ENC}@${PG_HOST}:5432/${PG_DB}"
write database_admin_url "postgres://staka_admin:${ADMIN_PW_ENC}@${PG_HOST}:5432/${PG_DB}"
write staka_jwt_keys "$JWT_JSON"

echo "Wrote secret files under $SECRETS_DIR (mode 644; dir 0700). Values not printed."
echo "Next: docker compose -f docker-compose.prod.yml up -d --build"
