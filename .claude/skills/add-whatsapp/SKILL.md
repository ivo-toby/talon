---
name: add-whatsapp
description: |
  Add WhatsApp as a channel via Baileys (WhatsApp Web bridge).
  Use when the user says "add whatsapp", "connect whatsapp",
  "set up whatsapp", or "whatsapp channel".
triggers:
  - "add whatsapp"
  - "connect whatsapp"
  - "whatsapp channel"
  - "whatsapp baileys"
  - "whatsapp web"
---

# Add WhatsApp Channel

Walk the user through adding a WhatsApp channel to Talon via the Baileys connector.
Baileys connects as a WhatsApp Web client — just scan a QR code. No Meta Business
account, no webhooks, no public endpoint needed. One question at a time.

## Pre-flight

Check if a whatsapp channel already exists:

```bash
npx talonctl list-channels
```

## Step 1: Install Baileys

Baileys and its QR rendering dependency are optional. Install them first:

```bash
npm install @whiskeysockets/baileys qrcode-terminal
```

## Step 2: Add the Channel

Ask for a channel name (suggest `my-whatsapp`), then:

```bash
npx talonctl add-channel --name <name> --type whatsappBaileys
```

Then ask: **"Will you use a dedicated WhatsApp number for the bot, or your own personal number (self-chat mode)?"**

| Option | Config | When to use |
|--------|--------|-------------|
| **Dedicated number** | `selfChat: false` (default) | You have a second phone/number for the bot |
| **Self-chat (personal number)** | `selfChat: true` | You want to use your own WhatsApp — the bot listens in your "Message Yourself" thread |

Then ask: **"Do you want to require a trigger word (e.g. `@Talon`) to activate the bot, or should every message be processed?"**

Trigger words are especially useful in self-chat mode so notes-to-self don't trigger the bot. They also work in dedicated-number mode.

Edit `talond.yaml` to set the config section based on their answers:

**Dedicated number:**
```yaml
config:
  authDir: './baileys-auth'
```

**Self-chat with trigger word:**
```yaml
config:
  authDir: './baileys-auth'
  selfChat: true
  triggerWords: ['@Talon']
```

**Self-chat without trigger word:**
```yaml
config:
  authDir: './baileys-auth'
  selfChat: true
```

No environment variables or secrets needed — authentication is via QR code.

## Step 3: Authenticate

Run the standalone auth command — it prints a QR code to the terminal and waits for a scan:

```bash
npx talonctl whatsapp-auth --auth-dir ./baileys-auth
```

Tell the user:

> 1. A QR code will appear in the terminal
> 2. Open WhatsApp on your phone > Settings > Linked Devices > Link a Device
> 3. Scan the QR code
> 4. Once authenticated, credentials are saved and the command exits
> 5. Now start (or restart) talond — no QR code will be needed

The `--auth-dir` must match the `authDir` in the channel config. Default is `./baileys-auth`.

## Step 4: Security — Restrict Access

**Important**: By default, anyone who knows the bot's phone number can chat with it. Walk the user through discovering their sender ID and locking down access:

> ### How to find sender IDs
>
> WhatsApp no longer uses phone numbers as identifiers in all cases. Contacts may appear
> as opaque "LID" numbers (e.g. `96490886312027@lid`) instead of phone-based JIDs
> (e.g. `31612345678@s.whatsapp.net`). You cannot predict which format you'll get,
> so the only reliable way to find a sender's ID is from the logs:
>
> 1. Temporarily set `logLevel: debug` in `talond.yaml`
> 2. Start talond (or restart it)
> 3. Send a test message from each phone that should be allowed
> 4. In the logs, find the line: `whatsapp-baileys: inbound message received`
> 5. Copy the `jid` value — the part **before the `@`** is the sender ID
> 6. Add each sender ID to `allowedSenders` in the channel config
> 7. Set `logLevel` back to `info` and restart talond

Ask the user to send a test message and share the `jid` from the logs so you can help them configure `allowedSenders`:

```yaml
config:
  authDir: './baileys-auth'
  allowedSenders:
    - '96490886312027'              # sender ID from logs (before the @)
```

When the list is omitted or empty, all senders are accepted.

> **Strongly recommended**: Always configure `allowedSenders` for production use. An open WhatsApp bot can be abused by anyone who discovers the number.

## Step 5: Verify (Baileys)

> Send a WhatsApp message to the connected number from an **allowed** phone. You should get a response within a few seconds. Then send from a phone that is **not** in `allowedSenders` and confirm the message is dropped (check logs for "message from disallowed sender, dropping").

If it doesn't work:

```bash
journalctl --user -u talond -f
```

**If you see "logged out"**: delete the `authDir` folder, re-run `talonctl whatsapp-auth`, and restart talond.

---

## Bind a Persona

```bash
npx talonctl list-personas
```

Ask which persona to bind, then:

```bash
npx talonctl bind --persona <name> --channel <channel-name>
```

## Validate

```bash
npx talonctl env-check
npx talonctl doctor
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| QR code not appearing | Run `npx talonctl whatsapp-auth` again in a visible terminal window. The QR is printed by `talonctl whatsapp-auth`, not by the connector — there is no `printQR` config option |
| "logged out" error | Delete `authDir` folder and restart to re-authenticate |
| Group messages ignored | Expected — Baileys connector only processes individual chats in v1 |
| Module not found | Run `npm install @whiskeysockets/baileys` — it's an optional dependency |
| Only text messages work | Normal — Talon v1 supports text only; media messages are logged but skipped |
| Self-chat not responding | Check `selfChat: true` in config. Verify `selfJid` appears in connect log |
| Trigger word not matching | Trigger words are case-insensitive. Check spelling. Message must **start** with the trigger word |
| Bot responds to everything in self-chat | Add `triggerWords` to only process triggered messages |

## Config Reference

```yaml
channels:
  - name: my-whatsapp
    type: whatsappBaileys
    config:
      authDir: './baileys-auth'                  # Optional (default: ./baileys-auth)
      markOnlineOnConnect: false                 # Optional (default: false)
      browser: ['Talon', 'Chrome', '1.0']        # Optional (default: Browsers.appropriate('Talon'))
      selfChat: false                            # Optional — self-chat mode (default: false)
      triggerWords: ['@Talon']                   # Optional — require trigger word to activate
      allowedSenders:                            # Optional — restrict who can message the bot
        - '96490886312027'
```
