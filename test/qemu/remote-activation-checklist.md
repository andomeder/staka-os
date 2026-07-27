# Remote activation checklist

Manual path against a deployed org server over HTTPS. Flow A (admin-provisioned) only. Not CI.

Default target: `https://org.staka.cc`

## Preconditions

- [ ] Public HTTPS: `curl -sS https://org.staka.cc/v1/health` and `/v1/ready` return 200
- [ ] Admin login page: `https://org.staka.cc/admin/login` returns 200
- [ ] `STAKA_AUTO_APPROVE` is off on the server
- [ ] Host has `staka-activate.sh` (repo tree or live ISO root)
- [ ] Fresh hardware identity for this run (do not reuse a bound HWID)

## 1. DNS and HTTPS

```bash
curl -sS -D- -o /dev/null https://org.staka.cc/v1/health | head -n 20
curl -sS https://org.staka.cc/v1/ready
curl -sS -o /dev/null -w '%{http_code}\n' https://org.staka.cc/admin/login
```

- [ ] Health 200
- [ ] Ready 200 with `db` up
- [ ] Admin login 200

## 2. Admin session

Use the dashboard or the JSON API.

Dashboard: open `https://org.staka.cc/admin/login`, sign in with the seed admin employee id and password from host secrets (never commit).

API:

```bash
ORG=https://org.staka.cc
# ADMIN_PASSWORD from host secrets only
curl -sS -X POST "$ORG/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"employee_id\":\"EMP-0001\",\"password\":\"$ADMIN_PASSWORD\"}"
# record admin_jwt once; do not log it into git
```

- [ ] Login 200 and admin JWT issued

## 3. Invited staff user and enrollment code

Dashboard: create staff user (invited), generate an admin-flow code, copy plaintext once.

API:

```bash
curl -sS -X POST "$ORG/v1/admin/users" \
  -H "authorization: Bearer $ADMIN_JWT" \
  -H 'content-type: application/json' \
  -d "{\"employee_id\":\"EMP-RMT-$(date +%s)\",\"display_name\":\"Remote Check\",\"role\":\"staff\"}"

curl -sS -X POST "$ORG/v1/admin/codes" \
  -H "authorization: Bearer $ADMIN_JWT" \
  -H 'content-type: application/json' \
  -d "{\"user_id\":\"$USER_ID\",\"flow\":\"admin\",\"max_uses\":1}"
# record plaintext code once
```

- [ ] User 201 `invited`
- [ ] Code 201 with one-time plaintext

## 4. Flow A enroll (host client)

Unique HWID required. Prefer explicit overrides over host DMI when testing from a workstation that may already be bound.

```bash
export STAKA_HWID_PRODUCT_UUID="$(uuidgen)"
export STAKA_HWID_BOARD_SERIAL="REMOTE-CHECK-1"
export STAKA_HWID_PRODUCT_NAME="Remote Activation Check"
export STAKA_HWID_CPU_ID="check-cpu"
./packages/image/configs/airootfs/root/staka-activate.sh \
  --org-url https://org.staka.cc \
  --code "$CODE" \
  --hostname "remote-check-$(date +%s | tail -c 6)" \
  --flow admin \
  --token-out /tmp/staka-remote-machine.token \
  --state-out /tmp/staka-remote-activation.json \
  --timeout 120
```

While pending, approve in admin UI or:

```bash
curl -sS -X POST "$ORG/v1/admin/machines/$MACHINE_ID/approve" \
  -H "authorization: Bearer $ADMIN_JWT" \
  -H 'content-type: application/json' \
  -d '{}'
```

If the script is waiting on status, complete approve before the timeout. Token write path may be script-driven after nonce; otherwise exchange manually:

```bash
curl -sS -X POST "$ORG/v1/activate/token" \
  -H 'content-type: application/json' \
  -d "{\"machine_id\":\"$MACHINE_ID\",\"enrollment_nonce\":\"$NONCE\"}"
```

Heartbeat (if not already done by the client after token):

```bash
curl -sS -X POST "$ORG/v1/activate/heartbeat" \
  -H "authorization: Bearer $MACHINE_JWT" \
  -H 'content-type: application/json' \
  -d '{}'
```

- [ ] Enroll 202 `pending`
- [ ] Approve 200 with one-time nonce
- [ ] Token 200; machine JWT written (mode 600 preferred)
- [ ] Heartbeat 200
- [ ] Dashboard or `GET /v1/admin/machines` shows `active`

## 5. Audit chain (read-only)

On the deploy host, same image as serve, owner DB URL via secret file only:

```bash
ssh cloudsurfer-server-hetzner
cd ~/staka-org-server/src/packages/org-server
docker compose -f docker-compose.prod.yml --env-file ../../../.env \
  run --rm --no-deps \
  -e DATABASE_URL_FILE=/run/secrets/database_url \
  org-server audit-verify
```

- [ ] Exit code 0
- [ ] No writes to application data beyond what the verifier needs to read

## 6. Record (outside git)

Store under `/mnt/staka-media/artifacts/remote-activation/` or `odocs/setup/` only. No JWTs, codes, or passwords in the artifact.

| Field | Value |
|---|---|
| Date | |
| Org URL | https://org.staka.cc |
| Deployed sha | |
| Enroll HTTP | |
| Approve / token / heartbeat | |
| Machine status | |
| audit-verify exit | |
| Notes | |

## Pass bar

Pass when Flow A enroll/approve/token/heartbeat succeeds once against the public URL and `audit-verify` exits 0 on prod. ISO rebuild is not required if the host activate client proves the API path.
