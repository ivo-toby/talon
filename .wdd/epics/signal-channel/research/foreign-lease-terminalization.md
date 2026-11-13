# Confirmed saved-terminalization lease ownership defect

Status: confirmed finding. Ivo explicitly selected “Add repair and continue (recommended)” after reviewing the bounded two-file TASK-017 proposal, its unchanged original sixteen tasks/spec/design, and the existing native review/test/local-only gates. Implementation is authorized only through normal WDD admission and ownership; commits still require fresh independent review and controller authorization.

## Actual producer and impact

At integration `79b232b8afa817b6258ed2545770cee63fd928b6`, `QueueRepository.terminateSignalDelivery` writes a ready checkpoint's permanent terminal state and calls private `releaseSavedSignalLease`. That cleanup returns `SignalStateError('CONFLICT')` when the destination lease belongs to a DIFFERENT delivery. The enclosing Result transaction therefore rolls back the waiting delivery's terminal/dead-letter decision.

A saved reply/background waiting behind another legitimate message can become unselected/permanently refused or expire. It must be terminalized without releasing, modifying or invalidating the other owner's lease/checkpoint/account reservation. The current helper confuses "not my lease to release" with "cannot terminalize my checkpoint". No new lease may be stolen or granted by the repair. Strict owned-send/settlement/lease CAS must remain unchanged.

TASK-007 D's caller currently quiesces after this unexpected conflict; this is an incomplete consumer path, not an accepted account-wide cancellation workaround. D remains partial and separately needs call-scope saved-cancellation/readiness corrections. A mere unwritten call cancellation should normally defer still-valid saved work; purge is its durable cancellation path.

## Independent evidence

Parent ran the actual built merged producer against fully migrated in-memory SQLite with foreign keys, synthetic fixtures and zero network:

- Permanent refusal with another valid lease owner: Err CONFLICT, waiter still ready/pending; other owner/lease/account unchanged.
- Live expiry with another valid lease owner: same incorrect rollback.
- No-lease control: terminalization succeeds.
- Own-lease control: terminalization succeeds and releases its own lease.
- Startup-expiry recovery control: succeeds and preserves the other owner. Recovery has a separate owner-based cleanup scan; it is NOT affected by this helper defect.

Raw final probe: `dispatch/pi-validation/TASK-007-foreign-lease-independent-validation.log`. Initial probe correctly reproduced permanent refusal but mistakenly expected the startup control to fail; that assertion failed. The refined control and source trace establish the narrower live-terminalization cause without any production change.

Parent separately repeated D's existing real-SQLite regression: `BLOCKER: permanent refusal terminalizes a saved waiter without changing another valid destination owner` in the TASK-007 coordinator test. It fails because expected terminal is ready; owner/account/lease/no-RPC assertions pass. Other56 tests are runner-filtered in this one-case run, not disabled source tests. Log: `dispatch/pi-validation/TASK-007-foreign-lease-coordinator-independent-red.log`.

D checkpoint/report: native run `b95399bc-f840-4c7d-a85b-f085403347db`, workflow `921da61f-2024-43ea-bab4-e0f626ac6277`. It stopped without READY; whole-task reviewer was not launched. Parent verified all eight partial files, all852 tracked dependencies, exact unchanged base/empty index, complete patch bodies and identity. Manifest/log: `dispatch/pi-validation/TASK-007-partial-files.sha256`, `TASK-007-blocked-checkpoint-identity.log`.

## Approved bounded repair

Add a high-risk prerequisite repair task owning ONLY queue-repository.ts and its existing repository test. Permit terminalization while leaving a foreign lease untouched; still release only a matching lease via strict repository validation, propagate genuine database/owned-CAS errors and preserve transaction rollback. Add real-SQLite regression/control coverage. No schema/API/cap/TTL/retry/provider/runtime or approved design/spec changes.

WDD v0.4.2 disallows blocking/reopening a done task (engine.py task.blocked excludes terminal statuses) and plan apply refuses edits to started tasks. Keep the original sixteen task definitions and TASK-006 audit history unchanged; add TASK-017 depending on TASK-006, hold TASK-007's retained writer until repair integration, then refresh its base and resume that writer. Ivo approved this exact plan addition through the decision prompt. Apply/admit it through WDD; preserve the original sixteen task definitions and TASK-006 history. No direct state edits, source-scope broadening, automatic commit, push, live Signal operation or main merge is authorized.
