#!/usr/bin/env bash
# Org activation client for the live ISO.
# Captures HWID, enrolls (Flow A admin or Flow B self), polls status, exchanges
# nonce for machine JWT, and writes token material for the installed system.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: staka-activate.sh --org-url URL --code CODE --hostname NAME --flow admin|self [options]
       staka-activate.sh --discover-domain DOMAIN --code CODE --hostname NAME --flow admin|self [options]

Options:
  --org-url URL              Org server base URL (http://host:port)
  --discover-domain DOMAIN   Discover org URL via DNS TXT at _staka-org.DOMAIN
  --code CODE                Enrollment code
  --hostname NAME            Machine hostname
  --flow admin|self          Provision flow (default: admin)
  --employee-id ID           Flow B employee id
  --token-out PATH           Write machine JWT here (default: ./machine.token)
  --state-out PATH           Write activation state JSON (default: ./staka-activation.json)
  --poll-interval SEC        Override poll interval from server
  --timeout SEC              Max seconds waiting for approval (default: 1800)

Flow B password:
  Set STAKA_SELF_PASSWORD in the environment (never pass on argv).

HWID:
  Prefer real DMI. When product UUID is missing, set STAKA_HWID_PRODUCT_UUID
  (and usually the other STAKA_HWID_* fields). Synthetic machine-id fallback
  requires STAKA_ALLOW_SYNTHETIC_HWID=1.
EOF
}

ORG_URL=""
DISCOVER_DOMAIN=""
ENROLLMENT_CODE=""
HOSTNAME_VALUE=""
FLOW="admin"
EMPLOYEE_ID=""
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
  --discover-domain)
    DISCOVER_DOMAIN="${2:-}"
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
    echo "--password is not accepted; set STAKA_SELF_PASSWORD instead" >&2
    exit 2
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

PASSWORD="${STAKA_SELF_PASSWORD:-}"

discover_org_url() {
  local domain="$1"
  local txt
  local org_url_re='^staka-org-url=(https?://[^[:space:"]]+)$'
  txt=$(dig +short +time=3 +tries=1 TXT "_staka-org.${domain}" 2>/dev/null | head -1)
  if [[ -z $txt ]]; then
    return 1
  fi
  txt="${txt#\"}"
  txt="${txt%\"}"
  if [[ $txt =~ $org_url_re ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

if [[ -z $ORG_URL && -n $DISCOVER_DOMAIN ]]; then
  if ! command -v dig >/dev/null 2>&1; then
    echo "dig is required for --discover-domain" >&2
    exit 1
  fi
  echo "Discovering org server via DNS TXT _staka-org.${DISCOVER_DOMAIN} ..."
  if discovered=$(discover_org_url "$DISCOVER_DOMAIN"); then
    ORG_URL="$discovered"
    echo "Discovered org URL: $ORG_URL"
  else
    echo "DNS TXT discovery failed for _staka-org.${DISCOVER_DOMAIN}" >&2
    echo "Provide --org-url explicitly or check the TXT record." >&2
    exit 2
  fi
fi

if [[ -z $ORG_URL || -z $ENROLLMENT_CODE || -z $HOSTNAME_VALUE ]]; then
  echo "org-url (or --discover-domain), code, and hostname are required" >&2
  usage >&2
  exit 2
fi

if [[ $FLOW != "admin" && $FLOW != "self" ]]; then
  echo "flow must be admin or self" >&2
  exit 2
fi

if [[ $FLOW == "self" && (-z $EMPLOYEE_ID || -z $PASSWORD) ]]; then
  echo "flow=self requires --employee-id and STAKA_SELF_PASSWORD" >&2
  exit 2
fi

# Match @staka/protocol Hostname: 1-63 of [A-Za-z0-9-]
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

is_blank_dmi() {
  local v="$1"
  [[ -z $v || $v == "Not Specified" || $v == "None" || $v == "To be filled by O.E.M." || $v == "Default string" ]]
}

# Optional env overrides when DMI is unreadable (lab/QEMU). Live ISO runs as root.
PRODUCT_UUID="${STAKA_HWID_PRODUCT_UUID:-$(read_dmi /sys/class/dmi/id/product_uuid)}"
BOARD_SERIAL="${STAKA_HWID_BOARD_SERIAL:-$(read_dmi /sys/class/dmi/id/board_serial)}"
PRODUCT_NAME="${STAKA_HWID_PRODUCT_NAME:-$(read_dmi /sys/class/dmi/id/product_name)}"
CPU_ID="${STAKA_HWID_CPU_ID:-$(read_cpu_id)}"

if is_blank_dmi "$PRODUCT_UUID"; then
  if [[ -n ${STAKA_HWID_PRODUCT_UUID:-} ]]; then
    PRODUCT_UUID="$STAKA_HWID_PRODUCT_UUID"
  elif [[ ${STAKA_ALLOW_SYNTHETIC_HWID:-0} == "1" ]]; then
    if [[ -r /etc/machine-id ]]; then
      PRODUCT_UUID=$(sha256_hex "$(cat /etc/machine-id)-${HOSTNAME_VALUE}")
      PRODUCT_UUID="${PRODUCT_UUID:0:8}-${PRODUCT_UUID:8:4}-${PRODUCT_UUID:12:4}-${PRODUCT_UUID:16:4}-${PRODUCT_UUID:20:12}"
      echo "warning: using synthetic product_uuid (STAKA_ALLOW_SYNTHETIC_HWID=1)" >&2
    else
      echo "product_uuid unavailable and /etc/machine-id unreadable" >&2
      exit 1
    fi
  else
    echo "product_uuid unavailable from DMI" >&2
    echo "set STAKA_HWID_PRODUCT_UUID (preferred) or STAKA_ALLOW_SYNTHETIC_HWID=1 for lab-only synthetic id" >&2
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
  local curl_rc=0
  if [[ -n $body ]]; then
    code=$(
      curl -sS -o "$tmp" -w '%{http_code}' \
        -X "$method" \
        -H 'Content-Type: application/json' \
        -H 'Accept: application/json' \
        --connect-timeout 10 \
        --max-time 60 \
        --data "$body" \
        "$url"
    ) || curl_rc=$?
  else
    code=$(
      curl -sS -o "$tmp" -w '%{http_code}' \
        -X "$method" \
        -H 'Accept: application/json' \
        --connect-timeout 10 \
        --max-time 60 \
        "$url"
    ) || curl_rc=$?
  fi
  HTTP_CURL_RC=$curl_rc
  HTTP_CODE="${code:-}"
  HTTP_BODY=$(cat "$tmp" 2>/dev/null || true)
  rm -f "$tmp"
}

write_activation_material() {
  local machine_jwt="$1"
  local expires_at="$2"
  local machine_id="$3"

  umask 077
  printf '%s\n' "$machine_jwt" >"$TOKEN_OUT"
  chmod 600 "$TOKEN_OUT"

  jq -nc \
    --arg org_url "$ORG_URL" \
    --arg machine_id "$machine_id" \
    --arg hostname "$HOSTNAME_VALUE" \
    --arg flow "$FLOW" \
    --arg hardware_id "$HARDWARE_ID" \
    --arg expires_at "$expires_at" \
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
}

# Resume path: valid local token+state matching this org/hostname skips re-enroll.
if [[ -s $TOKEN_OUT && -s $STATE_OUT ]]; then
  resume_org=$(jq -r '.org_url // empty' "$STATE_OUT" 2>/dev/null || true)
  resume_host=$(jq -r '.hostname // empty' "$STATE_OUT" 2>/dev/null || true)
  resume_machine=$(jq -r '.machine_id // empty' "$STATE_OUT" 2>/dev/null || true)
  resume_token=$(tr -d '\n' <"$TOKEN_OUT" 2>/dev/null || true)

  if [[ -n $resume_token && $resume_org == "$ORG_URL" && $resume_host == "$HOSTNAME_VALUE" && -n $resume_machine ]]; then
    tmp=$(mktemp)
    curl_rc=0
    code=$(
      curl -sS -o "$tmp" -w '%{http_code}' \
        -X POST \
        -H 'Content-Type: application/json' \
        -H 'Accept: application/json' \
        -H "Authorization: Bearer $resume_token" \
        --connect-timeout 10 \
        --max-time 60 \
        --data '{}' \
        "$ORG_URL/v1/activate/heartbeat"
    ) || curl_rc=$?
    rm -f "$tmp"
    if [[ $curl_rc -eq 0 && $code == "200" ]]; then
      echo "reusing existing activation material for machine_id=$resume_machine (heartbeat ok)"
      exit 0
    fi
    echo "existing token present but heartbeat failed (HTTP ${code:-?}); not reusing - remove $TOKEN_OUT to force re-enroll" >&2
    exit 1
  fi
fi

SELF_PROVISION_TOKEN=""
if [[ $FLOW == "self" ]]; then
  auth_body=$(
    jq -nc \
      --arg employee_id "$EMPLOYEE_ID" \
      --arg password "$PASSWORD" \
      --arg enrollment_code "$ENROLLMENT_CODE" \
      '{employee_id:$employee_id,password:$password,enrollment_code:$enrollment_code}'
  )
  # Drop password from shell env after building the request body.
  PASSWORD=""
  unset STAKA_SELF_PASSWORD
  http_json POST "$ORG_URL/v1/activate/self/authenticate" "$auth_body"
  if [[ ${HTTP_CURL_RC:-0} -ne 0 || -z $HTTP_CODE ]]; then
    echo "self authenticate transport failed (curl_rc=${HTTP_CURL_RC:-?})" >&2
    exit 1
  fi
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
if [[ ${HTTP_CURL_RC:-0} -ne 0 || -z $HTTP_CODE ]]; then
  echo "enroll transport failed (curl_rc=${HTTP_CURL_RC:-?})" >&2
  exit 1
fi
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
echo "note: enrollment code is consumed at enroll; if install fails later while pending, admin reissues a code (same HWID rebinds). approved/active/revoked stay hardware_id_bound - revoke does not free HWID"

deadline=$((SECONDS + TIMEOUT_SEC))
NONCE=""

while ((SECONDS < deadline)); do
  status_body=$(
    jq -nc --arg enrollment_code "$ENROLLMENT_CODE" '{enrollment_code:$enrollment_code}'
  )
  http_json POST "$ORG_URL/v1/activate/status/$MACHINE_ID" "$status_body"
  if [[ ${HTTP_CURL_RC:-0} -ne 0 || -z $HTTP_CODE ]]; then
    echo "status poll transport failed (curl_rc=${HTTP_CURL_RC:-?}); retrying" >&2
    sleep "$POLL_INTERVAL"
    continue
  fi
  if [[ $HTTP_CODE == "429" || $HTTP_CODE =~ ^5[0-9][0-9]$ ]]; then
    echo "status poll retryable (HTTP $HTTP_CODE): $HTTP_BODY" >&2
    sleep "$POLL_INTERVAL"
    continue
  fi
  if [[ $HTTP_CODE != "200" ]]; then
    echo "status poll failed hard (HTTP $HTTP_CODE): $HTTP_BODY" >&2
    exit 1
  fi
  STATUS=$(printf '%s' "$HTTP_BODY" | jq -er '.status')
  NONCE=$(printf '%s' "$HTTP_BODY" | jq -r '.enrollment_nonce // empty')
  echo "status=$STATUS"
  if [[ -n $NONCE ]]; then
    break
  fi
  if [[ $STATUS == "active" ]]; then
    echo "machine already active with no enrollment nonce; cannot complete token exchange" >&2
    echo "if a local machine.token already exists for this host, reuse it; otherwise clear or reopen the machine row (owner DB)" >&2
    exit 1
  fi
  if [[ $STATUS == "approved" ]]; then
    echo "machine approved but enrollment_nonce missing (likely already consumed)" >&2
    echo "stranded state: HWID is bound and no JWT is local. Keep any existing $TOKEN_OUT, or clear/reopen the machine row (owner DB). Do not expect pending-style code reissue to free this HWID." >&2
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
  if [[ $STATUS == "pending" ]]; then
    echo "recovery: still pending - admin can reissue a code; same HWID rebinds on enroll" >&2
  elif [[ $STATUS == "approved" ]]; then
    echo "recovery: approved without nonce - token may already be consumed; keep local token if present or clear machine row (owner DB)" >&2
  else
    echo "recovery: status=$STATUS binds this HWID; revoke does not free it - clear the machine row (owner DB) or use another HWID" >&2
  fi
  exit 1
fi

token_body=$(
  jq -nc \
    --arg machine_id "$MACHINE_ID" \
    --arg enrollment_nonce "$NONCE" \
    '{machine_id:$machine_id,enrollment_nonce:$enrollment_nonce}'
)

TOKEN_ATTEMPTS=0
TOKEN_MAX_ATTEMPTS=4
while ((TOKEN_ATTEMPTS < TOKEN_MAX_ATTEMPTS)); do
  TOKEN_ATTEMPTS=$((TOKEN_ATTEMPTS + 1))
  http_json POST "$ORG_URL/v1/activate/token" "$token_body"
  if [[ ${HTTP_CURL_RC:-0} -ne 0 || -z $HTTP_CODE ]]; then
    echo "token exchange transport failed (curl_rc=${HTTP_CURL_RC:-?}) attempt=${TOKEN_ATTEMPTS}/${TOKEN_MAX_ATTEMPTS}" >&2
    sleep 2
    continue
  fi
  if [[ $HTTP_CODE == "429" || $HTTP_CODE =~ ^5[0-9][0-9]$ ]]; then
    echo "token exchange retryable (HTTP $HTTP_CODE) attempt=${TOKEN_ATTEMPTS}/${TOKEN_MAX_ATTEMPTS}" >&2
    sleep 2
    continue
  fi
  break
done

if [[ ${HTTP_CURL_RC:-0} -ne 0 || -z $HTTP_CODE ]]; then
  echo "token exchange transport failed after ${TOKEN_MAX_ATTEMPTS} attempts" >&2
  echo "if the server consumed the nonce, this machine may be stranded without a local JWT" >&2
  exit 1
fi

if [[ $HTTP_CODE != "200" ]]; then
  err_code=$(printf '%s' "$HTTP_BODY" | jq -r '.error // empty' 2>/dev/null || true)
  echo "token exchange failed (HTTP $HTTP_CODE): $HTTP_BODY" >&2
  if [[ $HTTP_CODE == "410" || $err_code == "nonce_consumed" || $err_code == "nonce_invalid" ]]; then
    echo "stranded state: enrollment nonce is gone and no machine JWT was written" >&2
    echo "keep any existing local token, or clear/reopen the machine row (owner DB). Pending-style code reissue will not free an approved/bound HWID." >&2
  fi
  exit 1
fi

MACHINE_JWT=$(printf '%s' "$HTTP_BODY" | jq -er '.machine_jwt')
EXPIRES_AT=$(printf '%s' "$HTTP_BODY" | jq -er '.expires_at')
write_activation_material "$MACHINE_JWT" "$EXPIRES_AT" "$MACHINE_ID"
