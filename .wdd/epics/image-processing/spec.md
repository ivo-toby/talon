# Spec: Image processing through a vision subagent

## Goal

Users upload images through Telegram, WhatsApp, or email and discuss their
contents with Talon. A configurable vision subagent answers Inspections with
textual Findings. Images, metadata, and Findings remain in the conversation
after Normalized files expire, by default 24 hours after receipt.

## In scope

Use the vocabulary in [CONTEXT.md](../../../CONTEXT.md). Plan three sequential
waves: **(a) ingestion and storage → (b) Inspection → (c) replay and lookup**.
The contracts below are authoritative; acceptance criteria verify them.

**(a) Ingestion and storage**

Support Telegram photos/documents, WhatsApp Business and Baileys images/documents,
and email image Attachments. Preserve captions/text and existing sender, chat,
bot, group, and trigger policies; eligible image-only messages can start a run.
Separate media downloads follow authorization. Email keeps its bounded fetch
and MIME parsing before sender/DMARC checks; unauthorized parts are not normalized.

Match declared MIME case-insensitively without parameters. Channel photo/image
payloads may supply their known image MIME; document filenames do not establish MIME.

| Delivered item | Outcome | Uses an upload slot |
| --- | --- | --- |
| Photo, ordinary image message, image-MIME document/email Attachment | Evaluate as an Image | Yes |
| Unsupported image MIME, including HEIC or SVG | Rejected/unsupported_mime | Yes |
| Document/email part with absent or non-image MIME | Exclude silently | No |
| Email part marked inline or classified as related CID content, including inline photos | Exclude silently | No |
| Platform sticker, including static WebP | Exclude silently | No |
| Another size/thumbnail of the same photo | Not another Image | No |

Ordinary WebP documents are eligible; do not guess whether they were stickers.
Telegram album members remain separate messages. Eligible Attachments receive
slots in source order. Overflow is Rejected/count_limit without a separate
download; a failure within a slot does not admit a later Attachment.

| Configurable setting | Default |
| --- | --- |
| Input bytes per Image | 10 MiB |
| Upload slots per message / Image IDs per Inspection | 5 / 5, independent settings |
| Longest Normalized file edge / JPEG quality | 4,096 pixels / 85 |
| Normalized file retention | 24 hours |

Validate positive byte/count/edge/retention settings and JPEG quality from 1–100.
Check actual bytes during separate downloads and before staging email buffers
or converting; declared sizes alone are insufficient. Email's unchanged 10 MiB
whole-message cap includes encoding, headers, body, and every part. Base64 leaves
less than roughly 7.5 MiB for one decoded image before other overhead; docs must
state the lower practical email limit. Oversized whole emails keep existing
pre-ingestion skipping behavior.

Accept JPEG, static PNG, and static WebP. Reject animation explicitly, including
WebP frame information and PNG/APNG animation-control information even when
Sharp reports only one frame. Extract EXIF before conversion, apply orientation,
preserve aspect ratio without cropping/upscaling, flatten alpha on white, and
encode metadata-free JPEG. Keep Sharp's native input limits enabled. Remove
source and failed/uncommitted output files when no longer needed for recovery.
Use MIME checks and Sharp decoding without a separate extension/signature scanner.

Rejection reason is a closed list; no connector-specific values are permitted:

| Reason | Meaning |
| --- | --- |
| unsupported_mime | Eligible image MIME is outside the supported formats |
| count_limit | Eligible Attachment exceeds the message's upload slots |
| size_limit | Declared or actual input bytes exceed the per-Image limit |
| animated | Input is an animated image, including APNG |
| download_failed | Channel media fetch fails or times out |
| conversion_failed | Input cannot be decoded/normalized, including decoder input-limit failures |
| processing_interrupted | Recovery has no usable source before the processing deadline |
| processing_failed | Operational retries are exhausted or the processing deadline elapses |

Exclusions and slot selection precede supported-format, size, animation, and
conversion checks.
Overflow always receives count_limit; a download byte overflow receives
size_limit. Invalid input fails immediately as conversion_failed; operational
failures may retry under the limits below. Inspection/provider failures do not
change an Available Image into a Rejected Image.

Connectors select Attachments and fetch bounded media; they do not run Sharp
or write Image records. MessagePipeline owns Ingestion through an injected
service, and its channel callback returns an awaited Promise through enqueue.
For each image-bearing message:

1. In one SQLite transaction, persist/load the authoritative message using its
   channel-scoped idempotency key and record its route. For a routed message,
   create ordered Images and pending Ingestion with recovery source references;
   insert the message before its Images. No route records a terminal admission
   outcome with no Images/pending Ingestion and removes staging without normalization.
2. For routed messages, complete processing inline to Available, Rejected, or Unavailable outcomes.
   Processing is internal and never appears in queued-message descriptors.
3. In one transaction, enqueue and mark Ingestion complete. Repeated recovery
   cannot create another queue item; purging that item does not reopen Ingestion.

Only image-bearing messages receive the new recovery/completion records.
There is no thread-wide admission barrier or pending record for later text
messages. Overlapping connector callbacks and recovered messages may enqueue
in completion order; no cross-handoff ordering guarantee is introduced. Sequential
awaited handoffs complete processing before their caller delivers the next event.
This is an accepted trade-off: a sequential connector (for example Telegram
polling or email) waits for each image-bearing message's fetch and normalization
deadlines, up to roughly 120 seconds, before delivering events for any chat or
thread on that connector.

Remote media fetching has a fixed 60-second deadline per message, including
retries. After durable admission, normalization has a separate fixed 60-second
deadline for the entire message and at most three attempts per Image. Persist
that deadline and increment attempts before each attempt; neither redelivery
nor restart resets them. Exhaustion resolves unfinished Images as
Rejected/processing_failed and enqueues the message with its text and descriptors.
Late fetch/conversion results cannot overwrite terminal outcomes and are cleaned.

Startup, redelivery, and a sweep at most every 60 seconds recover pending
Ingestion without competing with an active owner of the same message. The first
four rows below apply only to Processing Images, including inline processing:

| Condition, checked in this order | Resolution |
| --- | --- |
| Image expiry elapsed | Unavailable/expired; remove remaining source/output copies |
| Processing deadline or attempt limit exhausted | Rejected/processing_failed |
| Before both deadlines, retained or redelivered source available | Resume with the same Image ID and remaining attempt/time budget |
| Before both deadlines, no usable source | Rejected/processing_interrupted |
| Outcomes resolved, not enqueued | Refresh availability; enqueue and mark complete atomically |
| Ingestion complete or intentionally unrouted | No enqueue; remove only new duplicate staging |

A crash consumes its started attempt. Resolved Images keep their outcomes;
recovery must not re-normalize them. Admission rollback leaves no committed
message without its recovery record. Recovery cleans orphaned staging and
uncommitted outputs. Database write failures return explicit pipeline errors;
pending records are recovered when writes resume, subject to the same deadlines.

Store Images in SQLite with globally unique IDs, exactly one owning thread,
owning message/source order, metadata, state/reason, receipt, and expiry.
Create one Image per owning message/source position; redelivery reuses it.
Normalized files use the existing per-thread storage area. Receipt means first
durable pipeline admission on the local clock, independent of platform/EXIF
timestamps. Access, retries, and restart never extend expiry.

| State | Availability contract |
| --- | --- |
| Processing | Internal until Ingestion resolves; no Inspection or lookup access |
| Available | Inspection permitted only with an existing Normalized file before expiry |
| Rejected | Terminal; exactly one reason from the rejection table |
| Unavailable | Terminal; reason exactly expired or file_missing; uniform re-upload recovery |

Refresh availability before every projection, lookup, or Inspection. Expiry
takes precedence when first establishing unavailability; retain an already
recorded unavailability reason. Queue backlog/backoff may mean the first run
already sees Unavailable/expired. Re-upload creates a new Image ID/deadline.

Delete expired files and orphaned image copies at startup and at most every
60 seconds; log/retry deletion failures without restoring availability. An
Inspection that loaded bytes before expiry may finish within its timeout, but
no new attempt/failover begins after expiry. Cleanup need not wait for it.
File retention does not delete Image records, GPS/EXIF, Findings, or conversation
text; these remain until separately deleted. It does not govern model-provider retention.

Automatically expose dimensions and selected EXIF as Image data: GPS
latitude/longitude/altitude, capture time and recorded offset, camera make/model,
and original orientation. Missing values are unknown; do not invent location or
timezone. Distinguish EXIF location from a model's inferred location.
Telegram/WhatsApp photos can lose EXIF; docs recommend original image documents
or email Attachments when metadata matters, without guaranteeing preservation.
Automatic metadata exposure applies to groups admitted by existing connector
group/trigger settings; there is no new Image/GPS group switch. Docs state that
GPS and OCR-derived personal data persist after file expiry and may appear in group responses.

**(b) Inspection and Findings**

Add a built-in vision subagent using existing persona assignment and
subagent.invoke permission. An Inspection requires a nonempty question and
one to the configured maximum distinct current-thread Image IDs. Excess,
duplicate, unknown/cross-thread, Processing, Rejected, or Unavailable IDs fail
the whole call before a model request. Do not accept paths/URLs or truncate the list.

Only anthropic, openai, google, and ollama adapters are permitted in its chain.
Config loading rejects text-only vision overrides; startup validates the
loaded manifest and entire effective chain, including the implicit manifest
fallback, before channel work. Reject a chain containing claude-code or
codex-sandbox rather than silently skipping entries. Other subagents are unchanged.

A model that rejects image parts is an ordinary request failure, without a
model-name capability registry. Every failover uses an independent request with
the question and all image parts, rechecks availability, and honors existing
timeouts/abort behavior. Never drop pixels to obtain a successful answer.
Exhaustion creates no Finding. Missing setup and denied access return explicit errors.

Widen SubAgentServices with thread-scoped Image/Finding services and update DI
and existing fixtures. Persist successful Findings exactly in a dedicated
SQLite store before returning them: globally unique Finding ID, owning thread/run,
source Image IDs, question, answer, extracted text, uncertainty, creation time,
producing model, and reported token usage. Persistence failure returns an error.
A Finding creates no synthetic inbound/outbound message.

The main provider receives text, never pixels through this feature, independent
of its vision support. Pixel bytes, base64 payloads, and download credentials
must not enter main-agent text prompts, durable message/queue content, summaries,
or application logs. This routing follows [ADR-0001](../../../docs/adr/0001-vision-subagent.md).

**(c) Replay and lookup**

An Image descriptor contains Image ID, owning message/source order, receipt and
expiry, current state/reason, filename/MIME, dimensions, and selected EXIF.
It exposes no pixel bytes, local path, staging reference, or media credentials.

Use one Image descriptor inventory, rebuilt from current-thread records for
each foreground ContextAssembler and ContextRoller input, independent of the
message rotation boundary. There is no separate saved Image ID reference list.
Query canonical Findings independently of message cutoffs, including Findings
from failed runs or arriving during summarizer latency. Present selected
Findings chronologically with source IDs and frame all projections as historical data.

| Automatic projection, in both paths | Fixed limit |
| --- | --- |
| Image descriptor inventory | Newest 20 non-Processing Images, at most 1,000 characters per descriptor and 8,000 total |
| Finding projections | Newest 10 Findings, at most 2,000 characters per projection and 8,000 total |

Select newest first by timestamp descending, then ID ascending. Budgets include
framing and truncation notices, measured by JavaScript string.length, and count
toward enclosing context budgets. Include complete entries that fit; clip optional display text
rather than descriptor IDs/state/expiry. Preserve Finding IDs and mark excerpted
text or omitted Image references. Canonical records are unchanged.
Rotation may summarize prose; subsequent inventories remain freshly rebuilt.
Omitted Images/Findings remain discoverable through lookup. Show a hint naming
image_lookup only when that tool is exposed to the persona; otherwise give a
neutral omission notice without suggesting an inaccessible tool.

Add host tool image.lookup, exposed as image_lookup, under image.read:thread.
Its trusted context supplies the thread; every operation enforces ownership and
the read capability. It needs no vision assignment, subagent.invoke permission,
model credentials, pixel access, channel download,
or model call; it creates no Finding.

| Operation | Request fields beyond operation | Result |
| --- | --- | --- |
| list_images | Optional limit, cursor | Current descriptors; includes uninspected/Rejected/Unavailable Images, excludes Processing |
| get_image | imageId | Current descriptor |
| list_findings | Optional imageId, limit, cursor | Finding IDs, Image IDs, questions, times, models; optional current-thread Image filter |
| get_finding | findingId | Exact canonical Finding, including answer, extracted text, uncertainty |

Lists default to 20 entries, allow 1–100, sort receipt/creation descending then
ID ascending, and return nextCursor, null when exhausted. Opaque cursors are scoped to
operation/filter/thread. Unknown, cross-thread, and Processing Image IDs return
the same not-found error; Rejected/Unavailable Images permit text lookup.

## Out of scope

- Native multimodal main-provider delivery, resumable vision sessions, or changes
  to subscription CLI/Codex sandbox protocols and containment.
- Other channels, stickers, inline email images, HEIC/HEIF, APNG/other animation,
  SVG, PDF, video, image generation/editing, arbitrary URLs, or remote email images.
- Malware scanning, a sandboxed decoder service, separate OCR, reverse geocoding,
  restoring stripped EXIF, original-file retention, or automatic re-download.
- Timed deletion of metadata/Findings/conversation text, external-provider
  retention, album coalescing, model-name capability registries, verbatim
  pinning of every Finding in active context, or scheduled-run context changes.
- Durable per-thread admission ordering or a pending ledger for text-only
  messages. Their existing persist-before-enqueue crash gap remains: redelivery
  can treat an unenqueued persisted text-only message as a duplicate.

## Acceptance criteria

- [ ] AC-1: All scoped connectors preserve text, existing authorization/triggers,
  and image-only handoff; unauthorized email never enters Image normalization.
- [ ] AC-2: Selection-table fixtures exclude non-image/missing MIME, inline/CID
  parts, stickers, and duplicate photo sizes without records, notices, or slots.
- [ ] AC-3: Source-order slots, failed-slot consumption, visible overflow without
  download, actual byte limits, and whole-email skipping/overhead match part (a).
- [ ] AC-4: Static-format fixtures verify orientation, dimensions, aspect ratio,
  no crop/upscale, white alpha, JPEG encoding, and stripped output EXIF;
  animated WebP and APNG are Rejected/animated despite convertible first frames.
- [ ] AC-5: Config tests cover every configurable default/override and invalid
  value in part (a), including independent upload/Inspection counts.
- [ ] AC-6: Pipeline processing follows atomic admission and the awaited handoff,
  owns normalization, and enqueues no Processing Image. Connector tests do not
  assume concurrent callbacks preserve per-thread arrival order.
- [ ] AC-7: Redelivery/restart preserves IDs/expiry and cleans duplicate staging.
  Atomic enqueue/completion survives crash tests without lost or repeated queue
  items; completed Ingestion stays complete after queue-item removal.
- [ ] AC-8: Document/email EXIF fixtures preserve selected GPS/time metadata;
  photo fixtures without EXIF produce unknown values. Authorized groups receive
  metadata under existing settings; no new group switch or invented timezone exists.
- [ ] AC-9: Vision receives pixels and returns a persisted Finding/usage when
  called from a text-only foreground persona.
- [ ] AC-10: Every invalid Inspection case in part (b) fails the whole call
  before requesting a model, without truncation or path/URL acceptance.
- [ ] AC-11: Override/manifest/implicit-fallback validation rejects text-only
  chains; valid failover retains all image parts, expiry checks, and timeouts.
- [ ] AC-12: Thread-scoped Image/Finding service injection preserves existing
  subagents, persona/capability enforcement, and scheduled-run isolation.
- [ ] AC-13: Exact SQLite Findings survive failed main runs, rotation, and file
  expiry; both context paths use the stated Finding count/character budgets,
  include late Findings, and return errors on Finding persistence failure.
- [ ] AC-14: Controlled-time tests cover expiry before first run, missing files,
  cleanup retries, failover at expiry, uniform re-upload errors, and new IDs.
- [ ] AC-15: Main-agent payloads/history/summaries/logs contain no image pixels,
  base64 payloads, or download credentials supplied by this feature.
- [ ] AC-16: Focused tests cover all closed rejection/unavailability reasons,
  permanent versus operational failures, attempt exhaustion, and deadline timeout;
  deterministic channel-to-Inspection tests pass with build and startup checks.
- [ ] AC-17: README.md, config/talond.example.yaml, AGENTS.md, relevant persona
  templates, and affected setup/channel skills document all part (a)–(c) contracts.
  The vision-enabled persona example/template and setup add image.read:thread
  alongside vision assignment/invocation, explain explicit enablement for existing
  personas, and state file-only retention, lower email limits, group exposure,
  and that slow image Ingestion delays other chats on a sequential connector.
- [ ] AC-18: Both context paths meet the descriptor count/character budgets.
  Rotation retains discovery of uninspected Images through the fresh inventory
  or permitted lookup; an unpermitted persona never receives an image_lookup hint.
- [ ] AC-19: The four lookup operations enforce ownership, separate permissions,
  pagination/cursor scoping, and exact Finding retrieval without vision/model access.
- [ ] AC-20: Recovery-table tests cover admission/enqueue transaction crashes,
  interrupted/missing source, startup without redelivery, active-owner exclusion,
  shared attempt/deadline budgets across restart/redelivery, late-result cleanup,
  and resolved outcomes enqueueing despite processing failure.
