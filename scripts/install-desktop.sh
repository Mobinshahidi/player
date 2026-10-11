#!/usr/bin/env bash
# Install (or reinstall) the "Player" launcher for the current user.
# Usage:
#   ./scripts/install-desktop.sh          # install / update the entry
#   ./scripts/install-desktop.sh --open   # also launch it once as a smoke test
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS_DIR="$DATA_DIR/applications"
ICON_DIR="$DATA_DIR/icons/hicolor/256x256/apps"
DESKTOP_FILE="$APPS_DIR/player.desktop"

mkdir -p "$APPS_DIR" "$ICON_DIR"

# Icon
if [ -f "$APP_DIR/logo.png" ]; then
  cp "$APP_DIR/logo.png" "$ICON_DIR/player.png"
fi

# A previous entry may be root-owned (created with sudo). Unlinking from a
# user-writable dir is fine; only open-for-truncate would fail — so remove
# first, and only complain if removal itself is blocked.
rm -f "$DESKTOP_FILE" "$APPS_DIR/player-gui.desktop" 2>/dev/null || true
if [ -e "$DESKTOP_FILE" ]; then
  echo "⚠  Could not remove an existing launcher at $DESKTOP_FILE"
  echo "   Remove it first:  sudo rm \"$DESKTOP_FILE\""
  echo "   then re-run:      ./scripts/install-desktop.sh"
  exit 1
fi

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Player
GenericName=Series Player
Comment=Local-first series player — add a series link and watch
Exec=$APP_DIR/scripts/run-gui.sh
Icon=player
Terminal=false
Categories=AudioVideo;Player;Video;
Keywords=series;movie;video;player;mpv;
StartupNotify=true
StartupWMClass=player
EOF

chmod +x "$DESKTOP_FILE"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" 2>/dev/null || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$DATA_DIR/icons/hicolor" 2>/dev/null || true
fi

echo "✓ Installed launcher: $DESKTOP_FILE"
echo "✓ Icon:             $ICON_DIR/player.png"

# Warn about any other stale player launchers that may shadow this one.
if ls "$APPS_DIR"/player-gui.desktop "$APPS_DIR"/player.desktop >/dev/null 2>&1; then
  :
fi

if [ "${1:-}" = "--open" ]; then
  echo
  echo "Launching to verify... (close the window when done; log: ~/.cache/player-gui.log)"
  if command -v gio >/dev/null 2>&1; then
    gio launch "$DESKTOP_FILE"
  elif command -v gtk-launch >/dev/null 2>&1; then
    gtk-launch player
  else
    "$APP_DIR/scripts/run-gui.sh" &
  fi
fi

echo
echo "It should now appear as \"Player\" in your app launcher."
echo "If it doesn't show up immediately, log out and back in (or restart the launcher/DE)."