#!/usr/bin/env bash
# install.sh — install the talonctl wrapper for the Talon + Postgram stack.
#
# Optional convenience: lets you run `talonctl ...` from anywhere instead
# of `./bin/talonctl`. Default location: ~/.local/bin (no sudo).
# Override with PREFIX:  PREFIX=/usr/local/bin sudo ./install.sh

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

# Ensure the talond bind-mount sources exist (bootstrap.sh also does this).
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
echo "Next: cp .env.example .env  (fill it in), then ./bootstrap.sh"
