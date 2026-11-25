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

If the user wants one group with a separate conversation per topic, or a persona per topic, skip to **Topic Workspace (forum group)** below: it covers everything in this phase and more.

If the user mentions group chats, explain:

> **Group Privacy:** By default, Telegram bots only see messages that @mention them in groups. To let the bot see all messages:
>
> 1. Open @BotFather
> 2. Send `/mybots` and select your bot
> 3. Go to **Bot Settings** > **Group Privacy** > **Turn off**
>
> After changing this, **remove and re-add the bot to the group** for it to take effect.
>
> Making the bot a group **administrator** has the same effect, works immediately, and is also needed to receive emoji reactions in a group.

Group chats are off by default. Set `allowGroupChats: true` on the channel, and add the group's chat ID to `allowedChatIds` if that list is set. To find the ID, send `/chatid@YourBotName` in the group.

## Topic Workspace (forum group)

Use this flow when the user wants to use one Telegram group as several separate conversations, one per topic ("a groceries topic, a calendar topic"), with or without a different persona per topic. Each topic becomes its own Talon thread with its own history.

Do the steps in order. Ask one question at a time and wait for the answer.

### T1: Check the starting point

Read `talond.yaml`. The Telegram channel must already exist and work in a private chat (Phases 1-6). Note the channel `name`, and whether `allowedChatIds` is set.

If `allowedChatIds` is missing, set it to the user's own chat ID first (Phase 4). The `/chatid` command in step T3 only answers senders listed there, and without the list the bot would answer in any group it is added to.

### T2: Create the forum group

Tell the user:

> 1. Create a Telegram group and add your bot to it.
> 2. Open the group settings and turn on **Topics**.
> 3. Make the bot an **administrator**. It needs no specific rights.

Explain why admin is required: Telegram only delivers ordinary group messages and emoji reactions to bots that are group administrators. If the member list shows "has no access to messages" next to the bot, this step was skipped.

Wait for the user to confirm.

### T3: Find the group ID

Tell the user to send this in the group (with the bot's real username):

> `/chatid@YourBotName`

The bot answers with `Chat ID: -100…`. Ask the user to paste the answer. The command is answered by Talon itself and works before the group is configured.

If the bot does not answer:

- talond is not running, or runs a build without `/chatid`: restart or update.
- The user's own chat ID is not in `allowedChatIds`: fix Phase 4.
- Fallback: send any message in the group and read the log. The first message from a group that is not enabled logs one warning, `telegram group chat is ignored because allowGroupChats is not enabled`, with the `chatId`.

Turning on Topics converts the group into a supergroup with a new ID starting with `-100`. Always use the ID from `/chatid`, never one noted earlier.

### T4: Ask how the group should behave

Ask:

> **Should the bot answer every message in this group, or only when it is @mentioned?**
>
> a) Every message (best when the group is just you and the bot, one subject per topic)
> b) Only on @mention, a trigger word, or a reply to the bot (best with several people)

Then ask:

> **Should answers quote the message they respond to?**
>
> a) No, plain answers (best for one-person topics)
> b) Yes, as replies (helps in a busy group)

### T5: Write the config

Edit the Telegram channel in `talond.yaml`. Keep every existing setting and add:

```yaml
      allowGroupChats: true
      allowedChatIds:
        - '<the user's own chat ID>'   # keep what is there
        - '<group chat ID>'            # from /chatid, quoted
      chats:
        '<group chat ID>':
          requireMention: false        # T4 answer a); omit for b)
          replyToTrigger: never        # T4 answer "plain"; omit for "as replies"
```

Rules:

- Chat IDs are quoted strings.
- Put `requireMention` and `replyToTrigger` under `chats.<group chat ID>`, not at the top level of `config`, so other chats on the same bot keep their behaviour.
- A chat listed under `chats` is not admitted by that alone: `allowGroupChats` and `allowedChatIds` are both still needed.

### T6: Persona per topic (optional)

Ask:

> **Should all topics use the same persona, or do you want a specific persona for some topics?**

If all the same: skip to T7. The channel's default persona answers every topic.

For each topic that gets its own persona:

1. The persona must exist. If it does not, create it first (`/create-profile`, or `npx talonctl add-persona`).
2. Ask the user to create the topic in Telegram and send `/chatid@YourBotName` **inside that topic**. The answer contains a line `Talon thread: -100…:<topic id>`. Ask them to paste it.
3. Bind it:

```bash
npx talonctl bind --persona <persona> --channel <channel> --thread '<Talon thread value>'
```

This writes a `thread:` entry to `bindings` in `talond.yaml`. The channel must also have a default binding (Phase 5) for the topics that are not bound; General always uses the default.

Tell the user that all personas speak through the same bot account: the persona changes the behaviour, not the name shown in Telegram.

### T7: Validate, restart, test

```bash
npx talonctl doctor
```

Restart talond; channel settings and bindings are applied at startup. Then tell the user:

> 1. Send a normal message in a topic, without a mention. The bot should answer in that topic.
> 2. Send a message in a second topic and check that the bot does not remember the first one.
> 3. If you bound personas: ask each topic "who are you?" and check the answer matches.

If something is off, see `docs/guides/telegram-topics.mdx`, section Troubleshooting. The two log lines that explain most problems:

- `telegram message from disallowed chat, dropping` — the group ID is missing from `allowedChatIds`.
- `telegram group chat is ignored because allowGroupChats is not enabled` — `allowGroupChats` is off.

### T8: Bring existing context into a topic (optional)

A new topic starts with no memory. Ask:

> **Have you already been talking to the bot about one of these subjects somewhere else, for example in your private chat, and should the topic know that?**

If no, the flow is done.

If yes, for each topic:

1. Find the source conversation:

```bash
npx talonctl list-threads --channel <channel>
```

For a private chat the external ID is the user's own chat ID. Confirm with the user which one it is.

2. Find the target: the `Talon thread` value from `/chatid@YourBotName` sent inside the topic (T6 step 2).

3. Ask:

> **Move or copy?**
>
> a) Move: the topic gets the memory and history, and the old conversation starts fresh
> b) Copy: the topic gets a copy and the old conversation keeps everything

Recommend **copy** when the source is a general-purpose chat that covers several subjects, because a move sends all of its memory to this one topic. Recommend **move** when the source conversation was about this subject only.

4. Show the preview and read it to the user:

```bash
npx talonctl move-context --channel <channel> --from '<source ID>' --to '<Talon thread>' --dry-run
```

Add `--copy` for a copy. Add `--memory-only` if the user wants the facts and notes but not the message history. Point out any warning in the preview: a target that already has history is merged by time, and messages with images stay in the source on a move.

5. After the user agrees, run the same command without `--dry-run` and with `--yes`.

Tell the user:

> The next message in the topic starts a fresh session that reads the migrated context. No restart is needed. Images are not carried over.

If the command refuses with "queued or running item(s)", the agent is busy in one of the conversations; wait for it to finish and run it again.

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

## Images (optional)

Telegram photos and image-MIME documents are ingested automatically. To let the
bound persona answer what a photo shows it needs exactly two things — existing
personas gain neither on upgrade:

```bash
npx talonctl set-capabilities --persona <persona> --add subagent.invoke:*
```

plus `vision` in that persona's `subagents` list in `talond.yaml` (there is no
`talonctl` command for persona sub-agent assignment). The shipped `vision` manifest
declares `requiredCapabilities: []`, so no image capability is part of an
Inspection. Pixels go only to the `vision` sub-agent; the persona itself stays
text-only.

Separately, `image.read:thread` is an **independent** model-free lookup grant for
the thread's Images and saved Findings (`image_lookup`). It needs no vision
assignment and never calls a model — recommended so the persona can re-read an
existing Finding, but not required for Inspections.

Telegram-specific behaviour worth warning the user about:

- **Photos usually lose EXIF.** Telegram recompresses photos, so GPS and capture
  time are typically gone. When metadata matters, tell the user to send the
  **original as a document** — for a format Talon already accepts (see below); this
  helps but cannot guarantee preservation.
- **HEIC is rejected** (`unsupported_mime`), which matters because iOS photos
  default to it. It must be **converted to JPEG, static PNG, or static WebP before
  sending**. Sending a HEIC as a document does **not** work: an unsupported image
  MIME in a document is rejected as `unsupported_mime` without even being
  downloaded, and it still burns one of the message's upload slots.
- **Albums stay separate messages**, each producing its own Image; a burst is not
  coalesced.
- **Up to 5 images per message** by default (`images.maxPerMessage`); the rest
  are rejected `count_limit` without being downloaded.
- **Polling is sequential.** While an image-bearing message is fetched and
  normalized that connector delivers nothing else — up to roughly 120 seconds,
  affecting every chat on this bot token.
- Normalized files are deleted after `images.retentionHours` (default 24h).
  Image records, GPS/EXIF and saved Findings persist beyond that.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot not responding | Check `TELEGRAM_BOT_TOKEN` in `.env`, restart talond |
| Bot only responds to @mentions in groups | Disable Group Privacy in BotFather (see Phase 7) |
| "Unauthorized" errors in logs | Token is wrong or revoked — get new one from BotFather |
| Bot responds to strangers | Add `allowedChatIds` to config (see Phase 4) |
| Duplicate responses | Check if multiple instances of talond are running |
| Bot is silent in a group, nothing in the log | Set `allowGroupChats: true`; add the group's chat ID to `allowedChatIds` if that list is set |
| Bot only answers @mentions, not ordinary group messages | Set `requireMention: false` and make the bot a group administrator |
| A topic should know what was discussed in another chat | `npx talonctl move-context --channel <channel> --from <source ID> --to <Talon thread>`; add `--copy` to keep the source, `--dry-run` to preview |
| Need the ID of a group or topic | Send `/chatid@YourBotName` there; the bot answers with the chat ID, topic ID and Talon thread key |
| Answers quote every message | Set `replyToTrigger: never`, connector-wide or under `chats.<chat ID>` |
| A reminder made in a topic arrives elsewhere | Check `recipientSource` on the `channel.send: message sent successfully` log line; `externalChatId argument` means the agent named a chat itself |
| Reactions in a group are not noticed | Make the bot a group administrator — Telegram only sends reaction updates to admins |
| Bot cannot react | Add `channel.react:*` to the persona's capabilities and restart |

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
      allowGroupChats: false             # Optional — answer in group chats (default: false)
      requireMention: true               # Optional — false = answer every group message (default: true)
      chats:                             # Optional — per-chat overrides, keyed by chat ID
        '-1001234567890':
          requireMention: false
          replyToTrigger: never
      replyToTrigger: groups             # Optional — never | groups (default) | always
      inboundReactions: true             # Optional (default: true)
```

### Replies, topics and reactions

- **Replies**: when a user replies to a message, the agent sees which one. `replyToTrigger` decides whether the bot's answer is sent as a native reply to the message that triggered it: in group chats only (`groups`, the default), everywhere (`always`), or not at all (`never`).
- **Groups**: off by default. With `allowGroupChats: true` the bot answers an @mention, a trigger word, or a native reply to one of its own messages. To have it answer every message (handy for a forum group where each topic is a conversation), also set `requireMention: false`, make the bot a group administrator, and list the group's chat ID in `allowedChatIds`. The chat ID is in the log line `telegram group chat is ignored because allowGroupChats is not enabled`, which appears the first time a group sends a message.
- **Topics**: a message inside a forum topic gets its own Talon thread (`<chat_id>:<topic_id>`), so each topic is a separate conversation and answers stay in the topic.
- **Reactions from the bot**: add the `channel.react:*` capability to the persona (`npx talonctl set-capabilities --persona <name> --add "channel.react:*"`). The agent can then react with 👍 instead of writing "understood". Telegram only accepts its standard reaction emoji.
- **Reactions from users**: a reaction on one of the bot's messages starts an agent run. Telegram delivers reactions in private chats, and in groups only when the bot is an administrator. Set `inboundReactions: false` to turn this off.

## How It Works

- Talon uses long-polling (`getUpdates`) — no webhook URL or public server needed
- Each Telegram chat maps to one Talon thread
- Of a photo's renditions, the largest one that fits the size limits becomes a
  single Image; the others are not separate Images
- Markdown formatting is auto-converted to Telegram's MarkdownV2
- Typing indicator is shown while the agent processes
