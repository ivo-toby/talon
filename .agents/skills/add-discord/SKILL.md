---
name: add-discord
description: |
  Add Discord as a channel. Use when the user says "add discord",
  "connect discord", "set up discord bot", or "discord channel".
triggers:
  - "add discord"
  - "connect discord"
  - "discord channel"
  - "discord bot"
---

# Add Discord Channel

Walk the user through adding a Discord bot channel to Talon. One question at a time.

## Phase 1: Pre-flight

Check if a discord channel already exists:

```bash
npx talonctl list-channels
```

## Phase 2: Create the Bot

Ask: **"Do you already have a Discord bot token and application ID?"**

If no, walk them through it:

> ### Create the Application
>
> 1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
> 2. Click **New Application**, give it a name (e.g. "Talon")
> 3. Copy the **Application ID** from the General Information page
>
> ### Create the Bot
>
> 1. Go to **Bot** in the left sidebar
> 2. Click **Add Bot** (or it may already exist)
> 3. Click **Reset Token** and copy the bot token
> 4. Under **Privileged Gateway Intents**, enable:
>    - **Message Content Intent** (required to read message text)
>    - **Server Members Intent** (optional, for user info)
>
> ### Invite the Bot to Your Server
>
> 1. Go to **OAuth2** > **URL Generator**
> 2. Select scopes: `bot`, `applications.commands`
> 3. Select bot permissions:
>    - Send Messages
>    - Read Message History
>    - View Channels
> 4. Copy the generated URL and open it in your browser
> 5. Select your server and authorize

Wait for the user to provide the bot token and application ID.

## Phase 3: Add the Channel

Ask for a channel name (suggest `my-discord`), then:

```bash
npx talonctl add-channel --name <name> --type discord
```

Then edit `talond.yaml` to set the config section:

```yaml
config:
  botToken: ${DISCORD_BOT_TOKEN}
  applicationId: "1234567890"
```

Tell the user to add to `.env`:

```
DISCORD_BOT_TOKEN=your-bot-token
```

## Phase 4: Restrict Access (Optional)

Ask: **"Do you want to restrict the bot to specific servers or channels?"**

If yes, get the IDs:

> **How to get Discord IDs:**
>
> 1. In Discord, go to **Settings** > **Advanced** > enable **Developer Mode**
> 2. Right-click a server name > **Copy Server ID** (this is the guild ID)
> 3. Right-click a channel > **Copy Channel ID**

Then edit the config:

```yaml
config:
  botToken: ${DISCORD_BOT_TOKEN}
  applicationId: "1234567890"
  guildId: "9876543210"
  allowedChannelIds:
    - "111111111"
    - "222222222"
```

## Phase 5: Bind a Persona

```bash
npx talonctl list-personas
```

Ask which persona to bind, then:

```bash
npx talonctl bind --persona <name> --channel <channel-name>
```

## Phase 6: Validate

```bash
npx talonctl env-check
npx talonctl doctor
```

## Phase 7: Verify

Tell the user:

> 1. Make sure talond is running (or restart it)
> 2. Send a message in a channel where the bot is present, or DM the bot
> 3. You should get a response within a few seconds

If it doesn't work:

```bash
journalctl --user -u talond -f
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot not responding | Check `DISCORD_BOT_TOKEN` in `.env`, restart talond |
| Bot is online but ignores messages | Enable **Message Content Intent** in developer portal |
| "Missing Access" errors | Bot lacks channel permissions — check invite URL scopes |
| Bot responds in wrong channels | Add `guildId` or `allowedChannelIds` to config |
| Rate limit warnings in logs | Normal for busy servers — Talon handles retries automatically (up to 3) |

## Config Reference

```yaml
channels:
  - name: my-discord
    type: discord
    config:
      botToken: ${DISCORD_BOT_TOKEN}       # Required
      applicationId: "1234567890"          # Required
      guildId: "9876543210"                # Optional — restrict to one server
      allowedChannelIds:                   # Optional — restrict to specific channels
        - "111111111"
      intents: 33280                       # Optional (default: GUILD_MESSAGES | MESSAGE_CONTENT)
```

## How It Works

- Talon connects to Discord's Gateway via WebSocket
- Bot messages are automatically filtered (no self-replies)
- Rate limits are respected with automatic retry (up to 3 attempts)
- Guild and channel allowlists are enforced before processing
