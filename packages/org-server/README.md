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

## Production compose

`docker-compose.prod.yml` is a deploy sketch only. It is not runnable yet:
the compiled binary has no `migrate` subcommand, secret `*_FILE` env vars are
not loaded by the process, and migrations are not packaged into the runtime
image. Use the dev compose path until the deploy work lands.

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
