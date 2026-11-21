# TASK-007: Baileys streamed image ingestion

## Objective

Deliver authorized Baileys image messages/documents without buffering an unbounded media download.

Wave (a); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

Supported wrapped images/documents use Baileys stream mode and preserve text and current sender/group/self filtering.

## Interfaces

Consumes:

TASK-004 transport; inventory E4 and installed Baileys 7.0.0-rc.9 source pinned in the manifest; existing connector policies.

Produces:

Bounded inbound image Attachments/outcomes from unwrapped Baileys payloads.

## Scope

- Read pinned normalize/extract and downloadMediaMessage signatures before coding. Unwrap supported message containers and preserve captions; exclude stickers and non-image documents.
- Run existing authorization/self/group/trigger rules before media requests. Feed downloadMediaMessage stream mode into the shared bounded consumer; destroy streams on actual byte/deadline overflow.
- Share retry/reupload fetch budget within the message. Image-only messages may invoke the callback; concurrent handlers are allowed to enqueue in processing completion order.
- Pin wrapper/media fields and stream invocation arguments to the source contract; failures retain closed reasons without credentials or pixel logging.

## Non-scope

No Baileys dependency upgrade, invented wrapper shapes, queue ordering barrier or normalization in connector.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-004

## Conflict domains

- `src/channels/connectors/whatsapp-baileys/**`
- `tests/unit/channels/connectors/whatsapp-baileys/**`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/channels/connectors/whatsapp-baileys/whatsapp-baileys-connector.test.ts tests/unit/channels/connectors/whatsapp-baileys/whatsapp-baileys-rejection-matcher.test.ts tests/unit/channels/connectors/whatsapp-baileys/whatsapp-baileys-images.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: E4 pinned Baileys implementation is the independent conformance oracle; assert stream invocation and wrapper extraction against its actual signatures, plus unchanged startup smoke.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
