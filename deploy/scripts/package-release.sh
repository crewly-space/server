#!/bin/sh
# Package this repository's release asset: the server binary plus the built app.
#
# The CLI ships from crewly-cli and is packaged by that repo, because neither
# repository can build the other's binary. install.sh fetches both assets and
# verifies each against its own release checksums.txt.
#
#   usage: package-release.sh <os> <arch> <crewly-server> <web-dir>
set -eu

if [ "$#" -ne 4 ]; then
  echo "usage: package-release.sh <os> <arch> <crewly-server> <web-dir>" >&2
  exit 2
fi
OS=$1
ARCH=$2
SERVER=$3
WEB=$4
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
OUT="$ROOT/dist"
STAGE="$OUT/stage_${OS}_${ARCH}"
NAME="crewly-server_${OS}_${ARCH}"

[ -f "$SERVER" ] || { echo "missing server artifact: $SERVER" >&2; exit 1; }
[ -f "$WEB/index.html" ] || { echo "missing app artifact: $WEB/index.html" >&2; exit 1; }
rm -rf "$STAGE"
mkdir -p "$STAGE" "$OUT"

if [ "$OS" = "windows" ]; then
  cp "$SERVER" "$STAGE/crewly-server.exe"
  cp -R "$WEB" "$STAGE/web"
  if command -v zip >/dev/null 2>&1; then
    (cd "$STAGE" && zip -qr "$OUT/$NAME.zip" ./*)
  elif command -v python3 >/dev/null 2>&1; then
    (cd "$STAGE" && python3 -m zipfile -c "$OUT/$NAME.zip" ./*)
  else
    echo "zip or python3 is required to package Windows" >&2
    exit 1
  fi
else
  cp "$SERVER" "$STAGE/crewly-server"
  cp -R "$WEB" "$STAGE/web"
  chmod 0755 "$STAGE/crewly-server"
  tar -C "$STAGE" -czf "$OUT/$NAME.tar.gz" .
fi

rm -rf "$STAGE"
echo "packaged $NAME"
