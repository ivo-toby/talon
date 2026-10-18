# Design: Image processing through a vision subagent

## Components

Contract: [approved spec](spec.md); evidence: [contract inventory](../../shared-context/contract-inventory.md).
Deliver in dependency order (a) → (b) → (c).

| Wave | Component | Responsibility |
| --- | --- | --- |
| a | Attachment transport | Connector authorization/trigger checks, shared MIME/slot selection, 60-second bounded downloads, source staging, payload or closed rejection outcomes |
| a | ImageRepository + Ingestion coordinator | SQLite Images and image_ingestions; atomic owning-message/route admission and conditional enqueue/completion; one owner per message |
| a | ImageStore + ImageNormalizer | Owned file publication/cleanup; Sharp 0.34.5 JPEG conversion; exifr 7.1.3 selected metadata; explicit PNG/APNG/WebP animation rejection |
| a | Image lifecycle | Three persisted attempts per Image and message deadline; startup/redelivery/60-second recovery and retention sweep; fenced late results |
| b | vision subagent + chain validation | Assigned, capability-gated, one-shot multimodal Inspections; validate overrides and actual manifest fallback before work |
| b | FindingRepository | Exact findings and finding_images association table; winning model, trusted run provenance, question/text/uncertainty and reported usage |
| c | ImageContextProjection | Current-message descriptors in the live prompt; full inventory and Finding projections for fresh sessions and rotation |
| c | image.lookup host tool | Four model-free, current-thread operations under image.read:thread; paginated discovery and exact Finding retrieval |

## Interfaces

- **Configuration** — proposed images fields: maxInputBytes, maxPerMessage,
  maxPerInspection, maxEdge, jpegQuality, retentionHours; spec defaults apply.
  Fixed processing/recovery deadlines and retry bounds are constants. Existing
  subagents.vision.model overrides configure the vision chain; missing API
  credentials remain explicit invocation errors rather than implicit foreground routing.
- **Channel → pipeline** — keep outbound Attachment unchanged. Inbound
  attachments accept existing Attachment payloads or metadata-only rejections
  with a closed reason; array position supplies stable source order. Shared
  transport stages accepted bytes beneath dataDir/image-staging/{deliveryUuid}/;
  filenames remain metadata. Email stages only after sender/DMARC authorization.
  Telegram selects the largest photo by pixel area whose declared size fits the
  configured input limit and the Bot API's 20 MB download cap; unknown-size
  candidates need the same bounded byte check, with smaller renditions tried on
  overflow within the shared deadline. One photo creates one Image; all renditions
  confirmed oversized produce size_limit, while fetch failure/timeout produces
  download_failed. Preserve caption entities. Baileys unwraps
  supported message containers. The Business task's first step must verify the
  configured-version media contract under the recorded prerequisite below.
- **Admission → recovery → queue** — Images are unique by (message_id, ordinal).
  Persist route/persona, receivedAt, expiresAt, processingDeadline, attempts and
  source references in the initial message/Image/Ingestion transaction. One
  message owner joins duplicate delivery; no thread barrier. Coordinator converts
  repository Err to transaction rollback internally and returns Result externally.
  QueueManager.enqueue and completion commit on the same connection; completed
  and unrouted duplicates clean only newly delivered staging. Audit mutations
  and cleanup with IDs/reasons and sanitized errors, without pixels or credentials.
  Transactional enqueue defers its success log until the outer transaction has
  committed; rollback emits no "queue item enqueued" success. Ordinary autocommit
  enqueue retains its existing logging behavior.
- **Normalization → storage** — parse Sharp's raw EXIF as TIFF after removing an
  Exif-zero-zero prefix when present; select tags and disable parser value/date
  conversion. Validate unknown parser output into a typed metadata DTO.
  Normalize with autoOrient, fit-inside/no-enlargement, white flatten, JPEG quality.
  Retain decoder limits; combine native timeout with the persisted wall deadline.
  Write an attempt-owned temporary output; a guarded synchronous publish/DB
  transaction checks Processing/attempt ownership and both deadlines before
  renaming and recording Available. Crash/rollback remnants are reconciled.
  Normalized path: dataDir/threads/{threadId}/attachments/images/{imageId}.jpg.
  Source cleanup follows committed outcomes; stale attempts cannot publish.
- **Inspection → Finding** — subagent_invoke(name='vision', input={imageIds,question}).
  Trusted runId flows from host-tool context through runner/context; other
  subagents can retain optional provenance, vision rejects missing provenance.
  Services resolve current-thread files at every attempt. SDK messages contain
  Buffer image parts marked image/jpeg, with abort/provider options forwarded.
  Disable SDK image input tracing. Validate the textual answer/extractedText/
  uncertainty result and recheck abort before persisting one canonical Finding;
  a timed-out attempt cannot save a late Finding. Return
  {findingId,imageIds,answer,extractedText,uncertainty,model,usage} as text/data.
- **Live message** — AgentRunner resolves Images by the trusted current message
  and thread, refreshes availability, and appends their descriptors to the live
  content passed to every provider. Keep stored message/queue text unchanged;
  owning-message associations rebuild descriptors for retries. Descriptors follow
  source order and enter provider history with that image-bearing message.
  Subsequent text-only resumed turns add no image inventory or Finding projection.
  A queue/provider retry follows the existing live-message retry behavior; this
  does not promise exactly-once insertion into an external provider's session log.
- **Replay** — ContextAssembler builds the full inventory/Finding projection only
  when foreground history is injected into a fresh session; ContextRoller builds
  it for rotation. Skip already-live Image IDs and share the descriptor count/
  character budget between live descriptors and fresh inventory; live descriptors
  take priority within the spec's existing limits. Findings retain their separate
  budget. Resumed sessions use image_lookup for older Images/Findings and current
  availability; historical descriptors are snapshots with their original expiry.
  Query Findings independently of message cutoffs. Hints depend on tool exposure,
  and schedules retain their existing context isolation. Record the placement
  decision in [ADR-0002](../../../docs/adr/0002-image-context-placement.md).
- **Lookup** — operation plus the spec's ID/limit/cursor fields. List results:
  {images,nextCursor} or {findings,nextCursor}; single results: {image} or {finding}.
  Capability prefix image.read maps to internal image.lookup and MCP image_lookup.
  Derive thread from trusted context for every operation; no pixel/file-path output.
  Bind cursors to operation/filter/thread and sort by time descending, ID ascending.

## Integration surfaces

- `package.json` — owned by: new Sharp/exifr dependency declarations.
- `package-lock.json` — owned by: pinned native/parser dependencies for all released container architectures.
- `src/images/**` — owned by: inbound outcomes, selection/transport, files, normalization, lifecycle, metadata and projection services.
- `src/core/database/migrations/*` — owned by: Images, Ingestion and Finding tables, keys and thread indexes.
- `src/core/database/repositories/*` — owned by: new repositories, transaction coordination and exports.
- `src/core/config/*.ts` — owned by: image defaults/validation and vision override validation.
- `src/channels/*.ts` — owned by: inbound typing, injected transport/settings and awaited callback.
- `src/daemon/channel-factory.ts` — owned by: media transport injection into scoped connectors.
- `src/channels/connectors/telegram/**` — owned by: photo/document download, captions and authorization.
- `src/channels/connectors/whatsapp-business/**` — owned by: verified media API mapper and authorized image delivery.
- `src/channels/connectors/whatsapp-baileys/**` — owned by: streaming media downloads, wrappers and existing sender/group rules.
- `src/channels/connectors/email/**` — owned by: attachment parsing, exclusions and staging after authorization.
- `src/pipeline/*.ts` — owned by: image-only atomic admission/recovery and handoff.
- `src/queue/queue-manager.ts` — owned by: transactional enqueue and deferred success logging after commit.
- `src/memory/thread-workspace.ts` — owned by: owned normalized-image subtree.
- `src/daemon/daemon*.ts` — owned by: service wiring, startup recovery and bounded shutdown before DB close.
- `src/subagents/default/vision/**` — owned by: one-shot multimodal Inspection and canonical Finding production.
- `src/subagents/subagent-types.ts` — owned by: Image/Finding services and trusted run provenance.
- `src/subagents/subagent-runner.ts` — owned by: provenance propagation and fixture compatibility.
- `src/subagents/subagent-model-chain.ts` — owned by: complete-chain vision validation and attempt fencing.
- `src/subagents/model-resolver.ts` — owned by: exporting the inference/subscription/sandboxed provider classifications used by vision chain validation (no duplicated lists).
- `src/tools/host-tools/*.ts` — owned by: lookup handler/exports and subagent run provenance.
- `src/tools/tool-filter.ts` — owned by: image.read capability catalog and lookup exposure.
- `src/tools/host-tools-bridge.ts` — owned by: authenticated lookup dispatch.
- `src/tools/host-tools-mcp-server.ts` — owned by: lookup request schema.
- `src/daemon/agent-runner.ts` — owned by: current-message descriptors in live content for every provider; preserve fresh-session-only history injection.
- `src/daemon/context-assembler.ts` — owned by: bounded inventory/Finding replay without duplication.
- `src/daemon/context-roller.ts` — owned by: image projections within rotation budgets.
- `templates/assistant/system.md` — owned by: vision/read persona guidance.
- `templates/tool-instructions/image.read.md` — owned by: lookup instructions, including that descriptors from earlier turns are snapshots whose availability may be stale; get_image returns current state.
- `templates/tool-instructions/subagent.invoke.md` — owned by: vision input shape, distinction between Inspection and saved-Finding lookup, and that an expiry/unavailable error means asking the user to re-upload.
- `config/talond.example.yaml` — owned by: image defaults and paired vision/read enablement example.
- `README.md` — owned by: supported uploads, metadata, limits, retention and recovery documentation.
- `AGENTS.md` — owned by: architecture and module documentation.
- `CLAUDE.md` — owned by: the corresponding Claude architecture and module documentation.
- `.agents/skills/*/SKILL.md` — owned by: affected setup/profile/Telegram/WhatsApp/email walkthroughs.
- `.claude/skills/*/SKILL.md` — owned by: matching image-feature guidance in the separate Claude skill copies.
- `deploy/Dockerfile` — owned by: Sharp production installation/normalization check on each build target, and copying templates/ into the builder stage before `npm run build` (today the build script's template copy silently no-ops in Docker).
- `.github/workflows/release.yaml` — owned by: verification that both published amd64/arm64 Talon builds execute the native check.
- `tests/unit/deploy/dockerfile.test.ts` — owned by: Docker build contract and a regression assertion that dist/templates/tool-instructions includes image.read.md.
- `tests/unit/**` — owned by: task-focused contract, crash, permission and native normalization verification.
- `tests/integration/e2e/image-processing.test.ts` — owned by: deterministic whole-feature proof.

## Epic deliverable

- Observable proof: mocked authorized channel uploads reach the real pipeline,
  SQLite queue and Sharp processing; a deterministic vision adapter receives JPEG
  pixels and produces a canonical Finding; rotation/restarted sessions discover
  uninspected Images, lookup retrieves exact Findings, and controlled-time expiry
  removes files while preserving text and refusing a new Inspection.
- Resumed Codex proof: one image-bearing message adds its own descriptors;
  subsequent text-only queries add no full inventory/Finding projection to stdin.
  Older Images/Findings remain reachable through capability-gated lookup.
- Deliverable command: npx vitest run tests/integration/e2e/image-processing.test.ts.
- Required gates: npm run build; task-specific focused tests; CLI startup check
  and the ratified no-cost daemon/terminal smoke. No live model call is needed to
  prove routing; these tests do not claim OCR accuracy.
- Packaging gate: release currently uses node:24-slim for linux/amd64 and
  linux/arm64 (glibc). Each production target must load Sharp and normalize a
  tiny JPEG during its build; the host smoke is not proof of another architecture.
  Sharp's pinned package declares glibc and musl x64/arm64 binaries. If an Alpine/
  musl target is introduced, it must pass the same native check before support
  is claimed. This check runs only on release-tag builds, so an arm64 Sharp
  regression surfaces after merge; that is an accepted trade-off unless a
  PR-time image build is added later. Document-copies checks compare new image guidance in both skill
  trees while preserving their existing agent-specific content.
- Planner prerequisite: the WhatsApp Business brief must begin with the exact
  first step in [its research prerequisite](research/whatsapp-business-prerequisite.md).
