#!/usr/bin/env bash
# Daily launcher for the GUI (used by the .desktop entry).
# - builds the release binary once if needed (via build-gui.sh)
# - starts the local Node server, waits for it
# - launches the app, cleans the server up when the window closes
# Everything is logged to ~/.cache/player-gui.log so failures are never silent.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

export PATH="$HOME/.cargo/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env" || true

LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/player-gui.log"

# Capture everything from the very first line.
exec >>"$LOG" 2>&1

echo
echo "[run-gui] $(date '+%F %T') start"

PORT="${GUI_PORT:-45871}"
BIN="$APP_DIR/src-tauri/target/release/player-gui"
URL="http://127.0.0.1:$PORT/api/health"

# Single instance: don't start a second one (would spam the port / RAM).
if pgrep -f "src-tauri/target/release/player-gui" >/dev/null 2>&1; then
  echo "[run-gui] already running — exiting."
  exit 0
fi

# Build once if the release binary doesn't exist yet.
if [ ! -x "$BIN" ]; then
  echo "[run-gui] release binary missing — building (one-time, a few minutes)..."
  if ! "$APP_DIR/scripts/build-gui.sh"; then
    echo "[run-gui] ERROR: build failed. See the messages above."
    exit 1
  fi
  echo "[run-gui] build finished."
fi

# Clean up any orphaned server from a crashed/old session.
pkill -f "gui[-]server" 2>/dev/null || true

# Start the local API server.
node --import tsx src/gui-server.ts --port "$PORT" &
SERVER_PID=$!
echo "[run-gui] server pid $SERVER_PID on port $PORT"

# Wait until it answers /api/health.
healthy=0
for _ in $(seq 1 40); do
  if curl -sf "$URL" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[run-gui] ERROR: server exited early."
    exit 1
  fi
  sleep 0.25
done

if [ "$healthy" != "1" ]; then
  echo "[run-gui] ERROR: server did not become healthy on $URL"
  kill "$SERVER_PID" 2>/dev/null || true
  exit 1
fi

# Launch the release app.
echo "[run-gui] launching $BIN"
set +e
"$BIN"
CODE=$?
set -e
echo "[run-gui] app exited (code=$CODE)"

# Cleanup: stop the server and any of its children (e.g. mpv).
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  pkill -P "$SERVER_PID" 2>/dev/null || true
  echo "[run-gui] cleaned up."
}
trap cleanup EXIT

exit 0