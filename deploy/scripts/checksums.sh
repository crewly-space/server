#!/bin/sh
# Write dist/checksums.txt over this repository's release assets.
#
# install.sh and install.ps1 look up their asset by basename in this file and
# refuse to install when the line is missing, so the globs here must match the
# names package-release.sh emits.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT"
FILES="dist/crewly-server_*.tar.gz dist/crewly-server_*.zip install.sh install.ps1 compose.yaml compose.proxy.yaml Caddyfile"
: > dist/checksums.txt
# shellcheck disable=SC2086
for file in $FILES; do
  [ -f "$file" ] || continue
  if command -v sha256sum >/dev/null 2>&1; then HASH=$(sha256sum "$file" | awk '{print $1}')
  else HASH=$(shasum -a 256 "$file" | awk '{print $1}'); fi
  printf '%s  %s\n' "$HASH" "$(basename "$file")" >> dist/checksums.txt
done
echo "wrote $(wc -l < dist/checksums.txt) checksum line(s)"
