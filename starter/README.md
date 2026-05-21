# Talon — Starter Bundle

Run [Talon](https://github.com/ivo-toby/talon) without cloning the source.

## What you get

- `docker-compose.yaml` pointing at the published `ghcr.io/ivo-toby/talond` image
- `.env.example` and a minimal `config/talond.example.yaml`
- One default persona (`personas/assistant/system.md`)
- `userdata/` — drop files here for the agent to see (see "Sharing files with the agent" below)
- `bin/talonctl` — host-side wrapper for the in-container CLI
- `.claude/skills/` — Claude Code skills that walk you through setup interactively

The container image ships with `git`, `curl`, `jq`, and `ca-certificates`
preinstalled alongside Node.js, so the agent can clone repos, fetch URLs,
and parse JSON without you adding tools. More specialized integrations
(GitHub, Atlassian, Gmail, Slack, …) come through MCP servers added via
`talonctl add-mcp` — no image rebuild needed.

## Requirements

- Docker (Engine on Linux, or Docker Desktop on macOS/Windows) with `docker compose`
- At least one AI provider account or local endpoint (see [Using a different AI provider](#using-a-different-ai-provider))
- Optional: [Claude Code](https://claude.com/code) for the guided setup flow

## Quickstart

```bash
# 1. Download and extract
curl -fsSL https://github.com/ivo-toby/talon/releases/latest/download/talon-starter.tar.gz | tar xz
cd talon-starter

# 2. Install the host-side CLI (no sudo, drops into ~/.local/bin)
./install.sh

# 3. Configure
cp .env.example .env                              # fill in TELEGRAM_BOT_TOKEN; ANTHROPIC_API_KEY too if using the default Claude provider
cp config/talond.example.yaml config/talond.yaml  # edit allowedChatIds at minimum

# 4. Run
docker compose up -d
talonctl status
```

Then DM your Telegram bot — the daemon polls Telegram, queues the message,
runs the agent, and replies. If you don't get a reply within ~30 seconds,
`docker compose logs -f talond` will show what happened.

## Guided setup with Claude Code

If you have [Claude Code](https://claude.com/code) installed, you can configure
Talon conversationally:

```bash
cd talon-starter
claude
```

Then in Claude Code:

- `/talon-setup` — top-level guided setup
- `/add-telegram`, `/add-slack`, `/add-discord`, `/add-whatsapp`, `/add-email`, `/add-terminal` — add channels
- `/create-profile` — create a new persona
- `/create-personality` — customize a persona's voice and tone
- `/manage-schedules` — set up scheduled agent runs

The skills edit your `.env`, `config/talond.yaml`, and `personas/` for you.

## Configuration

| File or dir | Purpose |
| --- | --- |
| `.env` | Secrets (API keys, bot tokens). Never commit. |
| `config/talond.yaml` | Main config — channels, personas, providers, bindings. |
| `personas/<name>/system.md` | System prompt for each persona. |
| `userdata/` | Files you want the agent to see. Bind-mounted at `/userdata`. |
| `data/` | Persistent state (SQLite DB, IPC socket). Back this up. |

## Using a different AI provider

The minimal `talond.yaml` defaults to Claude (`claude-code` provider) and reads
`ANTHROPIC_API_KEY` from `.env`. To use something else:

| Provider | What to change in `talond.yaml` | What to set in `.env` |
| --- | --- | --- |
| **OpenAI-compatible** (Ollama Cloud, Groq, Together, vLLM, llama.cpp, …) | Set `provider: openai-compatible` on the persona; configure `agentRunner.providers.openai-compatible` with `baseUrl` + `defaultModel`; set `auth.providers.<providerId>.baseURL` (+ optional `apiKey`) | Your endpoint's API key if it needs one |
| **Gemini CLI** | Set `provider: gemini-cli`; ensure `gemini` is on PATH inside the container (currently not preinstalled — workaround required) | `GOOGLE_AI_API_KEY` if not using interactive OAuth |
| **Codex CLI** | Set `provider: codex-cli`; same caveat as Gemini for the binary | `OPENAI_API_KEY` |

See the [full reference config](https://github.com/ivo-toby/talon/blob/main/config/talond.example.yaml)
for complete provider snippets including context-management and sub-agent tuning.

## Sharing files with the agent

Anything you place in `userdata/` is visible to the running agent at
`/userdata` inside the container. The agent reads (and writes) via its
provider's built-in file tools (Claude's `Read`/`Edit`, etc.) — no extra
configuration needed.

```bash
mkdir -p userdata/notes
cp ~/Documents/quarterly-report.pdf userdata/notes/
# then ask your bot:
#   "summarize /userdata/notes/quarterly-report.pdf"
```

The agent can also write artifacts back here — useful for drafts,
reports, generated code. See [`userdata/README.md`](userdata/README.md)
inside the bundle for permission notes (Linux UID/GID 1000).

## Common operations

```bash
docker compose up -d            # start in the background
docker compose logs -f talond   # tail logs
docker compose restart talond   # restart after editing config/talond.yaml
docker compose down             # stop

talonctl status                 # daemon health
talonctl list-channels          # configured channels
talonctl --help                 # all commands
```

## Updating

```bash
docker compose pull             # pull the latest image
docker compose up -d            # recreate the container
```

For a clean upgrade of the bundle itself (new templates, new skills), download
the latest `talon-starter.tar.gz` from
[Releases](https://github.com/ivo-toby/talon/releases) and merge the relevant
files manually — your `.env`, `config/talond.yaml`, and `personas/` are yours
to keep.

## Troubleshooting

**Telegram polls error 404** — your `botToken` is wrong or empty. Verify with
`curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"`.

**`getUpdates` conflict** — another process is polling the same bot. Stop the
other process or use a separate bot for this instance.

**Container exits immediately** — `docker compose logs talond` will usually
show a config-validation error. The reference config in this bundle is
schema-valid; check your edits.

**`talonctl: container 'talond' not found`** — the daemon isn't running yet.
`docker compose up -d` first.

**Permission denied writing to `data/` or `userdata/` on Linux** — the
container runs as UID/GID 1000. If your host user isn't 1000, `chown
1000:1000 data/ userdata/` (or `chmod 0777` for a quick test). macOS and
Windows on Docker Desktop don't hit this.

## License

AGPL-3.0-only, same as the parent project. See
[LICENSE](https://github.com/ivo-toby/talon/blob/main/LICENSE).
