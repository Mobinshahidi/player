#!/usr/bin/env bash
# One-time system dependencies for the player GUI on Arch Linux.
# Usage: ./scripts/setup-arch.sh
set -euo pipefail

sudo pacman -S --needed --noconfirm \
  nodejs npm mpv curl \
  rust webkit2gtk-4.1 base-devel \
  libappindicator-gtk3 librsvg patchelf openssl

echo
echo "System packages installed."
echo "Next:"
echo "  npm install"
echo "  npm run gui"
