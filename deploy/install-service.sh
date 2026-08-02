#!/usr/bin/env bash
#
# Install talond as a systemd service.
#
# Usage:
#   sudo ./deploy/install-service.sh [--user talon] [--dir /home/talon/talon] [--codex-runner]
#
# Generates a systemd unit from the template, installs it, and enables it.
# Does NOT start the service — run `sudo systemctl start talond` when ready.

set -euo pipefail

TALON_USER="talon"
TALON_DIR=""
NODE_BIN="$(which node 2>/dev/null || echo '/usr/bin/node')"
SERVICE_NAME="talond"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
CODEX_RUNNER_SERVICE_NAME="talon-codex-runner"
CODEX_RUNNER_UNIT_FILE="/etc/systemd/system/${CODEX_RUNNER_SERVICE_NAME}.service"
CODEX_RUNNER_DROPIN_DIR="/etc/systemd/system/${SERVICE_NAME}.service.d"
CODEX_RUNNER_DROPIN_FILE="${CODEX_RUNNER_DROPIN_DIR}/codex-runner.conf"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/talond.service"
CODEX_RUNNER_TEMPLATE="${SCRIPT_DIR}/talon-codex-runner.service"
CODEX_RUNNER_DROPIN_TEMPLATE="${SCRIPT_DIR}/talond-codex-runner.conf"
INSTALL_CODEX_RUNNER=false

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) TALON_USER="$2"; shift 2 ;;
    --dir)  TALON_DIR="$2"; shift 2 ;;
    --codex-runner) INSTALL_CODEX_RUNNER=true; shift ;;
    *)      shift ;;
  esac
done

if [[ -z "$TALON_DIR" ]]; then
  TALON_DIR="/home/${TALON_USER}/talon"
fi

# Verify running as root
if [[ $EUID -ne 0 ]]; then
  echo "error: must run as root (use sudo)" >&2
  exit 1
fi

# Verify user exists
if ! id "$TALON_USER" &>/dev/null; then
  echo "error: user '$TALON_USER' does not exist" >&2
  exit 1
fi

# Verify talon directory
if [[ ! -d "$TALON_DIR" ]]; then
  echo "error: directory '$TALON_DIR' does not exist" >&2
  exit 1
fi

if [[ ! -f "$TALON_DIR/dist/index.js" ]]; then
  echo "error: '$TALON_DIR/dist/index.js' not found — run 'npm run build' first" >&2
  exit 1
fi

# Verify node
if [[ ! -x "$NODE_BIN" ]]; then
  echo "error: node not found at '$NODE_BIN'" >&2
  exit 1
fi

if [[ "$INSTALL_CODEX_RUNNER" == true ]]; then
  DOCKER_BIN="$(command -v docker 2>/dev/null || true)"
  if [[ -z "$DOCKER_BIN" ]]; then
    echo "error: --codex-runner requires Docker with Docker Compose v2" >&2
    exit 1
  fi
  if ! "$DOCKER_BIN" compose version >/dev/null 2>&1; then
    echo "error: --codex-runner requires Docker Compose v2" >&2
    exit 1
  fi
fi

echo "Installing ${SERVICE_NAME} service..."
echo "  User:  ${TALON_USER}"
echo "  Dir:   ${TALON_DIR}"
echo "  Node:  ${NODE_BIN}"

# Generate unit file from template with substitutions
sed \
  -e "s|WorkingDirectory=.*|WorkingDirectory=${TALON_DIR}|" \
  -e "s|ExecStart=.*|ExecStart=${NODE_BIN} dist/index.js --config talond.yaml|" \
  -e "s|EnvironmentFile=.*|EnvironmentFile=-${TALON_DIR}/.env|" \
  -e "s|User=.*|User=${TALON_USER}|" \
  -e "s|Group=.*|Group=${TALON_USER}|" \
  "$TEMPLATE" > "$UNIT_FILE"

chmod 644 "$UNIT_FILE"

if [[ "$INSTALL_CODEX_RUNNER" == true ]]; then
  if [[ ! -f "$CODEX_RUNNER_TEMPLATE" || ! -f "$CODEX_RUNNER_DROPIN_TEMPLATE" ]]; then
    echo "error: Codex runner service templates are missing from deploy/" >&2
    exit 1
  fi

  sed \
    -e "s|WorkingDirectory=.*|WorkingDirectory=${TALON_DIR}|" \
    -e "s|EnvironmentFile=.*|EnvironmentFile=-${TALON_DIR}/.env|" \
    -e "s|Environment=TALON_ENV_FILE=.*|Environment=TALON_ENV_FILE=${TALON_DIR}/.env|" \
    -e "s|ExecStart=.*|ExecStart=${DOCKER_BIN} compose -f ${TALON_DIR}/deploy/docker-compose.yaml -f ${TALON_DIR}/deploy/docker-compose.native-runner.yaml --profile codex-sandbox up -d codex-runner|" \
    -e "s|ExecStop=.*|ExecStop=${DOCKER_BIN} compose -f ${TALON_DIR}/deploy/docker-compose.yaml -f ${TALON_DIR}/deploy/docker-compose.native-runner.yaml --profile codex-sandbox stop codex-runner|" \
    "$CODEX_RUNNER_TEMPLATE" > "$CODEX_RUNNER_UNIT_FILE"
  chmod 644 "$CODEX_RUNNER_UNIT_FILE"

  install -d -m 755 "$CODEX_RUNNER_DROPIN_DIR"
  install -m 644 "$CODEX_RUNNER_DROPIN_TEMPLATE" "$CODEX_RUNNER_DROPIN_FILE"
fi

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"

echo ""
echo "Service installed and enabled."
echo ""
echo "  Start:   sudo systemctl start ${SERVICE_NAME}"
echo "  Status:  sudo systemctl status ${SERVICE_NAME}"
echo "  Logs:    journalctl -u ${SERVICE_NAME} -f"
echo "  Stop:    sudo systemctl stop ${SERVICE_NAME}"
echo "  Disable: sudo systemctl disable ${SERVICE_NAME}"

if [[ "$INSTALL_CODEX_RUNNER" == true ]]; then
  echo ""
  echo "Codex runner dependency installed. Complete its one-time dedicated login before starting talond:"
  echo "  sudo systemctl start ${CODEX_RUNNER_SERVICE_NAME}"
  echo "  sudo ${DOCKER_BIN} compose -f ${TALON_DIR}/deploy/docker-compose.yaml -f ${TALON_DIR}/deploy/docker-compose.native-runner.yaml --profile codex-sandbox exec -e CODEX_HOME=/auth codex-runner codex login"
  echo ""
  echo "After login, starting talond will start the runner first on every boot."
fi
