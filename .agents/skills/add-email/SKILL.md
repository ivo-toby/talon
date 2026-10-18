---
name: add-email
description: |
  Add email (IMAP/SMTP) as a channel. Use when the user says "add email",
  "connect email", "set up email", or "email channel".
triggers:
  - "add email"
  - "connect email"
  - "email channel"
  - "imap"
  - "smtp"
---

# Add Email Channel

Walk the user through adding email (IMAP inbound + SMTP outbound) as a channel to Talon. One question at a time.

## Phase 1: Pre-flight

Check if an email channel already exists:

```bash
npx talonctl list-channels
```

## Phase 2: Gather Credentials

Ask: **"Which email provider will you use? (Gmail, Outlook, custom IMAP/SMTP)"**

### Gmail

> 1. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
>    - You need 2FA enabled to see this page
> 2. Create an app password for "Mail"
> 3. Copy the 16-character password (spaces don't matter)
>
> **Settings:**
> - IMAP: `imap.gmail.com`, port 993, TLS
> - SMTP: `smtp.gmail.com`, port 587, STARTTLS

### Outlook / Microsoft 365

> 1. Go to [account.microsoft.com/security](https://account.microsoft.com/security)
> 2. Create an app password (requires 2FA)
>
> **Settings:**
> - IMAP: `outlook.office365.com`, port 993, TLS
> - SMTP: `smtp.office365.com`, port 587, STARTTLS

### Custom IMAP/SMTP

Ask for:
- IMAP host, port, TLS (yes/no)
- SMTP host, port, TLS (yes/no)
- Username and password

## Phase 3: Add the Channel

Ask for a channel name (suggest `my-email`), then:

```bash
npx talonctl add-channel --name <name> --type email
```

Then edit `talond.yaml` to set the config section. Example for Gmail:

```yaml
config:
  imapHost: imap.gmail.com
  imapPort: 993
  imapUser: bot@gmail.com
  imapPass: ${EMAIL_PASSWORD}
  imapSecure: true
  smtpHost: smtp.gmail.com
  smtpPort: 587
  smtpUser: bot@gmail.com
  smtpPass: ${EMAIL_PASSWORD}
  smtpSecure: false
  fromAddress: "Talon Bot <bot@gmail.com>"
```

Tell the user to add to `.env`:

```
EMAIL_PASSWORD=your-app-password
```

## Phase 4: Restrict Senders (Recommended)

Ask: **"Do you want to restrict which email addresses can talk to the bot?"**

If yes, add to the config:

```yaml
config:
  # ... smtp/imap settings ...
  allowedSenders:
    - "user1@example.com"
    - "user2@example.com"
```

Without this, anyone who emails the address can interact with the bot.

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
> 2. Send an email to the bot's address
> 3. You should get a reply within 30-60 seconds (depends on polling interval)

If it doesn't work:

```bash
journalctl --user -u talond -f
```

## Images (optional)

Email image attachments are ingested automatically. To let the bound persona
answer what a picture shows it needs exactly two things — existing personas gain
neither on upgrade:

```bash
npx talonctl set-capabilities --persona <persona> --add subagent.invoke:*
```

plus `vision` in that persona's `subagents` list in `talond.yaml`. The shipped
`vision` manifest declares `requiredCapabilities: []`, so no image capability is
part of an Inspection. Pixels go only to the `vision` sub-agent; the persona stays
text-only.

Separately, `image.read:thread` is an **independent** model-free lookup grant for
the thread's Images and saved Findings (`image_lookup`) — recommended, not required
for Inspections.

Email-specific behaviour, which differs sharply from chat channels:

- **Only attached images count.** A part must carry an image MIME type. Parts with
  an absent or non-image MIME are excluded silently and use no upload slot.
- **Inline and CID images are never ingested.** A part marked inline, or
  classified as related CID content (`cid:` imagery inside an HTML body), is
  excluded silently — even a genuine photo. Ask the user to **attach** the file.
- **The practical size limit is far below `images.maxInputBytes`.** Email's
  unchanged 10 MiB cap applies to the **whole message** — encoding, headers, body
  and every part combined. Base64 leaves roughly **7.5 MiB or less** for one
  decoded image once overhead is counted, so a photo that fits the 10 MiB image
  setting can still be lost. Oversized whole emails keep the existing pre-ingestion
  skipping behaviour: Talon never sees them.
- **Authorization still gates everything.** Mail is fetched and MIME-parsed before
  sender checks so parts can be classified, but parts from an unauthorized sender
  are never normalized into Images.
- Normalized files are deleted after `images.retentionHours` (default 24h).
  Image records, GPS/EXIF and saved Findings persist beyond that. Mail is the
  recommended channel when metadata matters, because attached originals are less
  likely to be recompressed than chat photos — but preservation is still not
  guaranteed; missing values stay unknown.
- **Polling is sequential, but email performs no image fetch.** The bytes are
  already in hand: IMAP retrieves the whole message within the 10 MiB input cap and
  decodes the attachments before the connector plans any media, so there is nothing
  left to download and **the remote-fetch budget never applies to email**. While an
  image-bearing mail is normalized, this connector delivers nothing else, and the
  only image deadline is the shared 60-second normalization one (at most 3 attempts
  per Image) — plus ordinary IMAP polling latency, which is not an image budget.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| IMAP connection refused | Check host/port/TLS settings; some providers block "less secure apps" |
| SMTP auth failed | Use app-specific password, not account password |
| Gmail: "Application-specific password required" | Enable 2FA, then create an app password |
| Long delay before response | Default polling is 30s; lower `pollingIntervalMs` for faster response |
| Bot replies to spam | Add `allowedSenders` to config |
| Attachment ignored | Inline and `cid:` body images are excluded by design; ask the user to attach the file as a regular attachment with an image MIME type |
| Large photo never arrives | Email's 10 MiB cap covers the whole encoded message, so base64 leaves roughly 7.5 MiB or less per decoded image. Send it as its own email, or use Telegram/WhatsApp |
| HTML formatting broken | Talon sends HTML emails; check if email client renders HTML |

## Config Reference

```yaml
channels:
  - name: my-email
    type: email
    config:
      # IMAP (inbound)
      imapHost: imap.gmail.com             # Required
      imapPort: 993                        # Required
      imapUser: bot@gmail.com              # Required
      imapPass: ${EMAIL_PASSWORD}          # Required
      imapSecure: true                     # Required (true = TLS, false = STARTTLS)
      # SMTP (outbound)
      smtpHost: smtp.gmail.com             # Required
      smtpPort: 587                        # Required
      smtpUser: bot@gmail.com              # Required
      smtpPass: ${EMAIL_PASSWORD}          # Required
      smtpSecure: false                    # Required (false for port 587, true for 465)
      # General
      fromAddress: "Talon <bot@gmail.com>" # Required
      allowedSenders:                      # Optional — restrict who can email the bot
        - "user@example.com"
      pollingIntervalMs: 30000             # Optional (default: 30000 = 30s)
      mailbox: "INBOX"                     # Optional (default: INBOX)
```

## How It Works

- Inbound: polls IMAP at configurable intervals (default 30s)
- Outbound: sends via SMTP with HTML formatting
- Threading: uses Message-ID / In-Reply-To headers to maintain conversation threads
- Each sender email address maps to one Talon thread
