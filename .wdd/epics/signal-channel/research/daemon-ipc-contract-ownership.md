# Approved daemon IPC contract ownership correction

Ivo selected **“Add the path (recommended)”** when asked to add
`src/ipc/daemon-ipc.ts` to TASK-011's approved files, before TASK-011 admission.
This adds one owned path, not a task, feature, permission or alternate protocol.

## Confirmed cause and boundary

The original brief names `src/ipc/ipc-types.ts`, but that file defines the
container/host agent-message envelope. The actual talonctl/daemon contract is
`src/ipc/daemon-ipc.ts`: `DaemonCommandType` and `DaemonCommandSchema` enumerate
`status`, `reload`, `shutdown` and `queue-purge`. `DaemonIpcClient` imports those
types, while `DaemonIpcServer` parses through that exact schema before dispatch.
No approved task previously owned the canonical contract file.

Parent inspected all these boundaries and executed the compiled actual schema:
existing `queue-purge` was accepted, the already-approved `signal-resume` was
rejected. Editing the wrong schema, casting around the union, using a parallel
command model or bypassing server validation cannot implement the approved flow.

## Narrow authorized amendment

- Append only `src/ipc/daemon-ipc.ts` to TASK-011's conflict domains and name the
  actual canonical daemon contract in its brief.
- Keep existing TASK-011 domains, dependencies, risk, acceptance criteria and
  intended operator-authenticated challenge-resume semantics.
- TASK-012 still owns runtime handler/security wiring. TASK-011 defines/tests
  the actual command/schema/client/CLI contract, not daemon execution.
- Preserve all other seventeen task definitions/briefs and completed history,
  scope settings, config, approved spec/design and all dispatched snapshots.
- Apply through actual WDD lint/preview/dry-run/approved plan apply. Do not edit
  state.json or silently widen active worker authority.

No implementation source, test or real daemon state is changed by this record.
