# TASK-18 parity validation evidence

This evidence covers the offline production-composition checks and the
configuration documentation. It keeps external-provider and browser-device
claims separate from repository evidence.

## Offline bootstrap integration

Command:

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH \
  npx vitest run tests/integration/voice/bootstrap-parity.test.ts --reporter=verbose
```

Result: **1 file, 3 tests passed**.

`bootstrap-parity.test.ts` starts the actual `TalondDaemon`, runs SQLite
migrations and production bootstrap, resolves the named `Marin` persona to its
database UUID, and uses the real `BrowserVoiceServer`, cookie/CSRF auth,
`DurableVoiceSessionService`, voice store, durable queue, `AgentRunner`,
host-tools bridge, browser-voice connector, and MCP/OAuth resolver. Only the
live provider and the external backend command are fake, both running in
temporary test fixtures.

The integration assertions cover:

- two enabled `openai-compatible` backend registrations, persona backend model
  selection, and the separate live voice model;
- the normal persona's empty legacy voice allowlists inheriting
  `channel.send:*`, a real bridge `channel_send`, delivery to the browser-voice
  call, and the same generated message ID on the connector output and SQLite
  message row;
- OAuth MCP materialization, the cached OAuth header, and native shell and
  filesystem disablement at the backend boundary;
- approval-only `channel.send:*` denial both through the empty provider tool
  exposure and through a direct bridge attempt, with no voice notification;
- one owner/persona thread across calls, bounded history recovery after a
  daemon restart, and no replay of the completed first run.

The broader voice-focused command also passed:

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH \
  npx vitest run tests/integration/voice tests/unit/voice \
  tests/unit/channels/browser-voice-connector.test.ts \
  tests/unit/channels/channel-send-voice.test.ts \
  tests/unit/core/database/voice/voice-store.test.ts --reporter=dot
```

Result: **18 files, 127 tests passed**.

## Repository checks

These checks passed in the Node 24.15.0 environment:

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH \
  npx tsc -p tsconfig.json --noEmit
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH \
  npm run build
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH \
  node --test .wdd/epics/browservoice/evidence/lint-baseline-comparison.test.mjs
```

The comparator test passed **11 tests**. The approved lint baseline verifier
passed with the exact **75 errors and 21 warnings** baseline, preserved
unchanged diagnostic objects, and checked **35 changed source files** with
changed code clean:

```text
PATH=/Users/ivo.toby/.local/share/mise/installs/node/24.15.0/bin:$PATH \
  node .wdd/epics/browservoice/evidence/verify-lint-baseline.mjs
```

Prettier checks passed for the new integration test, the voice guide, the
example config, and the add-voice skill. The repository's existing README,
AGENTS, setup-skill, and config-reference formatting was not rewritten as part
of this focused documentation change.

## Documentation coverage

The README, architecture instructions, example YAML, voice guide, config
reference, and all voice setup skills now describe `voice.persona` as the
normal persona boundary, the separate live audio model, inherited tools,
skills, MCP, and explicit approval limitation. They document loopback and
reverse-proxy binding, HTTPS forwarding headers, bounded prompt history versus
durable row retention, no automatic old-call or other-channel import, and no
raw-audio storage.

When voice is enabled, the documentation also identifies `browser-voice` as a
reserved internal channel name: conflicting ordinary channel configuration is
rejected, and an existing non-voice database row is not overwritten.

## Browser and external-provider boundary

The controller supplied an offline Playwright browser check against the current
build with mocked media, WebRTC, HTTP, and provider APIs. It observed login,
start, mute, hangup, new-call, reload of closed state, literal `<script>` text
handling, and notifications; the 390x844 viewport had no horizontal overflow
and no page errors. The reviewed screenshot is
`/tmp/talon-voice-notification-mobile.png`.

That is browser-UI evidence only. It does not prove a physical microphone,
WebRTC audio, Safari/iPhone behavior, a live server, a paid provider call,
provider pricing, latency, or deployment proxy behavior.
