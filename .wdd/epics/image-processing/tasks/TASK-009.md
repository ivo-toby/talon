# TASK-009: Email image attachments after authorization

## Objective

Carry parsed ordinary image attachments through authorization and stage only admitted senders' content.

Wave (a); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

Authorized email attachments reach shared transport; inline/related/non-image parts consume no image slots and unauthorized emails stage no images.

## Interfaces

Consumes:

TASK-004 selection/staging; inventory E5/I12 and actual MailParser 3.9.37 attachment shape; existing sender and DMARC checks.

Produces:

Parsed email metadata/attachment forwarding and authorized bounded staging with preserved body text.

## Scope

- Keep whole-message 10 MiB fetch cap and pre-authorization parse behavior. Forward only needed attachment fields from simpleParser; do not stage/normalize until existing sender/DMARC checks pass.
- Exclude contentDisposition inline or related CID parts, including inline photos; exclude absent/non-image MIME attachments silently before slots. An ordinary image attachment with a content ID alone must follow its actual inline/related classification.
- Use declared contentType, actual Buffer length and source order; shared selection caps upload slots and bytes before staging. Preserve email body/caption-equivalent text and allow authorized image-only messages.
- Pin parsed attachment fields to E5 and make tests assert no staging for denied senders/failed DMARC. Keep pre-admission IMAP seen/dispatch semantics unchanged.

## Non-scope

No increase to whole-email cap, MIME parse reordering, remote CID fetching or PDF support.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-004

## Conflict domains

- `src/channels/connectors/email/**`
- `tests/unit/channels/connectors/email/**`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/channels/connectors/email/email-imap-client.test.ts tests/unit/channels/connectors/email/email-connector.test.ts tests/unit/channels/connectors/email/email-images.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: E5 literal MailParser fixtures and existing sender/DMARC tests are independent conformance evidence; unchanged startup smoke is required.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
