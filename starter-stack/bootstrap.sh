#!/usr/bin/env bash
# bootstrap.sh — first-run setup for the Talon + Postgram stack.
#
# Postgram API keys must be minted *after* its server is running, so this
# can't be a single `docker compose up`. This script does the ordering:
#
#   1. Bring up postgres + postgram, wait until Postgram is healthy.
#   2. Mint a Postgram API key via its admin CLI.
#   3. Write that key into .env (PGM_API_KEY) and render it into the
#      postgram-memory skill's MCP definition.
#   4. Bring up talond.
#
# Safe to re-run: if PGM_API_KEY is already set it skips key creation.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

ENV_FILE="$HERE/.env"
MCP_TEMPLATE="$HERE/skills/postgram-memory/mcp/postgram.json.template"
MCP_RENDERED="$HERE/skills/postgram-memory/mcp/postgram.json"

# --- prerequisites ----------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  echo "bootstrap: docker not found on PATH." >&2
  exit 127
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "bootstrap: .env not found. Run: cp .env.example .env  — then fill it in." >&2
  exit 1
fi

# Pull values from .env without sourcing it (avoids surprises with quoting).
get_env() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }

for required in POSTGRES_PASSWORD OPENAI_API_KEY TELEGRAM_BOT_TOKEN; do
  if [ -z "$(get_env "$required")" ]; then
    echo "bootstrap: $required is empty in .env — fill it in first." >&2
    exit 1
  fi
done

mkdir -p "$HERE/data" "$HERE/userdata"

# --- step 1: data services --------------------------------------------------

echo "==> Starting postgres + postgram ..."
docker compose up -d postgres postgram

echo "==> Waiting for Postgram to become healthy ..."
for _ in $(seq 1 60); do
  status="$(docker compose ps postgram --format '{{.Health}}' 2>/dev/null || echo '')"
  [ "$status" = "healthy" ] && break
  sleep 3
done
if [ "${status:-}" != "healthy" ]; then
  echo "bootstrap: Postgram did not become healthy in time." >&2
  echo "  Check: docker compose logs postgram" >&2
  exit 1
fi
echo "    Postgram is healthy."

# --- step 2: mint an API key (idempotent) -----------------------------------

existing_key="$(get_env PGM_API_KEY)"
if [ -n "$existing_key" ]; then
  echo "==> PGM_API_KEY already set in .env — skipping key creation."
  api_key="$existing_key"
else
  echo "==> Minting a Postgram API key for Talon ..."
  key_json="$(docker compose exec -T postgram pgm-admin key create \
    --name talon \
    --scopes read,write,delete \
    --visibility personal \
    --json)"
  api_key="$(printf '%s' "$key_json" | grep -oE '"plaintextKey"[[:space:]]*:[[:space:]]*"[^"]+"' | sed -E 's/.*"plaintextKey"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
  if [ -z "$api_key" ]; then
    echo "bootstrap: could not parse plaintextKey from pgm-admin output:" >&2
    printf '%s\n' "$key_json" >&2
    exit 1
  fi
  # Write it back into .env (replace the empty PGM_API_KEY= line).
  tmp="$(mktemp)"
  sed "s|^PGM_API_KEY=.*|PGM_API_KEY=$api_key|" "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
  echo "    Wrote PGM_API_KEY to .env"
fi

# --- step 3: render the skill's MCP definition ------------------------------

if [ ! -f "$MCP_TEMPLATE" ]; then
  echo "bootstrap: MCP template missing: $MCP_TEMPLATE" >&2
  exit 1
fi
sed "s|__PGM_API_KEY__|$api_key|" "$MCP_TEMPLATE" > "$MCP_RENDERED"
echo "==> Rendered postgram-memory MCP definition."

# --- step 4: talond ---------------------------------------------------------

if [ ! -f "$HERE/config/talond.yaml" ]; then
  echo "bootstrap: config/talond.yaml not found." >&2
  echo "  Run: cp config/talond.example.yaml config/talond.yaml  — then edit allowedChatIds." >&2
  exit 1
fi

echo "==> Starting talond ..."
docker compose up -d talond

echo
echo "Done. The stack is up:"
docker compose ps
echo
echo "Next: message your Telegram bot. Check logs with:"
echo "  docker compose logs -f talond"
