# TASK-024: Owner-only Signal socket mode

## Objective

Accept an owner-only signal-cli socket mode (0600 or 0700) in the local bridge trust check, as amended in the design on 2026-11-13, so the documented `umask 077` bridge start is trusted.

## Deliverable

`signal-socket-trust.ts` accepts a socket owned by talond's UID with no group or other permission bits, every other trust rule unchanged, with regression tests; Docker starter README socket ownership wording corrected for the container UID.

## Interfaces

Consumes:
- Approved spec/design (Local bridge trust boundary, amended 2026-11-13) and the merged TASK-003 trust check.
- Dependency tasks: TASK-013, TASK-016.

Produces:
- Updated trust predicate only. Keep the exported API, Result types and error identity unchanged.

## Scope

Change only the socket-entry mode predicate: accept when the entry is a socket, owned by the effective UID, and `(mode & 0o077) === 0` (so 0600 and 0700 pass; 0640, 0660, 0666, 0700|setuid bits and anything with group/other bits fail). Keep the parent rule exactly 0700 and same UID, the ancestor rule (UID or root, no group/world write), symlink rejection, absolute-normalized path rules, and the post-connect device/inode/mode re-check unchanged. Decide and document whether setuid/setgid/sticky bits on the socket are refused (they should be: require `(mode & 0o7077) === 0` with owner bits allowed as rw or rwx).

Tests: 0600 and 0700 accepted; 0640, 0660, 0606, 0755, 0777 refused; parent 0750 still refused; ancestor group-writable still refused; symlink still refused; post-connect re-check still detects a swapped socket. Use real temp sockets created under a controlled umask in a private (non-/tmp-ancestry if the existing tests require it) directory, following existing test patterns.

Starter READMEs: replace "owned by your user" with wording that the socket and its parent must be owned by the same UID as talond (in the Docker starter that is the container's talond UID, 1000, which must match the bridge's UID), and add the one-line ancestor rule. Match the add-signal skill wording.

## Non-scope

No other trust changes, no chmod/unlink of operator paths, no signal-cli provisioning, no docs beyond the two starter READMEs (README/docs/skills already describe the owner-only rule), no full npm test, no design/spec/plan edits.

## Files to read first

- AGENTS.md and /home/ivo/dotfiles/agents/.agents/skills/ivo-code-style/SKILL.md.
- design.md "Local bridge trust boundary (F13)"; src/channels/connectors/signal/signal-socket-trust.ts and its test; starter/README.md and starter-stack/README.md Signal sections; .claude/skills/add-signal/SKILL.md socket steps.

## Conflict domains

- src/channels/connectors/signal/signal-socket-trust.ts
- tests/unit/channels/connectors/signal/signal-socket-trust.test.ts
- starter/README.md
- starter-stack/README.md

## Verification

```sh
npx vitest run tests/unit/channels/connectors/signal/signal-socket-trust.test.ts tests/unit/channels/connectors/signal/signal-connector.test.ts tests/unit/deploy/starter-bundle.test.ts
```

```sh
npm run build
```

```sh
node dist/cli/index.js --help
```

## Definition of done

- Deliverable and regression tests complete with RED/GREEN evidence and exact verification results.
- No edits outside conflict domains; Decisions recorded.
- Before any commit, stop and return NEEDS_CONTEXT READY_FOR_REVIEW; the controller runs an independent Claude Opus review and then tells you to commit the exact reviewed content. Never run wddctl or merge.
