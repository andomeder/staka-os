# staka-org-server

Central org server for workstation provisioning by hardware ID.

## Stack

- Bun + Hono + Drizzle + PostgreSQL 18
- Shared types: `@staka/protocol`
- Server-rendered admin UI (hono/jsx)

## Dev loop

Preferred local path: Postgres in Docker, app via `bun --watch`.

```bash
# from packages/org-server
cp .env.example .env
docker compose up -d postgres
# resolve the published host port (compose uses an ephemeral binding)
export DATABASE_URL="postgres://staka@127.0.0.1:$(docker compose port postgres 5432 | awk -F: '{print $NF}')/staka"
bun run db:migrate
bun run db:seed
bun run dev
# bare bun listens on PORT from .env (default 8080)
curl -s "http://127.0.0.1:${PORT:-8080}/v1/health"
```

Full containerized path (migrate then app):

```bash
docker compose up --build
```

## Database roles

Migrations create `staka_app` and `staka_admin` with least-privilege grants
(including column deny of `machines.hwid_components` for the app role, and
append-only `admin_audit_log`).

Runtime uses dual-role pools: `DATABASE_APP_URL` (`staka_app`) for normal
traffic and `DATABASE_ADMIN_URL` (`staka_admin`) for PII reads. Owner
`DATABASE_URL` remains for migrate/seed.

## Binary commands

The compiled image entrypoint is a multi-command binary:

```
staka-org-server                 # default: serve
staka-org-server serve
staka-org-server migrate
staka-org-server seed            # refused in production unless STAKA_ALLOW_PROD_SEED=1
staka-org-server audit-verify
```

Migrations are packaged at `/app/db/migrations` (override with
`STAKA_MIGRATIONS_DIR`).

## Secrets

Secrets may be supplied as plain env vars or Docker-style files:

| Env | File form |
|---|---|
| `DATABASE_URL` | `DATABASE_URL_FILE` |
| `DATABASE_APP_URL` | `DATABASE_APP_URL_FILE` |
| `DATABASE_ADMIN_URL` | `DATABASE_ADMIN_URL_FILE` |
| `STAKA_JWT_KEYS` | `STAKA_JWT_KEYS_FILE` |
| `STAKA_SEED_ADMIN_PASSWORD` | `STAKA_SEED_ADMIN_PASSWORD_FILE` |

When `*_FILE` is set it wins. Missing files fail startup. Never log secret values.

Production (`NODE_ENV=production`) requires distinct `DATABASE_APP_URL` and
`DATABASE_ADMIN_URL`. Set `STAKA_ALLOW_SINGLE_DB_ROLE=1` only for constrained
lab hosts.

Behind Caddy or another reverse proxy, set `TRUST_PROXY=1` so rate limits use
`X-Forwarded-For` / `X-Real-IP`. The proxy must overwrite those headers.

## Production image

Build from repo root:

```bash
docker build -f packages/org-server/Dockerfile -t staka-org-server .
```

GHCR image: `ghcr.io/andomeder/staka-org-server` (tags: full git sha, short sha,
`latest`). Published by `.github/workflows/release-org-server.yml` on tag
`org-server-v*` or workflow_dispatch. Manual push:

```bash
SHA=$(git rev-parse HEAD)
docker build -f packages/org-server/Dockerfile -t "ghcr.io/andomeder/staka-org-server:${SHA}" .
docker tag "ghcr.io/andomeder/staka-org-server:${SHA}" ghcr.io/andomeder/staka-org-server:latest
echo "$GHCR_TOKEN" | docker login ghcr.io -u andomeder --password-stdin
docker push "ghcr.io/andomeder/staka-org-server:${SHA}"
docker push ghcr.io/andomeder/staka-org-server:latest
```

On a VPS, pin the compose `image:` lines to the full sha (or digests) so deploys
do not float on `:latest`. Local compose sets `pull_policy: build` so a clean
host builds from this tree instead of pulling GHCR first.

### Host layout (`/opt/staka-org-server`)

```
/opt/staka-org-server/
  docker-compose.prod.yml
  Caddyfile                 # reverse proxy on deploy host; optional locally
  secrets/                  # mode 0700 dir; secret files mode 600; never commit real secrets
    postgres_user
    postgres_password
    database_url            # owner/migrate URL (postgres://staka:...@postgres:5432/staka)
    database_app_url
    database_admin_url
    staka_jwt_keys
    staka_app_password      # used once by role-passwords init
    staka_admin_password
  backups/
  .env                      # non-secret toggles only (e.g. STAKA_ORG_HOST_PORT=18080)
```

Shape-only examples live in `secrets/*.example`. Generate real files once:

```bash
cd packages/org-server
./scripts/gen-prod-secrets.sh
# refuses overwrite if secrets already exist (avoids DB lockout).
# rotate deliberately: FORCE=1 ./scripts/gen-prod-secrets.sh
# optional: pick a free loopback port if 18080 is taken
export STAKA_ORG_HOST_PORT=18080
docker compose -f docker-compose.prod.yml up -d --build
# host probes (image is distroless; no in-container curl)
HOST_PORT=${STAKA_ORG_HOST_PORT:-18080}
curl -fsS "http://127.0.0.1:${HOST_PORT}/v1/health"
curl -fsS "http://127.0.0.1:${HOST_PORT}/v1/ready"
# or: docker compose -f docker-compose.prod.yml port org-server 8080
```

`docker-compose.prod.yml` runs: postgres → migrate (same image, `migrate`) →
role-passwords (sets scram passwords on `staka_app` / `staka_admin`) →
`org-server` (`serve`) with `NODE_ENV=production`, `TRUST_PROXY=1`, dual DB
role secrets, JWT file secret, bind `127.0.0.1:${STAKA_ORG_HOST_PORT:-18080}` →
container `8080`. Postgres is not published. Dev compose already uses an
ephemeral host port (`127.0.0.1::8080`). Caddy should reverse_proxy to the
chosen host port, not a public `8080`.

Single-container equivalent:

```bash
docker run --rm \
  -e NODE_ENV=production \
  -e TRUST_PROXY=1 \
  -e DATABASE_URL_FILE=/run/secrets/database_url \
  -e DATABASE_APP_URL_FILE=/run/secrets/database_app_url \
  -e DATABASE_ADMIN_URL_FILE=/run/secrets/database_admin_url \
  -e STAKA_JWT_KEYS_FILE=/run/secrets/staka_jwt_keys \
  -v "$PWD/secrets/database_url:/run/secrets/database_url:ro" \
  -v "$PWD/secrets/database_app_url:/run/secrets/database_app_url:ro" \
  -v "$PWD/secrets/database_admin_url:/run/secrets/database_admin_url:ro" \
  -v "$PWD/secrets/staka_jwt_keys:/run/secrets/staka_jwt_keys:ro" \
  staka-org-server migrate
docker run --rm -p "127.0.0.1:${STAKA_ORG_HOST_PORT:-18080}:8080" \
  -e NODE_ENV=production \
  -e TRUST_PROXY=1 \
  # same secret mounts as above
  staka-org-server serve
```

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/health` | liveness |
| GET | `/v1/ready` | readiness (Postgres) |
| GET | `/v1/config` | org config payload |
| POST | `/v1/auth/login` | admin JWT |
| POST | `/v1/auth/refresh` | rotate admin JWT |
| POST | `/v1/auth/logout` | invalidate session |
| * | `/v1/admin/*` | admin API (Bearer admin JWT) |
| * | `/admin/*` | server-rendered dashboard |
| POST | `/v1/kb/search` | agent KB search (machine JWT) |
| POST | `/v1/kb/skills` | agent org-skill search (machine JWT) |
| POST | `/v1/kb/who-knows` | evidence-backed colleague resolution (machine JWT) |
| GET | `/v1/kb/documents/:id` | full document text (machine JWT) |
| GET/POST | `/v1/admin/skill-packs` | list / upload org skill packs (admin JWT) |
| GET | `/v1/skill-packs/pull` | machine pulls current pack tarball (machine JWT) |

```bash
# create an enrollment code (plaintext printed once)
bun run code:create -- --employee-id EMP-0001 --flow admin
```

## Knowledge base engine

Org documents, directory profiles, and skill packs are indexed into a
retrieval engine (`supermemory lite`, MIT) deployed as a private second
container alongside `org-server`. Agents never reach the engine: every
query goes through `/v1/kb/*` with a machine JWT, and the server resolves
the org space (one `containerTag` per org) server-side. Documents flagged
sensitive are excluded from agent retrieval and stay admin-preview only.

Engine environment variables (org-server side):

- `STAKA_KB_ENGINE_URL` - engine base URL (compose: `http://supermemory:6767`).
  Without it the KB routes answer `503 kb_unavailable` and everything else works.
- `STAKA_KB_ENGINE_KEY` (or `*_FILE`) - engine API key.
- `STAKA_KB_SPACE` - optional space override; default derives `org_default`.

First boot of the engine generates its API key and stores it in
`/data/api-key` inside the `supermemory_data` volume. Copy it into the
`staka_kb_engine_key` secret and restart `org-server`:

```bash
docker compose -f docker-compose.prod.yml exec supermemory cat /data/api-key \
  > secrets/staka_kb_engine_key   # mode 600, never commit
docker compose -f docker-compose.prod.yml up -d org-server
```

Ops notes:

- The engine embeds a local embedding model (768d, no API key). An optional
  LLM key (e.g. `GEMINI_API_KEY`) enables memory extraction during ingest;
  document search works without one.
- The self-hosted binary is licensed up to 10,000 documents per store.
- `SUPERMEMORY_EMBEDDING_RAM_LIMIT` bounds ingest memory; it ships as
  `512mb` in compose. Measure RSS on the target host before raising it.
- The engine data directory holds the encrypted store and the API key;
  include the `supermemory_data` volume in backup coverage alongside
  Postgres dumps (skill pack bytes live in Postgres, so pack pull/verify
  is covered by the standard DB backup).

## Security notes

- Enrollment codes are always bound to a user.
- Machine JWTs are Ed25519 with `kid`; status is re-checked in DB.
- Admin JWTs carry `jti` and are tracked in an in-memory session store (rotation + logout).
  Single-process only: not multi-instance safe; restart logs everyone out.
- Dashboard secrets (nonce/code/PII) use one-shot server flash keyed by jti, not query strings.
- Dashboard CSRF is signed double-submit + `SameSite=Strict` admin cookie.
- `STAKA_AUTO_APPROVE` requires a paired confirm flag and refuses production boot.
- `bun run audit:verify` walks the admin audit forward hash-chain. Residual risk:
  DB superuser can rewrite history; no external tip is stored yet.

## Database backups

Prod backups run on the **host** (not inside the distroless app image).

1. Import the backup **public** key into a host keyring (private key stays off the VPS).
2. Copy `backup.env.example` to `backup.env`, set `BACKUP_KEY_ID` (fingerprint), paths, and optional `OFFSITE_DIR`.
3. Run:

```bash
cd packages/org-server   # or your deploy checkout of this package
./scripts/backup-db.sh
```

Output: `backups/staka-pg-YYYYMMDDThhmmssZ.sql.gpg` (encrypted only; no plaintext dump).
Default retention deletes local (and `OFFSITE_DIR`) files older than `RETENTION_DAYS` (7).

Optional daily timer (host):

```bash
# /etc/systemd/system/staka-org-backup.service  (Type=oneshot, ExecStart=.../backup-db.sh)
# /etc/systemd/system/staka-org-backup.timer     (OnCalendar=daily)
sudo systemctl enable --now staka-org-backup.timer
```

### Restore

Decrypt-only check (no DB changes):

```bash
./scripts/restore-db.sh --input backups/staka-pg-TIMESTAMP.sql.gpg
# optional: --write-sql /secure/path/restore.sql
```

Apply into the compose Postgres service (destructive; needs private key in `GNUPGHOME`):

```bash
RESTORE_CONFIRM=yes ./scripts/restore-db.sh --input backups/staka-pg-TIMESTAMP.sql.gpg --apply
```

Prefer restoring into a **new** empty database or a throwaway compose stack before touching a live volume. Practice cutover is a separate ops drill.
