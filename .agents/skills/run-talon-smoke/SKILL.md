---
name: run-talon-smoke
description: Run Talon local runtime smoke tests by booting talond with disposable ignored configs, validating Node/better-sqlite3, exercising the terminal channel with talonctl chat, optionally using the live authenticated codex-cli provider, and running the no-cost packaged Signal fake smoke and Signal deliverable gate. Use when the user asks for a real-life Talon smoke test, terminal client sanity check, daemon boot/connect verification, local runtime validation, proof that Talon can receive and answer a terminal message, or the Signal fake/live check.
---

# Run Talon Smoke

Use this skill to prove that Talon runs locally and the terminal client can
communicate with the daemon. Prefer the live `codex-cli` path when the user asks
for a real-life smoke test. Use the fake provider path when the user asks for a
no-cost or deterministic smoke test.

## Quick Decision

- Real-life smoke: use `live`.
- No-cost smoke: use `fake`.
- Broad validation: use `both`, then still do a manual `talonctl chat` check for
  `live` if the user specifically asked for terminal client proof.

## Fake vs real smoke

The fake and real paths prove different things. Do not report one as the other.

| | Fake (no cost, deterministic) | Real (live) |
| --- | --- | --- |
| Provider | Local fake `codex-cli` script that prints a fixed reply and counts invocations | Authenticated `codex-cli` / real model |
| Terminal channel | `run-talon-smoke.sh fake` (fixed port 17700) | `run-talon-smoke.sh live` (fixed port 17701) |
| Signal channel | `tests/smoke/signal-channel-smoke.mjs`: packaged `dist/index.js` against a private Unix-socket fake signal-cli bridge pinned to v0.14.9 wire shapes | A linked or dedicated Signal account on a real device (manual, below) |
| Proves | Boot, config, routing, admission/exclusion, one provider run per admitted input, chunked replies, deferral, rollback/retry, crash/reload recovery, reconnect, cleanup | Real provenance, echoes, delivery, relink and offline behaviour |
| Oracle | Existing terminal smoke, plus frozen upstream wire conformance (`signal-deliverable-conformance.test.ts`) | Observed device behaviour only |

The fake path never proves real account behaviour. Real-device evidence for Signal
(AC-15) is missing until the live recipe below is run by a human with accounts.

## Signal deliverable gate (fake)

```bash
npm run build && bash .agents/skills/run-talon-smoke/scripts/verify-signal-deliverable.sh --no-build
```

The gate fails if a listed test file is missing, runs only the focused Vitest paths
named in the Signal design's Integration table (no full suite), fails if the focused
tests change `starter/` or `starter-stack/` (the starter-bundle test syncs before it
compares, so a clean tree is checked separately), runs `node dist/cli/index.js --help`,
runs the existing fake terminal smoke under
`flock /tmp/talon-wdd-terminal-smoke.lock`, runs the packaged Signal fake smoke, and
prints an AC map that also lists what is only covered by unit tests.

The Signal fake smoke runs eleven scenarios concurrently against the built daemon, each
with its own private root, fake bridge, fake provider and SQLite file: dedicated and
personal modes, stale device setup refused, ACI-only account, ingress rollback/retry under
a held SQLite write lock, four delivery deferrals with maxAttempts 3, a rate limit on chunk 3 of a
long reply resumed from the saved cursor, chunk contiguity and other-group fairness, SIGKILL mid-chunk with restart, SIGHUP during an active send, and
proof expiry quarantine under `listDevices` failures. The wire shapes come from one
fixture module (`scripts/signal-wire-fixtures.mjs`), which the conformance test parses
through the production parser and inbound policy. The socket lives under a private
directory in `~/.cache` (never `/tmp`, which fails the connector's socket-ancestry
check). The harness stops every daemon process group, bridge and socket and removes its
root on success, failure, SIGINT, SIGTERM and uncaught errors, then verifies that they
are gone. Pass scenario names to run a subset, for example
`node tests/smoke/signal-channel-smoke.mjs personal deferrals`. Set `SIGNAL_SMOKE_KEEP=1`
to keep disposable state for debugging.

The smoke takes about seven minutes: the proof-expiry scenario waits out the fixed 300 s
proof TTL, and restarts wait for the one-device-check-per-60-seconds budget. The deferral
scenario fast-forwards the persisted rate-limit pause (at least 15 minutes) by updating
the disposable SQLite file between rounds.

## Live Signal check (recipe, not executed)

This recipe has not been run. It needs a real Signal account and a real device, and
it may send real messages. Do not claim it passed unless a human ran it and recorded
the redacted evidence. The pending AC-15 gate and its status are in
`.wdd/epics/signal-channel/research/live-validation-pending.md` (a WDD epic artifact) and
the operator reference `docs/signal-channel.md` (its "Status and evidence" section; it ships
on `wdd/signal-channel` and may be absent on older bases).

Scope gaps against AC-15: this recipe does not cover both account modes end to end,
groups, long replies and chunking, relink, or offline/reconnect limits, and it does not
record the freshness-rule or self-target metadata observations. AC-15 stays open until a
human extends and runs it for those.

1. Stop any daemon using the Signal config. Keep the account's primary device linked.
2. Run `talonctl` setup for the chosen account mode (`personal` or `dedicated`). For
   personal mode, record the bridge device ID shown by the standalone CLI while the
   bridge is stopped. Do not read account keys.
3. Start the daemon in the foreground with a real config that uses the live bridge
   socket and a fake or cheap provider.
4. From a selected DM, send `!talon live check 1`. Expect one reply in the same chat.
5. From Note to Self (personal mode), send plain text. Expect one reply. Confirm the
   bridge's own reply does not start another run.
6. Send a message from an unselected chat or unselected sender. Expect no run.
7. Restart the bridge, wait up to 90 seconds, then send one more command. Expect one reply.
8. Stop the daemon. Verify no listeners or sockets remain.
9. Record counts only: provider runs, chats replied, and any excluded inputs. Do not
   record message text, identifiers, phone numbers or challenge tokens.

## Workflow

1. Confirm the current branch and working directory.

```bash
rtk git status --short --branch
```

2. Prepare the selected smoke harness and run `doctor`.

```bash
rtk bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh live --prepare
```

For the no-cost path, replace `live` with `fake`.

3. Start the selected daemon as a foreground long-running process in its own
   exec session. Keep that session open while testing.

```bash
rtk npm run talond -- --config .codex/talon-smoke/talond-live-codex.yaml --env-file .codex/talon-smoke/empty.env
```

For fake mode:

```bash
rtk npm run talond -- --config .codex/talon-smoke/talond-smoke.yaml --env-file .codex/talon-smoke/empty.env
```

4. Connect with the real terminal client in a PTY.

```bash
rtk proxy npm run talonctl -- chat --host 127.0.0.1 --port 17701 --token live-terminal-token --client-id codex-live-smoke --persona live
```

For fake mode:

```bash
rtk proxy npm run talonctl -- chat --host 127.0.0.1 --port 17700 --token smoke-terminal-token --client-id codex-smoke --persona smoke
```

5. Send the smoke prompt through the interactive terminal session.

Live prompt:

```text
Reply exactly: TALON LIVE OK
```

Expected live response:

```text
TALON LIVE OK
```

Fake prompt can be any short message. Expected fake response:

```text
Talon smoke OK: terminal round-trip reached fake codex provider.
```

6. Collect evidence before stopping the daemon.

```bash
rtk bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh live --status
```

Use `fake --status` for the fake path.

7. Stop the terminal client with Ctrl+C, then stop the foreground daemon session
   with Ctrl+C. If a smoke daemon is still running, stop it with:

```bash
rtk bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh live --stop
```

8. Verify no listeners remain.

```bash
rtk lsof -nP -iTCP:17700 -sTCP:LISTEN
rtk lsof -nP -iTCP:17701 -sTCP:LISTEN
```

No output and exit code 1 from `lsof` means the port is clear.

## Helper Script

The helper script recreates ignored smoke files under `.codex/talon-smoke` if
they are missing, creates disposable data directories, runs `npm run build`,
runs `talonctl doctor`, and retries doctor after `npm run rebuild:sqlite` when
the failure looks like a missing Node 24 `better-sqlite3` binding.

Useful commands:

```bash
# Prepare files, build, run doctor, and print the foreground daemon/chat commands.
rtk bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh live --prepare

# Run an automated direct WebSocket check. This proves daemon/channel/provider,
# but it does not exercise the talonctl chat client.
rtk bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh live

# Stop any smoke daemon for a mode.
rtk bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh live --stop
```

## Reporting

Report these facts:

- branch and working directory
- mode used: `fake`, `live`, or `both`
- whether `npm run rebuild:sqlite` was needed
- `talonctl doctor` result
- terminal client auth result
- exact prompt and response
- DB evidence: thread/message/queue/run counts and last outbound body
- whether the daemon and chat client were stopped
- any remaining gaps, especially if the automated WebSocket fallback was used
  instead of `talonctl chat`
