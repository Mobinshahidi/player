#!/usr/bin/env bash
# Daily launcher for the native GTK4 player (used by the .desktop entry).
# Builds once if needed, then runs the binary instantly.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$APP_DIR/native/player"

LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/player-gui.log"

# Everything from the first line goes to the log.
exec >>"$LOG" 2>&1

echo
echo "[run-native] $(date '+%F %T') start"

if [ ! -x "$BIN" ]; then
  echo "[run-native] binary missing — building once…"
  if ! "$APP_DIR/scripts/build-native.sh"; then
    echo "[run-native] ERROR: build failed (see above)."
    exit 1
  fi
fi

echo "[run-native] launching $BIN"
exec "$BIN"