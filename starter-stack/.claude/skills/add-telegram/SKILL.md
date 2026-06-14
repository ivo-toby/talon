---
name: add-telegram
description: |
  Add Telegram as a channel. Use when the user says "add telegram",
  "connect telegram", "set up telegram bot", or "telegram channel".
triggers:
  - "add telegram"
  - "connect telegram"
  - "telegram channel"
  - "telegram bot"
---

# Add Telegram Channel

Walk the user through adding a Telegram bot channel to Talon. One question at a time.

## Phase 1: Pre-flight

Check if a telegram channel already exists:

```bash
npx talonctl list-channels
```

If one exists, ask the user if they want to add another or reconfigure.

## Phase 2: Create the Bot

Ask: **"Do you already have a Telegram bot token?"**

If no, walk them through it:

> 1. Open Telegram and search for **@BotFather**
> 2. Send `/newbot`
> 3. Choose a display name (e.g. "Talon Assistant")
> 4. Choose a username — must end with `bot` (e.g. `talon_assistant_bot`)
> 5. BotFather will reply with a token like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`
> 6. Copy that token

Wait for the user to provide the token. **Never store the actual token in config** — use an env var placeholder.

## Phase 3: Add the Channel

Ask for a channel name (suggest `my-telegram`), then:

```bash
npx talonctl add-channel --name <name> --type telegram
```

Then edit `talond.yaml` to set the config section for this channel:

```yaml
config:
  botToken: ${TELEGRAM_BOT_TOKEN}
  pollingTimeoutSec: 30
```

Tell the user to add to `.env`:

```
TELEGRAM_BOT_TOKEN=<their-actual-token>
```

## Phase 4: Restrict Access (Recommended)

Ask: **"Do you want to restrict the bot to specific chats?"**

If yes, explain how to get chat IDs:

> 1. Start a conversation with your bot in Telegram
> 2. Send any message
> 3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser
> 4. Find `"chat":{"id":12345678}` — that's your chat ID
> 5. For groups: add the bot to the group, send a message, check getUpdates again (group IDs are negative numbers like `-1001234567890`)

Then edit the channel config to add:

```yaml
config:
  botToken: ${TELEGRAM_BOT_TOKEN}
  pollingTimeoutSec: 30
  allowedChatIds:
    - "12345678"
```

## Phase 5: Bind a Persona

```bash
npx talonctl list-personas
```

Ask which persona to bind, then:

```bash
npx talonctl bind --persona <name> --channel <channel-name>
```

If no personas exist yet, suggest creating one first.

## Phase 6: Validate

```bash
npx talonctl env-check
npx talonctl doctor
```

Report any issues and help fix them.

## Phase 7: Group Chat Setup

If the user mentions group chats, explain:

> **Group Privacy:** By default, Telegram bots only see messages that @mention them in groups. To let the bot see all messages:
>
> 1. Open @BotFather
> 2. Send `/mybots` and select your bot
> 3. Go to **Bot Settings** > **Group Privacy** > **Turn off**
>
> After changing this, **remove and re-add the bot to the group** for it to take effect.

## Phase 8: Verify

Tell the user:

> 1. Make sure talond is running (or restart it)
> 2. Send a message to the bot in Telegram
> 3. You should get a response within a few seconds

If it doesn't work:

```bash
# Check if token is valid
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"

# Check logs
journalctl --user -u talond -f
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot not responding | Check `TELEGRAM_BOT_TOKEN` in `.env`, restart talond |
| Bot only responds to @mentions in groups | Disable Group Privacy in BotFather (see Phase 7) |
| "Unauthorized" errors in logs | Token is wrong or revoked — get new one from BotFather |
| Bot responds to strangers | Add `allowedChatIds` to config (see Phase 4) |
| Duplicate responses | Check if multiple instances of talond are running |

## Config Reference

```yaml
channels:
  - name: my-telegram
    type: telegram
    config:
      botToken: ${TELEGRAM_BOT_TOKEN}    # Required
      pollingTimeoutSec: 30              # Optional (default: 30)
      allowedChatIds:                    # Optional — restrict to specific chats
        - "12345678"
```

## How It Works

- Talon uses long-polling (`getUpdates`) — no webhook URL or public server needed
- Each Telegram chat maps to one Talon thread
- Markdown formatting is auto-converted to Telegram's MarkdownV2
- Typing indicator is shown while the agent processes
