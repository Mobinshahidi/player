#!/usr/bin/env bash
# Open the terminal TUI — the "Player" the user opens from the app menu.
# Same environment as the original launcher: loads cloud secrets, drops proxies.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Cloud sync secrets (set as env vars, like the original ~/.local/bin/player).
if [ -f "$APP_DIR/.mpv-player-secrets" ]; then
  set -a
  . "$APP_DIR/.mpv-player-secrets"
  set +a
fi
unset http_proxy https_proxy ALL_PROXY

# Fresh clone? Install deps once.
if [ ! -d "$APP_DIR/node_modules" ]; then
  echo "[player] installing dependencies (one-time)…"
  npm install
fi

exec node_modules/.bin/tsx src/tui.ts