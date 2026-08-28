#!/bin/sh
set -eu
: "${1:?Usage: capture-clock-evidence.sh OUTPUT_FILE}"
if ! command -v chronyc >/dev/null 2>&1; then
  printf '%s\n' 'chronyc is not installed' > "$1"
  exit 2
fi
chronyc tracking > "$1"
