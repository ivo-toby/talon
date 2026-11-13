# Signal channel tool policy compatibility decision

Ivo explicitly chose **Preserve existing behavior** after a focused decision
question explained that `requireApproval` currently exposes channel tools, but
the actual bridge does not request confirmation. The alternative offered was a
narrow Signal-only refusal pending a real approval flow. That alternative was
not selected.

Evidence read by parent and worker:
- `src/tools/tool-filter.ts`: tool-level matching compares capability prefixes,
  ignores scope suffixes, and includes both `allow` and `requireApproval`.
- `src/personas/persona-types.ts`: documents approval as requiring confirmation;
  it is not evidence that the actual bridge enforces it.
- Actual `HostToolsBridge` validates registered execution credentials/metadata
  and uses the existing filter, without an approval-confirmation step here.
- Approved Signal spec/design says to reuse existing capability/binding rules;
  this task is not authorization-framework redesign.

TASK-010 A must use the actual unchanged `isToolAllowed` with current real
`ResolvedCapabilities`. Named-scope labels retain existing prefix-only matching;
`requireApproval` retains existing tool-call admission. Do not add an exact-*
restriction, Signal-only approval gate, new scope matcher or global policy.
Empty/unrelated/missing capabilities still deny according to the real filter.

This does not relax the new Signal safety boundary: exact live registered
queue/run/thread/persona/guard/lifetime/ownership and existing bridge
credentials remain mandatory. Model arguments, copied metadata or guessed IDs
cannot mint those objects. TASK-012 must inject the same real dependencies at
the actual authenticated bridge.

The existing lack of fine-grained channel-scope and human-confirmation
enforcement is an acknowledged limitation, not a verified security guarantee.
TASK-010 B, TASK-012 and documentation/setup work must not claim those stronger
protections. Other channels/filter behavior remains untouched.

Initial A report and native failure remain historical evidence. Its temporary
wildcard-only/no-approval branch was explicitly not final policy; the retained
owner is instructed to replace only that branch/related new tests, capture real
RED/GREEN and repeat all current gates. Preserve all original A1–24 Decisions,
append the human choice and supersessions, and do not overwrite old reports or
failed receipts. No commit/runtime/live acceptance follows from this decision.
