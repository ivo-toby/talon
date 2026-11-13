# AC-15 real-device acceptance pending

On 2026-10-15 Ivo answered: “No live bridge yet; complete automated work first”.
The implementation plan covers automated code, documentation and fake validation.
Real-device acceptance is a separate pending gate, not a completed task or a waiver.
No real Signal messages are authorized or sent. TASK-013 prepares the procedure;
its fake bridge cannot establish AC-15. The final handoff must identify this
limitation and refrain from marking the epic delivered or finalizing it until
real-device evidence exists for both modes and all spec scenarios.

## Resolved 2026-11-13

Real-device validation was run by Ivo on 2026-11-13 for both account modes and all AC-15
scenarios, with a fake provider. Evidence (counts only, redacted):
research/live-validation-evidence.md. One defect found live (stale stored channel config
after allowlist changes) was fixed in 4fd1449 and re-validated.
