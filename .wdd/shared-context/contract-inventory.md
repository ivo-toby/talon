# Image processing contract inventory

Scope: [approved spec](../epics/image-processing/spec.md). Read existing
[knowledge](knowledge/image-processing.md) before external research.
This inventory separates observed contracts from proposed application interfaces.

Sources were fetched from the official npm registry at the versions in
[source-manifest.json](../epics/image-processing/research/source-manifest.json).
The lasting references are the primary URLs and the npm version/integrity pins
in source-manifest.json. Cache citations below record files actually opened and
line numbers actually read; /tmp locations are optional read caches and do not
survive reboot. Fetch the pinned tarballs or named protocol pages to reproduce a
missing citation; no worker may depend on the cache being present. Protocol
snapshots were extracted from the named primary pages.
The existing AI SDK, Baileys, and MailParser versions match package-lock.json;
Sharp 0.34.5 and exifr 7.1.3 are proposed new dependencies.

## External operations

| ID / operation | Request / input | Response / behavior consumed | Read citation |
| --- | --- | --- | --- |
| E1 Telegram image selection | Message.photo, Message.document, caption, caption_entities | photo is an array of PhotoSize with file_id/width/height/optional file_size; document supplies file_id and optional file_name/mime_type/file_size. Proposed selection: largest pixel area fitting the input/platform byte caps; unknown sizes need bounded download and smaller fallback on overflow. One Image per photo; preserve caption trigger entities | /tmp/talon-image-contracts/docs/telegram-api.txt:1766–1801,2525–2549,2635–2656,10310–10329; [primary API](https://core.telegram.org/bots/api#message) |
| E2 Telegram file lookup/download | getFile(file_id), then GET the returned download path using the connector token | General API envelope ok/result; result is File with file_id, file_unique_id, optional file_size/file_path. Preserve MIME/name from the original message; downloading returns bytes, not JSON | /tmp/talon-image-contracts/docs/telegram-api.txt:724–726,4254–4279,10310–10329; [getFile](https://core.telegram.org/bots/api#getfile) |
| E3 WhatsApp Business media metadata | GET https://graph.facebook.com/{configured-version}/{media-id}, optional phone_number_id; authenticated using existing connector token | Direct JSON envelope: url, mime_type, sha256, file_size, id, messaging_product in the primary v13 example. Only url is required by the proposed downloader; current-version response remains NOT READ and must be verified before its mapper is implemented | [Meta's current Postman request](https://www.postman.com/meta/whatsapp-business-platform/request/ptjyi84/retrieve-media-url); /tmp/talon-image-contracts/docs/meta-media-response.png, visually read [primary v13 example](https://whatsappbusiness.com/wp-content/uploads/2026/03/image4.png). The current Meta response reference returned an unavailable page |
| E4 Baileys media download | downloadMediaMessage(message, 'stream', {options: {signal}}, optional reupload context); normalize/extract wrapped content | Promise<Transform> for stream mode; buffer mode concatenates all chunks and therefore cannot enforce the limit during consumption. Destroy the stream on byte/deadline overflow; any transport retry shares the message deadline | /tmp/talon-image-contracts/whiskeysockets-baileys/7.0.0-rc.9/lib/Utils/messages.js:790–834 and lib/Utils/messages-media.d.ts:82–93 |
| E5 Email parsing | simpleParser(source) within existing whole-email fetch cap | parsed.attachments[] has filename?, contentType, contentDisposition?, size, content:Buffer, contentId/cid?, related?. Exclude inline or related parts before staging after connector authorization | /tmp/talon-image-contracts/mailparser/3.9.37/lib/simple-parser.js:37–78 and lib/mail-parser.js:999–1015; /tmp/talon-image-contracts/docs/mailparser.txt:434–469 |
| E6 Sharp metadata | sharp(ownedSource).metadata() | Promise of format, original width/height, orientation?, pages?/loop?/delay?, exif?:Buffer. Headers are not full pixel validation; conversion is still required. pages lists WebP support, not APNG detection | /tmp/talon-image-contracts/sharp/0.34.5/lib/input.js:566–602 and src/metadata.cc:104–110 |
| E7 PNG/APNG animation | Walk length-delimited PNG chunks with bounds checks; inspect acTL | acTL declares animation, including the valid single-frame case; num_frames and num_plays are unsigned four-byte values. Reject presence rather than relying only on pages > 1 | /tmp/talon-image-contracts/docs/png3.txt:4755–4786; [W3C PNG](https://www.w3.org/TR/png-3/#11acTL) |
| E8 EXIF parsing | exifr.parse(TIFF bytes, selected tag options), translateValues:false, reviveValues:false | Promise of loose tag data or undefined; validate as unknown in a local typed wrapper. Preserve DateTimeOriginal and OffsetTimeOriginal strings; latitude/longitude are derived from DMS/reference tags. Interpret GPSAltitudeRef explicitly | /tmp/talon-image-contracts/exifr/7.1.3/index.d.ts:9–53,65; src/file-parsers/tiff.mjs:12–15; src/segment-parsers/tiff-exif.mjs:333–345; src/dicts/tiff-exif-keys.mjs:25–30; src/dicts/tiff-gps-keys.mjs:5–11 |
| E9 EXIF default date handling | Default parser formatters | Defaults revive values; DateTimeOriginal revival uses a local JavaScript Date. Disable revival to avoid introducing the daemon's timezone into capture time | /tmp/talon-image-contracts/exifr/7.1.3/src/options.mjs:168–175 and src/dicts/tiff-revivers.mjs:18–22,48–61 |
| E10 JPEG normalization | autoOrient().resize(edge, edge, {fit:'inside', withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality}).toFile(ownedTemp) | Orientation including mirroring is applied; resize fits inside without enlargement; explicit JPEG encoding removes metadata by default. File result has format/size/width/height/channels | /tmp/talon-image-contracts/sharp/0.34.5/lib/operation.js:77–92, lib/resize.js:210–218, lib/output.js:38–46,62–70 |
| E11 Sharp timeout | timeout({seconds: positive integer}), alongside Talon's wall-clock deadline | Native timer starts at input processing and excludes waiting for a libuv thread; it cannot establish the whole-message deadline by itself. Fence late outcomes and discard their temporary output | /tmp/talon-image-contracts/sharp/0.34.5/lib/output.js:1445–1478 |
| E12 Vision SDK request/result | generateText({model, messages:[{role:'user',content:[text/ImagePart]}], maxOutputTokens, abortSignal, providerOptions}); ImagePart={type:'image',image:Buffer,mediaType:'image/jpeg'} | ImagePart supports Buffer; no URL download is needed. Result text and usage are returned; each model-chain attempt builds the complete request anew | /tmp/talon-image-contracts/ai-sdk-provider-utils/4.0.21/src/types/content-part.ts:27–50; /tmp/talon-image-contracts/ai/6.0.143/src/generate-text/generate-text.ts:205–230 and generate-text-result.ts:34–37,102–104 |
| E13 Vision SDK telemetry | experimental_telemetry with recordInputs:false for the vision call | Input recording otherwise defaults on. Existing subagent observations receive only question/IDs and textual Finding; do not export image buffers through SDK input tracing | /tmp/talon-image-contracts/ai/6.0.143/src/telemetry/telemetry-settings.ts:9–29; src/subagents/subagent-runner.ts:85–104 |
| E14 Sharp platform packages | Production npm installation must include the target's optional dependencies | Sharp 0.34.5 declares addon/libvips packages for Linux glibc and musl x64/arm64. Declarations are not executed platform proof; current Talon release builds amd64/arm64 node:24-slim targets and needs a native load/JPEG check inside each production build | /tmp/talon-image-contracts/sharp/0.34.5/package.json:146–170; deploy/Dockerfile:12–32; .github/workflows/release.yaml:44–49 |

## Existing Talon operations

| ID / operation | Observed input/result contract | Consequence / proposed extension | Read citation |
| --- | --- | --- | --- |
| I1 Attachment handoff | Attachment requires filename/mimeType/data/size; inbound attachments are optional; outbound shares Attachment | Add a backward-compatible inbound-only payload-or-rejection union; keep outbound payload requirements | src/channels/channel-types.ts:20–25,49–54,68–89 |
| I2 Admission / authoritative message | Message insert returns the existing authoritative row on duplicate; pipeline currently stops at any duplicate and enqueues after persistence/routing | Images need their own recovery ledger and conditional atomic completion, scoped to image-bearing messages | src/core/database/repositories/message-repository.ts:88–94; src/pipeline/message-pipeline.ts:143–212 |
| I3 SQLite transaction | BaseRepository.transaction executes a synchronous callback, rolls back on throw; repositories return Result errors | Coordinator must turn internal Err into rollback, catch at the boundary, and return a typed Result. Never await inside a transaction | src/core/database/repositories/base-repository.ts:78–82 |
| I4 Queue admission | enqueue(threadId,type,payload,messageId?) returns Result, generates a fresh queue UUID, and logs success immediately | Share the database transaction with the completion marker and defer the transactional success log until outer commit; rollback has no success log. Ordinary autocommit keeps existing logging | src/queue/queue-manager.ts:94–135 |
| I5 Async channel callback | Registered callback reads a synchronous pipeline Result today | Await the revised pipeline Result; concurrent platform handlers still have no thread-order guarantee | src/channels/channel-setup.ts:103–109; src/channels/connectors/whatsapp-baileys/whatsapp-baileys-connector.ts:261–273 |
| I6 Storage / lifecycle | ThreadWorkspace owns dataDir/threads/{thread}/attachments; daemon starts channels before queue and closes DB after shutdown | Add an owned image subtree and durable pre-thread staging; start recovery/cleanup before admission and stop/drain it before DB close | src/memory/thread-workspace.ts:43–60,90–104; src/daemon/daemon.ts:125–144,207–239 |
| I7 Effective model chain | Config overrides are followed by an implicit manifest model; resolver supports inference and text-only adapters | Validate every vision entry and retain image parts on all attempts; validate the actual loaded manifest after overrides | src/subagents/subagent-model-chain.ts:48–68; src/subagents/model-resolver.ts:22–24,53–91 |
| I8 Inspection provenance | ToolExecutionContext carries runId, but subagent invocation/context currently passes only thread/persona/policy identities | Thread trusted runId through the handler/runner/context; vision requires it rather than guessing an active run | src/tools/host-tools/subagent-invoke.ts:54–55,94–101; src/subagents/subagent-runner.ts:39–45,171–182 |
| I9 Service injection | SubAgentServices contains repositories but no Image/Finding service; bootstrap constructs its service bundle | Inject both services explicitly and update other fixtures/callers without granting a new persona capability implicitly | src/subagents/subagent-types.ts:79–98; src/daemon/daemon-bootstrap.ts:315–342 |
| I10 Context replay / resumed sessions | Assembler/roller project only body text; previous-context injection occurs only when no session is resumed. Codex stdin includes the system prompt in resumed turns; session token usage accumulates | Current-message descriptors go into live content; full inventory/Finding projection stays fresh-session/rotation-only. Deduplicate live IDs and share descriptor budgets; resumed older-data access uses image_lookup | src/daemon/context-assembler.ts:224–235; src/daemon/context-roller.ts:937–963; src/daemon/agent-runner.ts:552–559,720–733,1101–1111; src/providers/codex-cli-provider.ts:328–329 |
| I11 Tool names / exposure | Registry separates capabilityPrefix, internalName, and mcpName; filtering uses persona capabilities including approval-gated labels | Register image.read / image.lookup / image_lookup, enforce current-thread lookup, and derive hint availability from actual filtered tools | src/tools/tool-filter.ts:32–53,197–213; src/tools/host-tools-bridge.ts:628–646; src/tools/host-tools-mcp-server.ts:523–538 |
| I12 Email acknowledgement | Parsed messages are marked seen before the connector receives them | Existing pre-admission crash gap is unchanged; the new guarantees start at durable pipeline admission | src/channels/connectors/email/email-imap-client.ts:82–97,122–133; src/channels/connectors/email/email-connector.ts:419–445 |

## Executed probe and remaining verification

[Probe source](../epics/image-processing/research/normalization-probe.mjs) and
[results](../epics/image-processing/research/normalization-probe-result.json):
Node 24.15.0, Sharp 0.34.5, exifr 7.1.3; generated fixtures only, no model/channel calls.
JPEG and WebP raw EXIF have an Exif-zero-zero prefix; PNG raw EXIF starts with TIFF.
Removing that metadata prefix when present lets the same TIFF parser preserve
GPS, numeric orientation, raw capture time, and its offset in all three formats.
The normalized result is oriented 8×16 JPEG without EXIF.
A valid single-frame APNG converts while Sharp reports no pages: explicit acTL
inspection is required.

Reproduce with the pinned dependencies in a disposable directory and run:
TALON_IMAGE_PROBE_MODULE_ROOT=/tmp/talon-image-contracts/probe node
.wdd/epics/image-processing/research/normalization-probe.mjs.
The probe validates library behavior, not Talon's future implementation or OCR accuracy.

WhatsApp Business still needs current-version media response/download contract
verification before implementation. The current primary request was read, the
primary v13 response example was read, and the inaccessible current response
reference is explicitly NOT READ; no remembered response is presented as current.
The planner must make [this prerequisite](../epics/image-processing/research/whatsapp-business-prerequisite.md)
the first step of the Business task brief before any mapper code.
