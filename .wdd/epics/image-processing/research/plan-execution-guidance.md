# Image-processing execution order clarification

The spec/design wave labels (a) ingestion, (b) Inspection, (c) replay/lookup
are a delivery ordering guide. Ivo clarified during plan review that they
are not finish-before-start barriers between component implementation tasks.
Use the approved task graph's actual interface dependencies for admission.

Ports and DTOs are available before runtime adapters. TASK-001 declares the
ImageAccess contract; TASK-011 declares Finding types/persistence. TASK-012
adds model-chain validation/trusted run identity without depending on Findings.
TASK-013 then widens subagent services using those ports. Pure formatter and
lookup/context code use injected typed inputs rather than importing future
runtime services. Unit tests may use deterministic port fixtures until wiring.

TASK-010 completes ingestion runtime integration. TASK-014 waits for it and the
Inspection producers. TASK-019 waits for working Inspection plus replay/lookup
producers. Those runtime endpoints preserve end-to-end verification. No claim
is made that early vision components prove ingestion runtime behavior.

Concurrency stays at three, and every task retains the ratified independent
GPT-6.1-sol xhigh review. Do not infer authorization to raise concurrency, waive
review, substitute models, or bypass an unmet runtime integration dependency.
