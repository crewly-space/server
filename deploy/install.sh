#!/bin/sh
set -eu

# Installs only the crewly CLI. `crewly init` then asks how this device is
# used; the server and app are downloaded by the CLI only if the user picks a
# mode that hosts them, so a device that just connects to an existing server
# never carries them.

CLI_REPO="crewly-space/cli"
VERSION="${CREWLY_VERSION:-latest}"
INSTALL_DIR="${CREWLY_INSTALL_DIR:-/usr/local/bin}"
SKIP_INIT="${CREWLY_SKIP_INIT:-${CREWLY_SKIP_SETUP:-}}"

say() { printf '  %s\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1" >&2; }
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

if [ -n "${CREWLY_RELEASE_BASE_URL:-}" ]; then
  CLI_RELEASE_URL="${CREWLY_RELEASE_BASE_URL%/}"
elif [ "$VERSION" = "latest" ]; then
  CLI_RELEASE_URL="https://github.com/$CLI_REPO/releases/latest/download"
else
  CLI_RELEASE_URL="https://github.com/$CLI_REPO/releases/download/$VERSION"
fi
CLI_ASSET="crewly-cli_${OS}_${ARCH}.tar.gz"
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/crewly.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

say "Downloading the Crewly CLI"
curl -fL --retry 3 --connect-timeout 10 "$CLI_RELEASE_URL/$CLI_ASSET" -o "$TMP_DIR/$CLI_ASSET"
curl -fL --retry 3 --connect-timeout 10 "$CLI_RELEASE_URL/checksums.txt" -o "$TMP_DIR/checksums.txt"
expected=$(awk -v a="$CLI_ASSET" '$2 == a { print $1 }' "$TMP_DIR/checksums.txt")
[ -n "$expected" ] || fail "Release checksum for $CLI_ASSET is missing"
if has sha256sum; then actual=$(sha256sum "$TMP_DIR/$CLI_ASSET" | awk '{print $1}')
elif has shasum; then actual=$(shasum -a 256 "$TMP_DIR/$CLI_ASSET" | awk '{print $1}')
else fail "sha256sum or shasum is required"; fi
[ "$expected" = "$actual" ] || fail "Release checksum for $CLI_ASSET did not match"
tar -xzf "$TMP_DIR/$CLI_ASSET" -C "$TMP_DIR"
[ -x "$TMP_DIR/crewly" ] || fail "The CLI release does not contain the crewly binary"
ok "Verified the CLI"

SUDO=""
if [ ! -d "$INSTALL_DIR" ] || [ ! -w "$INSTALL_DIR" ]; then
  if [ "$(id -u)" -ne 0 ]; then has sudo || fail "Run as root or install sudo"; SUDO="sudo"; fi
fi
$SUDO mkdir -p "$INSTALL_DIR"
$SUDO install -m 0755 "$TMP_DIR/crewly" "$INSTALL_DIR/crewly"

# Older installers put the server and app next to the CLI, where the CLI still
# looks first. Left behind, that copy would never be updated again, so drop it;
# the CLI downloads a current one the next time this device starts a server.
if [ -e "$INSTALL_DIR/crewly-server" ] || [ -e "$INSTALL_DIR/web/index.html" ]; then
  $SUDO rm -f "$INSTALL_DIR/crewly-server" || warn "Could not remove the old $INSTALL_DIR/crewly-server"
  $SUDO rm -rf "$INSTALL_DIR/web" || warn "Could not remove the old $INSTALL_DIR/web"
fi
ok "Installed the Crewly CLI"

if [ -z "$SKIP_INIT" ] && [ -r /dev/tty ] && [ -t 1 ]; then
  printf '\n'
  "$INSTALL_DIR/crewly" init </dev/tty
else
  printf '\n'
  say "Next: crewly init"
fi
