#!/usr/bin/env bash
# Focused Signal deliverable gate. Not the full suite: it runs only the test files named in the
# Signal design's Integration surfaces table, the packaged CLI help, the serialized existing
# fake terminal smoke, and the packaged Signal fake smoke. Prints each stage and an AC map.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
BUILD=1

usage() {
  cat <<'USAGE'
Usage:
  verify-signal-deliverable.sh [--no-build]

  --no-build  Skip npm run build (run it first yourself: npm run build && ... --no-build).
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

cd "$ROOT_DIR"

# Every path the design's Integration surfaces table names for Signal, plus the conformance test.
FOCUSED_PATHS=(
  tests/unit/channels/connectors/signal
  tests/unit/channels/connectors/signal/signal-deliverable-conformance.test.ts
  tests/unit/core/database/transaction.test.ts
  tests/unit/pipeline/message-pipeline.test.ts
  tests/unit/core/database/repositories/signal-account-state-repository.test.ts
  tests/unit/core/database/repositories/signal-destination-lease-repository.test.ts
  tests/unit/core/database/repositories/queue-repository.test.ts
  tests/unit/core/config/config-schema.test.ts
  tests/unit/daemon/channel-factory.test.ts
  tests/unit/channels/channel-setup.test.ts
  tests/unit/core/errors/error-types.test.ts
  tests/unit/daemon/agent-runner.test.ts
  tests/unit/daemon/signal-reply-delivery.test.ts
  tests/unit/daemon/signal-handler.test.ts
  tests/unit/daemon/signal-invocation-guard.test.ts
  tests/unit/queue/queue-processor.test.ts
  tests/unit/queue/dead-letter.test.ts
  tests/unit/queue/signal-delivery-checkpoint.test.ts
  tests/unit/daemon/reload.test.ts
  tests/unit/daemon/lifecycle.test.ts
  tests/unit/daemon/daemon.test.ts
  tests/unit/daemon/daemon-bootstrap.test.ts
  tests/unit/queue/queue-manager.test.ts
  tests/unit/cli/cli-registration.test.ts
  tests/unit/core/database/migrations/runner.test.ts
  tests/unit/tools/host-tools-bridge.test.ts
  tests/unit/cli/add-channel.test.ts
  tests/unit/cli/config-utils.test.ts
  tests/unit/cli/signal-resume.test.ts
  tests/unit/tools/host-tools/channel-send.test.ts
  tests/unit/tools/host-tools/channel-broadcast.test.ts
  tests/unit/tools/host-tools/channel-list.test.ts
  tests/unit/ipc/signal-resume.test.ts
  tests/unit/cli/status.test.ts
  tests/unit/cli/queue-purge.test.ts
  tests/unit/subagents/background/background-agent-manager.test.ts
  tests/unit/deploy/starter-bundle.test.ts
)

REQUIRED_FILES=(
  tests/smoke/signal-channel-smoke.mjs
  .agents/skills/run-talon-smoke/scripts/signal-wire-fixtures.mjs
  .agents/skills/run-talon-smoke/SKILL.md
  .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh
)

stage() {
  echo
  echo "== STAGE $1: $2"
}

stage 1 "required files present"
missing=0
for path in "${REQUIRED_FILES[@]}" "${FOCUSED_PATHS[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "MISSING: $path" >&2
    missing=$((missing + 1))
  fi
done
if [[ "$missing" -gt 0 ]]; then
  echo "FAILED: $missing required file(s) missing" >&2
  exit 1
fi
echo "all ${#FOCUSED_PATHS[@]} focused paths and ${#REQUIRED_FILES[@]} harness files present"

if [[ "$BUILD" == "1" ]]; then
  stage 2 "build"
  npm run build
else
  stage 2 "build skipped (--no-build)"
fi

stage 3 "focused Vitest (Signal Integration surfaces) and starter-sync cleanliness"
# starter-bundle.test.ts runs the starter sync before comparing, so on its own it passes by
# construction. The gate therefore fails closed: starter/ and starter-stack/ must be clean
# (committed) both BEFORE and AFTER the focused tests. Only paths are printed, never content.
require_clean_starter() {
  local when="$1" dirty
  dirty="$(git status --porcelain -- starter starter-stack)"
  if [[ -n "$dirty" ]]; then
    echo "FAILED: starter/ or starter-stack/ is not clean $when the focused tests (starter sync is not committed)." >&2
    echo "Dirty paths:" >&2
    printf '%s\n' "$dirty" | sed 's/^/  /' >&2
    echo "Commit the starter sync (or run: git checkout -- starter starter-stack) and re-run." >&2
    exit 1
  fi
  echo "starter/ and starter-stack/ are clean $when the focused tests"
}
require_clean_starter before
npx vitest run "${FOCUSED_PATHS[@]}"
require_clean_starter after

stage 4 "packaged CLI help"
node dist/cli/index.js --help >/dev/null
echo "dist/cli/index.js --help exited 0"

stage 5 "existing fake terminal smoke (serialized with flock)"
if ! command -v flock >/dev/null 2>&1; then
  echo "FAILED: flock is required to serialize the fixed-port terminal smoke" >&2
  exit 1
fi
flock /tmp/talon-wdd-terminal-smoke.lock bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build

stage 6 "packaged Signal fake smoke (dist/index.js, 11 concurrent scenarios, private Unix-socket bridges, fake provider; ~7 minutes because of the 300 s proof-expiry scenario)"
node tests/smoke/signal-channel-smoke.mjs

stage 7 "AC map"
cat <<'MAP'
AC-1   config/factory/setup ............ tests/unit/core/config/config-schema.test.ts,
                                          tests/unit/daemon/channel-factory.test.ts,
                                          tests/unit/channels/channel-setup.test.ts,
                                          tests/unit/cli/add-channel.test.ts,
                                          tests/unit/cli/config-utils.test.ts,
                                          tests/unit/cli/cli-registration.test.ts
                                          (named instances, duplicate ownership rejection)
AC-2   linking/dedicated setup ......... tests/unit/cli/add-channel.test.ts, tests/unit/cli/config-utils.test.ts
AC-3   Note to Self / self events ...... packaged smoke: personal (sync sentMessage destination=self,
                                          bridge-device echo), tests/unit/channels/connectors/signal/
AC-4   DM/group authorization .......... packaged smoke: dedicated (stranger, untriggered), personal group
                                          command, tests/unit/channels/connectors/signal/
AC-5   linked-device commands, echo .... packaged smoke: personal (sync DM/group command, echo),
                                          tests/unit/daemon/signal-reply-delivery.test.ts
AC-6   canonical routing ............... tests/unit/channels/connectors/signal/signal-target.test.ts
AC-7   control/ephemeral exclusion ..... tests/unit/channels/connectors/signal/signal-inbound-policy.test.ts
AC-8   send chunks/errors .............. packaged smoke: dedicated (long reply), chunk-fairness (5+ chunks,
                                          other-group fairness), chunk-resume (rate limit on chunk 3, saved cursor
                                          resumes at chunk 3), deferrals (4 rate-limit deferrals, maxAttempts 3),
                                          tests/unit/channels/connectors/signal/signal-send-coordinator.test.ts
AC-9   attachments refused ............. tests/unit/channels/connectors/signal/signal-text.test.ts
AC-10  lifecycle/reload/recovery ....... packaged smoke: dedicated/personal (bridge restart), active-reload (SIGHUP
                                          during send), crash-marker (SIGKILL mid-chunk, restart, no replay),
                                          proof-expiry (listDevices failures, budget, quarantine), stale-device (refused),
                                          tests/unit/daemon/reload.test.ts, lifecycle.test.ts, daemon.test.ts,
                                          daemon-bootstrap.test.ts, tests/unit/queue/queue-manager.test.ts
AC-11  ingress rollback/retry .......... packaged smoke: ingress-rollback (held SQLite write lock, one accepted turn),
                                          tests/unit/core/database/transaction.test.ts,
                                          tests/unit/pipeline/message-pipeline.test.ts
AC-12  send/list/broadcast/schedule .... tests/unit/tools/host-tools/channel-send.test.ts,
                                          tests/unit/tools/host-tools/channel-broadcast.test.ts,
                                          tests/unit/tools/host-tools/channel-list.test.ts,
                                          tests/unit/tools/host-tools-bridge.test.ts
AC-13  docs ............................ tests/unit/deploy/starter-bundle.test.ts plus the stage 3 check that the
                                          starter/ and starter-stack/ are clean before and after the tests (fail closed)
AC-14  focused tests ................... every path in stage 3
AC-15  real-device evidence ............ NOT covered by this fake gate; live evidence is recorded separately in docs/signal-channel.md
Wire   v0.14.9 fixtures ................ tests/unit/channels/connectors/signal/signal-deliverable-conformance.test.ts
                                          (shared fixture module signal-wire-fixtures.mjs parsed by the production parser/policy)

Packaged smoke scenarios NOT driven through dist/index.js (unit fallback only):
  - background notification without a run ID (needs a background-agent task): tests/unit/daemon/signal-reply-delivery.test.ts,
    tests/unit/subagents/background/background-agent-manager.test.ts, tests/unit/daemon/agent-runner.test.ts
  - failed Signal tool send explained on Telegram/healthy Signal, partial/ambiguous tool sends: needs model tool calls the
    fake CLI provider cannot make: tests/unit/tools/host-tools/channel-send.test.ts, channel-broadcast.test.ts
  - account pause survives restart, local resume IPC: tests/unit/ipc/signal-resume.test.ts,
    tests/unit/core/database/repositories/signal-account-state-repository.test.ts
MAP

echo
echo "verify-signal-deliverable: all stages passed (this fake gate does not cover AC-15; live evidence is recorded separately in docs/signal-channel.md)"
