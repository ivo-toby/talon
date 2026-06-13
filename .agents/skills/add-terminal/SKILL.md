---
name: add-terminal
description: |
  Add the terminal/CLI channel for talonctl chat. Use when the user says
  "add terminal", "cli chat", "terminal channel", or "talonctl chat".
triggers:
  - "add terminal"
  - "terminal channel"
  - "cli chat"
  - "talonctl chat"
---

# Add Terminal Channel

Walk the user through adding the terminal channel, which enables `talonctl chat` for CLI-based conversations with the daemon.

## Phase 1: Pre-flight

Check if a terminal channel already exists:

```bash
npx talonctl list-channels
```

If one exists, the user can already use `talonctl chat`. Show them how (skip to Verify).

## Phase 2: Add the Channel

Ask for a channel name (suggest `terminal`), then:

```bash
npx talonctl add-channel --name <name> --type terminal
```

Then edit `talond.yaml` to set the config section:

```yaml
config:
  port: 8089
  host: "127.0.0.1"
  token: ${TERMINAL_TOKEN}
```

Tell the user to add to `.env`:

```
TERMINAL_TOKEN=any-secret-string-you-choose
```

The token can be any string — it's just used to authenticate CLI clients against the WebSocket server. Generate one with:

```bash
openssl rand -hex 16
```

## Phase 3: Bind a Persona

```bash
npx talonctl list-personas
```

Ask which persona to bind, then:

```bash
npx talonctl bind --persona <name> --channel <channel-name>
```

## Phase 4: Validate

```bash
npx talonctl env-check
npx talonctl doctor
```

## Phase 5: Verify

Tell the user:

> 1. Make sure talond is running (or restart it)
> 2. Run: `npx talonctl chat --port 8089 --token <your-token>`
> 3. Type a message and press Enter — you should get a response

For TLS connections (if running behind a reverse proxy):

```bash
npx talonctl chat --port 8089 --token <your-token> --tls
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Connection refused | Check talond is running and port matches config |
| Auth failed | Token in `talonctl chat --token` must match `TERMINAL_TOKEN` in `.env` |
| Port already in use | Change the port in config (e.g. 8090) |
| Works locally but not remotely | Default host is `127.0.0.1` (localhost only). Change to `0.0.0.0` to allow remote, but use a firewall + TLS |

## Config Reference

```yaml
channels:
  - name: terminal
    type: terminal
    config:
      port: 8089                    # Required — WebSocket server port
      host: "127.0.0.1"            # Optional (default: 127.0.0.1 — localhost only)
      token: ${TERMINAL_TOKEN}     # Required — shared secret for auth
```

## How It Works

- talond starts a WebSocket server on the configured port
- `talonctl chat` connects, authenticates with the token, then sends/receives messages
- Each CLI client gets its own persistent conversation thread
- Typing indicators are shown while the agent processes
- Reconnecting with the same client ID resumes the conversation
