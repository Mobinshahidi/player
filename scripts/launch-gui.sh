#!/usr/bin/env bash
# Launcher for the desktop GUI, used by the installed .desktop entry.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

# .desktop launches get a minimal PATH — add the usual tool locations.
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" || true

LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/player-gui.log"

# First run on a fresh clone: install JS deps (the Rust build happens inside
# `tauri dev`, and can take a few minutes the very first time).
if [ ! -d "$APP_DIR/node_modules" ]; then
  echo "[$(date)] node_modules missing — running npm install" >>"$LOG"
  npm install >>"$LOG" 2>&1 || true
fi

exec npm run gui >>"$LOG" 2>&1
