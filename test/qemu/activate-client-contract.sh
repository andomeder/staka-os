#!/usr/bin/env bash
# Static contract checks for the live ISO activation client vs @staka/protocol.
# Does not require a running org-server.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ACTIVATE="$ROOT/packages/image/configs/airootfs/root/staka-activate.sh"
CONFIGURATOR="$ROOT/packages/image/configs/airootfs/root/staka-configurator"
AUTOMATED="$ROOT/packages/image/configs/airootfs/root/.automated_script.sh"
PROTOCOL="$ROOT/packages/protocol/src/activate.ts"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -x $ACTIVATE ]] || fail "staka-activate.sh missing or not executable"
[[ -x $CONFIGURATOR ]] || fail "staka-configurator missing or not executable"
[[ -f $AUTOMATED ]] || fail ".automated_script.sh missing"
[[ -f $PROTOCOL ]] || fail "protocol activate.ts missing"

bash -n "$ACTIVATE"
bash -n "$CONFIGURATOR"
bash -n "$AUTOMATED"

# Endpoints / shapes the bash client must keep in sync with protocol routes.
for needle in \
  '/v1/activate/self/authenticate' \
  '/v1/activate/enroll' \
  '/v1/activate/status/' \
  '/v1/activate/token' \
  'enrollment_code' \
  'hardware_id' \
  'hwid_hash' \
  'hwid_components' \
  'product_uuid' \
  'board_serial' \
  'product_name' \
  'cpu_id' \
  'self_provision_token' \
  'enrollment_nonce' \
  'machine_jwt' \
  'flow:"admin"' \
  'flow:"self"'; do
  grep -qF "$needle" "$ACTIVATE" || fail "staka-activate.sh missing contract token: $needle"
done

# Protocol still exports the same core schemas.
for needle in \
  'export const Hostname' \
  'export const EnrollRequest' \
  'export const StatusResponse' \
  'export const TokenRequest' \
  'export const TokenResponse' \
  'export const SelfAuthenticateRequest' \
  'product_uuid' \
  'enrollment_nonce' \
  'machine_jwt'; do
  grep -qF "$needle" "$PROTOCOL" || fail "protocol missing: $needle"
done

# Password must not be accepted on argv.
if grep -qE -- '--password\)' "$ACTIVATE"; then
  # Reject path is required; ensure help does not advertise argv password.
  grep -q 'STAKA_SELF_PASSWORD' "$ACTIVATE" || fail "STAKA_SELF_PASSWORD missing"
  if grep -qE '^\s+--password PASS' "$ACTIVATE"; then
    fail "usage still advertises --password PASS"
  fi
else
  fail "expected explicit --password rejection branch"
fi

# Configurator must pass Flow B password via env, not argv.
grep -q 'STAKA_SELF_PASSWORD' "$CONFIGURATOR" || fail "configurator missing STAKA_SELF_PASSWORD"
if grep -qE -- '--password "\$self_password"' "$CONFIGURATOR"; then
  fail "configurator still passes password on argv"
fi

# Hostname regex must match protocol Hostname.
grep -qE '\^\[A-Za-z0-9-\]\{1,63\}\$' "$ACTIVATE" || fail "activate hostname regex drift"
grep -qE '\^\[A-Za-z0-9-\]\{1,63\}\$' "$CONFIGURATOR" || fail "configurator hostname regex drift"

# Installer is fail-closed without staka-configurator.
grep -q 'staka-configurator missing' "$AUTOMATED" || fail "automated_script not fail-closed"
if grep -qE '^\s+\./configurator$' "$AUTOMATED"; then
  fail "automated_script still falls back to legacy configurator"
fi

# Fake HTTP hard-fail: reject --password argv immediately.
if "$ACTIVATE" --password secret >/tmp/staka-activate-contract.out 2>&1; then
  fail "activate accepted --password"
fi
grep -qi 'STAKA_SELF_PASSWORD' /tmp/staka-activate-contract.out || fail "password rejection message missing"

echo "activate-client-contract: ok"
