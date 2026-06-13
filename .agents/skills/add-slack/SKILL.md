---
name: add-slack
description: |
  Add Slack as a channel. Use when the user says "add slack",
  "connect slack", "set up slack bot", or "slack channel".
triggers:
  - "add slack"
  - "connect slack"
  - "slack channel"
  - "slack bot"
---

# Add Slack Channel

Walk the user through adding a Slack bot channel to Talon. One question at a time.

## Phase 1: Pre-flight

Check if a slack channel already exists:

```bash
npx talonctl list-channels
```

If one exists, ask the user if they want to add another or reconfigure.

## Phase 2: Create the Slack App

Ask: **"Do you already have a Slack app with bot and app tokens?"**

If no, walk them through it:

> ### Create the App
>
> 1. Go to [api.slack.com/apps](https://api.slack.com/apps)
> 2. Click **Create New App** > **From scratch**
> 3. Name it (e.g. "Talon") and pick your workspace
>
> ### Enable Socket Mode
>
> 1. Go to **Settings** > **Socket Mode**
> 2. Toggle **Enable Socket Mode** on
> 3. When prompted, create an app-level token:
>    - Name: "socket" (or anything)
>    - Scope: `connections:write`
> 4. Copy the token (starts with `xapp-`)
>
> ### Subscribe to Events
>
> 1. Go to **Features** > **Event Subscriptions**
> 2. Toggle **Enable Events** on
> 3. Under **Subscribe to bot events**, add:
>    - `message.channels` (messages in public channels)
>    - `message.groups` (messages in private channels)
>    - `message.im` (direct messages)
>
> ### Add OAuth Scopes
>
> 1. Go to **Features** > **OAuth & Permissions**
> 2. Under **Bot Token Scopes**, add:
>    - `chat:write` (send messages)
>    - `channels:history` (read public channel messages)
>    - `groups:history` (read private channel messages)
>    - `im:history` (read DMs)
>    - `channels:read` (list channels)
>    - `groups:read` (list private channels)
>    - `users:read` (resolve user names)
>
> ### Install to Workspace
>
> 1. Go to **Settings** > **Install App**
> 2. Click **Install to Workspace** and authorize
> 3. Copy the **Bot User OAuth Token** (starts with `xoxb-`)
>
> ### Get Signing Secret
>
> 1. Go to **Settings** > **Basic Information**
> 2. Under **App Credentials**, copy the **Signing Secret**

Wait for the user to provide all three: bot token (`xoxb-`), app token (`xapp-`), and signing secret.

## Phase 3: Add the Channel

Ask for a channel name (suggest `my-slack`), then:

```bash
npx talonctl add-channel --name <name> --type slack
```

Then edit `talond.yaml` to set the config section:

```yaml
config:
  botToken: ${SLACK_BOT_TOKEN}
  appToken: ${SLACK_APP_TOKEN}
  signingSecret: ${SLACK_SIGNING_SECRET}
```

Tell the user to add to `.env`:

```
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_APP_TOKEN=xapp-your-token
SLACK_SIGNING_SECRET=your-signing-secret
```

## Phase 4: Invite the Bot

Tell the user:

> In Slack, invite the bot to the channels where it should be active:
>
> 1. Go to the channel
> 2. Type `/invite @Talon` (or whatever you named the app)
>
> The bot can only see messages in channels it's been invited to.
> For DMs, users can message the bot directly — no invite needed.

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

Report any issues and help fix them.

## Phase 7: Verify

Tell the user:

> 1. Make sure talond is running (or restart it)
> 2. Send a DM to the bot in Slack, or @mention it in a channel
> 3. You should get a response within a few seconds

If it doesn't work:

```bash
# Check logs
journalctl --user -u talond -f
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot not responding | Check all three tokens in `.env`, restart talond |
| "not_authed" errors | Bot token is wrong or expired — reinstall app in Slack |
| "missing_scope" errors | Add missing OAuth scopes, then reinstall the app |
| Bot doesn't see messages in channel | Invite the bot to the channel with `/invite @BotName` |
| Bot responds to itself | This is filtered automatically — check logs for other issues |
| Socket Mode connection fails | Check `SLACK_APP_TOKEN` (must start with `xapp-`), ensure Socket Mode is enabled |

## Config Reference

```yaml
channels:
  - name: my-slack
    type: slack
    config:
      botToken: ${SLACK_BOT_TOKEN}           # Required (xoxb-)
      appToken: ${SLACK_APP_TOKEN}           # Optional — for Socket Mode (xapp-)
      signingSecret: ${SLACK_SIGNING_SECRET} # Required
      defaultChannel: "C01234567"            # Optional — fallback channel ID
```

## How It Works

- Talon uses Socket Mode (WebSocket via app token) — no public webhook URL needed
- Thread replies are preserved (uses Slack thread_ts)
- Bot messages are automatically filtered to prevent self-replies
- Markdown is auto-converted to Slack's mrkdwn format
