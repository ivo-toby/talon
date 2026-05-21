#!/usr/bin/env bash
# sync-starter-skills.sh — copy the user-facing Claude skills into the starter
# bundle. Source: .claude/skills/<name>/. Destination: starter/.claude/skills/<name>/.
#
# Reads the allowlist from starter/.claude/skills/INCLUDED.txt.
#
# Usage:
#   scripts/sync-starter-skills.sh           # sync
#   scripts/sync-starter-skills.sh --check   # exit non-zero if any allowlisted
#                                            # skill is missing from .claude/skills/

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT/.claude/skills"
DEST_DIR="$ROOT/starter/.claude/skills"
ALLOWLIST="$DEST_DIR/INCLUDED.txt"

MODE="sync"
if [ "${1:-}" = "--check" ]; then
  MODE="check"
fi

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
