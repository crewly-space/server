#!/bin/sh
set -eu

REPO="opentribe-dev/opencrew"
VERSION="${OPENCREW_VERSION:-latest}"
INSTALL_DIR="${OPENCREW_INSTALL_DIR:-/usr/local/bin}"
SKIP_INIT="${OPENCREW_SKIP_INIT:-${OPENCREW_SKIP_SETUP:-}}"

say() { printf '  %s\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m×\033[0m %s\n' "$1" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

printf '\n  OpenCrew installer\n  ──────────────────\n\n'
has curl || fail "curl is required"
has tar || fail "tar is required"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$OS" in linux|darwin) ;; *) fail "Unsupported operating system: $OS" ;; esac
ARCH=$(uname -m)
case "$ARCH" in x86_64|amd64) ARCH="amd64" ;; aarch64|arm64) ARCH="arm64" ;; *) fail "Unsupported architecture: $ARCH" ;; esac
ok "Detected $OS / $ARCH"

if [ -n "${OPENCREW_RELEASE_BASE_URL:-}" ]; then
  RELEASE_URL=${OPENCREW_RELEASE_BASE_URL%/}
elif [ "$VERSION" = "latest" ]; then
  RELEASE_URL="https://github.com/$REPO/releases/latest/download"
else
  RELEASE_URL="https://github.com/$REPO/releases/download/$VERSION"
fi
ASSET="opencrew_${OS}_${ARCH}.tar.gz"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/opencrew.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

say "Downloading OpenCrew ${VERSION}"
curl -fL --retry 3 --connect-timeout 10 "$RELEASE_URL/$ASSET" -o "$TMP_DIR/$ASSET"
curl -fL --retry 3 --connect-timeout 10 "$RELEASE_URL/checksums.txt" -o "$TMP_DIR/checksums.txt"
EXPECTED=$(awk -v asset="$ASSET" '$2 == asset { print $1 }' "$TMP_DIR/checksums.txt")
[ -n "$EXPECTED" ] || fail "Release checksum is missing"
if has sha256sum; then ACTUAL=$(sha256sum "$TMP_DIR/$ASSET" | awk '{print $1}')
elif has shasum; then ACTUAL=$(shasum -a 256 "$TMP_DIR/$ASSET" | awk '{print $1}')
else fail "sha256sum or shasum is required"; fi
[ "$EXPECTED" = "$ACTUAL" ] || fail "Release checksum did not match"
ok "Verified release checksum"

tar -xzf "$TMP_DIR/$ASSET" -C "$TMP_DIR"
[ -x "$TMP_DIR/opencrew" ] || fail "Release does not contain the OpenCrew CLI"
[ -x "$TMP_DIR/opencrew-server" ] || fail "Release does not contain the OpenCrew server"
[ -f "$TMP_DIR/web/index.html" ] || fail "Release does not contain the OpenCrew app"

SUDO=""
if [ ! -d "$INSTALL_DIR" ] || [ ! -w "$INSTALL_DIR" ]; then
  if [ "$(id -u)" -ne 0 ]; then has sudo || fail "Run as root or install sudo"; SUDO="sudo"; fi
fi
$SUDO mkdir -p "$INSTALL_DIR/web"
$SUDO install -m 0755 "$TMP_DIR/opencrew" "$INSTALL_DIR/opencrew"
$SUDO install -m 0755 "$TMP_DIR/opencrew-server" "$INSTALL_DIR/opencrew-server"
$SUDO cp -R "$TMP_DIR/web/." "$INSTALL_DIR/web/"
ok "Installed CLI, server, and app"

if [ -z "$SKIP_INIT" ] && [ -r /dev/tty ] && [ -t 1 ]; then
  printf '\n'
  "$INSTALL_DIR/opencrew" init </dev/tty
else
  printf '\n'
  say "Next: opencrew init"
fi
