# Image processing spec feedback

Source: feedback supplied by Ivo on 2026-10-14. No independent model review or
full-spec approval is recorded by this document.

| Feedback | Resolution in the revised draft |
| --- | --- |
| 1: Attachment and Image overloaded | CONTEXT.md defines Attachment, Image, Image ID, and Normalized file; the spec uses those terms consistently |
| 2: Multiple names for an action/result | Inspection is the vision question; Finding is its persisted successful answer |
| 3: Expired and Unavailable overlap | One Unavailable state with expired/file_missing reasons and uniform re-upload recovery; AC-6 and AC-14 |
| 4: Tool results do not replay; exactness undefined | Exact canonical SQLite Findings; explicit bounded ContextAssembler/ContextRoller projections; summarized rotation permitted; exact Finding lookup; AC-13 |
| 5: Adapter versus model capability | Text-only override rejection at config load, manifest/effective-chain validation at startup; model-level rejection stays a request failure; AC-11 |
| 6: Implicit failover may drop images | Refuse the entire chain if any entry is text-only, including the manifest fallback; preserve image parts on each attempt; AC-11 |
| 7: Missing subagent services | Image and Finding services added explicitly to SubAgentServices with dependency-injection and compatibility checks; AC-12 |
| 8: Photo EXIF availability | Best-effort metadata expectations in docs; GPS fixtures use documents/email Attachments, photo-without-EXIF fixtures yield unknown; AC-8 and AC-17 |
| 9: First-frame conversion accepts animation | Explicit animation detection for WebP and PNG/APNG, not conversion success alone; AC-4 |
| 10: Static stickers | Platform sticker messages excluded; ordinary WebP documents remain eligible; AC-2 |
| 11: Email noise | Non-image/missing MIME and inline/related CID image parts excluded without Image records, rejection notices, or count slots; AC-2 |
| 12: Five-image ambiguity | First eligible Attachments in source order get slots, later ones have visible count_limit rejection; excess Inspection IDs fail the entire call; AC-3 and AC-10 |
| 13: Processing visibility | Complete normalization before enqueue; Processing is pipeline-internal; AC-6 |
| 14: Downloads can precede dedup | Duplicate downloaded staging files are cleaned without deleting existing Normalized files or resetting expiry; AC-7 |
| 15: Retention/privacy asymmetry | File expiry does not delete Image records, EXIF, Findings, or conversation text; automatic GPS also applies in enabled groups, documented explicitly; AC-14 and AC-17 |
| ADR candidate | docs/adr/0001-vision-subagent.md records the already-chosen vision-subagent routing and its tradeoffs |

Additional code check: email fetch/parsing happens before sender authorization.
AC-1 preserves bounded email fetching and requires authorization before Image
normalization/persistence rather than promising authorization before IMAP fetch.

New resolutions and the 4,096-pixel proposal remain subject to approval of the
revised spec. An extra model review has not been requested or performed.
