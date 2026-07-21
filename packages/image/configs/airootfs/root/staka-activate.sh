#!/usr/bin/env bash
# Org activation client for the live ISO.
# Captures HWID, enrolls (Flow A admin or Flow B self), polls status, exchanges
# nonce for machine JWT, and writes token material for the installed system.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: staka-activate.sh --org-url URL --code CODE --hostname NAME --flow admin|self [options]

Options:
  --org-url URL              Org server base URL (http://host:port)
  --code CODE                Enrollment code
  --hostname NAME            Machine hostname
  --flow admin|self          Provision flow (default: admin)
  --employee-id ID           Flow B employee id
  --password PASS            Flow B password
  --token-out PATH           Write machine JWT here (default: ./machine.token)
  --state-out PATH           Write activation state JSON (default: ./staka-activation.json)
  --poll-interval SEC        Override poll interval from server
  --timeout SEC              Max seconds waiting for approval (default: 1800)
  --auto-approve-wait        Keep polling until approved/active or timeout
EOF
}

ORG_URL=""
ENROLLMENT_CODE=""
HOSTNAME_VALUE=""
FLOW="admin"
EMPLOYEE_ID=""
PASSWORD=""
TOKEN_OUT="./machine.token"
STATE_OUT="./staka-activation.json"
POLL_INTERVAL=""
TIMEOUT_SEC=1800

while [[ $# -gt 0 ]]; do
  case "$1" in
  --org-url)
    ORG_URL="${2:-}"
    shift 2
    ;;
  --code)
    ENROLLMENT_CODE="${2:-}"
    shift 2
    ;;
  --hostname)
    HOSTNAME_VALUE="${2:-}"
    shift 2
    ;;
  --flow)
    FLOW="${2:-}"
    shift 2
    ;;
  --employee-id)
    EMPLOYEE_ID="${2:-}"
    shift 2
    ;;
  --password)
    PASSWORD="${2:-}"
    shift 2
    ;;
  --token-out)
    TOKEN_OUT="${2:-}"
    shift 2
    ;;
  --state-out)
    STATE_OUT="${2:-}"
    shift 2
    ;;
  --poll-interval)
    POLL_INTERVAL="${2:-}"
    shift 2
    ;;
  --timeout)
    TIMEOUT_SEC="${2:-}"
    shift 2
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    echo "unknown argument: $1" >&2
    usage >&2
    exit 2
    ;;
  esac
done

if [[ -z $ORG_URL || -z $ENROLLMENT_CODE || -z $HOSTNAME_VALUE ]]; then
  echo "org-url, code, and hostname are required" >&2
  usage >&2
  exit 2
fi

if [[ $FLOW != "admin" && $FLOW != "self" ]]; then
  echo "flow must be admin or self" >&2
  exit 2
fi

if [[ $FLOW == "self" && (-z $EMPLOYEE_ID || -z $PASSWORD) ]]; then
  echo "flow=self requires --employee-id and --password" >&2
  exit 2
fi

if ! [[ $HOSTNAME_VALUE =~ ^[A-Za-z0-9-]{1,63}$ ]]; then
  echo "invalid hostname" >&2
  exit 2
fi

for cmd in curl jq openssl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing required command: $cmd" >&2
    exit 1
  fi
done

ORG_URL="${ORG_URL%/}"

read_dmi() {
  local path="$1"
  if [[ -r $path ]]; then
    tr -d '\0\r\n' <"$path" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
  else
    printf ''
  fi
}

read_cpu_id() {
  local model
  model=$(awk -F: '/model name/ {gsub(/^[ \t]+/, "", $2); print $2; exit}' /proc/cpuinfo 2>/dev/null || true)
  printf '%s' "${model:-unknown}"
}

sha256_hex() {
  # openssl dgst prints "SHA2-256(stdin)= <hex>" or "SHA256(stdin)= <hex>"
  printf '%s' "$1" | openssl dgst -sha256 | awk '{print $NF}'
}

# Optional env overrides (host smoke / QEMU without DMI access). Live ISO runs as root.
PRODUCT_UUID="${STAKA_HWID_PRODUCT_UUID:-$(read_dmi /sys/class/dmi/id/product_uuid)}"
BOARD_SERIAL="${STAKA_HWID_BOARD_SERIAL:-$(read_dmi /sys/class/dmi/id/board_serial)}"
PRODUCT_NAME="${STAKA_HWID_PRODUCT_NAME:-$(read_dmi /sys/class/dmi/id/product_name)}"
CPU_ID="${STAKA_HWID_CPU_ID:-$(read_cpu_id)}"

if [[ -z $PRODUCT_UUID || $PRODUCT_UUID == "Not Specified" || $PRODUCT_UUID == "None" ]]; then
  # QEMU/headless fallback: stable synthetic uuid from machine-id + hostname
  if [[ -r /etc/machine-id ]]; then
    PRODUCT_UUID=$(sha256_hex "$(cat /etc/machine-id)-${HOSTNAME_VALUE}")
    PRODUCT_UUID="${PRODUCT_UUID:0:8}-${PRODUCT_UUID:8:4}-${PRODUCT_UUID:12:4}-${PRODUCT_UUID:16:4}-${PRODUCT_UUID:20:12}"
  else
    echo "product_uuid unavailable" >&2
    exit 1
  fi
fi

[[ -n $PRODUCT_NAME ]] || PRODUCT_NAME="unknown"
[[ -n $BOARD_SERIAL ]] || BOARD_SERIAL=""
[[ -n $CPU_ID ]] || CPU_ID="unknown"

HARDWARE_ID=$(sha256_hex "$PRODUCT_UUID")
HWID_HASH=$(sha256_hex "${PRODUCT_UUID}|${BOARD_SERIAL}|${CPU_ID}")

http_json() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  local tmp
  tmp=$(mktemp)
  local code
  if [[ -n $body ]]; then
    code=$(
      curl -sS -o "$tmp" -w '%{http_code}' \
        -X "$method" \
        -H 'Content-Type: application/json' \
        -H 'Accept: application/json' \
        --connect-timeout 10 \
        --max-time 60 \
        --data "$body" \
        "$url" || true
    )
  else
    code=$(
      curl -sS -o "$tmp" -w '%{http_code}' \
        -X "$method" \
        -H 'Accept: application/json' \
        --connect-timeout 10 \
        --max-time 60 \
        "$url" || true
    )
  fi
  HTTP_CODE="$code"
  HTTP_BODY=$(cat "$tmp")
  rm -f "$tmp"
}

SELF_PROVISION_TOKEN=""
if [[ $FLOW == "self" ]]; then
  auth_body=$(
    jq -nc \
      --arg employee_id "$EMPLOYEE_ID" \
      --arg password "$PASSWORD" \
      --arg enrollment_code "$ENROLLMENT_CODE" \
      '{employee_id:$employee_id,password:$password,enrollment_code:$enrollment_code}'
  )
  http_json POST "$ORG_URL/v1/activate/self/authenticate" "$auth_body"
  if [[ $HTTP_CODE != "200" ]]; then
    echo "self authenticate failed (HTTP $HTTP_CODE): $HTTP_BODY" >&2
    exit 1
  fi
  SELF_PROVISION_TOKEN=$(printf '%s' "$HTTP_BODY" | jq -er '.self_provision_token')
fi

if [[ $FLOW == "admin" ]]; then
  enroll_body=$(
    jq -nc \
      --arg enrollment_code "$ENROLLMENT_CODE" \
      --arg hardware_id "$HARDWARE_ID" \
      --arg hwid_hash "$HWID_HASH" \
      --arg product_uuid "$PRODUCT_UUID" \
      --arg board_serial "$BOARD_SERIAL" \
      --arg product_name "$PRODUCT_NAME" \
      --arg cpu_id "$CPU_ID" \
      --arg hostname "$HOSTNAME_VALUE" \
      '{
        enrollment_code:$enrollment_code,
        hardware_id:$hardware_id,
        hwid_hash:$hwid_hash,
        hwid_components:{
          product_uuid:$product_uuid,
          board_serial:$board_serial,
          product_name:$product_name,
          cpu_id:$cpu_id
        },
        hostname:$hostname,
        flow:"admin"
      }'
  )
else
  enroll_body=$(
    jq -nc \
      --arg enrollment_code "$ENROLLMENT_CODE" \
      --arg self_provision_token "$SELF_PROVISION_TOKEN" \
      --arg hardware_id "$HARDWARE_ID" \
      --arg hwid_hash "$HWID_HASH" \
      --arg product_uuid "$PRODUCT_UUID" \
      --arg board_serial "$BOARD_SERIAL" \
      --arg product_name "$PRODUCT_NAME" \
      --arg cpu_id "$CPU_ID" \
      --arg hostname "$HOSTNAME_VALUE" \
      '{
        enrollment_code:$enrollment_code,
        self_provision_token:$self_provision_token,
        hardware_id:$hardware_id,
        hwid_hash:$hwid_hash,
        hwid_components:{
          product_uuid:$product_uuid,
          board_serial:$board_serial,
          product_name:$product_name,
          cpu_id:$cpu_id
        },
        hostname:$hostname,
        flow:"self"
      }'
  )
fi

http_json POST "$ORG_URL/v1/activate/enroll" "$enroll_body"
if [[ $HTTP_CODE != "202" ]]; then
  echo "enroll failed (HTTP $HTTP_CODE): $HTTP_BODY" >&2
  exit 1
fi

MACHINE_ID=$(printf '%s' "$HTTP_BODY" | jq -er '.machine_id')
STATUS=$(printf '%s' "$HTTP_BODY" | jq -er '.status')
SERVER_POLL=$(printf '%s' "$HTTP_BODY" | jq -er '.poll_interval')
if [[ -z $POLL_INTERVAL ]]; then
  POLL_INTERVAL=$SERVER_POLL
fi
if ! [[ $POLL_INTERVAL =~ ^[0-9]+$ ]] || ((POLL_INTERVAL < 1)); then
  POLL_INTERVAL=10
fi

echo "enrolled machine_id=$MACHINE_ID status=$STATUS poll=${POLL_INTERVAL}s"

deadline=$((SECONDS + TIMEOUT_SEC))
NONCE=""

while ((SECONDS < deadline)); do
  status_body=$(
    jq -nc --arg enrollment_code "$ENROLLMENT_CODE" '{enrollment_code:$enrollment_code}'
  )
  http_json POST "$ORG_URL/v1/activate/status/$MACHINE_ID" "$status_body"
  if [[ $HTTP_CODE != "200" ]]; then
    echo "status poll failed (HTTP $HTTP_CODE): $HTTP_BODY" >&2
    sleep "$POLL_INTERVAL"
    continue
  fi
  STATUS=$(printf '%s' "$HTTP_BODY" | jq -er '.status')
  NONCE=$(printf '%s' "$HTTP_BODY" | jq -r '.enrollment_nonce // empty')
  echo "status=$STATUS"
  if [[ -n $NONCE ]]; then
    break
  fi
  if [[ $STATUS == "active" ]]; then
    echo "machine already active; no enrollment nonce" >&2
    exit 1
  fi
  if [[ $STATUS == "revoked" || $STATUS == "suspended" ]]; then
    echo "machine status is $STATUS; aborting" >&2
    exit 1
  fi
  sleep "$POLL_INTERVAL"
done

if [[ -z $NONCE ]]; then
  echo "timed out waiting for approval (last status=$STATUS)" >&2
  exit 1
fi

token_body=$(
  jq -nc \
    --arg machine_id "$MACHINE_ID" \
    --arg enrollment_nonce "$NONCE" \
    '{machine_id:$machine_id,enrollment_nonce:$enrollment_nonce}'
)
http_json POST "$ORG_URL/v1/activate/token" "$token_body"
if [[ $HTTP_CODE != "200" ]]; then
  echo "token exchange failed (HTTP $HTTP_CODE): $HTTP_BODY" >&2
  exit 1
fi

MACHINE_JWT=$(printf '%s' "$HTTP_BODY" | jq -er '.machine_jwt')
EXPIRES_AT=$(printf '%s' "$HTTP_BODY" | jq -er '.expires_at')

umask 077
printf '%s\n' "$MACHINE_JWT" >"$TOKEN_OUT"
chmod 600 "$TOKEN_OUT"

jq -nc \
  --arg org_url "$ORG_URL" \
  --arg machine_id "$MACHINE_ID" \
  --arg hostname "$HOSTNAME_VALUE" \
  --arg flow "$FLOW" \
  --arg hardware_id "$HARDWARE_ID" \
  --arg expires_at "$EXPIRES_AT" \
  --arg token_path "$TOKEN_OUT" \
  '{
    org_url:$org_url,
    machine_id:$machine_id,
    hostname:$hostname,
    flow:$flow,
    hardware_id:$hardware_id,
    expires_at:$expires_at,
    token_path:$token_path
  }' >"$STATE_OUT"
chmod 600 "$STATE_OUT"

echo "wrote machine token to $TOKEN_OUT"
echo "wrote activation state to $STATE_OUT"
