# Plan feedback: dependencies and concurrency

Ivo supplied feedback that the original 15-round chain contained false wave
barriers. The controller adopts waves as a delivery ordering guide, while
actual interface needs determine task dependencies. Spec wording is unchanged;
this interpretation is the explicit planning clarification for every worker.

- TASK-011 consumes TASK-002 ownership/migration contracts, not runtime ingestion.
- TASK-012 consumes TASK-001 config plus existing resolver/tool context; it adds
  trusted run provenance only. Image/Finding service widening moves to TASK-013
  and uses typed ports from TASK-001/TASK-011.
- TASK-013 consumes TASK-003 normalized-file conventions and TASK-011/012 ports
  and provenance, with fakes until runtime integration.
- TASK-015 is a pure formatter over TASK-002/011 DTOs.
- TASK-016 uses the early ImageAccess contract and repository/formatting types,
  without a concrete TASK-010 runtime import.
- TASK-018 waits for TASK-017 so hints use real registered tool exposure.
- TASK-014 waits for TASK-010 and Inspection producers; TASK-019 waits for
  TASK-014 plus replay/lookup producers. The runtime integration endpoints remain.
- TASK-021 explicitly needs TASK-003 Sharp dependencies and TASK-017 instructions.

Both migration briefs require the next free version greater than the current
maximum, with distinct Image/Finding numbers and no copying the two historical
007 filenames. Concurrency remains three and all tasks retain GPT-6.1-sol xhigh
review under the existing ratified policy; no cost/review exception was approved.

WDD also detected a separately edited design: its only change after the recorded
approval is the Docker templates copy correction already implemented in the
packaging brief. Preserve that correction. Design re-approval and plan approval
remain human-owned; this feedback is not claimed as either approval.
