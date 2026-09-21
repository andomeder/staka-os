#!/usr/bin/env bash

# Proves that the guide overlay's layer-shell surface is click-through on a
# live Hyprland session before any overlay feature is built on top of it.
#
# Three runs against the same target window at a fixed position:
#   1. control   - no overlay; the synthetic click must reach the target.
#   2. gate      - overlay mapped (overlay layer, transparent, empty input
#                  mask); the click at the highlighted coordinate must still
#                  reach the target beneath.
#   3. negative  - overlay mapped WITHOUT the input mask; the click must be
#                  intercepted (proves the test can detect a grabbing
#                  overlay and that the empty mask is what passes input
#                  through).
#
# Requirements: Hyprland (0.55+ dispatch syntax), quickshell, ydotool + a
# running ydotoold (uinput access), jq, and the user's input group or an
# ACL on /dev/uinput.
#
# The run briefly moves the pointer and floats a small test window on the
# focused workspace, then restores the previous focus and pointer position.

set -euo pipefail

WORKDIR=$(mktemp -d)
trap 'cleanup' EXIT

QS_PIDS=()
YDOTOOLD_PID=""

cleanup() {
  for pid in "${QS_PIDS[@]:-}"; do kill "$pid" 2>/dev/null || true
  done
  if [[ -n $YDOTOOLD_PID ]]; then kill "$YDOTOOLD_PID" 2>/dev/null || true; fi
  if [[ -n ${FOCUS_BEFORE:-} ]]; then
    hyprctl eval "hl.dispatch(hl.dsp.focus({ window = \"$FOCUS_BEFORE\" }))" >/dev/null 2>&1 || true
  fi
  if [[ -n ${CURSOR_BEFORE:-} ]]; then
    hyprctl eval "hl.dispatch(hl.dsp.cursor.move({ x = ${CURSOR_BEFORE%%,*}, y = ${CURSOR_BEFORE##*,} }))" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR"
}

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
clicks="$WORKDIR/clicks.log"
touch "$clicks"
export GATE_CLICKS_LOG="$clicks"

for bin in quickshell ydotool jq grim; do
  command -v "$bin" >/dev/null || { echo "missing dependency: $bin" >&2; exit 2; }
done

# The test needs a uinput daemon; start a private one if none is running.
if ! ydotool click 0xC0 >/dev/null 2>&1; then
  ydotoold >/dev/null 2>&1 &
  YDOTOOLD_PID=$!
  sleep 0.5
fi

# Session state to restore afterwards.
CURSOR_BEFORE=$(hyprctl cursorpos | tr -d ' ')
FOCUS_BEFORE=$(hyprctl activewindow -j | jq -r '.address // empty')

start_qs() {
  quickshell -p "$1" >/dev/null 2>&1 &
  QS_PIDS+=($!)
}

window_at() {
  hyprctl clients -j | jq -r --arg t "$1" \
    '.[] | select(.title==$t) | "\(.at[0]) \(.at[1]) \(.size[0]) \(.size[1]) \(.address)"'
}

click() {
  ydotool mousemove "$1" "$2" -a
  sleep 0.15
  ydotool click 0xC0
  sleep 0.5
}

click_count() { wc -l < "$clicks" | tr -d ' '; }

fail() { echo "FAIL: $1"; exit 1; }
pass() { echo "PASS: $1"; }

# --- target window ---------------------------------------------------------

start_qs "$here/target"
sleep 2

line=$(window_at "staka-gate-target")
[[ -n $line ]] || fail "target window did not map"
read -r wx wy ww wh addr <<<"$line"

hyprctl eval 'hl.dispatch(hl.dsp.window.float({ action = "enable", window = "address:'"$addr"'" }))'
sleep 0.3

# The target must sit on the workspace the user's monitor is showing,
# otherwise clicks route to whatever is currently visible instead.
active_ws=$(hyprctl activeworkspace -j | jq -r '.id')
hyprctl eval 'hl.dispatch(hl.dsp.window.move({ workspace = '"$active_ws"', window = "address:'"$addr"'" }))'
sleep 0.3

hyprctl eval 'hl.dispatch(hl.dsp.window.resize({ x = 420, y = 300, window = "address:'"$addr"'" }))'
hyprctl eval 'hl.dispatch(hl.dsp.window.move({ x = 60, y = 720, window = "address:'"$addr"'" }))'
sleep 0.4

line=$(window_at "staka-gate-target")
read -r wx wy ww wh addr <<<"$line"
cx=$((wx + ww / 2))
cy=$((wy + wh / 2))

# --- 1. control ------------------------------------------------------------

line=$(window_at "staka-gate-target")
read -r wx wy ww wh addr <<<"$line"
cx=$((wx + ww / 2))
cy=$((wy + wh / 2))

before=$(click_count)
click "$cx" "$cy"
after=$(click_count)
[[ $after -eq $((before + 1)) ]] || fail "control: click never reached the target (overlay test would be meaningless)"
pass "control: click reaches the target with no overlay"

# --- 2. gate (empty input mask) --------------------------------------------

GATE_HL_X=$wx GATE_HL_Y=$wy GATE_HL_W=$ww GATE_HL_H=$wh start_qs "$here/overlay"
sleep 2
hyprctl layers | grep -q "namespace: staka-gate-overlay" || fail "gate: overlay surface did not map on the overlay layer"

before=$(click_count)
click "$cx" "$cy"
after=$(click_count)
[[ $after -eq $((before + 1)) ]] || fail "gate: the overlay intercepted the click"
pass "gate: click at the highlighted coordinate passes through the overlay to the window beneath"

# --- 3. negative (no mask) -------------------------------------------------

GATE_HL_X=$wx GATE_HL_Y=$wy GATE_HL_W=$ww GATE_HL_H=$wh start_qs "$here/overlay-nomask"
sleep 2

before=$(click_count)
click "$cx" "$cy"
after=$(click_count)
[[ $after -eq $before ]] || fail "negative: unmasked overlay unexpectedly passed the click through"
pass "negative: an overlay without the input mask does intercept clicks (test is sensitive)"

grim -g "$((wx - 20)),$((wy - 20)) $((ww + 40))x$((wh + 40))" "$WORKDIR/evidence.png" 2>/dev/null \
  && echo "evidence screenshot: $WORKDIR/evidence.png"

echo
echo "click-through gate: OK"
