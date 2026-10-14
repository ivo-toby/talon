# Image processing knowledge draft

## Root causes

- Inbound normalization copies text but omits attachments; image references need
  to survive normalization, durable queue processing, and history reconstruction
  (`src/pipeline/message-normalizer.ts:27`).

## Quirks

- The subscription CLI and Codex sandbox subagent adapters reject non-text user
  parts. Vision support through these adapters requires separate work; the
  existing inference-provider resolver is the candidate for this epic
  (`src/subagents/subscription-cli-language-model.ts:192`,
  `src/subagents/codex-sandbox-language-model.ts:127`,
  `src/subagents/model-resolver.ts:53`).
- The model chain appends the manifest model after every configured override.
  Vision validation must inspect that implicit fallback as well as overrides
  (`src/subagents/subagent-model-chain.ts:48`).
- Context assembly and rotation consume message/memory projections, not
  tool_results. Findings need their own canonical persistence and explicit
  projection into both paths (`src/daemon/context-assembler.ts:224`,
  `src/daemon/context-roller.ts:937`).
- Email source fetch and MIME parsing precede sender/DMARC checks. Preserve the
  existing bounded fetch, but do not normalize or persist Images from
  unauthorized email (`src/channels/connectors/email/email-imap-client.ts:111`,
  `src/channels/connectors/email/email-connector.ts:419`).
- Sharp removes EXIF and other metadata from encoded output by default. Extract
  selected metadata before normalization and apply orientation to the pixels
  before removing the orientation tag
  (https://sharp.pixelplumbing.com/api-output/#tofile).
- APNG explicitly declares animation with an acTL chunk, which also contains its
  frame count. Do not infer a static PNG merely from successful Sharp conversion
  or absent multiple-frame metadata
  (https://www.w3.org/TR/png-3/#11acTL).

## Decisions

- Ivo approved the `image-processing` epic and inheritance of the ratified WDD
  configuration on 2026-10-14.
- Ivo chose a preconfigured vision subagent that the main agent asks specific
  questions, rather than putting image inputs in the main agent's session.
- Ivo chose configurable image retention, defaulting to one day, and automatic
  exposure of extracted metadata, including GPS, to the main agent.
- Ivo chose MIME checks and limited sizes/counts rather than a separate extension
  or file-signature checking workflow, and proposed Sharp downscaling and JPEG
  normalization to reduce image size and exposure.
- Ivo approved normalized-JPEG-only storage, explicit unavailable/expiry errors,
  and asking the user to re-upload when another inspection needs the image.
- Ivo requested a higher default normalization size to preserve text detail. The
  revised draft proposes a configurable 4,096-pixel longest edge; the exact value
  remains subject to spec sign-off.
- Ivo supplied the canonical Image, Normalized file, Attachment, Inspection, and
  Finding vocabulary; it is captured in CONTEXT.md.
- The revised spec proposes exact SQLite Finding retention with bounded,
  potentially summarized replay and exact lookup without another Inspection;
  internal Processing before enqueue; Unavailable with a diagnostic reason;
  full-chain rejection of text-only providers; exclusion of inline email images
  and stickers; ordered upload slots; and whole-Inspection failure on excess IDs.
  These resolutions remain part of the draft awaiting full-spec sign-off.
- Automatic metadata exposure in authorized, operator-enabled group chats
  follows Ivo's earlier automatic-exposure choice. The revised draft makes its
  implications and the persistence of EXIF/Findings after file expiry explicit.

## Review catches

- Ivo's spec feedback identified overloaded Attachment/ Image terminology,
  missing Finding replay/persistence contracts, implicit text-only failover,
  missing subagent services, animation acceptance, email/sticker noise,
  unspecified overflow behavior, duplicate-download cleanup, and the privacy
  difference between file retention and retained text. The response is recorded
  in .wdd/epics/image-processing/reviews/spec-feedback.md; this is supplied
  feedback, not a claimed independent model review or spec approval.
