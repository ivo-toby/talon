#!/usr/bin/env bash
# install.sh — install the talonctl wrapper to your PATH.
#
# Default install location: ~/.local/bin (no sudo). Override with PREFIX:
#   PREFIX=/usr/local/bin sudo ./install.sh

set -euo pipefail

PREFIX="${PREFIX:-$HOME/.local/bin}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/bin/talonctl"
DEST="$PREFIX/talonctl"

if [ ! -f "$SRC" ]; then
  echo "install.sh: source not found at $SRC" >&2
  exit 1
fi

mkdir -p "$PREFIX"
install -m 0755 "$SRC" "$DEST"
echo "Installed: $DEST"

# Ensure the bind-mount sources exist before `docker compose up`.
# Without this, Docker creates them as root-owned on Linux, breaking the
# non-root user inside the container.
mkdir -p "$HERE/data" "$HERE/userdata"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *)
    echo
    echo "Note: $PREFIX is not on your PATH. Add this to your shell rc:"
    echo "  export PATH=\"$PREFIX:\$PATH\""
    ;;
esac

echo
echo "Try it: talonctl --help"
