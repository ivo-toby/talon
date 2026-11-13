# TASK-017: Preserve foreign leases during saved terminalization

## Objective

Terminalize a permanently refused or expired ready saved delivery without disturbing a different delivery that owns the same destination lease.

## Deliverable

A narrow private queue-repository cleanup correction and real-SQLite regressions preserving foreign owner/account/checkpoint state, existing own-lease release and strict send/settlement ownership.

## Interfaces

Consumes:
- Approved spec/design destination-ordering, cancellation and Result transaction constraints.
- Confirmed evidence in research/foreign-lease-terminalization.md.
- Actual merged TASK-005 lease/account repositories and TASK-006 queue transitions/codec. Match their real APIs; no speculative duplicate or raw SQL workaround.

Produces:
- Existing terminateSignalDelivery signature and typed Result unchanged. A foreign lease is not released/modified and does not block this ready checkpoint's terminal decision merely because ownership differs.
- Matching owned lease still releases via strict validate/release; database and genuine owned-CAS errors retain typed identity and transaction rollback.

## Scope

Trace terminateSignalDelivery -> releaseSavedSignalLease -> lease find/release and all helper call sites. Keep correction local to the private cleanup policy. Add meaningful real migrated SQLite RED/GREEN cases for foreign saved/invocation owners, permanent refusal/live expiry, no lease/own lease controls, unaffected account/reservation/checkpoint/queue state and database failure rollback. Preserve strict begin/settle/full lease ownership and the independent correct startup-recovery owner scan; do not broaden generic APIs or revive cancelled work. Do not alter or weaken existing assertions.

## Non-scope

No other TASK-007 implementation, actor/cancellation/readiness fixes, new schema/API/config, checkpoint cap/version/TTL/identity changes, lease stealing, source metadata/protocol changes, approved spec/design edits, real Signal/accounts/keys, service/container/install/deletion, full slow suite, push/PR/main merge or governance/model changes. Ivo explicitly approved this bounded plan addition through “Add repair and continue”; preserve all original sixteen task definitions and completed TASK-006 audit history.

## Files to read first

- AGENTS.md and /home/ivo/.agents/skills/ivo-code-style/SKILL.md.
- Immutable dispatch brief/context and the actual producer implementation/adjacent tests before changing anything.
- Queue repository terminalization/private cleanup and its same-connection Result transaction, Signal destination lease repository strict owner/release, account-state repository and checkpoint invariants.

## Conflict domains

- src/core/database/repositories/queue-repository.ts
- tests/unit/core/database/repositories/queue-repository.test.ts

## Verification

```sh
npx vitest run tests/unit/core/database/repositories/queue-repository.test.ts tests/unit/core/database/repositories/signal-destination-lease-repository.test.ts tests/unit/core/database/repositories/signal-account-state-repository.test.ts
```

```sh
npm run build
```

```sh
node dist/cli/index.js --help
```

Existing unchanged lease/account tests, the existing TypeScript build and packaged CLI help are independent assertions the worker did not author. Run changed-source ESLint and targeted strict source/test compilation first. Controller additionally repeats the ratified serialized fake-terminal smoke with `flock /tmp/talon-wdd-terminal-smoke.lock bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build`, then verifies the retained TASK-007 consumer regression after reviewed repair integration/base refresh. No fake test is AC-15 live evidence.

## Definition of done

- Only the two owned paths change; root cause and all relevant regression/control cases verified; report exact RED/GREEN/check counts and every numbered Decision.
- Before ANY commit stop with NEEDS_CONTEXT and standalone READY_FOR_REVIEW; fresh independent GPT-6.1-sol xhigh review is required. Commit only exact reviewed bytes after explicit controller authorization; fresh exact-commit review/parent verification/freshness precede local integration.
- Never run wddctl, launch agents, stage/commit without authorization, push, merge or change approved inputs. Report missing contracts instead of broadening scope. Keep all unrelated/inherited work untouched.
