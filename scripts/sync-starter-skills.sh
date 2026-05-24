#!/usr/bin/env bash
# sync-starter-skills.sh — copy the user-facing Claude skills into a starter
# bundle. Source: .claude/skills/<name>/. Destination: <bundle>/.claude/skills/<name>/.
#
# Reads the allowlist from <bundle>/.claude/skills/INCLUDED.txt.
#
# Usage:
#   scripts/sync-starter-skills.sh [BUNDLE] [--check]
#
#   BUNDLE   directory under the repo root (default: starter)
#   --check  exit non-zero if any allowlisted skill is missing in source;
#            do not write to the destination
#
# Flag and positional may appear in any order. -h / --help prints this usage.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT/.claude/skills"

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

BUNDLE=""
MODE="sync"

for arg in "$@"; do
  case "$arg" in
    --check)
      MODE="check"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "sync-starter-skills: unknown flag: $arg" >&2
      usage >&2
      exit 64
      ;;
    *)
      if [ -n "$BUNDLE" ]; then
        echo "sync-starter-skills: unexpected positional argument: $arg" >&2
        usage >&2
        exit 64
      fi
      BUNDLE="$arg"
      ;;
  esac
done

BUNDLE="${BUNDLE:-starter}"

DEST_DIR="$ROOT/$BUNDLE/.claude/skills"
ALLOWLIST="$DEST_DIR/INCLUDED.txt"

if [ ! -f "$ALLOWLIST" ]; then
  echo "sync-starter-skills: allowlist not found at $ALLOWLIST" >&2
  exit 1
fi

# Read non-blank, non-comment lines into an array (Bash 3.2 compatible — no mapfile).
skills=()
while IFS= read -r line || [ -n "$line" ]; do
  trimmed="${line%%#*}"
  trimmed="${trimmed## }"
  trimmed="${trimmed%% }"
  [ -z "$trimmed" ] && continue
  skills+=("$trimmed")
done < "$ALLOWLIST"

if [ ${#skills[@]} -eq 0 ]; then
  echo "sync-starter-skills: allowlist is empty"
  exit 0
fi

missing=()
for skill in "${skills[@]}"; do
  if [ ! -d "$SRC_DIR/$skill" ]; then
    missing+=("$skill")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "sync-starter-skills: missing skill dirs in $SRC_DIR:" >&2
  for m in "${missing[@]}"; do echo "  - $m" >&2; done
  exit 2
fi

if [ "$MODE" = "check" ]; then
  echo "sync-starter-skills: all ${#skills[@]} allowlisted skills present in source"
  exit 0
fi

mkdir -p "$DEST_DIR"

# Remove any previously-synced skill dirs (anything inside DEST_DIR other than
# INCLUDED.txt) so the destination is a fresh, deterministic copy.
for entry in "$DEST_DIR"/*; do
  [ -e "$entry" ] || continue
  base="$(basename "$entry")"
  [ "$base" = "INCLUDED.txt" ] && continue
  rm -rf "$entry"
done

for skill in "${skills[@]}"; do
  cp -R "$SRC_DIR/$skill" "$DEST_DIR/$skill"
  echo "  + $skill"
done

echo "sync-starter-skills: synced ${#skills[@]} skills to $DEST_DIR"
