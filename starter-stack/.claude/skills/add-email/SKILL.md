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

## Troubleshooting

| Problem | Fix |
|---------|-----|
| IMAP connection refused | Check host/port/TLS settings; some providers block "less secure apps" |
| SMTP auth failed | Use app-specific password, not account password |
| Gmail: "Application-specific password required" | Enable 2FA, then create an app password |
| Long delay before response | Default polling is 30s; lower `pollingIntervalMs` for faster response |
| Bot replies to spam | Add `allowedSenders` to config |
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
