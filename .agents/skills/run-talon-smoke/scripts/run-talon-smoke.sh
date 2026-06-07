#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SMOKE_DIR="$ROOT_DIR/.codex/talon-smoke"
BUILD_ONCE=1
STOP_ONLY=0
STATUS_ONLY=0
PREPARE_ONLY=0
MODE="${1:-fake}"

usage() {
  cat <<'USAGE'
Usage:
  run-talon-smoke.sh fake|live|both [--prepare] [--status] [--stop] [--no-build]

Modes:
  fake  No-cost fake codex-cli provider on 127.0.0.1:17700.
  live  Authenticated real codex-cli provider on 127.0.0.1:17701.
  both  Run fake then live.

Options:
  --prepare      Create harness files, run build/doctor, and print manual commands.
  --status        Print talonctl status and DB evidence for the mode.
  --stop          Stop the smoke daemon for the mode.
  --no-build      Skip npm run build.
USAGE
}

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prepare)
      PREPARE_ONLY=1
      ;;
    --status)
      STATUS_ONLY=1
      ;;
    --stop)
      STOP_ONLY=1
      ;;
    --no-build)
      BUILD_ONCE=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

case "$MODE" in
  fake|live|both) ;;
  *)
    echo "Unknown mode: $MODE" >&2
    usage >&2
    exit 2
    ;;
esac

run() {
  echo "+ $*"
  "$@"
}

write_harness() {
  mkdir -p "$SMOKE_DIR/data" "$SMOKE_DIR/live-data"
  cat > "$SMOKE_DIR/empty.env" <<'EOF'
EOF

  cat > "$SMOKE_DIR/fake-codex.mjs" <<'EOF'
#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const outputFlagIndex = args.indexOf('-o');
const outputPath = outputFlagIndex >= 0 ? args[outputFlagIndex + 1] : undefined;
const response = 'Talon smoke OK: terminal round-trip reached fake codex provider.';

if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${response}\n`, 'utf8');
}

process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'smoke-thread' })}\n`);
process.stdout.write(`${JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'assistant_message',
    content: [{ type: 'output_text', text: response }],
  },
})}\n`);
process.stdout.write(`${JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 9 },
})}\n`);
EOF
  chmod 700 "$SMOKE_DIR/fake-codex.mjs"

  cat > "$SMOKE_DIR/runtime-validation-system.md" <<'EOF'
---
description: Minimal runtime validation persona for local Talon smoke tests.
---

You are a Talon runtime validation persona used only for local smoke tests.
When a prompt asks you to reply exactly with a phrase, reply with only that phrase.
EOF

  cat > "$SMOKE_DIR/talond-smoke.yaml" <<EOF
dataDir: .codex/talon-smoke/data

storage:
  type: sqlite
  path: .codex/talon-smoke/data/talond.sqlite

channels:
  - type: terminal
    name: smoke-terminal
    enabled: true
    config:
      host: 127.0.0.1
      port: 17700
      token: smoke-terminal-token

personas:
  - name: smoke
    model: smoke-model
    provider: codex-cli
    systemPromptFile: .codex/talon-smoke/runtime-validation-system.md
    skills: []
    subagents: []
    capabilities:
      allow:
        - channel.send:terminal
        - memory.access:*
    maxConcurrent: 1

bindings:
  - persona: smoke
    channel: smoke-terminal
    isDefault: true

ipc:
  pollIntervalMs: 250
  daemonSocketDir: .codex/talon-smoke/data/ipc/daemon

queue:
  maxAttempts: 1
  backoffBaseMs: 250
  backoffMaxMs: 1000
  concurrencyLimit: 1

agentRunner:
  defaultProvider: codex-cli
  providers:
    codex-cli:
      enabled: true
      command: $SMOKE_DIR/fake-codex.mjs
      contextWindowTokens: 100000
      contextManagement:
        enabled: false
      options:
        defaultModel: smoke-model

backgroundAgent:
  enabled: false
  maxConcurrent: 1
  defaultTimeoutMinutes: 30
  defaultProvider: codex-cli
  providers:
    codex-cli:
      enabled: true
      command: $SMOKE_DIR/fake-codex.mjs
      contextWindowTokens: 100000
      options:
        defaultModel: smoke-model

scheduler:
  tickIntervalMs: 1000

logLevel: info
EOF

  cat > "$SMOKE_DIR/talond-live-codex.yaml" <<'EOF'
dataDir: .codex/talon-smoke/live-data

storage:
  type: sqlite
  path: .codex/talon-smoke/live-data/talond.sqlite

channels:
  - type: terminal
    name: live-terminal
    enabled: true
    config:
      host: 127.0.0.1
      port: 17701
      token: live-terminal-token

personas:
  - name: live
    model: ""
    provider: codex-cli
    systemPromptFile: .codex/talon-smoke/runtime-validation-system.md
    skills: []
    subagents: []
    capabilities:
      allow:
        - channel.send:terminal
        - memory.access:*
    maxConcurrent: 1

bindings:
  - persona: live
    channel: live-terminal
    isDefault: true

ipc:
  pollIntervalMs: 250
  daemonSocketDir: .codex/talon-smoke/live-data/ipc/daemon

queue:
  maxAttempts: 1
  backoffBaseMs: 250
  backoffMaxMs: 1000
  concurrencyLimit: 1

agentRunner:
  defaultProvider: codex-cli
  providers:
    codex-cli:
      enabled: true
      command: codex
      contextWindowTokens: 100000
      contextManagement:
        enabled: false

backgroundAgent:
  enabled: false
  maxConcurrent: 1
  defaultTimeoutMinutes: 30
  defaultProvider: codex-cli
  providers:
    codex-cli:
      enabled: true
      command: codex
      contextWindowTokens: 100000

scheduler:
  tickIntervalMs: 1000

logLevel: info
EOF
}

mode_config() {
  case "$1" in
    fake)
      CONFIG="$SMOKE_DIR/talond-smoke.yaml"
      DATA_DIR="$SMOKE_DIR/data"
      PORT="17700"
      TOKEN="smoke-terminal-token"
      CLIENT_ID="codex-smoke"
      PERSONA="smoke"
      PROMPT="smoke test from run-talon-smoke"
      EXPECTED="Talon smoke OK: terminal round-trip reached fake codex provider."
      TIMEOUT_MS="60000"
      ;;
    live)
      CONFIG="$SMOKE_DIR/talond-live-codex.yaml"
      DATA_DIR="$SMOKE_DIR/live-data"
      PORT="17701"
      TOKEN="live-terminal-token"
      CLIENT_ID="codex-live-smoke"
      PERSONA="live"
      PROMPT="Reply exactly: TALON LIVE OK"
      EXPECTED="TALON LIVE OK"
      TIMEOUT_MS="180000"
      ;;
  esac
  IPC_DIR="$DATA_DIR/ipc/daemon"
  DB_PATH="$DATA_DIR/talond.sqlite"
  LOG_PATH="$DATA_DIR/talond.log"
}

ensure_dirs() {
  mkdir -p "$DATA_DIR/threads" "$DATA_DIR/backups" "$IPC_DIR"
}

doctor() {
  local log
  log="$(mktemp)"
  if (cd "$ROOT_DIR" && npm run talonctl -- doctor --config "$CONFIG") 2>&1 | tee "$log"; then
    rm -f "$log"
    return 0
  fi

  if grep -Eqi 'better-sqlite3|bindings file|Could not locate the bindings file' "$log"; then
    echo "doctor detected a missing better-sqlite3 native binding; rebuilding sqlite"
    (cd "$ROOT_DIR" && run npm run rebuild:sqlite)
    rm -f "$log"
    (cd "$ROOT_DIR" && run npm run talonctl -- doctor --config "$CONFIG")
    return 0
  fi

  rm -f "$log"
  return 1
}

process_matches_smoke() {
  local pid="$1"
  local command_line
  local relative_config="${CONFIG#"$ROOT_DIR/"}"
  local relative_smoke_dir="${SMOKE_DIR#"$ROOT_DIR/"}"
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"

  [[ -n "$command_line" ]] && {
    [[ "$command_line" == *"$CONFIG"* ]] \
      || [[ "$command_line" == *"$relative_config"* ]] \
      || [[ "$command_line" == *"$SMOKE_DIR"* ]] \
      || [[ "$command_line" == *"$relative_smoke_dir"* ]]
  }
}

stop_mode() {
  local quiet="${1:-0}"
  local pid_file="$DATA_DIR/talond.pid"
  local wrapper_pid_file="$DATA_DIR/smoke-process.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      if process_matches_smoke "$pid"; then
        [[ "$quiet" == "1" ]] || echo "Stopping smoke daemon pid $pid"
        kill -INT "$pid" 2>/dev/null || true
        for _ in $(seq 1 50); do
          kill -0 "$pid" 2>/dev/null || break
          sleep 0.1
        done
        if kill -0 "$pid" 2>/dev/null; then
          kill "$pid" 2>/dev/null || true
        fi
      else
        [[ "$quiet" == "1" ]] || echo "Ignoring stale smoke daemon pid file for unrelated pid $pid"
      fi
    fi
    rm -f "$pid_file"
  fi
  if [[ -f "$wrapper_pid_file" ]]; then
    local wrapper_pid
    wrapper_pid="$(cat "$wrapper_pid_file")"
    if [[ -n "$wrapper_pid" ]] && kill -0 "$wrapper_pid" 2>/dev/null; then
      if process_matches_smoke "$wrapper_pid"; then
        kill -INT "$wrapper_pid" 2>/dev/null || true
        for _ in $(seq 1 20); do
          kill -0 "$wrapper_pid" 2>/dev/null || break
          sleep 0.1
        done
        if kill -0 "$wrapper_pid" 2>/dev/null; then
          kill "$wrapper_pid" 2>/dev/null || true
        fi
      else
        [[ "$quiet" == "1" ]] || echo "Ignoring stale smoke wrapper pid file for unrelated pid $wrapper_pid"
      fi
    fi
    rm -f "$wrapper_pid_file"
  fi
}

ensure_port_free() {
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $PORT is still in use; refusing to start smoke daemon." >&2
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
    exit 1
  fi
}

start_daemon() {
  stop_mode 1
  ensure_port_free
  rm -f "$LOG_PATH"
  echo "Starting talond for $MODE_NAME on 127.0.0.1:$PORT"
  (
    cd "$ROOT_DIR"
    nohup npm run talond -- --config "$CONFIG" --env-file "$SMOKE_DIR/empty.env" >"$LOG_PATH" 2>&1 &
    echo "$!" > "$DATA_DIR/smoke-process.pid"
  )
  DAEMON_PID="$(cat "$DATA_DIR/smoke-process.pid")"

  for _ in $(seq 1 100); do
    if node -e "const net=require('node:net'); const s=net.connect($PORT,'127.0.0.1'); s.on('connect',()=>{s.destroy(); process.exit(0)}); s.on('error',()=>process.exit(1)); setTimeout(()=>process.exit(1),250);" >/dev/null 2>&1; then
      echo "talond is listening on 127.0.0.1:$PORT"
      return 0
    fi
    if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
      echo "talond exited before listening. Log:" >&2
      sed -n '1,200p' "$LOG_PATH" >&2 || true
      exit 1
    fi
    sleep 0.2
  done

  echo "Timed out waiting for talond on 127.0.0.1:$PORT. Log:" >&2
  sed -n '1,200p' "$LOG_PATH" >&2 || true
  exit 1
}

print_chat_command() {
  cat <<EOF
Foreground daemon command:
  rtk npm run talond -- --config ${CONFIG#"$ROOT_DIR/"} --env-file ${SMOKE_DIR#"$ROOT_DIR/"}/empty.env

Manual terminal client command:
  rtk proxy npm run talonctl -- chat --host 127.0.0.1 --port $PORT --token $TOKEN --client-id $CLIENT_ID --persona $PERSONA

Send:
  $PROMPT

Expected response:
  $EXPECTED

Cleanup:
  rtk bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh $MODE_NAME --stop
EOF
}

direct_websocket_check() {
  echo "Running direct WebSocket check for $MODE_NAME"
  SMOKE_PORT="$PORT" \
  SMOKE_TOKEN="$TOKEN" \
  SMOKE_CLIENT_ID="$CLIENT_ID-direct" \
  SMOKE_PERSONA="$PERSONA" \
  SMOKE_PROMPT="$PROMPT" \
  SMOKE_EXPECTED="$EXPECTED" \
  SMOKE_TIMEOUT_MS="$TIMEOUT_MS" \
    node --input-type=module <<'NODE'
import WebSocket from 'ws';

const port = process.env.SMOKE_PORT;
const token = process.env.SMOKE_TOKEN;
const clientId = process.env.SMOKE_CLIENT_ID;
const persona = process.env.SMOKE_PERSONA;
const prompt = process.env.SMOKE_PROMPT;
const expected = process.env.SMOKE_EXPECTED;
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? '60000');

const ws = new WebSocket(`ws://127.0.0.1:${port}`);
let done = false;

const fail = (message) => {
  if (done) return;
  done = true;
  try { ws.close(); } catch {}
  console.error(message);
  process.exit(1);
};

const timer = setTimeout(() => fail(`timed out waiting for response after ${timeoutMs}ms`), timeoutMs);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth', token, clientId, persona }));
});

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    fail(`received malformed JSON: ${String(raw)}`);
    return;
  }

  if (msg.type === 'auth_ok') {
    ws.send(JSON.stringify({ type: 'message', content: prompt }));
    return;
  }

  if (msg.type === 'typing') {
    return;
  }

  if (msg.type === 'response') {
    const body = String(msg.body ?? '').trim();
    if (body !== expected) {
      fail(`unexpected response: ${JSON.stringify(body)}; expected ${JSON.stringify(expected)}`);
      return;
    }
    done = true;
    clearTimeout(timer);
    console.log(`response ok: ${body}`);
    ws.close();
    return;
  }

  if (msg.type === 'auth_error' || msg.type === 'error') {
    fail(`server error: ${JSON.stringify(msg)}`);
  }
});

ws.on('error', (error) => fail(`websocket error: ${error.message}`));
ws.on('close', () => {
  if (!done) {
    fail('websocket closed before smoke response');
  }
});
NODE
}

print_status() {
  echo "talonctl status for $MODE_NAME"
  (cd "$ROOT_DIR" && npm run talonctl -- status --ipc-dir "$IPC_DIR" --timeout 5000) || true

  if [[ -f "$DB_PATH" ]]; then
    DB_PATH="$DB_PATH" node <<'NODE'
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH, { readonly: true });
for (const table of ['channels', 'personas', 'threads', 'messages', 'queue_items', 'runs']) {
  const row = db.prepare(`select count(*) as c from ${table}`).get();
  console.log(`${table}: ${row.c}`);
}
const outbound = db
  .prepare("select content from messages where direction = 'outbound' order by created_at desc limit 1")
  .get();
console.log(`last outbound: ${outbound ? outbound.content : '(none)'}`);
const run = db
  .prepare('select status,input_tokens,output_tokens,provider_name,error from runs order by created_at desc limit 1')
  .get();
console.log(`last run: ${run ? JSON.stringify(run) : '(none)'}`);
db.close();
NODE
  else
    echo "database not found: $DB_PATH"
  fi
}

run_one_mode() {
  MODE_NAME="$1"
  mode_config "$MODE_NAME"
  ensure_dirs

  if [[ "$STOP_ONLY" == "1" ]]; then
    stop_mode 0
    return
  fi

  if [[ "$STATUS_ONLY" == "1" ]]; then
    print_status
    return
  fi

  if [[ "$BUILD_ONCE" == "1" ]]; then
    (cd "$ROOT_DIR" && run npm run build)
    BUILD_ONCE=0
  fi

  doctor

  if [[ "$PREPARE_ONLY" == "1" ]]; then
    print_chat_command
    return
  fi

  start_daemon

  trap 'stop_mode 1' EXIT
  direct_websocket_check
  print_status
  stop_mode 0
  trap - EXIT
}

cd "$ROOT_DIR"
write_harness

if [[ "$MODE" == "both" ]]; then
  run_one_mode fake
  run_one_mode live
else
  run_one_mode "$MODE"
fi
