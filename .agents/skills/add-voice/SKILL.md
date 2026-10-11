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

Check the current configuration without printing secrets:

```bash
npx talonctl list-personas
npx talonctl list-providers
npx talonctl config-show
```

Choose the persona first. Its configured provider must be enabled and must use
the `openai-compatible` implementation (`type: openai-compatible` when the
provider name is an alias). Voice currently accepts WebRTC only. SIP and
physical phone access are not supported by this skill.

Ask: **"Which existing persona should browser voice use?"**

## Configure the auth slots

Add environment-backed entries to `auth.providers` in `config/talond.yaml`.
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
  provider: openai-compatible
  model: gpt-live-1
  persona: assistant
  voice: marin
  # usdPerMinute: 0.00  # placeholder only; replace with a current provider rate; omitted means unavailable
  allowedTransportTypes: [webrtc]
  allowedOrigins:
    - https://voice.example.com
  allowedToolNames: []
  allowedMcpServerNames: []
```

`voice.model` is the live voice model. The selected persona's `model` is the
backend `AgentRunner` model. Native provider tools remain disabled, and
approval-gated or unproven MCP capabilities fail closed at the voice boundary.

## HTTPS and proxy

For a browser outside the daemon host, terminate HTTPS in a reverse proxy and
forward `/voice/` to the listener. Keep the default loopback bind when the
proxy shares the daemon's network namespace; otherwise set `voice.host` to a
reachable interface or `0.0.0.0` and restrict network access. Preserve the
public `Host` and `Origin` headers and send `X-Forwarded-Proto: https`; this is
required for secure cookie and same-origin decisions. `publicHost` contributes
the matching `https://` origin but does not change the listener address.

## Validate

Run the normal configuration checks after editing:

```bash
npx talonctl doctor --config talond.yaml
npx talonctl env-check
```

Restart the daemon after changing voice or provider configuration, then open
`https://<publicHost>/voice/` (or the local loopback URL). Check login, denied
microphone handling, hangup/restart, and the retained result list. A successful
offline check does not prove a physical iPhone/Safari call or a paid live
provider call; record those separately.

## Limits, storage, and cost

Voice session creation and concurrency are bounded by the `voice` settings.
Talon stores bounded text, output, usage, and lifecycle state in SQLite and no
raw audio. Local voice rows have no automatic TTL cleanup, so include them in
the operator's retention policy. Provider-side audio/transcript retention is
controlled by the provider account. Voice cost is reported only when provider
usage supports it and may be unavailable; set `voice.usdPerMinute` only with a
current operator-supplied provider rate. The value produces a duration
estimate with no default rate; final provider usage remains `estimated`, a
configured rate with known usage and an incomplete close is `incomplete`, and
no rate is `unavailable`. Backend cost comes only from AgentRunner run
accounting.

See [the browser voice guide](../../../docs/guides/voice.mdx) and [the config
reference](../../../docs/reference/config-schema.mdx) for the route list and
validation boundaries.
