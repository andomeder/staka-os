#!/usr/bin/env bash
# Bare-metal Hyprland headless-output cost bench.
# Scope: hyprctl create/sample/remove + write ./results only.
# Does not touch disks, mounts, packages, or user hypr config.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/results"
mkdir -p "$OUT"

DURATION_SEC="${DURATION_SEC:-60}"
SAMPLE_SEC="${SAMPLE_SEC:-5}"
WORKSPACE_ID="${WORKSPACE_ID:-77}"
HEADLESS_MODE="${HEADLESS_MODE:-1920x1080@60}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$OUT/headless-bench-$TS.log"
JSON="$OUT/headless-bench-$TS.json"
MD="$OUT/headless-bench-$TS.md"

HEADLESS_NAME=""
CREATED=0

log() {
  printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG"
}

die() {
  log "ERROR: $*"
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

remove_headless() {
  local name="${1:-}"
  [[ -n "$name" ]] || return 0
  log "removing headless output $name"
  hyprctl output remove "$name" >>"$LOG" 2>&1 || log "WARN: remove failed for $name"
}

cleanup() {
  local ec=$?
  set +e
  if [[ -n "$HEADLESS_NAME" ]]; then
    remove_headless "$HEADLESS_NAME"
    HEADLESS_NAME=""
    CREATED=0
  elif [[ "$CREATED" -eq 1 ]]; then
    local n
    while read -r n; do
      [[ -n "$n" ]] || continue
      remove_headless "$n"
    done < <(hyprctl monitors -j 2>/dev/null | jq -r '.[].name' | grep -E '^HEADLESS-' || true)
  fi
  log "cleanup done (exit=$ec)"
  exit "$ec"
}

trap cleanup EXIT INT TERM

need hyprctl
need jq

if ! hyprctl monitors >/dev/null 2>&1; then
  die "not talking to a live Hyprland instance (run inside the laptop Hyprland session)"
fi

: >"$LOG"
log "headless bench start duration=${DURATION_SEC}s sample=${SAMPLE_SEC}s"
log "results dir: $OUT"

BEFORE_MONITORS="$(hyprctl monitors -j)"
BEFORE_NAMES="$(printf '%s' "$BEFORE_MONITORS" | jq -r '.[].name' | sort)"
BEFORE_MEM_AVAIL="$(free -b | awk '/^Mem:/ {print $7}')"
BEFORE_LOAD="$(cut -d' ' -f1-3 /proc/loadavg)"

log "monitors before:"
printf '%s\n' "$BEFORE_MONITORS" | jq -c '.[] | {name,width,height,refreshRate,focused,disabled}' | tee -a "$LOG"
log "load before: $BEFORE_LOAD"
log "mem available before bytes: $BEFORE_MEM_AVAIL"

log "creating headless output"
if ! hyprctl output create headless >>"$LOG" 2>&1; then
  die "hyprctl output create headless failed"
fi
CREATED=1
sleep 0.5

AFTER_CREATE="$(hyprctl monitors -j)"
AFTER_NAMES="$(printf '%s' "$AFTER_CREATE" | jq -r '.[].name' | sort)"
HEADLESS_NAME="$(comm -13 <(printf '%s\n' "$BEFORE_NAMES") <(printf '%s\n' "$AFTER_NAMES") | head -n1 || true)"

if [[ -z "$HEADLESS_NAME" ]]; then
  HEADLESS_NAME="$(printf '%s' "$AFTER_CREATE" | jq -r '.[].name' | grep -E '^HEADLESS-' | tail -n1 || true)"
fi
[[ -n "$HEADLESS_NAME" ]] || die "could not determine new headless output name"

log "headless output name: $HEADLESS_NAME"
HEADLESS_NAME_FINAL="$HEADLESS_NAME"

if ! hyprctl keyword monitor "${HEADLESS_NAME},${HEADLESS_MODE},0x0,1" >>"$LOG" 2>&1; then
  log "WARN: failed to set mode ${HEADLESS_MODE} on ${HEADLESS_NAME}"
fi

hyprctl dispatch focusmonitor "$HEADLESS_NAME" >>"$LOG" 2>&1 || true
hyprctl dispatch workspace "$WORKSPACE_ID" >>"$LOG" 2>&1 || true
hyprctl keyword workspace "${WORKSPACE_ID},monitor:${HEADLESS_NAME}" >>"$LOG" 2>&1 || true
hyprctl dispatch moveworkspacetomonitor "$WORKSPACE_ID" "$HEADLESS_NAME" >>"$LOG" 2>&1 || true

TERM_CMD=""
for c in foot kitty alacritty ghostty; do
  if command -v "$c" >/dev/null 2>&1; then
    TERM_CMD="$c"
    break
  fi
done

if [[ -n "$TERM_CMD" ]]; then
  log "launching $TERM_CMD on workspace $WORKSPACE_ID / $HEADLESS_NAME"
  hyprctl dispatch exec "[workspace ${WORKSPACE_ID} silent] ${TERM_CMD}" >>"$LOG" 2>&1 || \
    hyprctl dispatch exec "$TERM_CMD" >>"$LOG" 2>&1 || true
  sleep 0.8
  hyprctl dispatch movetoworkspacesilent "$WORKSPACE_ID" >>"$LOG" 2>&1 || true
else
  log "no terminal found; sampling headless output with no client window"
fi

log "monitors with headless:"
hyprctl monitors -j | jq -c '.[] | {name,width,height,refreshRate,focused,disabled,activeWorkspace}' | tee -a "$LOG"

log "SAMPLE WINDOW ${DURATION_SEC}s - use the PHYSICAL display now (move/type/scroll)"
echo
echo ">>> Interact on the laptop screen for ${DURATION_SEC}s while headless stays up."
echo ">>> Ctrl-C aborts and still tears down the headless output."
echo

SAMPLE_FILE="$(mktemp)"
ELAPSED=0
PEAK_LOAD1="0"
MIN_MEM_AVAIL="$BEFORE_MEM_AVAIL"
HYPR_OK=1

while (( ELAPSED < DURATION_SEC )); do
  LOAD="$(cut -d' ' -f1-3 /proc/loadavg)"
  LOAD1="$(cut -d' ' -f1 /proc/loadavg)"
  MEM_AVAIL="$(free -b | awk '/^Mem:/ {print $7}')"
  MON_OK=1
  if ! hyprctl monitors -j >/dev/null 2>&1; then
    MON_OK=0
    HYPR_OK=0
    log "hyprctl monitors failed at t=${ELAPSED}s"
  fi

  HSTATE="$(hyprctl monitors -j 2>/dev/null | jq -c --arg n "$HEADLESS_NAME" '
    [.[] | select(.name==$n) | {name,width,height,refreshRate,disabled}] | .[0] // null
  ' 2>/dev/null || echo null)"
  PHYS="$(hyprctl monitors -j 2>/dev/null | jq -c --arg n "$HEADLESS_NAME" '
    [.[] | select(.name!=$n) | {name,width,height,refreshRate,focused}]
  ' 2>/dev/null || echo '[]')"

  jq -nc \
    --argjson t "$ELAPSED" \
    --arg load "$LOAD" \
    --argjson mem "$MEM_AVAIL" \
    --argjson hypr_ok "$MON_OK" \
    --argjson headless "$HSTATE" \
    --argjson physical "$PHYS" \
    '{t:$t, load:$load, mem_available_bytes:$mem, hypr_ok:($hypr_ok==1), headless:$headless, physical:$physical}' \
    >>"$SAMPLE_FILE"

  if command -v bc >/dev/null 2>&1; then
    if (( $(echo "$LOAD1 > $PEAK_LOAD1" | bc -l) )); then
      PEAK_LOAD1="$LOAD1"
    fi
  else
    PEAK_LOAD1="$LOAD1"
  fi
  if [[ "$MEM_AVAIL" -lt "$MIN_MEM_AVAIL" ]]; then
    MIN_MEM_AVAIL="$MEM_AVAIL"
  fi

  log "t=${ELAPSED}s load=$LOAD mem_avail=$MEM_AVAIL headless=$HSTATE"
  sleep "$SAMPLE_SEC"
  ELAPSED=$((ELAPSED + SAMPLE_SEC))
done

AFTER_MEM_AVAIL="$(free -b | awk '/^Mem:/ {print $7}')"
AFTER_LOAD="$(cut -d' ' -f1-3 /proc/loadavg)"
WITH_HEADLESS_MONITORS="$(hyprctl monitors -j 2>/dev/null || echo '[]')"

log "sampling done; tearing down"
remove_headless "$HEADLESS_NAME"
HEADLESS_NAME=""
CREATED=0
sleep 0.4

POST_MONITORS="$(hyprctl monitors -j 2>/dev/null || echo '[]')"
log "monitors after remove:"
printf '%s\n' "$POST_MONITORS" | jq -c '.[] | {name,width,height,refreshRate}' | tee -a "$LOG" || true

SAMPLE_JSON="$(jq -s '.' "$SAMPLE_FILE")"
rm -f "$SAMPLE_FILE"

jq -nc \
  --arg ts "$TS" \
  --argjson duration "$DURATION_SEC" \
  --argjson sample_sec "$SAMPLE_SEC" \
  --arg workspace "$WORKSPACE_ID" \
  --arg mode "$HEADLESS_MODE" \
  --arg headless_name "$HEADLESS_NAME_FINAL" \
  --arg load_before "$BEFORE_LOAD" \
  --arg load_after "$AFTER_LOAD" \
  --arg peak_load1 "$PEAK_LOAD1" \
  --argjson mem_before "$BEFORE_MEM_AVAIL" \
  --argjson mem_after "$AFTER_MEM_AVAIL" \
  --argjson mem_min "$MIN_MEM_AVAIL" \
  --argjson hypr_ok_throughout "$HYPR_OK" \
  --argjson monitors_before "$BEFORE_MONITORS" \
  --argjson monitors_with_headless "$WITH_HEADLESS_MONITORS" \
  --argjson monitors_after "$POST_MONITORS" \
  --argjson samples "$SAMPLE_JSON" \
  '{
     ts: $ts,
     duration_sec: $duration,
     sample_sec: $sample_sec,
     workspace_id: $workspace,
     headless_mode: $mode,
     headless_name: $headless_name,
     load_before: $load_before,
     load_after: $load_after,
     peak_load1: $peak_load1,
     mem_available_bytes: {before: $mem_before, after: $mem_after, min_during: $mem_min},
     hypr_ok_throughout: ($hypr_ok_throughout == 1),
     monitors_before: $monitors_before,
     monitors_with_headless: $monitors_with_headless,
     monitors_after: $monitors_after,
     samples: $samples
   }' >"$JSON"

MEM_BEFORE_MIB=$((BEFORE_MEM_AVAIL / 1024 / 1024))
MEM_AFTER_MIB=$((AFTER_MEM_AVAIL / 1024 / 1024))
MEM_MIN_MIB=$((MIN_MEM_AVAIL / 1024 / 1024))
HYPR_OK_TXT="no"
[[ "$HYPR_OK" -eq 1 ]] && HYPR_OK_TXT="yes"

cat >"$MD" <<EOF
# Headless bench $TS

## Setup

- duration: ${DURATION_SEC}s (sample every ${SAMPLE_SEC}s)
- headless mode requested: ${HEADLESS_MODE}
- workspace: ${WORKSPACE_ID}
- headless name: ${HEADLESS_NAME_FINAL}

## Objective

| metric | value |
|---|---|
| load before | ${BEFORE_LOAD} |
| load after | ${AFTER_LOAD} |
| peak load1 during | ${PEAK_LOAD1} |
| mem avail before (MiB) | ${MEM_BEFORE_MIB} |
| mem avail min during (MiB) | ${MEM_MIN_MIB} |
| mem avail after (MiB) | ${MEM_AFTER_MIB} |
| hyprctl healthy throughout | ${HYPR_OK_TXT} |

## Files

- log: \`$(basename "$LOG")\`
- json: \`$(basename "$JSON")\`

## Operator judgment (required)

Fill \`DECISION.md\`. Metrics alone do not pass the gate; physical-display feel during the sample window does.
EOF

if [[ ! -f "$OUT/DECISION.md" ]]; then
  cat > "$OUT/DECISION.md" <<'EOF'
# ProBook headless decision

Date (local):
Machine: HP ProBook 440 G3
Operator:

## Bench

- headless create succeeded? (yes/no):
- headless output name:
- physical display stayed usable? (yes/no):
- interactive feel with headless active: smooth / occasional hitch / unusable
- compositor crash or restart? (yes/no):
- felt like >= ~30fps on physical display? (yes/no):

## Objective notes

- peak loadavg:
- mem available before -> after:
- hyprctl errors:

## Demo path

- [ ] LIVE demo remains primary
- [ ] RECORDED demo becomes primary

Reason:

## Artifact files

- inventory:
- bench log/json/md:
EOF
fi

log "wrote $JSON"
log "wrote $MD"
echo
echo "Done."
echo "  log:  $LOG"
echo "  json: $JSON"
echo "  md:   $MD"
echo "  decision: $OUT/DECISION.md"
echo
echo "Fill results/DECISION.md (live vs recorded demo)."
