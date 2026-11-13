# AC-15 real-device evidence

- Date: 2026-11-13
- Operator: Ivo (sent all test messages from real phones; a second person, "helper", assisted)
- Recorded by: Claude Opus 5.5 (WDD controller), from Talon's own SQLite rows and
  content-free daemon logs. No message text, phone numbers, full identifiers, link URIs,
  verification codes or challenge tokens are recorded here.

## Setup

- Host: Debian 13 VM (QEMU virtual CPU, x86-64-v2). The signal-cli GraalVM native build
  refused to run ("CPU ISA level is lower than required"); the JVM build was used.
- Bridge: signal-cli 0.14.9 JVM build (release tarball, GPG signature verified against
  AsamK key FA10 826A 7490 7F9E C6BB B7FC 2BA2 CD21 B5B0 9570) on Eclipse Temurin JRE
  25.0.5 (Adoptium checksum verified), installed under the operator's home directory.
- Bridge run: one multi-account `signal-cli daemon` (no `-a`), `--receive-mode=manual`,
  `--ignore-attachments --ignore-stories --ignore-avatars --ignore-stickers`,
  `--no-receive-stdout`, started under `umask 077`. Socket `/run/user/1000/talon-signal/
  signal.sock`: parent 0700, socket **0700** (accepted under the 2026-11-13 owner-only
  amendment, TASK-024).
- Talon: `wdd/signal-channel` built at `15124aa`, later `4fd1449` (see Defect found),
  fake `codex-cli` provider (fixed reply, no model cost), two Signal channels on the same
  bridge:
  - `signal-personal`: personal mode, operator's own account linked as device 3
    (newest device; an older stale linked device 2 remained and was harmless).
  - `signal-agent`: dedicated mode, a second number registered on signal-cli as device 1.
- Linking, registration, CAPTCHA and rate-limit-challenge submission were done by the
  operator in their own terminal. A new dedicated account was rate-limit challenged on
  first send; the operator resolved it with `submitRateLimitChallenge` (first attempt
  failed with HTTP 400 because a registration CAPTCHA was used instead of a challenge
  CAPTCHA).

## Observed results (counts from Talon's database and logs)

| AC-15 scenario | Mode | Observation | Result |
| --- | --- | --- | --- |
| Note to Self (no trigger) | personal | 3 inputs → 3 replies, 3 completed runs | pass |
| Echo suppression (own bridge output) | personal | bridge replies started no further runs | pass |
| Bridge restart / reconnect | personal | Talon reconnected automatically in ~40 s, device re-verified; next input answered once | pass |
| Talon restart, persistent linking | personal, dedicated | link survived several Talon restarts; no relink needed | pass |
| Offline input (Talon stopped) | personal | input sent while Talon was down was received after restart and answered once | pass |
| Selected-chat command | personal | `!talon …` by the operator in the selected DM with the helper → 1 reply from the operator's account | pass |
| Authorization exclusion | personal | `!talon …` by the helper in that DM → not admitted, no run | pass |
| DM reply | dedicated | operator's `!talon …` DM → 1 reply | pass |
| Trigger exclusion | dedicated | DM and group text without trigger → not admitted | pass |
| Group reply | dedicated | operator's `!talon …` in the test group → 1 reply (after fix, see below) | pass |
| Authorization exclusion | dedicated | helper's `!talon …` in the group and as DM → not admitted, no run | pass |
| Cross-account loop safety | both | dedicated replies to the operator's DM arrive at the personal account as an unselected DM and are ignored; no reply loops | pass |
| Live reload | both | two `talonctl reload` runs; both channels returned to ready/verified | pass |
| Multi-account bridge | both | one bridge served both accounts; both channels ready/verified simultaneously | pass |

Final totals: personal 4 inbound / 4 outbound; dedicated 4 inbound / 3 outbound
(one dead-lettered reply, explained below); 7 completed runs; 0 error-level log lines
after the setup issues below were corrected.

## Defect found and fixed during live validation

- Symptom: after adding a new group to the dedicated channel's `allowedGroups` and running
  `talonctl reload`, the operator's `!talon …` group command was admitted but its reply was
  dead-lettered with `TARGET_REFUSED` (no provider run).
- Cause: `registerChannels` stored a channel's config in the `channels` table on first
  registration and never refreshed it; the Signal reply target check validates against
  both the stored row and the current config, so allowlist expansions never took effect
  for replies (removals stayed fail-safe). The fake gate could not catch this because it
  always starts from a fresh database.
- Fix: commit `4fd1449` (refresh stored config/type when they differ; rejected instances
  never overwrite), independently reviewed by Claude Opus 5.5 (RED confirmed without the
  fix). After rebuild and restart, the same group command was answered once.

## Setup issues (not product defects)

- A first live config placed Talon's data under a long worktree path; the host-tools Unix
  socket path exceeded the kernel limit (`EINVAL`). Data was moved to a short path.
- The original test group created from the dedicated account during the rate-limit
  challenge left the operator as a pending member only; a new group created from the
  operator's phone was used instead.

## Observed limits (not guaranteed behaviour)

- Reconnect after a bridge restart took ~40 s here, bounded by the device-check budget.
- Delivery means "accepted by the bridge"; recipient delivery/read state was observed on
  the phones, not guaranteed by Talon.
- Attachments, disappearing messages and background-agent sends were not exercised
  (out of scope or documented limitations).
