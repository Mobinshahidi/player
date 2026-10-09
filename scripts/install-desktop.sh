#!/usr/bin/env bash
# Install (or reinstall) the "Player" launcher for the current user.
# Works on any distro — it resolves this repo's real path automatically.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS_DIR="$DATA_DIR/applications"
ICON_DIR="$DATA_DIR/icons/hicolor/256x256/apps"

mkdir -p "$APPS_DIR" "$ICON_DIR"

# Install the icon into the hicolor theme so launchers can resolve `Icon=player`.
ICON_DST="$ICON_DIR/player.png"
if [ -f "$APP_DIR/logo.png" ]; then
  cp "$APP_DIR/logo.png" "$ICON_DST"
fi

DESKTOP_FILE="$APPS_DIR/player-gui.desktop"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Player GUI
GenericName=Series Player
Comment=Local-first series player — add a series link and watch
Exec=$APP_DIR/scripts/launch-gui.sh
Icon=player
Terminal=false
Categories=AudioVideo;Player;Video;
Keywords=series;video;player;mpv;
StartupNotify=true
EOF

chmod +x "$DESKTOP_FILE"

# If an old launcher named "Player" exists, point out the difference.
if [ -e "$APPS_DIR/player.desktop" ]; then
  echo "note: $APPS_DIR/player.desktop already exists (the old terminal/TUI launcher)."
  echo "      The GUI is installed separately as \"Player GUI\"."
fi

update-desktop-database "$APPS_DIR" 2>/dev/null || true
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$DATA_DIR/icons/hicolor" 2>/dev/null || true
fi

echo "✓ Installed launcher: $DESKTOP_FILE"
echo "✓ Icon:             $ICON_DST"
echo
echo "It should now appear as \"Player GUI\" in your app launcher."
echo "If it doesn't show up immediately, log out and back in (or restart the launcher/DE)."
