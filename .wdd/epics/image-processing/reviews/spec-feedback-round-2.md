# Image processing spec feedback: round 2

Source: feedback supplied by Ivo on 2026-10-14. Ivo accepted the first round's
resolutions and ADR-0001; this document records responses to the remaining gaps,
not approval of the newly revised spec or an independent model review.

| Feedback | Resolution in the revised draft |
| --- | --- |
| 1: Image IDs disappear across rotation | Explicit Image descriptor projections in ContextAssembler/ContextRoller, a structured reference inventory independent of prose summaries, and paginated list_images discovery even for uninspected Images; AC-13 and AC-18 |
| 2: Email's encoded-message cap is lower than the image limit | Retain the existing 10 MiB whole-email cap and document base64/MIME overhead, sharing across all parts, lower practical decoded-image size, and whole-email skipping before Image creation; AC-3 and AC-17 |
| 3: Interrupted Processing can stick forever | Startup/redelivery recovery table: resume from retained/new source, reject missing source as processing_interrupted, mark elapsed expiry Unavailable/expired, and enqueue resolved messages exactly once; AC-7 and AC-20 |
| 4: Lookup interface and vision-assignment gate unclear | New image.lookup host tool / image_lookup MCP interface with list_images, get_image, list_findings, and get_finding; separate image.read:thread capability, without vision assignment or model credentials; AC-19 |
| 5: Operator-enabled groups ambiguous | Existing connector group-chat and trigger settings are the only controls; no additional Image/GPS group switch; AC-8 and AC-17 |
| 6: Image expires before its first run | Receipt-based deadline is not extended by queue delay/backoff; descriptors refreshed at run/replay time can show Unavailable/expired on first run and offer re-upload; AC-14 |
| 7: Normalization location and owning message order unclear | Connectors select/fetch bounded Attachments; MessagePipeline deduplicates/adopts the authoritative message, admits Images, normalizes centrally, and atomically enqueues after terminal ingestion outcomes; AC-6, AC-7, and AC-20 |
| Glossary: Image descriptor missing | CONTEXT.md defines its text-only identity/origin/availability/expiry/metadata representation |
| Glossary: Rejected Images may have no content | Image now means the durable record of an accepted or rejected image Attachment; download is not assumed |
| Glossary: Image ID uniqueness | Globally unique, with exactly one owning conversation thread |
| Glossary: Normalized file circular definition | Size-bounded, metadata-free JPEG derived from an accepted Image |

Additional checks and clarifications:

- Initial message, Image, route/admission, and recovery-reference writes commit
  together. Otherwise a crash between message persistence and admission creation
  could still turn incomplete work into an unrecoverable duplicate.
- Enqueue and admission completion commit together because current QueueManager
  generates a new UUID on every call; repeated enqueue is not inherently
  idempotent.
- Image receipt for retention is first durable pipeline admission on the local
  clock, not a platform-supplied message date or EXIF capture time.
- Lookup hides internal Processing records; global IDs do not replace checking
  thread ownership. Lists page deterministically and scope cursors to the same
  operation/filter/thread.

The revised spec remains awaiting full-spec sign-off.
