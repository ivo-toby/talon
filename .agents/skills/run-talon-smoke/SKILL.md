---
name: run-talon-smoke
description: Run Talon local runtime smoke tests by booting talond with disposable ignored configs, validating Node/better-sqlite3, exercising the terminal channel with talonctl chat, and optionally using the live authenticated codex-cli provider. Use when the user asks for a real-life Talon smoke test, terminal client sanity check, daemon boot/connect verification, local runtime validation, or proof that Talon can receive and answer a terminal message.
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
