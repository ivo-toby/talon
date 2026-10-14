# TASK-008: WhatsApp Business verified media ingestion

## Mandatory first step

1. Verify the current primary media contract for the connector's configured
   apiVersion. Read and cite the media-ID lookup request, authentication headers,
   response envelope and fields consumed by the mapper, and the download-URL
   request/authentication/byte response. Record the version and actual source
   file/line references in research. Do not derive the mapper from the v13
   screenshot: it is historical evidence, not a verified current response.

If unreadable, mark NOT READ and report NEEDS_CONTEXT before mapper implementation. Read research/whatsapp-business-prerequisite.md from the supplied snapshot.

## Objective

Implement authorized Business image/document delivery only after reading the configured-version media contract.

Wave (a); integration or contract work. Implementation and review models inherit the ratified risk-tiered WDD configuration.

## Deliverable

Verified metadata lookup and bounded byte download preserve text/captions and existing webhook authorization/group rules, with documented primary contract evidence.

## Interfaces

Consumes:

Mandatory research prerequisite, TASK-004 transport, E3 and source manifest; existing connector apiVersion/token/webhook checks.

Produces:

Business Attachments/outcomes and a durable verified-contract report used by the reviewer.

## Scope

- Begin with the exact prerequisite at the start of this brief; it is a gate before any media mapper code. Record read request/response fields, version and actual primary citations in the new verified-contract report, not the already-approved research files.
- Use the connector configured apiVersion and existing token; verify metadata authentication and direct response envelope before selecting the download URL. Verify byte-download authentication and response separately.
- Preserve webhook/sender/chat/group/trigger authorization before metadata/download calls. Exclude stickers and non-image documents, preserve captions, and allow image-only eligible handoff.
- Bound both metadata/download time by the shared fetch deadline; enforce actual bytes using shared streaming transport. Test exact URLs/headers/envelope mapping from verified primary fixtures.
- If the current contract remains unreadable, report NEEDS_CONTEXT to the controller and retain NOT READ; never implement from the historical v13 screenshot. Do not edit fingerprinted research/inventory artifacts.

## Non-scope

No operator credentials or live API call merely for public contract reading; no invented current response fields or channel policy changes.

## Files to read first

Read the immutable brief/context snapshot paths supplied by the controller. Read the named inventory rows and actual reference files before coding their contracts; /tmp cache is optional and reproducible from the pinned source manifest. Read the glossary/accepted ADR copies in shared-context/image-processing-domain.md from the supplied snapshot, then the relevant existing source/tests inside the declared domains.

## Dependencies

TASK-004

## Conflict domains

- `src/channels/connectors/whatsapp-business/**`
- `tests/unit/channels/connectors/whatsapp-business/**`
- `.wdd/epics/image-processing/research/whatsapp-business-verified-contract.md`

## Verification

Run these commands on the task branch after implementation:

```bash
npm run build
npx vitest run tests/unit/channels/connectors/whatsapp-business/whatsapp-connector.test.ts tests/unit/channels/connectors/whatsapp-business/whatsapp-webhook-server.test.ts tests/unit/channels/connectors/whatsapp-business/whatsapp-images.test.ts
node dist/cli/index.js --help
bash .agents/skills/run-talon-smoke/scripts/run-talon-smoke.sh fake --no-build
```

Independent oracle: Current primary media contract must be read first; exact metadata/download URL, authentication and response fixtures pin conformance independently of mapper output. Existing startup smoke also runs.

Use meaningful red/green evidence for behavior changes; prose-only exceptions are stated explicitly. Do not run the full suite without the repository-required permission. Stop smoke processes and verify their listeners are gone.

## Definition of done

- [ ] Observable deliverable and mapped acceptance criteria are verified.
- [ ] Build, focused tests, CLI startup and unchanged no-cost daemon smoke pass.
- [ ] A fresh independent GPT-6.1-sol xhigh review precedes every commit; critical/high/medium findings are fixed.
- [ ] Only declared domains changed; no pixels or credentials enter durable text/logs.
- [ ] Report exact verification evidence, remaining concerns and Decisions to the controller; do not run wddctl or merge.
- [ ] Finish with one WDD status token. After three blocking review rounds the controller escalates rather than dispatching another automatic fix.
