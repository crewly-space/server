#!/bin/sh
set -eu

SERVER_REPO="crewly-space/server"
CLI_REPO="crewly-space/cli"
VERSION="${CREWLY_VERSION:-latest}"
INSTALL_DIR="${CREWLY_INSTALL_DIR:-/usr/local/bin}"
SKIP_INIT="${CREWLY_SKIP_INIT:-${CREWLY_SKIP_SETUP:-}}"

say() { printf '  %s\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m×\033[0m %s\n' "$1" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

printf '\n  Crewly installer\n  ──────────────────\n\n'
has curl || fail "curl is required"
has tar || fail "tar is required"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$OS" in linux|darwin) ;; *) fail "Unsupported operating system: $OS" ;; esac
ARCH=$(uname -m)
case "$ARCH" in x86_64|amd64) ARCH="amd64" ;; aarch64|arm64) ARCH="arm64" ;; *) fail "Unsupported architecture: $ARCH" ;; esac
ok "Detected $OS / $ARCH"

# The server (with the bundled app) and the CLI ship from separate
# repositories now, so each asset resolves against its own release.
release_url_for() {
  if [ -n "${CREWLY_RELEASE_BASE_URL:-}" ]; then
    printf '%s' "${CREWLY_RELEASE_BASE_URL%/}"
  elif [ "$VERSION" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download' "$1"
  else
    printf 'https://github.com/%s/releases/download/%s' "$1" "$VERSION"
  fi
}
RELEASE_URL=$(release_url_for "$SERVER_REPO")
CLI_RELEASE_URL=$(release_url_for "$CLI_REPO")
SERVER_ASSET="crewly-server_${OS}_${ARCH}.tar.gz"
CLI_ASSET="crewly-cli_${OS}_${ARCH}.tar.gz"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/crewly.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

# Download one asset and verify it against its release's checksums.txt.
fetch_verified() {
  base_url=$1; asset=$2; label=$3
  say "Downloading $label"
  curl -fL --retry 3 --connect-timeout 10 "$base_url/$asset" -o "$TMP_DIR/$asset"
  curl -fL --retry 3 --connect-timeout 10 "$base_url/checksums.txt" -o "$TMP_DIR/checksums.$label.txt"
  expected=$(awk -v a="$asset" '$2 == a { print $1 }' "$TMP_DIR/checksums.$label.txt")
  [ -n "$expected" ] || fail "Release checksum for $asset is missing"
  if has sha256sum; then actual=$(sha256sum "$TMP_DIR/$asset" | awk '{print $1}')
  elif has shasum; then actual=$(shasum -a 256 "$TMP_DIR/$asset" | awk '{print $1}')
  else fail "sha256sum or shasum is required"; fi
  [ "$expected" = "$actual" ] || fail "Release checksum for $asset did not match"
  tar -xzf "$TMP_DIR/$asset" -C "$TMP_DIR"
  ok "Verified $label"
}

fetch_verified "$RELEASE_URL" "$SERVER_ASSET" "server"
fetch_verified "$CLI_RELEASE_URL" "$CLI_ASSET" "CLI"

[ -x "$TMP_DIR/crewly" ] || fail "The CLI release does not contain the crewly binary"
[ -x "$TMP_DIR/crewly-server" ] || fail "The server release does not contain crewly-server"
[ -f "$TMP_DIR/web/index.html" ] || fail "The server release does not contain the Crewly app"

SUDO=""
if [ ! -d "$INSTALL_DIR" ] || [ ! -w "$INSTALL_DIR" ]; then
  if [ "$(id -u)" -ne 0 ]; then has sudo || fail "Run as root or install sudo"; SUDO="sudo"; fi
fi
$SUDO mkdir -p "$INSTALL_DIR/web"
$SUDO install -m 0755 "$TMP_DIR/crewly" "$INSTALL_DIR/crewly"
$SUDO install -m 0755 "$TMP_DIR/crewly-server" "$INSTALL_DIR/crewly-server"
$SUDO cp -R "$TMP_DIR/web/." "$INSTALL_DIR/web/"
ok "Installed CLI, server, and app"

if [ -z "$SKIP_INIT" ] && [ -r /dev/tty ] && [ -t 1 ]; then
  printf '\n'
  "$INSTALL_DIR/crewly" init </dev/tty
else
  printf '\n'
  say "Next: crewly init"
fi
