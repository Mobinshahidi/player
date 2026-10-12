#!/usr/bin/env bash
# One-time build of the native GTK4 player (a few seconds on any machine).
# Produces: native/player
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR/native"

export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if ! command -v cc >/dev/null 2>&1; then
  echo "[build-native] ERROR: no C compiler found (cc)."
  echo "            Fedora: sudo dnf install gcc make"
  echo "            Arch:   sudo pacman -S gcc make"
  exit 1
fi
if ! pkg-config --exists gtk4; then
  echo "[build-native] ERROR: GTK4 development headers not found."
  echo "            Fedora: sudo dnf install gcc make pkgconf-pkg-config gtk4-devel glib2-devel libcurl-devel"
  echo "            Arch:   sudo pacman -S gcc make pkgconf gtk4 glib2 libcurl"
  echo "            (or re-run: ./scripts/setup-arch.sh  /  ./scripts/setup-fedora.sh)"
  exit 1
fi

echo "[build-native] compiling (native/player)…"
make clean >/dev/null 2>&1 || true
make

echo "[build-native] done: $APP_DIR/native/player"
echo "[build-native] launch with: ./scripts/run-native.sh"