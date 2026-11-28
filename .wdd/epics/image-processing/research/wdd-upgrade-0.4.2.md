# WDD 0.4.2 compatibility upgrade

The installed controller identifies as 0.4.2. Primary release evidence was read
from /home/ivo/workspace/wdd/wdd: release 9132f1f, review-limit change e3204e7,
and the installed wave_delivery config/engine/handover/path implementations.
Version 0.4.1 ignores machine-local .wdd transients; 0.4.2 stops after three
blocking review rounds per task for human guidance. No artifact schema bump
was introduced by those changes.

wddctl init safely reports alreadyInitialized; doctor reports valid configuration
and no governance drift. Current state is already schema 7. Intake still retains
Ivo's spec/design approvals and the completed research; no approval was fabricated
or re-stamped. Active approved artifact bytes were preserved.

Updated reference templates: plan.json and task.md were emitted from the CLI;
spec.md/design.md use the current intake sections. The old task template is kept
as historical reference. README documents current paths, immutable snapshots,
controller-only state writes, the blocking-round limit and the pending plan gate.

The interrupted turn had produced no plan. A new 21-task draft now carries
acceptance mappings, declared conflict domains, exact focused gates, independent
oracles and explicit runtime integration sinks. Its 15-round schedule and six
intentional/advisory lint findings are described in plan-summary.md. Dry-run
apply succeeds with a clearly marked hypothetical approver; state remains
unchanged and no actual plan approval/application or worker dispatch occurred.

No Talon implementation files, model choices or verification commands changed.

## Subsequent plan review

The first 15-round draft was revised to 10 rounds at concurrency three after
Ivo clarified wave ordering and actual interface dependencies. The current
design was independently edited to correct the Docker templates-copy sentence;
that is the only design fingerprint change. Current dry-run apply is blocked
on re-approval of those design bytes. The earlier successful compatibility
check remains historical evidence; it is not proof of current intake freshness.

## Approval/application checkpoint

Ivo explicitly approved the revised ten-round plan and corrected design.
Design approval was refreshed through wddctl; dry-run apply passed and the
21-task plan was applied. The earlier drift is resolved. No task has started;
Ivo requested committing and pushing the planning artifacts before implementation.
