# TASK45 voice operator documentation evidence

## Candidate

This candidate updates the operator-facing browser/SIP documentation and setup
skills only. The main addition is the ordered SIP/Asterisk walkthrough in
`docs/guides/voice-asterisk.mdx`; it keeps provider contacts, trunk setup,
credentials, key storage, proxy deployment, media/NAT behavior, and paid tests
operator-owned and explicitly unverified until the operator checks them.

Changed documentation paths:

- `README.md`
- `config/talond.example.yaml`
- `docs/guides/voice.mdx`
- `docs/guides/voice-asterisk.mdx`
- `docs/reference/config-schema.mdx`
- `.agents/skills/add-voice/SKILL.md`
- `.agents/skills/talon-setup/SKILL.md`
- `.agents/skills/talon-setup-docker/SKILL.md`

## Checks run

- `git diff --check` — PASS.
- Local Markdown/MDX link check over the seven changed documentation guides and
  references — PASS; no missing repository-relative targets.
- Ruby YAML parse of the operator SIP snippet in
  `docs/guides/voice-asterisk.mdx` — PASS; required `voice` and `voice.sip`
  keys parsed, including the operator-chosen stable owner mapping.
- Ruby YAML parse of `config/talond.example.yaml` — PASS.
- Source audit against `src/core/config/config-schema.ts` confirmed the
  documented SIP fields/defaults and the browser `liveApiKeyRef`, `persona`,
  and `maxSessionLifetimeMs` fields.
- Source audit against `scripts/voice/asterisk-sign-call.mjs` confirmed the
  four signer environment variables, AGI variable reads, and rejection of
  signer arguments.
- Source audit against `src/cli/index.ts` confirmed `doctor`, `env-check`, and
  `config-show` and their `--config <path>` option.
- Documentation audit confirmed the fixed sample uses SIP port `8789` (the
  starter bundle's `8788` remains its OAuth callback), routes `700` to
  `s@talon-incoming`, and keeps local-only `600` on `Answer`/`Echo`/`Hangup`
  without entering `talon-incoming` or the provider `Dial`; step 7 records only
  the operator-owned local echo, static signer/configuration checks, and
  static outgoing dialplan-hook review; step 8 relies on provider webhook HTTP
  status and existing durable SIP admission status when exposed, without
  requiring runtime AGI/PJSIP traces or raw assertion/header capture.
- Documentation audit confirmed provider delivery is described as Talon
  Standard Webhooks HMAC with no browser/SSO/Basic-auth layer, and that the
  SIP owner is operator-chosen and stable; `voice:<persona-name>` is documented
  only as an optional intentional browser-history sharing choice.
- Documentation audit confirmed `config-show` is described generically as
  local inspection with no universal redaction guarantee and no direct secret
  field named in the guide; output is never to be pasted.
- Documentation audit confirmed the approved provider-test status wording uses
  provider webhook HTTP status and existing durable SIP status when exposed;
  daemon/PBX logs are limited to available technical startup/error details and
  the guide invents no delivery-ID log or status CLI and requires no runtime
  AGI/PJSIP trace or raw assertion/header capture.
- Parent-run source gates on the unchanged implementation — PASS: Node 24
  TypeScript check, build, and lint-baseline comparison (75 existing errors and
  21 existing warnings unchanged).
- Official Asterisk references linked by the guide were reviewed for the
  documented `pjsip show endpoints`, `pjsip show endpoint`, and `dialplan show`
  checks:
  [Making a Phone Call](https://docs.asterisk.org/Deployment/Basic-PBX-Functionality/Making-a-Phone-Call/)
  and the
  [Asterisk PJSIP troubleshooting guide](https://docs.asterisk.org/Configuration/Channel-Drivers/SIP/Configuring-res_pjsip/Asterisk-PJSIP-Troubleshooting-Guide/).

## Scope and remaining verification

The controller owns the broader regression checks; they were not rerun for this
documentation-only candidate. No Asterisk service, provider project, trunk,
proxy, live call, production data, or secret was accessed. Provider-assigned
SIP contact, provider compatibility, custom SIP header preservation, RTP/NAT
behavior, billing, and the bounded live test remain operator-owned deployment
checks. `config-show` was documented only as local inspection; direct secret
fields must use environment-backed references and its output must not be pasted.
