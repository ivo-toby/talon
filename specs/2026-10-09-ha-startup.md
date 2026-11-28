# Home Assistant startup regression (1.0.10)

## Problem and evidence

The reported 1.0.9 daemon and terminal are running, but Supervisor remains in
`startup` and does not expose the terminal UI. Both add-on Dockerfiles contain
`HEALTHCHECK NONE`. Docker serializes that as `Config.Healthcheck.Test=["NONE"]`.
Supervisor treats the nonempty healthcheck object as true when handling a
running container, so it waits for a health event that a disabled check cannot
produce. Daemon `READY` logging is not a Supervisor readiness signal.

Reference inspected: home-assistant/supervisor commit
`01b32d6d31125425260638f768980d35659c4874`,
`supervisor/apps/app.py` (`_derive_state`) and
`supervisor/docker/interface.py` (`healthcheck`). The deployed Supervisor
version/container metadata still need confirmation; do not equate source
analysis or Docker smoke tests with verification on the user's HA installation.

## Intended behavior and scope

Remove the explicit disabled Docker healthcheck from both node-based images.
The base image must have no inherited check (verify the built image, fail if
that assumption changes). Supervisor can then classify Docker `running` as
`started`; the recovery terminal remains available independently of daemon
configuration/provider authentication. Release add-on 1.0.10.

Preserve the gateway-only proxy on 7681, loopback-only ttyd on 7682, unprivileged
terminal/daemon, private storage and current start/stop behavior. Do not add
network privileges, publish terminal ports, admit other add-ons, or require an
OpenAI API key. No changes to main or upstream PRs #288–#291, no deployment,
no deletion/migration of existing configuration or databases.

## Acceptance criteria and verification plan

1. Reproduce the `NONE` metadata trap; the actual HA-context image has no
   `Config.Healthcheck`, and container `running` requires no health event.
2. Build `talon-haos/Dockerfile` with context `talon-haos/` for linux/amd64,
   inspect version 1.0.10 and run that exact image (not only Dockerfile.source).
3. A Docker ingress fixture with source IP 172.30.32.2 can fetch ttyd HTML and
   establish a tty WebSocket; another peer is denied, even with spoofed headers.
   These tests simulate ingress transport, not HA login/session validation.
4. Fresh empty options start the daemon without an API key; the generated YAML
   and a SQLite sentinel survive a restart of the same image. This checks restart
   persistence, not an upgrade of a user's pre-existing installation. Recovery terminal remains usable
   if the daemon cannot start. Relevant Codex CLI tests still pass.
5. Real HA validation requires read-only access to the target: record Supervisor
   version, add-on version/state, relevant container metadata and an authenticated
   ingress HTTP/WebSocket session. Never deploy automatically; if the fixed
   version is not installed by the operator, report this criterion unverified.

## Edge cases

Disabled versus missing healthchecks are distinct Docker configurations.
Listening sockets and log lines alone are not proof of an interactive terminal.
An unauthenticated Codex CLI may prevent AI requests, but must not prevent
management access. Proxy rejection must happen before reaching ttyd. Existing
workspaces and legacy state must remain authoritative across upgrades.

## Results

- Local regression: both Dockerfile assertions failed before the fix; all four
  add-on Node tests pass after it. Shell, JavaScript and Python syntax checks pass.
- Executed the pinned upstream Supervisor state method with stub model inputs:
  disabled metadata returns STARTUP; absent metadata returns STARTED.
- Independent GPT-6-sol review found an overbroad persistence claim; narrowed
  criterion 4 to the actual restart test. Upgrade preservation on user data is
  unverified. Runtime scripts and storage behavior are unchanged.
- CI [run 37858190197](https://github.com/lukkezen/talon/actions/runs/37858190197)
  on implementation/test commit `a40758524ce0607f194dd20ba78b268adf043062`:
  - Criterion 1 passed: built image has no healthcheck; a derived image with
    `HEALTHCHECK NONE` has `Test: ["NONE"]` while running without `State.Health`.
    The pinned upstream method returns STARTUP for that image and STARTED for
    the fixed image. This executes a state method with stub inputs, not Supervisor.
  - Criterion 2 passed: actual `talon-haos/` build context, linux/amd64 image,
    version label 1.0.10; built, loaded into Docker, and run successfully.
    Image ID/config digest:
    `sha256:8bbfb4597a2cb957fabbb63c8019e2953821e3c1d30071a9ea3f4b8438f9e4fd`.
    Manifest digest:
    `sha256:36b2ee7659b63269779eba95726996502a30c3f7739660e7d8dc6d88d8c561d0`.
    The separate `Dockerfile.source` build also passed. Neither image was published.
  - Criterion 3 passed: HTTP 200 and interactive tty WebSocket from 172.30.32.2,
    shell-generated output and `id -un` confirm execution as `talond`. Peer
    172.30.32.11 was denied on both ports, including spoofed forwarding headers.
  - Criterion 4 passed within its stated scope: empty options bootstrap Codex CLI
    and start talond without an API key; YAML content matches its pre-restart
    value and a SQLite sentinel survives restart. Malformed fixture YAML
    leaves an interactive recovery terminal. No live Codex account/API call used.
  - 122 targeted Vitest tests passed (including 32 Codex CLI provider tests),
    as did all 4 add-on Node tests and shell/JavaScript syntax checks.
  - The full existing suite: 3507 passed, 68 skipped, 1 failed, across 186 files.
    Failure: `tests/unit/tools/background-agent.test.ts:186`, expecting expanded
    `PERPLEXITY_API_KEY` instead of the literal environment reference. The same
    failure is present in baseline 1.0.9
    [run 37851868613](https://github.com/lukkezen/talon/actions/runs/37851868613).
    It was not changed or suppressed by this fix; the overall workflow remains red.
- The first image build passed but its new smoke harness failed because the
  runner's Python 3.12 could not parse unrelated Python 3.14 syntax in upstream
  Supervisor. Extracting the pinned method before parsing fixed the harness;
  the successful run above includes the correction.
- Criterion 5 remains unverified: no target HA address/access or deployed
  Supervisor version was supplied, and no automatic deployment is allowed.
  Real authenticated HA ingress, target `started` state, and preservation of
  the user's existing data across an actual upgrade remain operator checks.
  See `talon-haos/DOCS.md#startup-verification`. Do not describe this as a verified
  fix on the user's Home Assistant installation.
