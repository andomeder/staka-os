#!/usr/bin/env bash
# Read-only host facts for the headless bench. Writes only under ./results/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/results"
mkdir -p "$OUT"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="$OUT/inventory-$TS.md"

{
  echo "# Inventory $TS"
  echo
  echo "## Host"
  echo '```'
  date -Is
  echo "user=$USER hostname=$(hostname)"
  uname -a
  cat /etc/os-release 2>/dev/null || true
  echo '```'
  echo
  echo "## CPU / mem"
  echo '```'
  lscpu 2>/dev/null | sed -n '1,30p' || true
  echo
  free -h
  echo '```'
  echo
  echo "## Session / Hyprland"
  echo '```'
  echo "XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-}"
  echo "XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-}"
  echo "WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-}"
  echo "HYPRLAND_INSTANCE_SIGNATURE=${HYPRLAND_INSTANCE_SIGNATURE:-}"
  echo
  if command -v hyprctl >/dev/null 2>&1; then
    hyprctl version || true
    echo
    hyprctl monitors || true
    echo
    hyprctl workspaces || true
  else
    echo "hyprctl missing - cannot bench"
  fi
  echo '```'
  echo
  echo "## Optional tools"
  echo '```'
  for c in jq bc glxinfo intel_gpu_top foot kitty alacritty ghostty; do
    if command -v "$c" >/dev/null 2>&1; then
      echo "$c: $(command -v "$c")"
    else
      echo "$c: absent"
    fi
  done
  if command -v glxinfo >/dev/null 2>&1; then
    echo
    glxinfo -B 2>/dev/null || true
  fi
  echo '```'
} | tee "$REPORT"

if [[ ! -f "$OUT/DECISION.md" ]]; then
  cat > "$OUT/DECISION.md" <<'EOF'
# Slice 0 ProBook headless decision

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

echo
echo "Wrote $REPORT"
echo "Decision sheet: $OUT/DECISION.md"
