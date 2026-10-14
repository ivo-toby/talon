# Spec: Image processing through a vision subagent

## Goal

Users upload images through Telegram, WhatsApp, or email and discuss their
contents with Talon. The main agent asks a configurable vision subagent an
Inspection question and receives a textual Finding. Image records and Findings
remain part of the conversation after Normalized files expire, by default
24 hours after receipt.

## In scope

Use the vocabulary in [CONTEXT.md](../../../CONTEXT.md). An Attachment is the
short-lived channel payload. An Image is the durable, thread-scoped record with
an Image ID, state, metadata, and expiry. A Normalized file is the JPEG on disk;
its lifetime is separate from the Image record's. An Inspection asks the vision
subagent a question about Images. Its persisted answer is a Finding.

**Channels and Attachment selection**

- Telegram photos and image documents, WhatsApp Business images and image
  documents, WhatsApp Baileys images and image documents, and email image
  Attachments. Captions and accompanying text are preserved. An eligible
  image-only message can start a run under the connector's existing trigger rules.
- Sender, chat, bot, and trigger policies remain in force. Telegram and WhatsApp
  apply them before separate media downloads. Email retains its existing bounded
  message fetch and parsing before sender/DMARC checks; unauthorized email
  Attachments never become Images or enter normalization.
- Declared MIME is matched case-insensitively after removal of MIME parameters.
  Known channel photo/image payloads supply their image MIME when the platform
  does not include a MIME field. Documents with absent or non-image MIME are
  excluded; a filename extension alone does not make them eligible.
- JPEG, PNG, and static WebP are supported. Unsupported image MIME types,
  animated inputs, oversized inputs, and failed downloads or conversions produce
  a Rejected Image with a reason. There is no separate extension-checking,
  file-signature validation service, or malware-scanning service.

| Delivered item | Image processing | Counts toward upload limit |
| --- | --- | --- |
| Photo, ordinary image message, or document/email Attachment with declared image MIME | Create an Image and evaluate acceptance | Yes |
| Unsupported image MIME, such as image/heic or image/svg+xml | Create a Rejected Image with reason unsupported_mime | Yes |
| Non-image or missing MIME on a document/email Attachment | Exclude without an Image or rejection notice | No |
| Email part marked inline or identified by the mail parser as related CID content | Exclude without an Image or rejection notice, including inline photographs | No |
| Platform sticker message, including a static WebP sticker | Exclude without an Image or rejection notice | No |
| A thumbnail or another size representation of the same photo | Not a separate Attachment or Image | No |

A WebP file sent as an ordinary document is eligible; its contents are not used
to guess whether it was originally a sticker. Email image parts with neither an
inline disposition nor a related-CID classification remain eligible. Telegram
album members remain separate inbound messages; no album coalescing is added.

**Limits, normalization, and ingestion order**

- Proposed defaults for sign-off: 10 MiB per input Attachment, five eligible
  Attachments per message, five Image IDs per Inspection, a 4,096-pixel longest
  Normalized file edge, JPEG quality 85, and a 24-hour Normalized file retention
  period. These values are configurable; upload and Inspection count limits are
  independently configurable.
- Eligible Attachments are counted in source message order after exclusions.
  The first configured number get processing slots. Later eligible Attachments
  become Rejected Images with reason count_limit; this rejection is visible to
  the main agent. A rejected Attachment within the first slots still consumes its
  slot; later ones are not substituted. Excess remote media is not downloaded.
- Apply the byte limit during separate media downloads, before saving parsed
  email Attachment buffers to staging, and before Sharp conversion. The email
  message's existing overall byte limit also remains in force. A declared size
  does not replace checking the actual number of bytes.
- Reject animation explicitly before accepting a Normalized file. Frame-count
  and animation information are checked for WebP and PNG, including APNG.
  Successful first-frame conversion alone does not establish that an input is
  static. APNG animation-control information must be checked even when Sharp's
  metadata does not report multiple frames.
- Extract selected EXIF before conversion, apply orientation to the pixels,
  preserve aspect ratio, never crop or upscale, flatten transparency on white,
  and encode JPEG within the configured longest-edge and quality settings.
  Sharp's built-in input limits remain enabled. Retain only the Normalized file;
  remove the downloaded source after conversion and remove failed staging files.
- Classification and normalization finish before the message is enqueued.
  Processing is an internal Image state, never an agent-visible pending upload.
  Image descriptors for the run contain only Available, Rejected, or Unavailable
  Images. An arbitrary Inspection of a still-Processing Image fails without a
  model request.
- Durable Image identity is tied to channel-scoped message identity and the
  Attachment's source order. Redelivery reuses existing Image records and never
  resets expiry. Deduplication may happen after the connector has downloaded an
  Attachment: that path removes newly downloaded staging files without removing
  existing Normalized files. Crash/retry cleanup also removes orphaned staging
  and uncommitted Normalized files.

**Image availability and retention**

Image records are stored in SQLite and identify their owning message and thread,
selected metadata, state, reason when present, and expiry. Normalized files use
the existing per-thread storage area. The expiry is fixed from first local
receipt and is not extended by access, retries, or daemon restart.

| Image state | Transition | Agent-visible behavior |
| --- | --- | --- |
| Processing (internal) | Normalization completes as Available, or acceptance fails as Rejected | Not exposed in queued-message context; an Inspection cannot use it |
| Available | Expiry becomes Unavailable with reason expired; an unexpectedly missing Normalized file becomes Unavailable with reason file_missing | An Inspection can use its Normalized file before expiry |
| Rejected | Terminal for this Image ID; the rejection reason is retained | Visible rejection reason; no Inspection can use it |
| Unavailable | Terminal for this Image ID; the first unavailability reason is retained | Uniform re-upload recovery; existing metadata and Findings remain accessible |

- A new Inspection fails once current time reaches an Image's expiry, even if
  the Normalized file has not yet been physically deleted. File cleanup runs on
  daemon startup and at an interval of at most 60 seconds. Deletion failures are
  logged and retried; they never make an expired Image Available.
- The user-facing recovery is the same for expiry and a missing Normalized file:
  the main agent can ask the user to re-upload. The reason remains available for
  diagnostics. Re-upload creates a new Image ID and expiry; it never revives the
  old Image.
- An Inspection that has already loaded bytes before expiry can finish within
  its configured timeout. No new attempt, including a failover attempt, starts
  after expiry. Cleanup is not postponed by such an Inspection.
- Retention applies to local Normalized files and temporary image copies.
  Image records, GPS/EXIF, Findings, and ordinary conversation text are not
  deleted by image-file cleanup. They remain until separately deleted with their
  owning data; this feature introduces no timed deletion of those records.
  Local cleanup makes no promise about retention by the selected external model.

**Metadata and group conversations**

- The main agent automatically receives Image IDs, state/reason, original and
  normalized dimensions, and selected EXIF as data. Selected EXIF covers GPS
  latitude/longitude/altitude, capture time with its recorded offset when
  present, camera make/model, and original orientation. Missing fields are
  unknown; neither location nor timezone is fabricated.
- GPS and capture time are extracted only when present in the received
  Attachment. Telegram/WhatsApp photo delivery can recompress and strip EXIF;
  documentation directs users who need metadata to send an original image as a
  document or an email Attachment, while stating preservation is not guaranteed.
  GPS acceptance fixtures use document/email Attachment ingestion; ordinary
  photo fixtures without EXIF produce unknown metadata.
- Automatic metadata exposure also applies to authorized group conversations
  that the operator has enabled. The existing group/trigger policies still
  decide which messages reach the persona. Documentation states that GPS and
  OCR-derived personal data can persist in Findings and can appear in responses
  visible to group members.

**Inspections, Findings, and service contracts**

- Add a built-in vision subagent, assigned and capability-gated through the
  existing subagent tool. An Inspection accepts a nonempty question and between
  one and the configured maximum number of distinct current-thread Image IDs.
  Too many IDs, duplicate IDs, unknown/cross-thread IDs, or any Image without an
  Available Normalized file fail the entire Inspection before a model request;
  the list is never silently truncated or partly answered.
- Only anthropic, openai, google, and ollama inference-provider adapters are
  permitted in the vision model chain. Configuration loading rejects text-only
  providers in vision overrides. Startup validation also checks the loaded
  vision manifest and the complete effective chain, including its implicit
  manifest fallback, before accepting channel work. A text-only entry invalidates
  the chain; it is not silently skipped. Other subagents retain their provider
  choices.
- Model names are not classified into vision/text-only registries. A configured
  model that rejects image content is an ordinary request failure, eligible for
  failover within the valid chain. Every attempt includes the same question and
  image parts in an independent request, rechecks availability, and preserves
  existing timeout/abort behavior. Image parts are never dropped to make a
  fallback succeed. Exhausting the chain returns an error without a Finding.
- The main persona's provider and model do not select the vision model. Talon's
  image feature supplies the main provider with text and Image descriptors,
  keeping pixel inputs out of its session. This routing decision is recorded in
  [ADR-0001](../../../docs/adr/0001-vision-subagent.md); it does not introduce new
  operating-system isolation of provider-native filesystem tools.
- Widen SubAgentServices explicitly with Image and Finding services. They
  provide thread-scoped Image resolution, access to Available Normalized files,
  and Finding persistence/lookup. Dependency injection and existing subagent
  fixtures are updated without giving other subagents access to another thread's
  Images through these services.
- Persist each successful Finding in a dedicated SQLite store before returning
  it. A Finding has a Finding ID, owning thread and run, Image IDs, question,
  answer, extracted text, uncertainty, creation time, and the model that produced
  it. The stored Finding preserves the returned text exactly. A storage failure
  returns an error rather than an unrecorded successful Finding.
- Extend ContextAssembler and ContextRoller explicitly to include bounded
  textual projections of Findings alongside messages in chronological order,
  with Finding/Image IDs and historical-data framing. Tool results alone are
  not the replay source, and Finding storage creates no fake inbound or outbound
  messages.
- Automatic replay and rotation can excerpt or summarize a Finding within
  existing context budgets; verbatim retention in every future prompt is not
  promised. Full Findings remain in their canonical store after rotation and
  Normalized file expiry. The main agent can look up a saved Finding by Finding
  ID or discover its ID from an Image ID and retrieve its exact text without
  performing another Inspection or calling a model. Lookup uses the same
  thread, persona-assignment, and capability checks as Inspection.
- Existing scheduled-run context isolation remains unchanged. New replay is
  limited to the foreground conversation paths that already assemble history.
  Missing vision setup, denied access, and exhausted request failures produce
  explicit errors; the foreground model is never silently replaced.

## Out of scope

- Native multimodal delivery through Talon's main provider and resumable vision
  sessions; changes to subscription CLI or Codex sandbox image protocols or
  containment boundaries.
- Other channels, platform sticker messages, inline email images, HEIC/HEIF,
  animated images including APNG, SVG, PDF, video, image generation/editing, and
  automatic downloads of remote email images or arbitrary supplied URLs.
- A dedicated malware scanner, sandboxed decoder service, separate OCR engine,
  automatic reverse geocoding, or recovery of EXIF stripped before receipt.
- Retaining original image copies, automatic re-download after expiry, or
  applying Normalized file retention to Image metadata, Findings, conversation
  text, or the external model provider's records.
- Telegram album coalescing, a static model-name capability registry, permanent
  verbatim pinning of every Finding in active context, and changes to
  scheduled-run context behavior.

## Acceptance criteria

- [ ] AC-1: Scoped connectors preserve accompanying text and emit eligible
  Attachments for image-only messages. Existing authorization and trigger
  behavior is preserved, with separately fetched media downloaded after those
  checks and email normalization performed only after sender/DMARC checks.
- [ ] AC-2: The Attachment-selection table is enforced. Non-image/missing MIME,
  inline/related email images, platform stickers, and duplicate photo-size
  representations create no Image or rejection notice and consume no slot.
  Unsupported image MIME creates a Rejected Image with unsupported_mime.
- [ ] AC-3: Upload slots are assigned in source message order. The default sixth
  eligible Attachment gets a visible count_limit rejection and no separate
  download; failures within the first five do not admit the sixth. Actual input
  bytes are limited during download or before staging/conversion for email.
- [ ] AC-4: JPEG, static PNG, and static WebP normalize to the configured JPEG
  size/quality with orientation applied, aspect ratio preserved, no crop or
  upscale, white transparency background, and EXIF stored separately. Animated
  WebP and APNG fixtures are rejected even when their first frame could convert.
- [ ] AC-5: Configuration validates defaults and overrides for input bytes,
  independent upload/Inspection counts, longest edge, JPEG quality, and retention.
  The proposed defaults are 10 MiB, five/five, 4,096 pixels, quality 85, and 24 hours.
- [ ] AC-6: Processing completes before enqueue. Agent-visible Image descriptors
  use Available, Rejected, or Unavailable states; reason distinguishes expiry
  from an unexpectedly missing Normalized file without introducing another state.
- [ ] AC-7: SQLite Image records and linked Normalized files survive restart and
  queue retries. Redelivery does not add Images or reset expiry, and duplicate
  downloads, failed conversion, and crash/retry reconciliation leave no orphaned
  staging or uncommitted Normalized files.
- [ ] AC-8: Selected metadata is automatically available as Image data, including
  in operator-enabled groups. Document/email fixtures with GPS preserve
  coordinates; metadata-free photo fixtures yield unknown fields; absent capture
  offsets never become invented timezones. EXIF and inferred locations are
  distinguishable.
- [ ] AC-9: An Inspection of valid current-thread Images sends multimodal content
  through the configured vision model and returns a persisted Finding with source
  IDs and token usage. Text-only foreground models work through the same flow.
- [ ] AC-10: The entire Inspection fails before a model request for excess,
  duplicate, unknown/cross-thread, Processing, Rejected, or Unavailable Image IDs.
  No partial or silently truncated Inspection result is returned; filesystem
  paths and URLs are not accepted as Image identities.
- [ ] AC-11: Vision overrides reject claude-code and codex-sandbox during config
  loading; loaded manifest and effective-chain validation prevent a text-only
  implicit fallback before work is accepted. Failure of a model that rejects
  image parts remains a request failure. Failover resends the image parts and
  question, respects expiry/timeout, and never reports success from a text-only
  replacement request.
- [ ] AC-12: Image and Finding services are explicitly injected into
  SubAgentServices, and their operations are thread-scoped. Existing subagents,
  persona assignment, capability checks, and scheduled-run isolation still work.
- [ ] AC-13: Successful Findings are stored exactly in SQLite before being
  returned. ContextAssembler and ContextRoller replay bounded historical Finding
  projections, including findings from failed main-agent runs, without relying
  on tool_results or inventing delivered messages. Rotation can summarize text;
  exact saved Finding lookup remains possible after rotation and file expiry
  without another model call. Persistence failures produce an error.
- [ ] AC-14: New Inspections and failover attempts fail at expiry. Startup and
  recurring cleanup delete expired Normalized files and orphaned temporary image
  copies; deletion failure is logged and retried. Unavailability errors identify
  the Image and offer re-upload recovery. Re-upload creates a new Image ID and
  deadline while old Image records, EXIF, and Findings remain accessible.
- [ ] AC-15: Pixel bytes, base64 image payloads, and media credentials are absent
  from the text prompts, message/queue payloads, summaries, and application logs
  produced by Talon's image feature for the main agent.
- [ ] AC-16: Focused tests cover the selection/availability tables, deterministic
  ordering, overflow and whole-Inspection failure, inline MIME/CID exclusion,
  sticker exclusion, animation rejection, GPS document ingestion, normalization,
  deduplication cleanup, startup/failover validation, exact Finding persistence
  and bounded replay, retention with controlled time, and text-only foreground
  operation. Build and startup checks pass. A deterministic channel-to-Inspection
  test does not claim to prove a real model's OCR accuracy.
- [ ] AC-17: README.md, config/talond.example.yaml, AGENTS.md, and affected setup
  skills use the glossary and document enablement, supported formats and upload
  types, limits, source order, normalized-only storage, metadata availability for
  photo versus document uploads, and re-upload recovery. They explicitly state
  that 24-hour retention deletes Normalized files while GPS, EXIF, OCR-derived
  Findings, and conversation text remain, including exposure in enabled groups.
