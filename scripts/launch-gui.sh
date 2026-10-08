#!/usr/bin/env bash
# Launcher for the desktop GUI, used by player-gui.desktop.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

# .desktop launches get a minimal PATH — add the usual tool locations.
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}"
mkdir -p "$LOG_DIR"

# First run compiles the Rust shell (can take a few minutes); later runs start
# in a second. Logs are written so a silent failure is still diagnosable.
exec npm run gui >>"$LOG_DIR/player-gui.log" 2>&1
