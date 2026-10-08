#!/bin/sh
set -eu

OPTIONS="/data/options.json"
if [ ! -f "$OPTIONS" ]; then
  echo "[talon] Home Assistant options file not found: $OPTIONS"
  exit 1
fi

# One daemon per add-on, with private persistent storage.
BASE="$(jq -r '.storage_path // ""' "$OPTIONS")"
[ -n "$BASE" ] || BASE="/data/talon"
case "$BASE" in
  /data/*) ;;
  *) echo "[talon] storage_path must be within private /data" >&2; exit 1 ;;
esac
case "$BASE" in
  *..*|*//*|*/.) echo "[talon] Invalid storage_path" >&2; exit 1 ;;
esac
BASE="${BASE%/}"
STATE_DIR="$BASE/state"
# Preserve existing workspace paths when upgrading earlier installations.
INSTANCE="$(jq -r '.instance // ""' "$OPTIONS" | xargs)"

case "$INSTANCE" in
  "")
    INSTANCE_DIR="default"
    ;;
  *[!A-Za-z0-9._-]*|.*|*..*)
    echo "[talon] Invalid instance name: '$INSTANCE'"
    echo "[talon] Use only letters, numbers, dot, underscore and dash; '..' is not allowed."
    exit 1
    ;;
  *)
    INSTANCE_DIR="$INSTANCE"
    ;;
esac

WORKSPACE="$BASE/workspaces/$INSTANCE_DIR"
CONFIG_FILE="$WORKSPACE/talond.yaml"
PERSONA_DIR="$WORKSPACE/personas/assistant"

mkdir -p "$STATE_DIR" "$WORKSPACE" "$WORKSPACE/skills" "$WORKSPACE/personas" "$WORKSPACE/subagents" "$WORKSPACE/userdata"

# Keep the daemon and CLI IPC endpoint local and writable.
IPC_DIR="$STATE_DIR/ipc/daemon"
mkdir -p "$STATE_DIR/ipc"
if [ -L "$IPC_DIR" ] || [ -e "$IPC_DIR" ]; then
  rm -rf "$IPC_DIR"
fi
mkdir -p "$IPC_DIR"
echo "[talon] Local daemon IPC: $IPC_DIR"

OPENAI_API_KEY="$(jq -r '.openai_api_key // ""' "$OPTIONS")"
OPENAI_MODEL="$(jq -r '.openai_model // "gpt-5.4"' "$OPTIONS")"
TELEGRAM_BOT_TOKEN="$(jq -r '.telegram_bot_token // ""' "$OPTIONS")"
TELEGRAM_CHAT_ID="$(jq -r '.telegram_chat_id // ""' "$OPTIONS")"


export OPENAI_API_KEY
export TELEGRAM_BOT_TOKEN
export TALON_WORKSPACE="$WORKSPACE"
export TALOND_CONFIG_PATH="$CONFIG_FILE"
export TALON_PID_FILE="$STATE_DIR/talond.pid"
export PATH="/usr/local/bin:/opt/talond/node_modules/.bin:$PATH"

MODEL_JSON="$(printf '%s' "$OPENAI_MODEL" | jq -Rs .)"
CHAT_ID_JSON="$(printf '%s' "$TELEGRAM_CHAT_ID" | jq -Rs .)"

mkdir -p "$PERSONA_DIR"
if [ ! -f "$PERSONA_DIR/system.md" ]; then
  cat > "$PERSONA_DIR/system.md" <<'EOF'
You are Talon, a helpful assistant running in Home Assistant.
Be concise, useful, and careful with actions that affect external systems.
Use configured MCP tools only when they are available and appropriate.
EOF
fi

if [ ! -f "$CONFIG_FILE" ]; then
  if [ -z "$OPENAI_API_KEY" ]; then
    echo "[talon] An OpenAI API key is required when creating a new default workspace." >&2
    exit 1
  fi
  echo "[talon] No existing workspace found; bootstrapping $CONFIG_FILE."
  cat > "$CONFIG_FILE" <<EOF
storage:
  type: sqlite
  path: $STATE_DIR/talond.sqlite

channels:
EOF

  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
    cat >> "$CONFIG_FILE" <<EOF
  - type: telegram
    name: telegram
    enabled: true
    config:
      botToken: \${TELEGRAM_BOT_TOKEN}
      allowedChatIds:
        - $CHAT_ID_JSON
      pollingTimeoutSec: 30
EOF
  else
    cat >> "$CONFIG_FILE" <<'EOF'
  []
EOF
  fi

  cat >> "$CONFIG_FILE" <<EOF

personas:
  - name: assistant
    model: $MODEL_JSON
    provider: openai-compatible
    systemPromptFile: $WORKSPACE/personas/assistant/system.md
    skills: []
    subagents: []
    capabilities:
      allow:
        - memory.access:*
        - subagent.invoke:*
      requireApproval: []
    maxConcurrent: 2

bindings:
EOF

  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
    cat >> "$CONFIG_FILE" <<'EOF'
  - persona: assistant
    channel: telegram
    isDefault: true
EOF
  else
    cat >> "$CONFIG_FILE" <<'EOF'
  []
EOF
  fi

  cat >> "$CONFIG_FILE" <<EOF

ipc:
  pollIntervalMs: 500
  daemonSocketDir: $WORKSPACE/data/ipc/daemon

queue:
  maxAttempts: 3
  backoffBaseMs: 1000
  backoffMaxMs: 60000
  concurrencyLimit: 3

scheduler:
  tickIntervalMs: 5000

agentRunner:
  defaultProvider: openai-compatible
  providers:
    openai-compatible:
      enabled: true
      command: node
      contextWindowTokens: 256000
      contextManagement:
        enabled: false
      options:
        baseUrl: https://api.openai.com/v1
        defaultModel: $MODEL_JSON
        providerId: openai
        apiMode: responses
        toolOutputCap: 8000

backgroundAgent:
  enabled: false
  maxConcurrent: 1
  defaultTimeoutMinutes: 30
  defaultProvider: openai-compatible
  providers:
    openai-compatible:
      enabled: false
      command: node
      contextWindowTokens: 256000
      options:
        baseUrl: https://api.openai.com/v1
        defaultModel: $MODEL_JSON
        providerId: openai

auth:
  mode: api_key
  providers:
    openai:
      apiKey: \${OPENAI_API_KEY}
      baseURL: https://api.openai.com/v1

logLevel: info
dataDir: $STATE_DIR
EOF
fi

# Upstream talonctl hardcodes data/ipc/daemon relative to its current workspace,
# while talond hardcodes <dataDir>/ipc/daemon. Bridge those two private paths.
CLI_IPC_PARENT="$WORKSPACE/data/ipc"
CLI_IPC_DIR="$CLI_IPC_PARENT/daemon"
mkdir -p "$CLI_IPC_PARENT"
if [ -L "$CLI_IPC_DIR" ]; then
  rm -f "$CLI_IPC_DIR"
elif [ -e "$CLI_IPC_DIR" ]; then
  rm -rf "$CLI_IPC_DIR"
fi
ln -s "$IPC_DIR" "$CLI_IPC_DIR"
echo "[talon] CLI IPC bridge: $CLI_IPC_DIR -> $IPC_DIR"

mkdir -p /home/talond
cat >/home/talond/.bashrc <<EOF
cd "$WORKSPACE"
export TALON_WORKSPACE="$WORKSPACE"
export TALOND_CONFIG_PATH="$CONFIG_FILE"
export OPENAI_API_KEY="\${OPENAI_API_KEY}"
export TELEGRAM_BOT_TOKEN="\${TELEGRAM_BOT_TOKEN}"
export PATH="/usr/local/bin:/opt/talond/node_modules/.bin:\$PATH"
echo
echo "Talon"
echo "Storage: $BASE"
echo "Workspace: $WORKSPACE"
echo "Management CLI is built into this app."
echo "Try: talonctl status"
echo "     talonctl list-skills --persona assistant"
echo "     talonctl reload"
echo
EOF

cat >/home/talond/.bash_profile <<'EOF'
[ -f /home/talond/.bashrc ] && . /home/talond/.bashrc
EOF

cleanup() {
  trap - INT TERM EXIT
  set +e
  if [ -n "${DAEMON_PID:-}" ]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    # Wait for talond to drain queued work, stop connectors and close SQLite.
    wait "$DAEMON_PID" 2>/dev/null || true
    DAEMON_PID=""
  fi
  if [ -n "${PROXY_PID:-}" ]; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
    PROXY_PID=""
  fi
  if [ -n "${TTYD_PID:-}" ]; then
    kill "$TTYD_PID" 2>/dev/null || true
    wait "$TTYD_PID" 2>/dev/null || true
    TTYD_PID=""
  fi
}
trap 'cleanup; exit 143' INT TERM
trap cleanup EXIT

# Restrict writable workspace/state to the dedicated unprivileged daemon user.
chown -R talond:talond "$BASE" /home/talond
chmod 700 "$BASE" "$STATE_DIR" "$WORKSPACE"
cd "$WORKSPACE"
echo "[talon] Workspace: $WORKSPACE"
echo "[talon] Private storage: $BASE"
echo "[talon] Starting management terminal on ingress port 7681..."
# ttyd is reachable only over loopback; the gate accepts ingress gateway IP.
runuser -u talond -- /usr/local/bin/ttyd -W -i 127.0.0.1 -p 7682 /bin/bash -l &
TTYD_PID=$!
node /usr/local/lib/talon-ingress-proxy.cjs &
PROXY_PID=$!

echo "[talon] Starting Talon daemon..."
runuser -u talond -- node /opt/talond/dist/index.js --config "$CONFIG_FILE" &
DAEMON_PID=$!

set +e
wait "$DAEMON_PID"
DAEMON_STATUS=$?
set -e
echo "[talon] Daemon exited with status $DAEMON_STATUS"
exit "$DAEMON_STATUS"
