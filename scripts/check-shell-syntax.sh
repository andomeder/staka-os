#!/usr/bin/env bash
# Syntax-check every shell script shipped in the installer image.
# A single parse error here bricks workstation installs (see the
# activate-script regression fixed in Sep 2026).
set -euo pipefail

cd "$(dirname "$0")/.."

fail=0
while IFS= read -r -d '' script; do
  if ! bash -n "$script" 2>err.txt; then
    echo "PARSE ERROR: $script"
    cat err.txt
    fail=1
  fi
  rm -f err.txt
done < <(find packages/image/configs -name '*.sh' -type f -print0)

if (( fail )); then
  echo "shell syntax check FAILED" >&2
  exit 1
fi
echo "shell syntax check ok"
