# Setting up Talon

Talon runs on a dedicated VM or server, receives messages from your chat channels, processes them through an AI provider (Claude Code, Gemini CLI, or Codex CLI), and sends responses back. This guide gets you from zero to a working deployment.

## What you need

A Linux server with at least 2 cores, 4GB RAM, and a stable internet connection. A small VPS or home server works. Talon uses SQLite, not Postgres, so storage requirements are minimal.

Software:
- Node.js 22+ (Talon uses `process.loadEnvFile`)
- Git
- One or more AI providers installed and authenticated:
  - **Claude Code** (`claude` CLI from Anthropic)
  - **Gemini CLI** (`gemini` from Google)
  - **Codex CLI** (`codex` from OpenAI)

## Provider setup

Talon talks to AI through CLI providers. You need at least one.

### Claude Code

Install and authenticate:

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

Verify it works:

```bash
claude --version
claude --print -p "say hello"
```

Claude uses the Anthropic API. You need a valid API key or a Max subscription with Agent SDK access.

### Gemini CLI

Install and authenticate:

See https://github.com/google-gemini/gemini-cli for the latest install instructions. Then authenticate:

```bash
gemini    # first run triggers OAuth in browser
```

The OAuth flow opens a browser. Complete the Google login once and the tokens get cached in `~/.gemini/oauth_creds.json`. After that, headless runs work without interaction.

Verify:

```bash
gemini --version
gemini --approval-mode yolo --output-format json "say hello"
```

You should get a JSON response with a `response` field and `stats.models` usage data.

If you're running on a headless VM without a browser, do the initial OAuth from a machine with a browser, then copy `~/.gemini/` to the server.

### Codex CLI

Install and authenticate:

```bash
npm install -g @openai/codex
codex login
```

Verify:

```bash
codex --version
codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C /tmp -o /tmp/codex-last.txt "say hello"
```

## Installation

```bash
git clone https://github.com/ivo-toby/talon.git
cd talon
npm install
npm run build
```

Run first-time setup:

```bash
npx talonctl setup
```

This creates the `data/` directory, a default `talond.yaml`, and runs database migrations.

## Configuration

The config lives in `talond.yaml`. The setup wizard creates a starter, but you'll want to edit it.

### Providers

This is the part that matters. You configure which AI providers are available and which one is default.

```yaml
agentRunner:
  defaultProvider: claude-code      # alternatives: gemini-cli, codex-cli
  providers:
    claude-code:
      enabled: true
      command: claude               # or full path
      contextWindowTokens: 200000
      contextManagement:
        enabled: true
        triggerMetric: cache_read_input_tokens
        thresholdRatio: 0.5
        recentMessageCount: 10
        summarizer: session-summarizer
    gemini-cli:
      enabled: true
      command: /home/talon/.npm-global/bin/gemini
      contextWindowTokens: 1000000
      contextManagement:
        enabled: true
        triggerMetric: input_tokens
        thresholdRatio: 0.8
        recentMessageCount: 10
        summarizer: session-summarizer
      options:
        defaultModel: gemini-3.1-pro-preview
    codex-cli:
      enabled: false
      command: codex
      contextWindowTokens: 400000
      contextManagement:
        enabled: true
        triggerMetric: cache_read_input_tokens
        thresholdRatio: 0.8
        recentMessageCount: 10
        summarizer: session-summarizer
      options:
        defaultModel: gpt-5.4

backgroundAgent:
  enabled: true
  maxConcurrent: 2
  defaultTimeoutMinutes: 30
  defaultProvider: claude-code
  providers:
    claude-code:
      enabled: true
      command: claude
      contextWindowTokens: 200000
    gemini-cli:
      enabled: true
      command: /home/talon/.npm-global/bin/gemini
      contextWindowTokens: 1000000
      options:
        defaultModel: gemini-3.1-pro-preview
    codex-cli:
      enabled: false
      command: codex
      contextWindowTokens: 400000
      options:
        defaultModel: gpt-5.4
```

You can run different providers for interactive vs background work. For example: Claude for conversations, Gemini for batch research, Codex for coding-heavy prompts, or any mix that fits your workflow. Only `agentRunner` providers use `contextManagement`; background agents do not need rolling session state.

For the context-management strategies and migration details, see [context-management.md](context-management.md).

The `command` field needs to resolve on the server. If the binary isn't on PATH, use the full path. Run `which codex` (or the equivalent `which` command for your selected provider CLI) to find it.

The `options.defaultModel` field is provider-specific. Gemini CLI uses it when the run does not provide an explicit model. Persona runs still pass the persona's `model` field through to the provider, so keep persona model names compatible with the provider you choose.

Use `talonctl` to manage providers without editing YAML:

```bash
# see what's configured
npx talonctl list-providers

# add a provider
npx talonctl add-provider --name gemini-cli \
  --command /usr/local/bin/gemini \
  --context both \
  --context-window 1000000 \
  --trigger-metric input_tokens \
  --threshold-ratio 0.8 \
  --recent-message-count 10 \
  --summarizer session-summarizer \
  --enabled \
  --default-model gemini-3.1-pro-preview

# switch the default
npx talonctl set-default-provider --name gemini-cli --context agent-runner

# test it
npx talonctl test-provider --name gemini-cli
npx talonctl add-provider --name codex-cli \
  --command /usr/local/bin/codex \
  --context both \
  --context-window 400000 \
  --trigger-metric cache_read_input_tokens \
  --threshold-ratio 0.8 \
  --recent-message-count 10 \
  --summarizer session-summarizer \
  --enabled \
  --default-model gpt-5.4
npx talonctl test-provider --name codex-cli
```

The test command checks the binary, runs a version check, sends a test prompt, and verifies JSON output parsing. Run it after any provider change.

### Provider affinity

When a thread starts on one provider, it stays on that provider for the rest of the conversation. This prevents mid-conversation switches that would break session continuity (Claude Code and Codex CLI keep session continuity; Gemini CLI is stateless). New threads pick up the current `defaultProvider`.

### Channels

Add channels through the CLI or the Claude Code setup skill (`/talon-setup`):

```bash
npx talonctl add-channel --name my-telegram --type telegram
npx talonctl add-channel --name my-slack --type slack
```

Then edit `talond.yaml` to fill in the credentials. Use `${ENV_VAR}` placeholders and put secrets in `.env`:

```yaml
channels:
  - name: my-telegram
    type: telegram
    enabled: true
    config:
      botToken: ${TELEGRAM_BOT_TOKEN}
      allowedChatIds:
        - "123456789"
```

### Personas

A persona is the agent's identity: system prompt, model, tools, and permissions.

```bash
npx talonctl add-persona --name assistant
```

This scaffolds:

```
personas/assistant/
  system.md                    # main system prompt
  personality/01-tone.md       # personality fragments (loaded alphabetically)
  prompts/memory-grooming.md   # default task prompt
```

**System prompt** (`system.md`): the core instruction set. Define what the agent does, what tools it has access to, constraints, and behavior rules.

**Personality files** (`personality/*.md`): optional markdown files that get appended to the system prompt in alphabetical order. Use these to separate tone, communication style, and domain knowledge from the core instructions. You can add as many as you want. Examples: `01-tone.md` for communication style, `02-domain.md` for domain-specific knowledge, `03-preferences.md` for user preferences. The numbering controls load order.

**Task prompts** (`prompts/*.md`): markdown files the agent executes on schedule. The `memory-grooming.md` prompt ships by default. Copy more from `prompt-templates/scheduled-tasks/` in the repo.

Bind the persona to a channel:

```bash
npx talonctl bind --persona assistant --channel my-telegram
```

## Task prompts and schedules

Task prompts are markdown files in `personas/<name>/prompts/` that the agent executes on a schedule. This is where Talon becomes a proactive assistant instead of a reactive chatbot. Ready-to-use templates are in `prompt-templates/scheduled-tasks/` at the repo root. Copy what you need into your persona's `prompts/` folder and adapt.

### How schedules work

The agent can create its own schedules using the `schedule.manage:own` capability. For reusable prompt files, put markdown files in `personas/<name>/prompts/` and reference them by basename through `promptFile`.

To add a schedule via CLI:

```bash
npx talonctl add-schedule \
  --persona assistant \
  --channel my-telegram \
  --cron "0 7 * * 1-5" \
  --label "Morning briefing" \
  --prompt "Run the morning-briefing task prompt"
```

### Recommended task prompts

These are examples from a production deployment. Adapt them to your setup. Each prompt file lives in `personas/assistant/prompts/`.

#### morning-briefing.md

Runs weekday mornings. Checks calendar, email, Jira, GitHub, and home sensors, then sends a compiled briefing to your channel. The best part: it auto-schedules meeting prep tasks 30 minutes before each meeting.

```
0 7 * * 1-5    Morning briefing
```

#### end-of-day-summary.md

Runs weekday evenings. Recaps what happened, what's still open, and previews tomorrow. Useful for winding down and catching loose threads.

```
0 18 * * 1-5    End of day summary
```

#### weekly-review.md

Friday afternoons. Finds stale Jira tickets, unactioned meeting items, forgotten follow-ups. Cross-references across systems to catch things that slipped through.

```
0 16 * * 5    Weekly review
```

#### week-planning.md

Sunday evenings. Full week overview from both work and personal calendars, grouped by day with focus windows and heavy days flagged. Designed for reviewing with a partner.

```
0 19 * * 0    Week planning
```

#### meeting-prep.md

Not scheduled directly. The morning briefing auto-schedules this 30 minutes before each meeting. It pulls context from Confluence, Jira, email, notes, and memory, then sends a prep brief.

#### grocery-check.md

Sunday evenings. Checks Picnic for delivery slots, reviews past orders from memory, and suggests a cart. Doesn't auto-order.

```
0 18 * * 0    Grocery check
```

### Memory grooming (you need this)

This is the one scheduled task every Talon deployment should have. Without it, the memory store grows without bound and fills with stale, duplicated, or scattered entries.

The memory grooming prompt ships with the default persona at `personas/assistant/prompts/memory-grooming.md`. It tells the agent to list all memory entries, check for stale or duplicate data, consolidate scattered entries, prune what's irrelevant, and report what changed. You don't need to write it, but you do need to schedule it.

```bash
npx talonctl add-schedule \
  --persona assistant \
  --channel my-telegram \
  --cron "0 3 */2 * *" \
  --label "Memory grooming" \
  --prompt "Run the memory-grooming task prompt"
```

Running at 3 AM means it doesn't compete with interactive conversations. The agent uses the `memory_access` host tool to read, consolidate, and prune entries, then sends a summary of what it cleaned up.

Every 2-3 days works well. Once a week is the minimum. If you skip this entirely, the agent's memory context gets increasingly noisy and you'll notice degraded recall quality after a few weeks.

## Recommended deployment setup

### Dedicated VM

Run Talon on its own VM or VPS. It doesn't need much (2 cores, 4GB RAM), but it should be always-on and not shared with other workloads that might kill the process.

### Notes in git

Keep work notes, meeting notes, and reference docs in a git-synced folder on the same machine. If you want Talon to work with that material, expose it explicitly through sandbox mounts or skill-provided MCP servers rather than assuming file access is available by default. Git still gives you version history for free.

```
/home/talon/notes/
  work/          # work notes, meeting summaries
  personal/      # personal reference material
  rfcs/          # design documents
```

Sync with a private GitHub repo if you want versioned notes and backups.

### Systemd service

For production, run Talon as a systemd service:

```ini
[Unit]
Description=Talon Agent Daemon
After=network.target

[Service]
Type=notify
User=talon
WorkingDirectory=/home/talon/talon
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10
WatchdogSec=60
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Talon has built-in systemd watchdog support. If the process hangs, systemd will restart it.

### Building after updates

```bash
cd /home/talon/talon
git pull
npm install
npm run build
npx talonctl migrate    # apply any new database migrations
sudo systemctl restart talond
```

Don't rsync or scp the dist/ folder. Always build on the target machine.

## Quick setup with Claude Code

If you have Claude Code installed locally, the fastest path is the interactive setup skill:

```
claude
> /talon-setup
```

This walks you through prerequisites, channel configuration, persona setup, and validation one step at a time. It uses `talonctl` commands under the hood.

## Verifying your setup

```bash
# check system requirements
npx talonctl doctor

# check env vars are set
npx talonctl env-check

# test each enabled provider in the context you actually use
# use `--context background` when testing a provider configured only for background runs
npx talonctl test-provider --name <provider>

# list what's configured
npx talonctl list-providers
npx talonctl list-channels
npx talonctl list-personas

# start the daemon in foreground to watch logs
node dist/index.js
```

When the daemon starts, you should see bootstrap messages for each channel connector, the provider registry, and the context roller. Send a test message from your configured channel and watch the logs for `agent-runner: starting query` with the correct provider name.
