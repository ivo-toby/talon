#!/usr/bin/env bash
# talonctl-docker.sh — Run talonctl commands against the containerized daemon.
#
# Usage:
#   ./deploy/talonctl-docker.sh status
#   ./deploy/talonctl-docker.sh reload
#   ./deploy/talonctl-docker.sh list-channels
#
# This is a thin wrapper around `docker exec` that forwards arguments to the
# talonctl CLI inside the running talond container.

set -euo pipefail

CONTAINER="${TALOND_CONTAINER:-talond}"

if ! docker inspect "$CONTAINER" &>/dev/null; then
  echo "Error: container '$CONTAINER' not found. Is the daemon running?" >&2
  exit 1
fi

exec docker exec -it "$CONTAINER" node dist/cli/index.js "$@"
