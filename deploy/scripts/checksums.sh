#!/bin/sh
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
FILES="dist/opencrew_*.tar.gz dist/opencrew_*.zip install.sh install.ps1 compose.yaml"
: > dist/checksums.txt
# shellcheck disable=SC2086
for file in $FILES; do
  [ -f "$file" ] || continue
  if command -v sha256sum >/dev/null 2>&1; then HASH=$(sha256sum "$file" | awk '{print $1}')
  else HASH=$(shasum -a 256 "$file" | awk '{print $1}'); fi
  printf '%s  %s\n' "$HASH" "$(basename "$file")" >> dist/checksums.txt
done
