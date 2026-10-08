#!/usr/bin/env bash
# One-time system dependencies for the player GUI on Fedora.
# Usage: ./scripts/setup-fedora.sh
set -euo pipefail

sudo dnf install -y \
  nodejs npm mpv curl wget file \
  webkit2gtk4.1-devel javascriptcoregtk4.1-devel libsoup3-devel \
  openssl-devel librsvg2-devel libappindicator-gtk3-devel \
  gcc gcc-c++ make pkgconf-pkg-config \
  rust cargo

echo
echo "System packages installed."
echo "Next:"
echo "  npm install"
echo "  npm run gui"
