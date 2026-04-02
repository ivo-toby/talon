# Multi-Connector Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable multiple channel connector instances of the same type with bot-self filtering to prevent feedback loops in shared workspaces.

**Architecture:** The channel infrastructure already supports multi-connector (keyed by name, not type). The work adds bot-self filtering at the connector level — each connector resolves its own bot user ID on startup, and after all connectors start, sibling bot IDs are injected per type group so each connector can ignore messages from other Talon bots. Telegram needs a `getMe` call added; Slack and Discord already filter all bot messages.

**Tech Stack:** TypeScript, Vitest, neverthrow Result types, pino logging

---

### Task 1: Add `botUserId` and `setSiblingBotIds` to ChannelConnector interface

**Files:**
- Modify: `src/channels/channel-types.ts:105-154`

- [ ] **Step 1: Add optional members to the ChannelConnector interface**

After the `readonly name: string;` line (line 109), add:

```typescript
  /**
   * The resolved bot/service user ID for this connector instance.
   * Set during start() by connectors that can resolve their own identity
   * (e.g. Slack auth.test, Telegram getMe). Undefined if not yet started
   * or if the connector type has no bot identity concept.
   */
  readonly botUserId?: string;

  /**
   * Provides the set of sibling bot user IDs (same connector type) to
   * filter out from inbound messages. Called by channel-setup after all
   * connectors have started. Connectors that don't need filtering can
   * implement this as a no-op.
   */
  setSiblingBotIds?(ids: Set<string>): void;
```

- [ ] **Step 2: Commit**

```bash
git add src/channels/channel-types.ts
git commit -m "feat(channels): add botUserId and setSiblingBotIds to ChannelConnector interface"
```

---

### Task 2: Add bot-self filtering to Telegram connector

**Files:**
- Modify: `src/channels/connectors/telegram/telegram-types.ts:38-43`
- Modify: `src/channels/connectors/telegram/telegram-connector.ts`
- Create: `tests/unit/channels/connectors/telegram/telegram-bot-filter.test.ts`

- [ ] **Step 1: Add `is_bot` field to TelegramUser type**

In `src/channels/connectors/telegram/telegram-types.ts`, update the `TelegramUser` interface:

```typescript
export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
}
```

- [ ] **Step 2: Write the failing test for bot message filtering**

Create `tests/unit/channels/connectors/telegram/telegram-bot-filter.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { TelegramConnector } from '../../../../../src/channels/connectors/telegram/telegram-connector.js';
import type { TelegramConfig } from '../../../../../src/channels/connectors/telegram/telegram-types.js';

function makeConnector(config?: Partial<TelegramConfig>): TelegramConnector {
  return new TelegramConnector(
    { botToken: 'test-token', ...config },
    'test-telegram',
    { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as any,
  );
}

describe('Telegram bot-self filtering', () => {
  it('drops messages where from.is_bot is true', async () => {
    const connector = makeConnector();
    const handler = vi.fn();
    connector.onMessage(handler);

    await connector.handleUpdatePublic({
      update_id: 1,
      message: {
        message_id: 100,
        from: { id: 999, first_name: 'OtherBot', is_bot: true },
        chat: { id: 123, type: 'private' },
        date: Date.now(),
        text: 'hello from a bot',
      },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('allows messages where from.is_bot is false', async () => {
    const connector = makeConnector({ allowedChatIds: ['123'] });
    const handler = vi.fn();
    connector.onMessage(handler);

    await connector.handleUpdatePublic({
      update_id: 2,
      message: {
        message_id: 101,
        from: { id: 456, first_name: 'Human', is_bot: false },
        chat: { id: 123, type: 'private' },
        date: Date.now(),
        text: 'hello from a human',
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('allows messages where from.is_bot is undefined (legacy)', async () => {
    const connector = makeConnector({ allowedChatIds: ['123'] });
    const handler = vi.fn();
    connector.onMessage(handler);

    await connector.handleUpdatePublic({
      update_id: 3,
      message: {
        message_id: 102,
        from: { id: 789, first_name: 'LegacyUser' },
        chat: { id: 123, type: 'private' },
        date: Date.now(),
        text: 'hello from legacy',
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('drops messages from sibling bot IDs', async () => {
    const connector = makeConnector({ allowedChatIds: ['123'] });
    connector.setSiblingBotIds(new Set(['999']));
    const handler = vi.fn();
    connector.onMessage(handler);

    await connector.handleUpdatePublic({
      update_id: 4,
      message: {
        message_id: 103,
        from: { id: 999, first_name: 'SiblingBot' },
        chat: { id: 123, type: 'private' },
        date: Date.now(),
        text: 'hello from sibling',
      },
    });

    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/channels/connectors/telegram/telegram-bot-filter.test.ts`
Expected: FAIL — `handleUpdatePublic` and `setSiblingBotIds` don't exist yet.

- [ ] **Step 4: Implement bot filtering in TelegramConnector**

In `src/channels/connectors/telegram/telegram-connector.ts`:

1. Add instance fields after the existing `private handler` field:

```typescript
  private _botUserId: string | undefined;
  private siblingBotIds: Set<string> = new Set();
```

2. Add public accessors:

```typescript
  get botUserId(): string | undefined {
    return this._botUserId;
  }

  setSiblingBotIds(ids: Set<string>): void {
    this.siblingBotIds = ids;
  }
```

3. Add a `getMe` call at the start of `start()`, before `this.pollLoopPromise = this.pollLoop()`:

```typescript
    // Resolve bot identity for self-filtering.
    try {
      const resp = await fetch(this.apiUrl('getMe'));
      const data = (await resp.json()) as { ok: boolean; result?: { id: number } };
      if (data.ok && data.result) {
        this._botUserId = String(data.result.id);
        this.logger.info(
          { channelName: this.name, botUserId: this._botUserId },
          'telegram connector resolved bot identity',
        );
      }
    } catch (cause) {
      this.logger.warn(
        { channelName: this.name, err: cause },
        'telegram connector failed to resolve bot identity via getMe',
      );
    }
```

Note: `start()` currently returns `Promise.resolve()` synchronously. Change it to `async start()` and `await` the getMe call before starting the poll loop.

4. Add bot filtering in `handleUpdate()`, right after the `allowedChatIds` check (around line 291):

```typescript
    // Drop messages from bots (including other Talon bots).
    if (message.from?.is_bot) {
      this.logger.debug(
        { channelName: this.name, senderId: String(message.from.id) },
        'telegram message from bot, skipping',
      );
      return;
    }

    // Drop messages from known sibling Talon bot IDs.
    const senderId = message.from ? String(message.from.id) : chatId;
    if (this.siblingBotIds.has(senderId)) {
      this.logger.debug(
        { channelName: this.name, senderId },
        'telegram message from sibling bot, skipping',
      );
      return;
    }
```

5. Expose `handleUpdate` for testing — add a public alias:

```typescript
  /** Test-only: direct access to handleUpdate for unit testing. */
  async handleUpdatePublic(update: TelegramUpdate): Promise<void> {
    return this.handleUpdate(update);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/channels/connectors/telegram/telegram-bot-filter.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Run existing Telegram tests to check for regressions**

Run: `npx vitest run tests/unit/channels/connectors/telegram/`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/channels/connectors/telegram/ tests/unit/channels/connectors/telegram/telegram-bot-filter.test.ts
git commit -m "feat(telegram): add bot-self filtering and getMe identity resolution"
```

---

### Task 3: Add sibling bot ID injection to channel-setup

**Files:**
- Modify: `src/channels/channel-setup.ts`
- Modify: `src/channels/channel-registry.ts`

- [ ] **Step 1: Add `injectSiblingBotIds` function to channel-setup.ts**

Add after the `registerChannels` function:

```typescript
/**
 * After all connectors have started and resolved their bot identities,
 * inject sibling bot ID sets so each connector can filter messages from
 * other Talon bots of the same type in the same workspace.
 */
export function injectSiblingBotIds(registry: ChannelRegistry, logger: pino.Logger): void {
  const byType = new Map<string, ChannelConnector[]>();
  for (const connector of registry.listAll()) {
    const group = byType.get(connector.type) ?? [];
    group.push(connector);
    byType.set(connector.type, group);
  }

  for (const [type, connectors] of byType) {
    if (connectors.length < 2) continue;

    const botIds = new Set<string>();
    for (const c of connectors) {
      if (c.botUserId) botIds.add(c.botUserId);
    }

    if (botIds.size === 0) continue;

    for (const c of connectors) {
      c.setSiblingBotIds?.(botIds);
    }

    logger.info(
      { type, connectorCount: connectors.length, botIdCount: botIds.size },
      'channel-setup: injected sibling bot IDs',
    );
  }
}
```

- [ ] **Step 2: Wire into daemon startup**

In `src/daemon/daemon.ts`, after `await this.ctx.channelRegistry.startAll()` (around line 104), add:

```typescript
    // Inject sibling bot IDs for multi-connector self-filtering.
    injectSiblingBotIds(this.ctx.channelRegistry, this.logger);
```

Add the import at the top:

```typescript
import { injectSiblingBotIds } from '../channels/channel-setup.js';
```

- [ ] **Step 3: Wire into hot-reload path**

In the hot-reload method, after the new `startAll()` call (around line 371), add the same injection:

```typescript
    injectSiblingBotIds(this.ctx.channelRegistry, this.logger);
```

- [ ] **Step 4: Run existing tests**

Run: `npx vitest run tests/unit/channels/ tests/unit/daemon/daemon.test.ts`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/channels/channel-setup.ts src/daemon/daemon.ts
git commit -m "feat(channels): inject sibling bot IDs after connector startup"
```

---

### Task 4: Add `setSiblingBotIds` no-ops to remaining connectors

**Files:**
- Modify: `src/channels/connectors/slack/slack-connector.ts`
- Modify: `src/channels/connectors/discord/discord-connector.ts`
- Modify: `src/channels/connectors/whatsapp-baileys/whatsapp-baileys-connector.ts`
- Modify: `src/channels/connectors/email/email-connector.ts`
- Modify: `src/channels/connectors/terminal/terminal-connector.ts`

Slack and Discord already drop all bot messages, so `setSiblingBotIds` is a no-op. WhatsApp Baileys already has self-chat filtering. Email and Terminal don't need it. But the interface method should be implemented for type safety.

- [ ] **Step 1: Add to Slack connector**

In `slack-connector.ts`, add after the `format()` method:

```typescript
  get botUserId(): string | undefined {
    return undefined; // Slack already filters all bot messages via bot_id field
  }

  setSiblingBotIds(_ids: Set<string>): void {
    // No-op: Slack connector already drops all messages with bot_id set.
  }
```

- [ ] **Step 2: Add to Discord connector**

In `discord-connector.ts`, add after the `format()` method:

```typescript
  get botUserId(): string | undefined {
    return undefined; // Discord already filters all bot messages via author.bot
  }

  setSiblingBotIds(_ids: Set<string>): void {
    // No-op: Discord connector already drops all messages from bot authors.
  }
```

- [ ] **Step 3: Add to WhatsApp Baileys connector**

In `whatsapp-baileys-connector.ts`, add after the `format()` method:

```typescript
  get botUserId(): string | undefined {
    return [...this.selfIds][0]; // First self-JID, if resolved
  }

  setSiblingBotIds(_ids: Set<string>): void {
    // No-op: WhatsApp Baileys uses JID-based self-filtering via selfIds set.
  }
```

- [ ] **Step 4: Add to email connector**

In `email-connector.ts`, add after the `format()` method:

```typescript
  get botUserId(): string | undefined {
    return this.config.address;
  }

  setSiblingBotIds(_ids: Set<string>): void {
    // No-op: email connector does not receive messages from other Talon bots.
  }
```

- [ ] **Step 5: Add to terminal connector**

In `terminal-connector.ts`, add after the `format()` method:

```typescript
  get botUserId(): string | undefined {
    return undefined;
  }

  setSiblingBotIds(_ids: Set<string>): void {
    // No-op: terminal connector is single-user.
  }
```

- [ ] **Step 6: Build to verify type safety**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 7: Commit**

```bash
git add src/channels/connectors/
git commit -m "feat(channels): add setSiblingBotIds to all connector implementations"
```

---

### Task 5: Build, full test run, verify

**Files:** None (verification only)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: Clean

- [ ] **Step 2: Run all channel and daemon tests**

Run: `npx vitest run tests/unit/channels/ tests/unit/daemon/ tests/unit/pipeline/`
Expected: All pass

- [ ] **Step 3: Commit if any fixups needed**

---

### Task 6: Documentation — README, example config, CLAUDE.md

**Files:**
- Modify: `README.md`
- Modify: `config/talond.example.yaml`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add Multi-Connector section to README.md**

Add a new section after the existing channels documentation. Include:

- What multi-connector means (N connector instances of the same type, each with own credentials)
- Use case: virtual team with per-persona bots in the same Slack workspace
- Use case: separate Telegram bots per persona in a shared group
- Config example showing 2 Slack channels with different tokens
- How bot-self filtering works (automatic after startup, no config needed)
- How `channel_send` routes by channel name (persona sends under specific bot identity)
- Note: WhatsApp Business connectors need unique `webhookPort` values
- How persona bindings reference channel names

- [ ] **Step 2: Add multi-connector example to config/talond.example.yaml**

Add a commented block near the existing channels section:

```yaml
  # --- Multi-connector example (multiple Slack bots in one workspace) ---
  # Each entry creates an independent bot. Messages between bots are
  # automatically filtered to prevent feedback loops.
  #
  # - name: slack-pm
  #   type: slack
  #   enabled: true
  #   config:
  #     botToken: ${SLACK_PM_BOT_TOKEN}
  #     appToken: ${SLACK_PM_APP_TOKEN}
  #     signingSecret: ${SLACK_PM_SIGNING_SECRET}
  #
  # - name: slack-dev
  #   type: slack
  #   enabled: true
  #   config:
  #     botToken: ${SLACK_DEV_BOT_TOKEN}
  #     appToken: ${SLACK_DEV_APP_TOKEN}
  #     signingSecret: ${SLACK_DEV_SIGNING_SECRET}
```

- [ ] **Step 3: Add architecture note to CLAUDE.md**

Under "Architecture Overview" or "Key Architectural Decisions", add:

```markdown
- **Multi-connector** — Multiple connector instances of the same channel type are supported. Channels are keyed by `name` (unique), not `type`. Bot-self filtering prevents feedback loops when multiple Talon bots coexist in the same workspace/server/group.
```

- [ ] **Step 4: Commit**

```bash
git add README.md config/talond.example.yaml CLAUDE.md
git commit -m "docs: multi-connector setup guide, example config, and architecture note"
```

---

## File Structure Summary

| File | Action | Responsibility |
|------|--------|---------------|
| `src/channels/channel-types.ts` | Modify | Add `botUserId` and `setSiblingBotIds` to interface |
| `src/channels/connectors/telegram/telegram-types.ts` | Modify | Add `is_bot` to TelegramUser |
| `src/channels/connectors/telegram/telegram-connector.ts` | Modify | getMe call, bot filtering, setSiblingBotIds |
| `src/channels/connectors/slack/slack-connector.ts` | Modify | No-op setSiblingBotIds |
| `src/channels/connectors/discord/discord-connector.ts` | Modify | No-op setSiblingBotIds |
| `src/channels/connectors/whatsapp-baileys/whatsapp-baileys-connector.ts` | Modify | No-op setSiblingBotIds |
| `src/channels/connectors/email/email-connector.ts` | Modify | No-op setSiblingBotIds |
| `src/channels/connectors/terminal/terminal-connector.ts` | Modify | No-op setSiblingBotIds |
| `src/channels/channel-setup.ts` | Modify | Add injectSiblingBotIds function |
| `src/daemon/daemon.ts` | Modify | Wire injection after startAll + hot-reload |
| `tests/unit/channels/connectors/telegram/telegram-bot-filter.test.ts` | Create | Bot filtering tests |
| `README.md` | Modify | Multi-connector documentation |
| `config/talond.example.yaml` | Modify | Multi-connector example |
| `CLAUDE.md` | Modify | Architecture note |
