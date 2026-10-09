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
# Do not allow configured paths to escape private storage through symlinks.
CURRENT=/data
REST="${BASE#/data/}"
OLD_IFS="$IFS"; IFS=/
for PART in $REST; do
  CURRENT="$CURRENT/$PART"
  if [ -L "$CURRENT" ]; then
    echo "[talon] storage_path must not contain symlinks" >&2
    exit 1
  fi
done
IFS="$OLD_IFS"
case "$BASE" in
  *[!A-Za-z0-9_./-]*) echo "[talon] storage_path contains unsupported characters" >&2; exit 1 ;;
esac
# Use one state directory per workspace. Keep legacy default state intact.
INSTANCE="$(jq -r '.instance // "" | gsub("^\\s+|\\s+$"; "")' "$OPTIONS")"

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
STATE_DIR="$WORKSPACE/state"
# The initial add-on stored default state at $BASE/state. Never move it
# automatically: existing config may still reference it and contain live data.
if [ "$INSTANCE_DIR" = default ] && [ -d "$BASE/state" ]; then
  STATE_DIR="$BASE/state"
fi
EXPECTED_STATE_DIR="$STATE_DIR"
CONFIG_FILE="$WORKSPACE/talond.yaml"
PERSONA_DIR="$WORKSPACE/personas/assistant"

mkdir -p "$STATE_DIR" "$WORKSPACE" "$WORKSPACE/skills" "$WORKSPACE/personas" "$WORKSPACE/subagents" "$WORKSPACE/userdata"

# Keep the daemon and CLI IPC endpoint local and writable.
# Existing workspaces may point at a different dataDir after a migration.
# Resolve against the actual configuration, rather than assuming state layout.
if [ -f "$CONFIG_FILE" ]; then
  CONFIG_DATA_DIR="$(node -e 'const fs=require("fs");const yaml=require("/opt/talond/node_modules/js-yaml");try{const c=yaml.load(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(typeof c?.dataDir==="string"?c.dataDir:"")}catch(e){process.stderr.write("Invalid talond.yaml: "+e.message+"\\n");}' "$CONFIG_FILE")"
  [ -z "$CONFIG_DATA_DIR" ] || STATE_DIR="$CONFIG_DATA_DIR"
fi
case "$STATE_DIR" in
  /data/*) ;;
  *) echo "[talon] dataDir must be inside /data" >&2; exit 1 ;;
esac
IPC_DIR="$STATE_DIR/ipc/daemon"
mkdir -p "$STATE_DIR/ipc"
if [ -L "$IPC_DIR" ]; then
  rm -f "$IPC_DIR"
elif [ -e "$IPC_DIR" ] && [ ! -d "$IPC_DIR" ]; then
  echo "[talon] Unsafe IPC path: $IPC_DIR" >&2; exit 1
fi
mkdir -p "$IPC_DIR"
echo "[talon] Local daemon IPC: $IPC_DIR"

OPENAI_API_KEY="$(jq -r '.openai_api_key // ""' "$OPTIONS")"
OPENAI_MODEL="$(jq -r '(.openai_model // "") | if . == "" then "gpt-5.4" else . end' "$OPTIONS")"
# Legacy options remain readable ONLY when bootstrapping an installation that
# predates the streamlined HA schema. Existing talond.yaml is never overwritten.
TELEGRAM_BOT_TOKEN="$(jq -r '.telegram_bot_token // ""' "$OPTIONS")"
TELEGRAM_CHAT_ID="$(jq -r '.telegram_chat_id // ""' "$OPTIONS")"


export OPENAI_API_KEY
export TELEGRAM_BOT_TOKEN
export TALON_WORKSPACE="$WORKSPACE"
export TALOND_CONFIG_PATH="$CONFIG_FILE"
export CODEX_HOME="$BASE/codex-home"
mkdir -p "$CODEX_HOME"
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
    BOOTSTRAP_PROVIDER=codex-cli
    BOOTSTRAP_MODEL=gpt-5.6
  else
    BOOTSTRAP_PROVIDER=openai-compatible
    BOOTSTRAP_MODEL="$OPENAI_MODEL"
  fi
  BOOTSTRAP_MODEL_JSON="$(printf '%s' "$BOOTSTRAP_MODEL" | jq -Rs .)"
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
    model: $BOOTSTRAP_MODEL_JSON
    provider: $BOOTSTRAP_PROVIDER
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
  defaultProvider: $BOOTSTRAP_PROVIDER
  providers:
    $BOOTSTRAP_PROVIDER:
      enabled: true
      command: $(if [ "$BOOTSTRAP_PROVIDER" = codex-cli ]; then printf codex; else printf node; fi)
      contextWindowTokens: 256000
      contextManagement:
        enabled: false

backgroundAgent:
  enabled: false
  maxConcurrent: 1
  defaultTimeoutMinutes: 30
  defaultProvider: $BOOTSTRAP_PROVIDER
  providers:
    $BOOTSTRAP_PROVIDER:
      enabled: false
      command: $(if [ "$BOOTSTRAP_PROVIDER" = codex-cli ]; then printf codex; else printf node; fi)
      contextWindowTokens: 256000

logLevel: info
dataDir: $STATE_DIR
EOF
  if [ "$BOOTSTRAP_PROVIDER" = openai-compatible ]; then
    cat >> "$CONFIG_FILE" <<EOF

auth:
  mode: api_key
  providers:
    openai:
      apiKey: \${OPENAI_API_KEY}
      baseURL: https://api.openai.com/v1
EOF
  fi
fi

# PR #289 provides the attachments schema. Sync only the HA-managed origin
# stanza, keeping other talond.yaml settings and comments unchanged.
# Invalid origins leave the recovery terminal accessible, without starting Talon.
CONFIG_VALID=1
if ! node /usr/local/lib/talon-sync-attachment-origins.cjs "$OPTIONS" "$CONFIG_FILE"; then
  CONFIG_VALID=0
fi
if ! node /usr/local/lib/talon-check-config.cjs "$CONFIG_FILE" "$WORKSPACE" "$EXPECTED_STATE_DIR"; then
  CONFIG_VALID=0
fi

# Upstream talonctl hardcodes data/ipc/daemon relative to its current workspace,
# while talond hardcodes <dataDir>/ipc/daemon. Bridge those two private paths.
CLI_IPC_PARENT="$WORKSPACE/data/ipc"
CLI_IPC_DIR="$CLI_IPC_PARENT/daemon"
mkdir -p "$CLI_IPC_PARENT"
if [ -L "$CLI_IPC_DIR" ]; then
  rm -f "$CLI_IPC_DIR"
elif [ -e "$CLI_IPC_DIR" ]; then
  echo "[talon] Existing IPC directory requires manual migration: $CLI_IPC_DIR" >&2; exit 1
fi
ln -s "$IPC_DIR" "$CLI_IPC_DIR"
echo "[talon] CLI IPC bridge: $CLI_IPC_DIR -> $IPC_DIR"

mkdir -p /home/talond
cat >/home/talond/.bashrc <<EOF
cd "$WORKSPACE"
export TALON_WORKSPACE="$WORKSPACE"
export TALOND_CONFIG_PATH="$CONFIG_FILE"
export CODEX_HOME="$BASE/codex-home"
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
    kill -TERM "-$DAEMON_PID" 2>/dev/null || true
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
    kill -TERM "-$TTYD_PID" 2>/dev/null || true
    wait "$TTYD_PID" 2>/dev/null || true
    TTYD_PID=""
  fi
}
trap 'cleanup; exit 0' INT TERM
trap cleanup EXIT

# Restrict writable workspace/state to the dedicated unprivileged daemon user.
chown -R talond:talond "$BASE" /home/talond
chmod 700 "$BASE" "$STATE_DIR" "$WORKSPACE"
cd "$WORKSPACE"
echo "[talon] Workspace: $WORKSPACE"
echo "[talon] Private storage: $BASE"
echo "[talon] Starting management terminal on ingress port 7681..."
# ttyd is reachable only over loopback; the gate accepts ingress gateway IP.
setsid setpriv --reuid=talond --regid=talond --init-groups -- /usr/local/bin/ttyd -W -i 127.0.0.1 -p 7682 /bin/bash -l &
TTYD_PID=$!
node /usr/local/lib/talon-ingress-proxy.cjs &
PROXY_PID=$!

if [ ! -f "$CONFIG_FILE" ] || [ "$CONFIG_VALID" -ne 1 ]; then
  echo "[talon] Recovery terminal available. Create $CONFIG_FILE and restart."
  wait "$TTYD_PID"
  exit $?
fi

echo "[talon] Starting Talon daemon..."
setsid setpriv --reuid=talond --regid=talond --init-groups -- node /opt/talond/dist/index.js --config "$CONFIG_FILE" &
DAEMON_PID=$!

set +e
wait "$DAEMON_PID"
DAEMON_STATUS=$?
set -e
echo "[talon] Daemon exited with status $DAEMON_STATUS; recovery terminal remains available."
DAEMON_PID=""
wait "$TTYD_PID"
