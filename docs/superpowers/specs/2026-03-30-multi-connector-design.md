# Multi-Connector Support

> Status: Approved
> Date: 2026-03-30
> Issue: #145
> Scope: Bot-self filtering, webhook port validation, docs. Activity feed split to separate ticket.

## Problem

Talon's channel infrastructure already supports multiple connector instances of the same type (keyed by name, not type), but two gaps prevent real-world multi-bot deployments:

1. **No bot-self filtering** — When multiple Talon bots coexist in the same Slack workspace / Discord server / Telegram group, each connector sees messages from all bots, creating feedback loops.
2. **No documentation** — The multi-connector capability is undocumented, making it invisible to operators.

## What already works

The exploration confirmed these require no changes:

- **Channel registry** — keyed by `name`, not `type`. `getByType()` returns an array.
- **Config schema** — no uniqueness constraint on `type`, only on `name`.
- **Database** — `channels.name` is UNIQUE, `type` is not.
- **Pipeline routing** — resolves by channel name throughout.
- **Bindings** — reference channel by name, not type.
- **`channel_send` tool** — resolves by channel name.
- **Connector implementations** — no module-level state, all instance-scoped.
- **Hot reload** — unregisters/re-registers by name.

## Design

### 1. Bot-self filtering

Each connector resolves its own bot user ID on startup and filters inbound events where the sender is any Talon bot in the same workspace.

#### Connector interface changes

Add to `ChannelConnector`:

```typescript
/** Returns the resolved bot/service user ID, or undefined if not yet started. */
readonly botUserId?: string;

/** Provides the set of sibling bot IDs to filter out inbound messages from. */
setSiblingBotIds(ids: Set<string>): void;
```

#### Per-connector bot ID resolution

| Connector | API call | ID field |
|-----------|----------|----------|
| Slack | `auth.test` (already called) | `response.user_id` |
| Telegram | `getMe` (already called) | `result.id` (numeric, store as string) |
| Discord | Gateway READY event | `user.id` |
| WhatsApp Baileys | Connection info | `user.id` (JID) |
| Email | Config `address` field | Direct from config |
| Terminal | N/A | No filtering needed |

#### Bot message filtering

All connectors that support it (Slack, Discord, Telegram) drop inbound messages from all bot accounts, consistent across platforms. This prevents feedback loops from both Talon bots and third-party bots.

#### Sibling ID injection

As a secondary layer, `channel-setup.ts` groups connectors by type after startup, collects their bot IDs, and calls `setSiblingBotIds()` on each with the full set for that type. This provides an additional filter for connectors that don't have platform-level bot detection.

#### Filter logic (secondary layer)

In each connector's inbound event handler, before emitting to the pipeline:

```typescript
if (this.siblingBotIds?.has(senderUserId)) {
  this.logger.debug({ sender: senderUserId }, 'ignoring message from sibling bot');
  return;
}
```

The connector's own bot ID is included in the sibling set, which also handles self-echo filtering (messages the bot itself sent appearing as inbound events).

### 2. WhatsApp Business webhook port validation

Multiple WhatsApp Business connectors with embedded webhook servers must each bind a unique port. Add a config-level validation in `channel-setup.ts` or the config loader:

- Collect all WA Business channels that have `appSecret` + `webhookPort` configured.
- Check for duplicate `(host, webhookPort)` pairs.
- Fail startup with a clear error if duplicates are found.

### 3. Documentation

#### README.md

New section "Multi-Connector Setup" covering:

- What multi-connector means (N bots of the same type, each with its own credentials)
- Use cases: virtual team (per-persona bots), workspace separation
- Config example: 2+ Slack channels with different tokens and default personas
- Config example: per-persona Telegram bots
- How bot-self filtering works (automatic, no config needed)
- Note on WhatsApp Business webhook port uniqueness
- How `channel_send` routes by channel name (persona sends to specific bot identity)

#### config/talond.example.yaml

Add a commented multi-connector example block showing:

```yaml
# Multi-connector: multiple Slack bots in the same workspace
channels:
  - name: slack-pm
    type: slack
    config:
      botToken: ${SLACK_PM_BOT_TOKEN}
      appToken: ${SLACK_PM_APP_TOKEN}
      signingSecret: ${SLACK_PM_SIGNING_SECRET}
    enabled: true

  - name: slack-dev
    type: slack
    config:
      botToken: ${SLACK_DEV_BOT_TOKEN}
      appToken: ${SLACK_DEV_APP_TOKEN}
      signingSecret: ${SLACK_DEV_SIGNING_SECRET}
    enabled: true
```

#### CLAUDE.md

Add note under Architecture: channels are keyed by name, multiple instances per type are supported.

## Files to modify

| File | Change |
|------|--------|
| `src/channels/channel-types.ts` | Add `botUserId` and `setSiblingBotIds` to `ChannelConnector` interface |
| `src/channels/connectors/slack/slack-connector.ts` | Store bot user ID from `auth.test`, implement `setSiblingBotIds`, filter in event handler |
| `src/channels/connectors/telegram/telegram-connector.ts` | Store bot user ID from `getMe`, implement `setSiblingBotIds`, filter in `handleUpdate` |
| `src/channels/connectors/discord/discord-connector.ts` | Store bot user ID from READY, implement `setSiblingBotIds`, filter in `feedEvent` |
| `src/channels/connectors/whatsapp-baileys/whatsapp-baileys-connector.ts` | Store JID, implement `setSiblingBotIds`, filter inbound |
| `src/channels/connectors/email/email-connector.ts` | Store address from config, implement `setSiblingBotIds`, filter inbound |
| `src/channels/connectors/terminal/terminal-connector.ts` | No-op `setSiblingBotIds`, no `botUserId` |
| `src/channels/channel-setup.ts` | After `startAll()`, build sibling ID sets per type, call `setSiblingBotIds` |
| `README.md` | New "Multi-Connector Setup" section |
| `config/talond.example.yaml` | Add multi-connector example |
| `CLAUDE.md` | Add architecture note |

## Testing

- Two connectors of the same type start without conflict
- Each connector resolves its bot user ID on start
- Sibling bot IDs are injected after all connectors start
- Messages from sibling bots are filtered (not forwarded to pipeline)
- Messages from non-bot users are forwarded normally
- `channel_send` routes to correct connector by name
- Hot reload correctly rebuilds sibling ID sets
- WhatsApp Business rejects duplicate webhook port config

## Out of scope

- A2A activity feed (separate ticket)
- OAuth/signed agent cards
- Per-connector webhook path routing (not needed — Socket Mode is per-app)
