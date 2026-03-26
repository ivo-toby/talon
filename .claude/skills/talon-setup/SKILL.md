---
name: talon.setup
description: |
  Use when setting up Talon for the first time, adding channels or personas to an
  existing config, or running validation. Also use when the user says "configure
  talon", "add a channel", "add a persona", "add provider", "set up the daemon",
  "add schedule", or "configure providers".
triggers:
  - "setup talon"
  - "configure talon"
  - "talon setup"
  - "add channel"
  - "add persona"
  - "add provider"
  - "set up the daemon"
  - "configure providers"
  - "add schedule"
---

# Talon setup skill

Guide the user through setting up and configuring Talon interactively. This is a
conversational wizard. Ask one question at a time, act on the answer, move on.

## Core principles

- **One question at a time.** Never dump a wall of questions.
- **Detect state first.** Skip steps that are already done.
- **Use talonctl commands.** Never edit talond.yaml directly except system prompts and task prompts.
- **No secrets.** Never ask for or write actual tokens. Use `${ENV_VAR}` placeholders only.
- **Show what you do.** When running commands, show the output.

## Available talonctl commands

All config mutations go through these commands:

| Command | Purpose |
|---------|---------|
| `npx talonctl setup` | Bootstrap (dirs, config, migrations) |
| `npx talonctl add-channel --name <n> --type <t>` | Add a channel |
| `npx talonctl add-persona --name <n>` | Scaffold persona + add to config |
| `npx talonctl add-skill --name <n> --persona <p> [--format <fmt>]` | Add a skill to a persona |
| `npx talonctl bind --persona <p> --channel <c>` | Bind persona to channel |
| `npx talonctl unbind --persona <p> --channel <c>` | Remove binding |
| `npx talonctl add-mcp --skill <s> --name <n> --transport stdio --command <c>` | Add MCP server |
| `npx talonctl add-provider --name <n> --command <c> [--context both]` | Add a provider |
| `npx talonctl set-default-provider --name <n> --context <ctx>` | Set default provider |
| `npx talonctl test-provider --name <n>` | Test a provider works |
| `npx talonctl list-providers` | Show all providers |
| `npx talonctl list-channels` | Show channels |
| `npx talonctl list-personas` | Show personas |
| `npx talonctl list-skills` | Show skills |
| `npx talonctl list-schedules` | Show scheduled tasks |
| `npx talonctl add-schedule --persona <p> --channel <c> --cron <expr> --label <l> --prompt <text>` | Add scheduled task |
| `npx talonctl remove-schedule <id>` | Remove a scheduled task |
| `npx talonctl env-check` | Audit env var placeholders |
| `npx talonctl config-show` | Show effective config (secrets masked) |
| `npx talonctl remove-channel --name <n>` | Remove a channel |
| `npx talonctl remove-persona --name <n>` | Remove a persona |
| `npx talonctl migrate` | Run database migrations |
| `npx talonctl doctor` | Validate configuration |

## State detection

Before starting, check the current state:

```
Check these files/directories:
- talond.yaml              → config exists?
- node_modules/            → dependencies installed?
- dist/                    → project built?
- data/                    → data directory exists?
- data/talond.sqlite       → database initialized?
- .env                     → env file with secrets?
```

### Entry points

| State | Action |
|-------|--------|
| No `talond.yaml` | Full flow from step 1 |
| Config exists, no providers configured | Skip to provider setup |
| Config exists, no channels | Skip to channel configuration |
| Config exists, has channels and personas | Show menu |

### Returning user menu

If setup is already complete, present:

```
What would you like to do?
  a) Add or configure a provider (Claude, Gemini)
  b) Add a channel
  c) Add a persona
  d) Add a skill to a persona
  e) Add or manage scheduled tasks
  f) Bind/unbind persona to channel
  g) Run validation (doctor)
  h) Show current config summary
  i) Test a provider
  j) Check environment variables
```

## Skill formats

When adding a skill, choose a format with `--format`:

- **SKILL.md** (`--format skillmd`, recommended for new skills): Single markdown file with YAML frontmatter for metadata and markdown body for instructions. No separate prompts directory.
- **skill.yaml** (`--format yaml`, default/legacy): Separate YAML manifest file plus a `prompts/` directory for prompt fragments.

Example:
```bash
# New style (recommended)
npx talonctl add-skill --name my-skill --persona assistant --format skillmd

# Legacy style (default if --format is omitted)
npx talonctl add-skill --name my-skill --persona assistant
```

## Full setup flow

### Step 1: Prerequisites

Check each prerequisite. Report status. Fix what can be fixed automatically.

```
1. Node.js >= 22          → check `node --version`
2. Dependencies installed → check node_modules/, run `npm install` if not
3. Project built          → check dist/, run `npm run build` if not
4. AI providers installed → check `claude --version` and/or `gemini --version`
```

For provider binaries not on PATH, ask for the full path (e.g. `/home/user/.npm-global/bin/gemini`).

At least one provider must be installed and authenticated. Check both:

- **Claude Code**: `claude --version`. Auth: `claude auth login` or valid Anthropic API key.
- **Gemini CLI**: `gemini --version`. Auth: run `gemini` once interactively for OAuth, or set `GEMINI_API_KEY`.

If neither is installed, stop and explain how to install at least one.

### Step 2: Bootstrap

Skip if `talond.yaml` already exists.

Run: `npx talonctl setup`

This creates directories, generates default config, runs migrations, validates.

### Step 3: Provider configuration

This step configures which AI providers Talon uses for interactive conversations and background tasks.

Ask: **"Which AI providers do you want to use?"**

```
a) Claude Code only (default)
b) Gemini CLI only
c) Both (recommended if both are installed)
```

For each selected provider, run `add-provider`:

```bash
# Claude (if selected)
npx talonctl add-provider --name claude-code \
  --command claude \
  --context both \
  --context-window 200000 \
  --rotation-threshold 0.5 \
  --enabled

# Gemini (if selected)
npx talonctl add-provider --name gemini-cli \
  --command <path-to-gemini> \
  --context both \
  --context-window 1000000 \
  --rotation-threshold 0.8 \
  --enabled
```

For Gemini, ask: **"Which Gemini model? (default: gemini-2.5-pro)"**

Available models: gemini-3.1-pro-preview, gemini-3-flash-preview, gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite.

If a model is specified, add `--default-model <model>` to the add-provider command.

If both providers are configured, ask: **"Which should be the default for conversations?"**

```bash
npx talonctl set-default-provider --name <choice> --context agent-runner
```

Then: **"And for background tasks?"** (explain: background tasks run async, cheaper/faster models work well here)

```bash
npx talonctl set-default-provider --name <choice> --context background
```

Test each configured provider:

```bash
npx talonctl test-provider --name claude-code
npx talonctl test-provider --name gemini-cli
```

If a test fails, troubleshoot:
- Binary not found → check the command path, `which claude` or `which gemini`
- Auth failure → Claude: `claude auth login`. Gemini: run `gemini` interactively once for OAuth.
- JSON parse failure → Gemini CLI version too old, see https://github.com/google-gemini/gemini-cli for upgrade instructions

### Step 4: Channel configuration

Ask: **"Which channel do you want to connect first?"**

```
a) Telegram
b) Slack
c) Discord
d) WhatsApp
e) Email
f) Terminal (for CLI chat)
g) Skip for now
```

Invoke the matching per-channel skill for the full setup walkthrough:

| Channel | Skill to invoke |
|---------|----------------|
| Telegram | `/add-telegram` |
| Slack | `/add-slack` |
| Discord | `/add-discord` |
| WhatsApp | `/add-whatsapp` |
| Email | `/add-email` |
| Terminal | `/add-terminal` |

Each skill handles: bot/app creation, credentials, config, env vars, verification, and troubleshooting.

Ask: **"Add another channel?"** Loop until done.

### Step 5: Persona configuration

Ask: **"Let's create a persona. What should this agent be called?"**

1. Accept a name (suggest "assistant")
2. Run: `npx talonctl add-persona --name <name>`
3. Ask these questions one at a time:
   - **"What should {name} do?"** (purpose)
   - **"What tone?"** (professional/casual/technical/friendly)
   - **"Any specific constraints?"** (optional)
4. Generate a system prompt from the answers
5. Show it to the user for review
6. Write the approved prompt to `personas/{name}/system.md`
7. Ask which channels to bind:
   - Run: `npx talonctl list-channels` to show options
   - For each selected: `npx talonctl bind --persona <name> --channel <channel>`

Ask: **"Add another persona?"** Loop until done.

### Step 6: Scheduled tasks

Ask: **"Do you want to set up scheduled tasks?"**

Explain what they are: the agent runs a task prompt on a cron schedule and sends results to a channel. This makes the agent proactive instead of reactive.

Recommend starting with memory grooming (required for long-term health):

```bash
npx talonctl add-schedule \
  --persona assistant \
  --channel <primary-channel> \
  --cron "0 3 */2 * *" \
  --label "Memory grooming" \
  --prompt "Run the memory-grooming task prompt"
```

Explain: without memory grooming, the agent's stored memory fills up with stale and duplicate entries. Every 2-3 days at a quiet hour is the recommended cadence.

Then offer other common schedules:

```
Suggested schedules (optional):
  a) Morning briefing (weekdays 7am) — calendar, email, Jira, GitHub summary
  b) End-of-day summary (weekdays 6pm) — recap and tomorrow preview
  c) Weekly review (Friday 4pm) — stale tickets, forgotten follow-ups
  d) Week planning (Sunday 7pm) — upcoming week overview
  e) Custom schedule
  f) Done, skip the rest
```

For each selected, the user needs a task prompt file at `personas/<name>/prompts/<prompt-name>.md`. Either use the defaults that ship with the assistant persona or help the user write one.

Create each schedule with:

```bash
npx talonctl add-schedule \
  --persona <persona> \
  --channel <channel> \
  --cron "<expression>" \
  --label "<label>" \
  --prompt "Run the <prompt-name> task prompt"
```

Common cron expressions for reference:
- `0 7 * * 1-5` — weekdays at 7am
- `0 18 * * 1-5` — weekdays at 6pm
- `0 16 * * 5` — Friday at 4pm
- `0 19 * * 0` — Sunday at 7pm
- `0 3 */2 * *` — every 2 days at 3am

### Step 7: Database setup

Run: `npx talonctl migrate --config talond.yaml`

### Step 8: Validation

Run: `npx talonctl doctor --config talond.yaml`

For failures, provide specific remediation steps.

### Step 9: Environment check

Run: `npx talonctl env-check`

Show which env vars are missing. Tell the user to add them to `.env`.

### Step 10: Provider verification

Test every configured provider one more time:

```bash
npx talonctl test-provider --name claude-code
npx talonctl test-provider --name gemini-cli
```

Only declare setup complete if at least one provider passes.

### Step 11: Systemd service (Linux only)

Ask: **"Want to install talond as a systemd service?"**

If yes, tell the user to run:
```bash
sudo ./deploy/install-service.sh --user $(whoami) --dir $(pwd)
```

### Step 12: Summary

Run these to build the summary:
```bash
npx talonctl list-providers
npx talonctl list-channels
npx talonctl list-personas
npx talonctl list-schedules
npx talonctl env-check
```

Print results and instructions to start the daemon:

```bash
node dist/index.js          # foreground with logs
# or if systemd service is installed:
sudo systemctl start talond
```

## Shared memory between agents

Talon supports shared memory between personas using the [Anthropic Memory MCP server](https://github.com/anthropics/memory). This is a knowledge graph stored in a single JSON file. When multiple personas use the same file, they share knowledge automatically.

How to set it up: for each persona that should share memory, add the memory MCP server to one of its skills:

```bash
npx talonctl add-mcp --skill <skill-name> --name memory \
  --transport stdio \
  --command npx \
  --args "-y @anthropic-ai/memory --memory-path data/shared-memory.json"
```

All personas point to the same `--memory-path`. Use `data/shared-memory.json` as the default location.

When to suggest this: when the user has multiple personas and asks about sharing context between them. Don't suggest it proactively during initial setup.

## Rules

1. **Never write actual secrets.** Only `${ENV_VAR}` placeholders in config files.
2. **Use talonctl commands for all config mutations.** Exceptions: system prompt files, task prompt files, and `.env`.
3. **One question per message.** Do not batch questions.
4. **Show command output.** Let the user see what happened.
5. **Don't start the daemon.** Setup only. The user starts it themselves.
6. **Validate at the end.** Always run doctor, env-check, and test-provider before declaring setup complete.
7. **Test providers.** After any provider change, run `test-provider` to verify.
