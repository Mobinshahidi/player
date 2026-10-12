#!/usr/bin/env bash
# Install "Player" (TUI, opens in a terminal) and "Player GUI" (native app).
# Usage:
#   ./scripts/install-desktop.sh          # install / update the entries
#   ./scripts/install-desktop.sh --open   # also launch "Player" once as a smoke test
#   ./scripts/install-desktop.sh --gui    # only install the native GUI entry
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS_DIR="$DATA_DIR/applications"
ICON_DIR="$DATA_DIR/icons/hicolor/256x256/apps"

mkdir -p "$APPS_DIR" "$ICON_DIR"
if [ -f "$APP_DIR/logo.png" ]; then
  cp "$APP_DIR/logo.png" "$ICON_DIR/player.png"
fi

# ── the TUI entry: Player (opens in a terminal) ──────────────────────────────
TUI_FILE="$APPS_DIR/player.desktop"
rm -f "$TUI_FILE" 2>/dev/null || true
cat > "$TUI_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Player
GenericName=Series Player (TUI)
Comment=Local-first series player (terminal)
Exec=$APP_DIR/scripts/launch-tui.sh
Icon=player
Terminal=true
Categories=AudioVideo;Player;Video;
Keywords=series;movie;video;player;mpv;
StartupNotify=true
EOF
chmod +x "$TUI_FILE"

# ── the native GUI entry: Player GUI ─────────────────────────────────────────
GUI_FILE="$APPS_DIR/player-gui.desktop"
rm -f "$GUI_FILE" 2>/dev/null || true
cat > "$GUI_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Player GUI
GenericName=Series Player
Comment=Local-first series player (native GUI)
Exec=$APP_DIR/scripts/run-native.sh
Icon=player
Terminal=false
Categories=AudioVideo;Player;Video;
Keywords=series;movie;video;player;mpv;
StartupNotify=true
EOF
chmod +x "$GUI_FILE"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" 2>/dev/null || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$DATA_DIR/icons/hicolor" 2>/dev/null || true
fi

echo "✓ Installed: $TUI_FILE   (search \"Player\" → TUI)"
echo "✓ Installed: $GUI_FILE   (\"Player GUI\" → native window)"
echo "✓ Icon: $ICON_DIR/player.png"

if [ "${1:-}" = "--open" ] || [ "${1:-}" = "--gui" ]; then
  :
fi
if [ "${1:-}" = "--open" ]; then
  echo
  echo "Launching \"Player\" (TUI) to verify… close it when done."
  if command -v gio >/dev/null 2>&1; then
    gio launch "$TUI_FILE" || "$APP_DIR/scripts/launch-tui.sh"
  else
    "$APP_DIR/scripts/launch-tui.sh"
  fi
fi

echo
echo "If the launcher doesn't show up immediately, log out and back in (or restart the launcher/DE)."