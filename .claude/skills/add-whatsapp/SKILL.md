---
name: add-whatsapp
description: |
  Add WhatsApp as a channel. Use when the user says "add whatsapp",
  "connect whatsapp", "set up whatsapp", or "whatsapp channel".
  Supports two modes: WhatsApp Business (Cloud API) and WhatsApp Baileys (WhatsApp Web bridge).
triggers:
  - "add whatsapp"
  - "connect whatsapp"
  - "whatsapp channel"
  - "whatsapp business"
  - "whatsapp baileys"
  - "whatsapp web"
---

# Add WhatsApp Channel

Walk the user through adding a WhatsApp channel to Talon. One question at a time.

## Phase 1: Choose Connector Type

Ask: **"Which WhatsApp connector do you want to use?"**

| Option | Type | When to use |
|--------|------|-------------|
| **WhatsApp Business** (`whatsappBusiness`) | Cloud API with webhook server | You have a Meta Business Account and want the official API |
| **WhatsApp Baileys** (`whatsappBaileys`) | WhatsApp Web bridge | You want to use a regular WhatsApp number, no Meta Business account needed |

If the user isn't sure, explain:
- **Business** requires a Meta developer account, a verified business phone number, and a public webhook endpoint. It's the official API — reliable and production-grade.
- **Baileys** connects as a WhatsApp Web client. Just scan a QR code. No Meta account, no webhooks, no public endpoint. Good for personal use or testing. Requires the optional `@whiskeysockets/baileys` npm package.

## Phase 2: Pre-flight

Check if a whatsapp channel already exists:

```bash
npx talonctl list-channels
```

---

# Path A: WhatsApp Business

## A.1: Meta Business Setup

Ask: **"Do you already have a WhatsApp Business API set up with a phone number ID and access token?"**

If no, walk them through it:

> ### Prerequisites
>
> - A Meta (Facebook) Business account
> - A phone number that can receive SMS or calls for verification
>
> ### Create the App
>
> 1. Go to [developers.facebook.com](https://developers.facebook.com)
> 2. Click **My Apps** > **Create App**
> 3. Select **Business** as the app type
> 4. Fill in the app name and select your business account
>
> ### Set Up WhatsApp
>
> 1. In the app dashboard, click **Add Product** > **WhatsApp** > **Set Up**
> 2. Go to **WhatsApp** > **API Setup** in the left sidebar
> 3. You'll see a test phone number — or add your own business number
> 4. Copy:
>    - **Phone Number ID** (numeric, under the phone number)
>    - **Temporary Access Token** (for testing — generate a permanent one for production)
>
> ### Generate a Permanent Token
>
> 1. Go to **Business Settings** > **System Users**
> 2. Create a system user with Admin role
> 3. Generate a token with `whatsapp_business_messaging` permission
> 4. This token doesn't expire
>
> ### Set Up Webhook
>
> 1. Go to **WhatsApp** > **Configuration**
> 2. Set the webhook URL to your server's endpoint (e.g. `https://your-server.com/webhook/whatsapp`)
> 3. Set a **Verify Token** (any string you choose — you'll use this in config)
> 4. Subscribe to the `messages` webhook field

Wait for the user to provide: phone number ID, access token, and verify token.

## A.2: Add the Channel

Ask for a channel name (suggest `my-whatsapp`), then:

```bash
npx talonctl add-channel --name <name> --type whatsappBusiness
```

Then edit `talond.yaml` to set the config section:

```yaml
config:
  phoneNumberId: "123456789"
  accessToken: ${WHATSAPP_ACCESS_TOKEN}
  verifyToken: ${WHATSAPP_VERIFY_TOKEN}
  appSecret: ${WHATSAPP_APP_SECRET}       # Enables embedded webhook server with HMAC validation
  webhookPort: 3000                        # Optional (default: 3000)
  webhookPath: '/webhook'                  # Optional (default: /webhook)
```

Tell the user to add to `.env`:

```
WHATSAPP_ACCESS_TOKEN=your-access-token
WHATSAPP_VERIFY_TOKEN=your-verify-token
WHATSAPP_APP_SECRET=your-app-secret
```

Note: if `appSecret` is omitted, the embedded webhook server does not start. The user would need to proxy webhook events externally and call `feedWebhook()`.

## A.3: Verify (Business)

Tell the user:

> 1. Make sure talond is running (or restart it)
> 2. Make sure your webhook endpoint is publicly accessible (use ngrok for testing: `ngrok http 3000`)
> 3. Send a WhatsApp message to the business number
> 4. You should get a response within a few seconds

If it doesn't work:

```bash
# Check logs
journalctl --user -u talond -f

# Test webhook verification
curl "https://your-server.com/webhook?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=test"
```

---

# Path B: WhatsApp Baileys

## B.1: Install Baileys

Baileys is an optional dependency. Install it first:

```bash
npm install @whiskeysockets/baileys
```

## B.2: Add the Channel

Ask for a channel name (suggest `my-whatsapp`), then:

```bash
npx talonctl add-channel --name <name> --type whatsappBaileys
```

Then edit `talond.yaml` to set the config section:

```yaml
config:
  authDir: './baileys-auth'         # Where session credentials are stored (default: ./baileys-auth)
  printQR: true                     # Print QR code to terminal (default: true)
  markOnlineOnConnect: false        # Show as online in WhatsApp (default: false)
```

No environment variables or secrets needed — authentication is via QR code.

## B.3: First Connection

Tell the user:

> 1. Start talond (or restart it)
> 2. Watch the terminal — a QR code will appear
> 3. Open WhatsApp on your phone > Settings > Linked Devices > Link a Device
> 4. Scan the QR code
> 5. Once connected, credentials are saved to `authDir` and reused on next start

## B.4: Verify (Baileys)

> Send a WhatsApp message to the connected number from another phone. You should get a response within a few seconds.

If it doesn't work:

```bash
journalctl --user -u talond -f
```

**If you see "logged out"**: delete the `authDir` folder and restart to re-authenticate.

---

# Common Steps (both paths)

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

### WhatsApp Business

| Problem | Fix |
|---------|-----|
| Webhook verification fails | Check `verifyToken` matches what's in Meta App Dashboard |
| Messages not arriving | Ensure webhook URL is publicly accessible and subscribed to `messages` |
| "Invalid OAuth access token" | Token expired — generate a permanent one via System Users |
| Bot responds but user doesn't see it | Check WhatsApp message template approval (for outbound-first messages) |
| Only text messages work | Normal — Talon v1 supports text only; media messages are logged but skipped |

### WhatsApp Baileys

| Problem | Fix |
|---------|-----|
| QR code not appearing | Check `printQR: true` in config and that you can see terminal output |
| "logged out" error | Delete `authDir` folder and restart to re-authenticate |
| Group messages ignored | Expected — Baileys connector only processes individual chats in v1 |
| Module not found | Run `npm install @whiskeysockets/baileys` — it's an optional dependency |
| Only text messages work | Normal — Talon v1 supports text only; media messages are logged but skipped |

## Config Reference

### WhatsApp Business

```yaml
channels:
  - name: my-whatsapp
    type: whatsappBusiness
    config:
      phoneNumberId: "123456789"               # Required
      accessToken: ${WHATSAPP_ACCESS_TOKEN}    # Required
      verifyToken: ${WHATSAPP_VERIFY_TOKEN}    # Required — must match Meta dashboard
      appSecret: ${WHATSAPP_APP_SECRET}        # Optional — enables embedded webhook server
      webhookPort: 3000                         # Optional (default: 3000)
      webhookHost: '0.0.0.0'                   # Optional (default: 0.0.0.0)
      webhookPath: '/webhook'                  # Optional (default: /webhook)
      apiVersion: "v18.0"                      # Optional (default: v18.0)
```

### WhatsApp Baileys

```yaml
channels:
  - name: my-whatsapp
    type: whatsappBaileys
    config:
      authDir: './baileys-auth'                  # Optional (default: ./baileys-auth)
      printQR: true                              # Optional (default: true)
      markOnlineOnConnect: false                 # Optional (default: false)
      browser: ['Talon', 'Chrome', '1.0']        # Optional (default: Browsers.appropriate('Talon'))
```
