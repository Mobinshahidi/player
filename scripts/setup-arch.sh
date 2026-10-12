#!/usr/bin/env bash
# One-time system dependencies for the native player on Arch Linux.
# Usage: ./scripts/setup-arch.sh
set -euo pipefail

sudo pacman -S --needed --noconfirm \
  gcc make pkgconf gtk4 glib2 libcurl \
  mpv curl

echo
echo "System packages installed."
echo "Next:"
echo "  ./scripts/build-native.sh"
echo "  ./scripts/install-desktop.sh"
echo "  ./scripts/run-native.sh"