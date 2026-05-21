---
name: talon.setup.docker
description: |
  Use when setting up Talon from the starter bundle (docker-based install)
  for the first time, adding channels or personas, changing the AI provider,
  or troubleshooting. Triggers on phrases like "set up talon", "configure
  talon", "add channel", "switch provider", "talonctl …".
triggers:
  - "set up talon"
  - "setup talon"
  - "configure talon"
  - "talon setup"
  - "add channel"
  - "add persona"
  - "switch provider"
  - "change provider"
  - "talon doctor"
  - "talonctl"
---

# Talon setup — docker bundle

Guide the user through configuring the Talon starter bundle. This is a
conversational wizard — **one question at a time**, act on the answer,
move on.

## Core principles

- **Docker-first.** The bundle ships a published image and a host-side
  `talonctl` wrapper. Never run `npx talonctl`, `npm install`, or
  `node dist/index.js`.
- **`talonctl` requires the daemon to be running.** The wrapper is a
  `docker exec` into the `talond` container. For first-time setup, the
  user edits `.env` and `config/talond.yaml` manually, then boots the
  daemon, then `talonctl` is available for everything else.
- **One question at a time.** Never dump a wall of options.
- **No secrets.** Never ask for or write actual tokens. Only show
  `${ENV_VAR}` placeholders in `config/talond.yaml`. Real values go in
  `.env`.
- **Show output.** When you run a command, show what came back.

## Detect state first

Before asking anything, look at the bundle directory:

```bash
ls -la                                                              # bundle layout
test -f .env && echo ".env present" || echo ".env missing"           # exists?
grep -oE '^[A-Z][A-Z0-9_]*' .env 2>/dev/null | sort -u                # which env vars set? (names only)
test -f config/talond.yaml && echo "yaml present" || echo "yaml missing"
docker ps --filter name=talond --format '{{.Names}} {{.Status}}'    # daemon running?
```

**Never print secret values.**

- `.env` contains real secrets — only inspect variable *names*, never
  `cat .env`.
- `config/talond.yaml` *should* only contain `${ENV_VAR}` placeholders,
  but some users hand-paste literal keys. Don't `cat` it either. When
  the daemon is running, use `talonctl config-show` (auto-masked). Until
  then, inspect specific sections you need with `grep -A` for the keys
  you're checking, and never display lines that match `apiKey:`,
  `botToken:`, `password:`, `secret`, or `token:` patterns with a
  literal value.

If you need to *show* a config snippet to the user, use:

```bash
talonctl config-show 2>/dev/null         # post-boot, masked
# OR pre-boot, redact inline:
sed -E 's/^(  *(apiKey|botToken|.*[Tt]oken|.*[Ss]ecret|password): )(.+)$/\1***MASKED***/' config/talond.yaml
```

Use the state to skip steps:

| State | Action |
|-------|--------|
| `.env` missing | Run `cp .env.example .env`, fill in step 2 |
| `config/talond.yaml` missing | Run `cp config/talond.example.yaml config/talond.yaml`, edit in step 3 |
| Daemon already running | Skip to talonctl-based additions (step 6) |
| All configured + daemon running | Present the menu (see "Returning user menu") |

### Returning user menu

If everything is configured:

```
What would you like to do?
  a) Switch AI provider
  b) Add another channel (Telegram, Slack, …)
  c) Add or modify a persona
  d) Bind/unbind a persona to a channel
  e) Manage scheduled tasks
  f) Run health check (talonctl doctor)
  g) Show current config (talonctl config-show)
  h) View daemon logs (docker compose logs -f talond)
  i) Restart the daemon
```

## Available talonctl commands (post-boot)

All commands run via the bundle's `bin/talonctl` wrapper (or the
installed `talonctl` if `./install.sh` has been run):

| Command | Purpose |
|---------|---------|
| `talonctl status` | Daemon health, active runs, queue depth |
| `talonctl doctor` | Validate config + environment |
| `talonctl config-show` | Show current config (secrets masked) |
| `talonctl env-check` | List env-var placeholders the config expects |
| `talonctl list-channels` | Configured channels |
| `talonctl add-channel --name <n> --type <t>` | Add a channel |
| `talonctl remove-channel --name <n>` | Remove a channel |
| `talonctl list-personas` | Configured personas |
| `talonctl add-persona --name <n>` | Scaffold a persona dir + add to config |
| `talonctl remove-persona --name <n>` | Remove a persona |
| `talonctl bind --persona <p> --channel <c>` | Bind persona to channel |
| `talonctl unbind --persona <p> --channel <c>` | Remove a binding |
| `talonctl add-mcp --skill <s> --name <n> --transport stdio --command <c>` | Add an MCP server to a skill |
| `talonctl list-providers` | Configured AI providers |
| `talonctl add-provider --name <n> --command <c> [--context both]` | Add a provider |
| `talonctl set-default-provider --name <n> --context <ctx>` | Set default provider |
| `talonctl test-provider --name <n>` | Verify a provider connects |
| `talonctl list-capabilities` | All available capability labels |
| `talonctl set-capabilities --persona <p> --add <labels>` | Add capabilities |
| `talonctl set-capabilities --persona <p> --remove <labels>` | Remove capabilities |
| `talonctl list-schedules` | Configured scheduled tasks |
| `talonctl add-schedule --persona <p> --channel <c> --cron <expr> --label <l> --prompt <text>` | Add a scheduled task |
| `talonctl remove-schedule <id>` | Remove a scheduled task |

Use these for all post-boot mutations. **Do not edit `config/talond.yaml`
by hand** once the daemon is running — talonctl handles it correctly.

## First-time setup flow

### Step 1: Pick an AI provider

Ask: **"Which AI provider do you want to use?"**

```
a) Claude (Anthropic API)            — default, smartest, costs $
b) OpenAI-compatible endpoint        — local Ollama, vLLM, Groq, Together, custom
c) Gemini CLI                        — Google's CLI, needs gemini binary in container (advanced)
d) Codex CLI                         — OpenAI's CLI, same caveat as Gemini (advanced)
```

For (a) ask for nothing else here — defaults work.

For (b) ask three things, **one at a time**:
- "What's the base URL? (e.g. `https://api.groq.com/openai/v1`,
  `http://host.docker.internal:11434/v1` for local Ollama, etc.)"
- "What model name does the endpoint serve?
  (e.g. `qwen3-coder:30b`, `llama-3.3-70b-versatile`)"
- "Does the endpoint need an API key?" → if yes, ask the env var name
  to use (default: `OPENAI_COMPATIBLE_API_KEY`)

For (c)/(d), explain: "Gemini CLI and Codex CLI run *inside* the
container. The starter image does not preinstall these binaries — you'd
need to build a custom image. For most users, OpenAI-compatible (b)
pointing at Google or OpenAI is simpler." Then offer to switch to (b).

### Step 2: Configure `.env`

If `.env` doesn't exist: `cp .env.example .env`

Ask: **"Which channel do you want to connect first?"** Answer determines
which env var the user needs to fill:

| Channel | Env var(s) |
|---------|-----------|
| Telegram | `TELEGRAM_BOT_TOKEN` (from @BotFather) |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET` |
| Discord | `DISCORD_BOT_TOKEN` |
| WhatsApp Business | `WHATSAPP_API_KEY` |
| WhatsApp Baileys | (no env, uses QR-code auth at first boot) |
| Email | IMAP/SMTP credentials (see add-email skill) |
| Terminal | `TERMINAL_TOKEN` (just `talonctl chat`) |

Plus the provider env from step 1 (e.g. `ANTHROPIC_API_KEY` for Claude).

Tell the user **exactly** which lines to uncomment/fill in `.env`.
Do not write the actual secrets to disk.

### Step 3: Configure `config/talond.yaml`

If `config/talond.yaml` doesn't exist:
`cp config/talond.example.yaml config/talond.yaml`

The default config uses Claude + Telegram. If the user picked something
else in step 1, walk them through the edits:

#### Edit the persona

Find:
```yaml
personas:
  - name: assistant
    model: claude-sonnet-4-6
    provider: claude-code
```

If provider is OpenAI-compatible:
```yaml
    model: <model from step 1>
    provider: openai-compatible
```

If Gemini CLI:
```yaml
    model: gemini-2.5-pro
    provider: gemini-cli
```

#### Replace the `agentRunner.providers` block

For Claude (default), no change.

For OpenAI-compatible — replace the `claude-code:` block under
`agentRunner.providers:` with:

```yaml
    openai-compatible:
      enabled: true
      command: node
      contextWindowTokens: 32000
      options:
        baseUrl: <base URL from step 1>
        defaultModel: <model from step 1>
        providerId: <a short slot name, e.g. "groq" or "ollama">
        toolOutputCap: 4000
```

Apply the same change to `backgroundAgent.providers` (or set
`backgroundAgent.enabled: false` if you don't need background work).

#### Replace `auth.providers`

For Claude, the default block is fine.

For OpenAI-compatible:
```yaml
auth:
  mode: api_key
  providers:
    <slot name from above>:
      baseURL: <base URL from step 1>
      # apiKey: ${YOUR_ENV_VAR}   # uncomment if the endpoint needs one
```

#### Set the channel's `allowedChatIds` / equivalent

For Telegram, find the channels block and set the chat ID the bot is
allowed to talk to (find your ID via [@userinfobot](https://t.me/userinfobot)):

```yaml
channels:
  - type: telegram
    name: personal-telegram
    config:
      botToken: ${TELEGRAM_BOT_TOKEN}
      allowedChatIds:
        - "<your-numeric-chat-id>"        # must be a string, not a number
      pollingTimeoutSec: 30
```

For other channels, refer to the matching `add-*` skill.

### Step 4: Boot the daemon

```bash
./install.sh                                  # ensures data/ + userdata/ exist + installs talonctl wrapper
docker compose up -d                          # detached
docker compose logs --tail=50 talond          # confirm clean boot — no -f, no head; just the last 50 lines
```

Look for `bootstrap: config loaded`, the channel connector starting,
and `daemon: running`. If the daemon exits, the logs will say why
(usually a config validation error).

### Step 5: Verify

```bash
talonctl status                # health, queue depth, channels, personas
talonctl doctor                # full validation
talonctl list-channels         # confirms the channel is registered
talonctl test-provider --name <provider-name>   # round-trips a request
```

Then ask the user to **send a real message** to the configured channel
(Telegram DM, Slack message, etc.) and confirm a reply lands. Tail
`docker compose logs -f talond` while they do.

### Step 6: Optional additions

Once boot is verified, anything else uses `talonctl`:

- **Add another channel** — invoke the matching channel skill (`/add-slack`,
  `/add-discord`, etc.) OR `talonctl add-channel` directly.
- **Add another persona** — `talonctl add-persona --name <n>`, then edit
  the generated `personas/<name>/system.md`.
- **Bind persona ↔ channel** — `talonctl bind --persona <p> --channel <c>`.
- **Adjust capabilities** — `talonctl set-capabilities --persona <p> --show`
  to see current, then `--add` or `--remove`.
- **Schedule tasks** — `talonctl add-schedule …` (see `/manage-schedules`).
- **Add MCP servers** — `talonctl add-mcp …`. Pre-built MCP servers for
  GitHub, Atlassian, Gmail, Slack, etc. are documented in
  `starter/docs/troubleshooting.md` and the upstream MCP server registry.

Each mutation modifies `config/talond.yaml`. The daemon **does not
auto-reload** — after a mutation, tell the user to apply it:

```bash
talonctl reload          # hot-reload via IPC; works for most changes
# or for changes that require a full restart:
docker compose restart talond
```

After `add-channel` or `add-provider`, also run:
```bash
talonctl env-check       # confirm any new ${ENV_VAR} placeholders are set in .env
talonctl test-provider --name <n>   # if a provider was added
```

## Rules

1. **Never write actual secrets.** Only `${ENV_VAR}` placeholders in
   `config/talond.yaml`. Real values are in `.env`, edited by the user.
2. **Use `talonctl` for all post-boot mutations.** Exceptions: persona
   `system.md` files (these are agent-facing prompts and benefit from
   hand-editing) and `.env`.
3. **One question per message.** Do not batch.
4. **Show command output.** Let the user see what happened.
5. **Don't start or stop the daemon** without telling the user. Boot
   only after they've confirmed the config is ready. Use
   `docker compose up -d` (detached) so logs don't block their terminal.
6. **Always validate.** After meaningful changes, run `talonctl doctor`
   and `talonctl env-check`. After provider changes, run
   `talonctl test-provider`.
7. **Tell users when something is broken or unsupported.** Some channel
   skills (add-telegram, add-slack, …) were lifted from the native-install
   workflow and still reference `npx talonctl`; treat their guidance as
   *informational* and execute the equivalent via the docker wrapper.

## Differences from `talon-setup` (native)

This skill replaces the native-install `talon-setup` skill for users of
the docker starter bundle. Key differences:

- No prereq check for `node_modules/`, `dist/`, or local `node --version`
  — the image ships everything.
- No `npx talonctl setup` or `talonctl migrate` step — the daemon
  bootstraps + migrates on first boot.
- Provider menu lists OpenAI-compatible as a first-class option.
- Service install via systemd is skipped — `docker compose up -d`
  + `restart: unless-stopped` is the equivalent.
- Daemon start is `docker compose up -d`, never `node dist/index.js`.
