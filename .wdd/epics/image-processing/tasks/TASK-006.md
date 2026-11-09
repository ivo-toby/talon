# TASK-006: Telegram photo and image-document ingestion

## Objective

Pass authorized Telegram photos and image documents with their caption through shared image transport.

Wave (a); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

Photo/document-only messages and captions reach the inbound callback with one photo Image candidate and bounded authorized downloads.

## Interfaces

Consumes:

TASK-004 transport/selection API; inventory E1/E2 and pinned primary Telegram request/response contracts; existing bot/chat/group/trigger checks.

Produces:

Telegram inbound Attachments/outcomes preserving caption entities and stable idempotency keys.

## Scope

- Preserve existing sender/chat/bot/group/trigger behavior before separate media downloads; use caption/caption_entities for existing mention rules and retain textual captions.
- Choose largest pixel area fitting both configured bytes and Telegram getFile 20 MB cap. Unknown-size choices use bounded actual-byte checks and smaller fallback on overflow within the same deadline. One photo creates one candidate; albums remain separate messages.
- Exclude stickers; use document declared MIME rather than extension. Static WebP documents remain eligible. If all photo renditions are confirmed oversized return size_limit; fetch failure/deadline is download_failed.
- Pin exact getFile request, ok/result response mapping and file_path byte download to E2; sanitize token-bearing error URLs. Test denial makes no separate media request.

## Non-scope

No album aggregation, image records, normalization or Telegram platform API changes.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-004

## Conflict domains

- `src/channels/connectors/telegram/**`
- `tests/unit/channels/connectors/telegram/**`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/channels/connectors/telegram/telegram-connector.test.ts tests/unit/channels/connectors/telegram/telegram-bot-filter.test.ts tests/unit/channels/connectors/telegram/telegram-images.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: E1/E2 primary Bot API envelopes/fields are the independent conformance oracle; use literal frozen wire fixtures and exact request assertions, plus unchanged startup smoke.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
