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
curl -s localhost:8080/v1/health
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

```bash
# from repo root
docker build -f packages/org-server/Dockerfile -t staka-org-server .
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
docker run --rm -p 127.0.0.1:8080:8080 \
  -e NODE_ENV=production \
  -e TRUST_PROXY=1 \
  # same secret mounts as above
  staka-org-server serve
```

`docker-compose.prod.yml` is still a sketch for the packaging track; the binary
now supports migrate, serve, and `*_FILE` secrets.

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

```bash
# create an enrollment code (plaintext printed once)
bun run code:create -- --employee-id EMP-0001 --flow admin
```

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
