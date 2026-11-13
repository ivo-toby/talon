---
name: add-voice
description: |
  Add and validate Talon's opt-in browser voice UI. Use when the user says
  "add voice", "enable browser voice", "configure voice", or "voice UI".
triggers:
  - 'add voice'
  - 'enable browser voice'
  - 'configure voice'
  - 'voice UI'
  - 'browser voice'
---

# Add browser voice

Guide the user through enabling Talon's opt-in authenticated browser voice
boundary. Ask one question at a time and never request, print, or write actual
secret values.

## Pre-flight

Use the operator's actual config path. The examples below use
`CONFIG_PATH=talond.yaml`; replace it when the deployment uses another path and
pass `--config "$CONFIG_PATH"` on every supported command. Keep secret fields
environment-backed and do not paste `config-show` output.

```bash
CONFIG_PATH=talond.yaml
npx talonctl list-personas --config "$CONFIG_PATH"
npx talonctl list-providers --config "$CONFIG_PATH"
npx talonctl config-show --config "$CONFIG_PATH"
```

Choose the persona first. Its configured provider must be enabled; the
provider's normal OAuth and native-tool restrictions remain in force. This
skill configures the browser WebRTC path. Incoming SIP is a separate
advanced boundary, disabled by default. When enabled, it accepts the existing
provider-created GPT-Live session after independent caller proof, reuses the
normal persona/queue/backend path, and keeps provider media outside Talon. It
does not provision Asterisk, keys, trunks, or paid calls; use the [incoming SIP
guide](../../../docs/guides/voice-asterisk.mdx) only for an explicitly
authorised operator setup.

Ask: **"Which existing persona should browser voice use?"**

## Configure the auth slots

Add environment-backed entries to `auth.providers` in the operator config at
`$CONFIG_PATH`.
Put values in the operator's environment or `.env`; use placeholders in YAML:

```yaml
auth:
  providers:
    voice:
      apiKey: ${TALON_VOICE_ACCESS_TOKEN}
    openai:
      apiKey: ${OPENAI_API_KEY}
```

`voice` is the browser login token. `openai` is the live provider slot in this
example; use the actual slot named by `liveApiKeyRef` if it differs. The access
token is exchanged once for an expiring cookie and is never sent to the live
provider or returned in session status.

The browser login form leaves `Keep me signed in for one year` unchecked. The
default omitted/false `rememberMe` request creates a fixed 15-minute grant;
checking it sends the strict boolean `rememberMe: true` for a fixed 365-day
grant. There is no sliding refresh. Talon persists only hashed session/CSRF
verification values and bounded metadata, preserving grants across normal
restart while logout, credential/owner rotation, and configuration reload
revoke the affected authority. The browser never stores the access token or
raw session bearer in Web Storage.

## Add the voice block

Edit the config with the selected persona and provider. The listener defaults
to loopback; use a reachable explicit bind address when a remote proxy needs to
connect, and start with an explicit origin:

```yaml
voice:
  enabled: true
  host: 127.0.0.1
  port: 8787
  publicHost: voice.example.com
  accessTokenRef: voice
  liveApiKeyRef: openai
  # provider: openai-compatible  # deprecated compatibility field; persona provider is authoritative
  model: gpt-live-1
  persona: assistant
  voice: marin
  # usdPerMinute: 0.00  # placeholder only; replace with a current provider rate; omitted means unavailable
  allowedTransportTypes: [webrtc]
  allowedOrigins:
    - https://voice.example.com
  # Deprecated compatibility fields; voice inherits the selected persona's
  # capabilities, skills, and configured MCP servers.
  allowedToolNames: []
  allowedMcpServerNames: []
```

`voice.persona` selects the existing normal persona, including its backend
`AgentRunner` model, ordinary tools, skills, and configured MCP servers.
`voice.model` is the separate live voice model. The persona provider's normal
OAuth and native-tool restrictions remain in force. Approval-gated capabilities
are unavailable because voice has no interactive approval channel, and unproven MCP capabilities fail closed. The
old `voice.allowedToolNames` and `voice.allowedMcpServerNames` fields are
ignored; leave them empty for compatibility.

The selected persona policy also governs voice descendants. Approval-gated
capability families are removed before child registration and enforced again at
the shared host-tools bridge if denial metadata is missing. Current backend
results remain in durable history after authority expiry or hangup, while the
expired session cannot speak them.

When `voice.enabled` is true, `browser-voice` is reserved for Talon's internal
voice channel. A conflicting ordinary channel configuration is rejected at
startup, and an existing non-voice `browser-voice` database row is not
overwritten.

## HTTPS and proxy

For a browser outside the daemon host, terminate HTTPS in a reverse proxy and
forward `/voice/` to the listener. Keep the default loopback bind when the
proxy shares the daemon's network namespace; otherwise set `voice.host` to a
reachable interface or `0.0.0.0` and restrict network access. Preserve the
public `Host` and `Origin` headers and send `X-Forwarded-Proto: https`; this is
required for secure cookie and same-origin decisions. `publicHost` contributes
the matching `https://` origin but does not change the listener address.

## Optional incoming SIP

If the transport choice is not already specified, ask one separate question:
**"Do you also want to enable the incoming SIP boundary?"** Leave
`voice.sip.enabled` false unless the operator explicitly chooses it. If the
answer is yes, stop the browser-only walkthrough and follow
the [ordered incoming SIP/Asterisk guide](../../../docs/guides/voice-asterisk.mdx)
from start to finish. It covers the operator-owned provider contact and trunk,
Ed25519 key and signer environment, `publicKeys`/`endpointMappings`, separate
webhook and live-provider secrets, the two listener proxy routes, local echo,
network/media checks, and the bounded provider test. This skill must not invent
a provider contact, install a PBX, provision a trunk, or place a paid call.

Use the same actual config path throughout. `talonctl` defaults to
`talond.yaml` (or the `TALOND_CONFIG_PATH` value), while
`config/talond.example.yaml` is only a repository example. The guide's
validation commands are:

```bash
npx talonctl doctor --config "$CONFIG_PATH"
npx talonctl env-check --config "$CONFIG_PATH"
npx talonctl config-show --config "$CONFIG_PATH"
```

## Validate

Run the normal configuration checks after editing:

```bash
npx talonctl doctor --config "$CONFIG_PATH"
npx talonctl env-check --config "$CONFIG_PATH"
```

Restart the daemon after changing voice or provider configuration, then open
`https://<publicHost>/voice/` (or the local loopback URL). Check login, denied
microphone handling, hangup/restart, and the retained result list. A successful
offline check does not prove a physical iPhone/Safari call or a paid live
provider call; record those separately.

## Limits, storage, and cost

Voice session creation and concurrency are bounded by the `voice` settings.
Talon stores bounded prompt fragments, output, usage, and lifecycle state in
SQLite and no raw audio. One owner/persona thread is reused across calls;
prompt history is bounded by the voice history row and character limits. Old
calls and other-channel messages are not imported automatically. Local voice
rows have no automatic TTL cleanup, so include them in the operator's
retention policy. Provider-side audio/transcript retention is
controlled by the provider account. Voice cost is reported only when provider
usage supports it and may be unavailable; set `voice.usdPerMinute` only with a
current operator-supplied provider rate. The value produces a duration
estimate with no default rate; final provider usage remains `estimated`, a
configured rate with known usage and an incomplete close is `incomplete`, and
no rate is `unavailable`. Backend cost comes only from AgentRunner run
accounting.

The first live delegation remains provisional until a 1,000 ms quiet interval
has passed after the latest meaningful captured USER signature or safety
classification change. A fixed 5,000 ms collection deadline starts when that
notice is received and never extends. An initial safe snapshot still waits for
quiet; an unsafe snapshot remains pending at quiet expiry so a valid late
transcript can settle before the absolute deadline. At absolute expiry, a safe
but unsettled snapshot is invalidated and follows the clarification path. This
is local policy, not a completeness proof, and it does not depend on an
undocumented response-completion event.

Later delegations require a fresh user turn and cannot reuse an earlier
utterance. Assistant progress, completion timing, or notification speech does
not change an admitted request. User corrections, ambiguous timing, truncation,
and provider replay conflicts remain fail-closed. A transcript that arrives
after first publication or expiry is treated as a late change and fails
closed. Optional diagnostics contain only local opaque correlation IDs, fixed
event/reason values, bounded durations, counts, and an observation-scope marker.
Close summaries add fixed availability, opened, finalized, close-requested, and
observation-duration fields. They exclude transcript, prompt, provider ID,
payload, error, hash, and credential data; a zero observed-delegation count
describes only the observed window and does not prove that no provider event
occurred before observation began. The provider offset is not proof that a user
turn was complete; offline checks do not establish provider-specific live audio
timing or causal attribution.

The delegation offset is a capture boundary, not an utterance cutoff. Only
event-identified native input/output transcript deltas with valid explicit
`start_ms` and `end_ms` can carry atomic chunk timing across that boundary;
missing or legacy timing remains fail-closed at capture.

On page load, the browser checks `GET /voice/auth/session` before looking up an
optional retained call. A valid cookie reaches the ready screen without a
retained call; a retained-call 404 clears only the stale pointer. Transient
auth or retained-call failures preserve recoverable pointers and show an
English retry message. Restore may reopen read-only history/status streams but
never requests a microphone, creates a peer or paid session, connects a
provider, enqueues work, or replays old work. Cookie retention depends on the
browser cookie context; Safari home-screen contexts may need a fresh login.
Background/lock-screen audio and physical iPhone retention are not promised.

See [the browser voice guide](../../../docs/guides/voice.mdx) and [the config
reference](../../../docs/reference/config-schema.mdx) for the route list and
validation boundaries.
