# Image processing knowledge draft

Status: spec and design approved by Ivo on 2026-10-14; research completed.
WDD 0.4.2 compatibility checked; the 21-task/10-round plan and corrected design
are approved and applied. Implementation has not started.
Earlier draft decisions below are historical.

## Root causes

- Inbound normalization copies text but omits attachments; image references need
  to survive normalization, durable queue processing, and history reconstruction
  (`src/pipeline/message-normalizer.ts:27`).
- Foreground previous-context injection is skipped for resumed provider sessions.
  Current-message Image descriptors need live-content delivery; full inventory/
  Finding projections must stay in fresh-session/rotation context because
  Codex appends resumed-turn system prompts to its persistent log
  (`src/daemon/agent-runner.ts:552`, `src/providers/codex-cli-provider.ts:328`).

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
- The current whole-email fetch cap is 10 MiB, applied to encoded MIME source.
  Base64 increases content size by about 33 percent before line/header overhead;
  a configurable 10 MiB decoded-image limit is therefore not a promise that an
  email can carry a 10 MiB image
  (`src/channels/connectors/email/email-imap-client.ts:19`,
  https://www.rfc-editor.org/rfc/rfc2045#section-6.8).
- Existing pipeline dedup returns immediately for an existing message, and
  QueueManager assigns a new queue UUID on each enqueue call. Pending Image
  ingestion needs an explicit recovery/admission record and atomic enqueue
  completion rather than treating every existing message as fully ingested
  (`src/pipeline/message-pipeline.ts:143`, `src/queue/queue-manager.ts:114`).
- Baileys starts inbound handlers concurrently, and separate WhatsApp Business
  webhook requests can overlap. Awaiting a pipeline callback does not establish
  per-thread ordering across those callbacks. The callback registration must
  itself await the new asynchronous pipeline handoff
  (`src/channels/connectors/whatsapp-baileys/whatsapp-baileys-connector.ts:261`,
  `src/channels/channel-setup.ts:103`).
- Sharp removes EXIF and other metadata from encoded output by default. Extract
  selected metadata before normalization and apply orientation to the pixels
  before removing the orientation tag
  (https://sharp.pixelplumbing.com/api-output/#tofile).
- APNG explicitly declares animation with an acTL chunk, which also contains its
  frame count. Do not infer a static PNG merely from successful Sharp conversion
  or absent multiple-frame metadata
  (https://www.w3.org/TR/png-3/#11acTL).
- The executed Sharp/exifr probe confirms raw EXIF differs by container:
  JPEG/WebP include an Exif-zero-zero prefix, PNG starts at TIFF. Parse the TIFF
  data after removing that metadata prefix, and disable exifr date/value revival
  to retain recorded time/offset and numeric orientation. Fixtures preserve GPS
  through extraction; normalized JPEG removes EXIF. A valid single-frame APNG
  converts while Sharp exposes no pages, confirming the need for acTL checking
  (.wdd/epics/image-processing/research/normalization-probe-result.json).
- Sharp's native timeout excludes waiting for a libuv worker. Keep the outer
  persisted wall-clock deadline and fence late results rather than relying on
  native timeout alone (sharp@0.34.5 lib/output.js:1445–1478, read from the
  pinned npm source cache documented by the contract inventory).
- Tool context has runId but subagent invocation drops it. Findings need trusted
  run provenance threaded through the handler/runner/context, not an inferred
  active run (`src/tools/host-tools/subagent-invoke.ts:94`).

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
- Ivo accepted the first feedback round's resolutions and ADR-0001 and supplied
  a second round covering descriptor discovery, MIME transport limits,
  interrupted ingestion, lookup permissions, group-switch ambiguity, early
  expiry, and processing ownership. The glossary now defines Image descriptors,
  globally unique Image IDs, content-free Rejected Images, and Normalized files.
- The second-round draft retains the whole-email cap, introduces a separate
  model-free image_lookup tool under image.read:thread, preserves descriptor
  discovery across rotation, and specifies pipeline-owned atomic admission and
  Processing recovery. Existing group/trigger controls are the only group
  switches. These changes remain subject to full-spec sign-off.
- The third-round draft drops the new cross-handoff ordering promise and uses
  inline awaited normalization without a durable barrier for later text-only
  messages. It proposes at most three total processing attempts per Image and a
  fixed 60-second deadline per admitted message, persisted across restarts and
  redelivery; unresolved work becomes processing_failed. This supersedes the
  earlier draft's unbounded transient recovery retries and ordering promise.
- The third-round draft closes rejection/unavailability reason lists, uses one
  fresh Image descriptor inventory, and fixes automatic projection budgets:
  20 descriptors / 1,000 characters each / 8,000 total; 10 Finding projections /
  2,000 characters each / 8,000 total. Lookup hints require tool exposure, and
  vision-enabled setup examples must grant image.read:thread explicitly. The
  text-only persist-before-enqueue crash gap remains outside this epic.
- Delivery is proposed in three dependent waves: ingestion/storage, Inspection,
  then replay/lookup. No task plan or approval has been recorded.
- Ivo approved the full revised spec on 2026-10-14 (20 acceptance criteria),
  including its 4,096-pixel normalization default. WDD fingerprints the accepted
  bytes; the earlier draft/sign-off qualifications are now closed.
- Ivo confirmed the three human review rounds suffice: "It has been reviewed,
  we can move on." No additional model spec review was requested.
- Research pins proposed Sharp 0.34.5/exifr 7.1.3 and the current locked
  AI SDK/Baileys/MailParser source contracts. The design proposes a separate
  inbound rejection envelope, explicit transaction coordinator, owned staging
  and normalized-file paths, and trusted Finding provenance. Its initial
  per-query full replay proposal was corrected after design feedback; design
  approval remains pending.
- The revised design places current-message descriptors in live content and
  reserves full inventory/Findings for fresh sessions and rotation. Budget
  sharing prevents duplication; resumed sessions use lookup for historical data.
  Proposed ADR-0002 records the trade-off; accepted ADR-0001 is unchanged.
- Connector authorization/trigger checks are distinct from durable Admission.
  The design names both .agents/skills and .claude/skills plus both architecture
  files. Their new image guidance must agree; existing agent-specific differences
  are preserved.

## Review catches

- Ivo's spec feedback identified overloaded Attachment/ Image terminology,
  missing Finding replay/persistence contracts, implicit text-only failover,
  missing subagent services, animation acceptance, email/sticker noise,
  unspecified overflow behavior, duplicate-download cleanup, and the privacy
  difference between file retention and retained text. The response is recorded
  in .wdd/epics/image-processing/reviews/spec-feedback.md; this is supplied
  feedback, not a claimed independent model review or spec approval.
- The second response is recorded in
  .wdd/epics/image-processing/reviews/spec-feedback-round-2.md. In addition to
  the supplied gaps, initial message/admission writes are now explicitly atomic
  to avoid committing a message without its recovery record, and lookup cannot
  expose internal Processing descriptors.
- The third response is recorded in
  .wdd/epics/image-processing/reviews/spec-feedback-round-3.md. It records the
  supplied review and the revised draft, not an independent model review or
  full-spec approval.
- Research found the existing pre-admission IMAP seen/dispatch crash gap; its
  acknowledgment behavior remains unchanged. New image recovery guarantees
  begin at durable pipeline admission (email-imap-client.ts:82–97).
- WhatsApp Business's current media response reference was inaccessible. Its
  primary Postman request and older primary response example were read;
  current-version response/download verification is explicitly NOT READ and
  assigned to the connector implementation rather than fabricated from memory.
- Design feedback is recorded in reviews/design-feedback-round-1.md. The
  revised design also specifies largest-fitting Telegram rendition selection,
  main-agent vision input instructions, transactional logging only after commit,
  and native Sharp verification in both released container architectures.
- Research cache paths are temporary read provenance. Primary URLs and the
  pinned source manifest are the lasting references. The exact first step for
  the future Business task is saved in research/whatsapp-business-prerequisite.md.

**Upgrade checkpoint: 2026-10-14**

- Ivo explicitly approved the design; WDD recorded it before the planning interruption. ADR-0002 is accepted.
- WDD 0.4.2 accepts the existing schema-7 state and all approval fingerprints. The new default stops automatic fix dispatch after three blocking review rounds for a human decision.
- The replacement AGENTS.md review/model instructions agree with ratified WDD choices. Models and gates were preserved.
- New CLI plan/brief templates replace the active examples; older artifacts remain historical. The 21-task draft and coverage/schedule evidence are in the active epic, pending explicit plan approval.

**Plan review checkpoint: 2026-10-14**

- Ivo clarified that wave labels express interface/delivery order, not component
  admission barriers; the spec is unchanged. The revised graph projects 10 rounds
  at concurrency three instead of 15.
- Early components use ImageAccess/Finding ports. TASK-012 handles config/chain/
  run provenance only; TASK-013 owns subagent Image/Finding type widening.
- TASK-018 waits for actual TASK-017 lookup exposure; TASK-014 and TASK-019
  retain real runtime integration prerequisites. Review remains always/xhigh.
- The current design's only post-approval edit fixes Docker templates copying.
  WDD refuses dry-run apply until that edited design is reconfirmed. No approval
  was invented; plan application/dispatch still waits for human sign-off.

**Approval checkpoint: 2026-10-14**

- Ivo explicitly approved the revised plan and corrected design with "Approved!".
  The controller refreshed design approval, passed dry-run apply and applied
  all 21 tasks. TASK-001 is the first eligible task; every task remains todo.
- Ivo requested a commit and push of these artifacts before implementation.
  This checkpoint records approval/application, not a claimed review or test run.
