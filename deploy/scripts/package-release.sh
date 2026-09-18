#!/bin/sh
set -eu

if [ "$#" -ne 5 ]; then
  echo "usage: package-release.sh <os> <arch> <opencrew-cli> <opencrew-server> <web-dir>" >&2
  exit 2
fi
OS=$1
ARCH=$2
CLI=$3
SERVER=$4
WEB=$5
ROOT=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
OUT="$ROOT/dist"
STAGE="$OUT/stage_${OS}_${ARCH}"

[ -f "$CLI" ] || { echo "missing CLI artifact: $CLI" >&2; exit 1; }
[ -f "$SERVER" ] || { echo "missing server artifact: $SERVER" >&2; exit 1; }
[ -f "$WEB/index.html" ] || { echo "missing app artifact: $WEB/index.html" >&2; exit 1; }
rm -rf "$STAGE"
mkdir -p "$STAGE" "$OUT"

if [ "$OS" = "windows" ]; then
  cp "$CLI" "$STAGE/opencrew.exe"
  cp "$SERVER" "$STAGE/opencrew-server.exe"
  cp -R "$WEB" "$STAGE/web"
  if command -v zip >/dev/null 2>&1; then
    (cd "$STAGE" && zip -qr "$OUT/opencrew_${OS}_${ARCH}.zip" ./*)
  elif command -v python3 >/dev/null 2>&1; then
    (cd "$STAGE" && python3 -m zipfile -c "$OUT/opencrew_${OS}_${ARCH}.zip" ./*)
  else
    echo "zip or python3 is required to package Windows" >&2
    exit 1
  fi
else
  cp "$CLI" "$STAGE/opencrew"
  cp "$SERVER" "$STAGE/opencrew-server"
  cp -R "$WEB" "$STAGE/web"
  chmod 0755 "$STAGE/opencrew"
  chmod 0755 "$STAGE/opencrew-server"
  tar -C "$STAGE" -czf "$OUT/opencrew_${OS}_${ARCH}.tar.gz" .
fi

rm -rf "$STAGE"
