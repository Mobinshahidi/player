#!/usr/bin/env bash
# One-time release build for the GUI. Produces:
#   src-tauri/target/release/player-gui
# The launcher (run-gui.sh) calls this automatically if the binary is missing.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

export PATH="$HOME/.cargo/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" || true

# Fast, clear failures instead of a long cryptic compile error.
if ! command -v cargo >/dev/null 2>&1; then
  echo "[build-gui] ERROR: cargo/rust not found."
  echo "            Fedora: sudo dnf install rust cargo"
  echo "            Arch:   sudo pacman -S rust"
  exit 1
fi

if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  echo "[build-gui] ERROR: webkit2gtk-4.1 development files not found."
  echo "            Fedora: sudo dnf install webkit2gtk4.1-devel javascriptcoregtk4.1-devel librsvg2-devel"
  echo "            Arch:   sudo pacman -S webkit2gtk-4.1"
  echo "            (then re-run: ./scripts/setup-fedora.sh  or  ./scripts/setup-arch.sh)"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[build-gui] installing npm dependencies..."
  npm install
fi

echo "[build-gui] compiling release build (one-time, a few minutes)..."
npm run gui:build

BIN="src-tauri/target/release/player-gui"
if [ ! -x "$BIN" ]; then
  echo "[build-gui] ERROR: expected binary not found: $BIN"
  exit 1
fi

echo "[build-gui] done: $BIN"
echo "[build-gui] launch it with: ./scripts/run-gui.sh"