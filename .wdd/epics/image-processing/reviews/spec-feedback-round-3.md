# Image processing spec feedback: round 3

Source: feedback supplied by Ivo on 2026-10-14. Ivo accepted the prior seven
gap/glossary resolutions and kept ADR-0001 unchanged. This records the new
draft's responses; it does not record full-spec approval or a model review.

| Feedback | Resolution in the revised draft |
| --- | --- |
| 1: Ordering requires an unspecified admission barrier | Drop cross-handoff ordering. Normalize within an awaited pipeline handoff; concurrent callbacks and recovery may enqueue in completion order. No pending records for later text messages; AC-6 |
| 2: Transient errors may retry forever | Fixed three total attempts per Image and 60-second normalization deadline per message, persisted across restart/redelivery. Exhaustion becomes processing_failed; resolve outcomes and enqueue. Remote fetching has its own 60-second per-message deadline; AC-16 and AC-20 |
| 3: Rejection reasons incomplete | Closed table: unsupported_mime, count_limit, size_limit, animated, download_failed, conversion_failed, processing_interrupted, processing_failed. Unavailability remains exactly expired/file_missing; AC-16 |
| 4: Two inventory names | One Image descriptor inventory rebuilt from canonical records independently of rotation. No separately persisted reference list; AC-18 |
| 5: Projection bounds unspecified | Fixed descriptor maximum 20 rows, 1,000 characters each, 8,000 total; Finding maximum 10 rows, 2,000 characters each, 8,000 total. Framing/notices count; AC-13 and AC-18 |
| 6: Hint may name an inaccessible tool | Name image_lookup only when exposed to the persona. Vision-enabled persona example/template/setup pairs image.read:thread with vision assignment/invocation; existing personas require explicit enablement; AC-17 and AC-18 |
| 7: Text-only crash gap remains | Explicitly out of scope; atomic recovery/completion guarantees apply to image-bearing messages only |
| Epic shape and duplicate contracts | Keep one spec, organize three dependent waves: ingestion/storage → Inspection → replay/lookup. Define replay and lookup permissions once; acceptance criteria reference those contracts |
| Glossary additions | Define Ingestion, Image descriptor inventory, and both closed reason lists in CONTEXT.md |

Code checks refine the simpler ordering alternative: Baileys starts handlers
concurrently and webhook requests can overlap. Awaiting normalization alone
does not provide a universal per-thread ordering guarantee. Pipeline callback
registration also needs to await its newly asynchronous result. A message has
one active processing owner; duplicate/recovery attempts cannot compete.

The new deadlines fence late conversion/fetch results. Invalid input fails
immediately; operational retries consume the persistent budget. Resolved Images
are reused, and recovery reasons apply only to unfinished Processing Images.
Database write failure returns a pipeline error; recovery resumes after writes
become available without resetting deadlines. This is not a promise to enqueue
while SQLite itself cannot accept writes.

The spec remains on the WDD spec rung. ADR-0001 is unchanged.
