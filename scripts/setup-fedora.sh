#!/usr/bin/env bash
# One-time system dependencies for the native player on Fedora.
# Usage: ./scripts/setup-fedora.sh
set -euo pipefail

sudo dnf install -y \
  gcc make pkgconf-pkg-config gtk4-devel glib2-devel libcurl-devel \
  mpv curl

echo
echo "System packages installed."
echo "Next:"
echo "  ./scripts/build-native.sh"
echo "  ./scripts/install-desktop.sh"
echo "  ./scripts/run-native.sh"