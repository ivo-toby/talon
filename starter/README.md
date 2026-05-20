# Talon — Starter Bundle

Run [Talon](https://github.com/ivo-toby/talon) without cloning the source.

## What you get

- `docker-compose.yaml` pointing at the published `ghcr.io/ivo-toby/talond` image
- `.env.example` and a minimal `config/talond.example.yaml`
- One default persona (`personas/assistant/system.md`)
- `bin/talonctl` — host-side wrapper for the in-container CLI
- `.claude/skills/` — Claude Code skills that walk you through setup interactively

## Requirements

- Docker (with `docker compose`)
- Optional: [Claude Code](https://claude.com/code) for the guided setup flow

## Quickstart

```bash
# 1. Download and extract
curl -fsSL https://github.com/ivo-toby/talon/releases/latest/download/talon-starter.tar.gz | tar xz
cd talon-starter

# 2. Install the host-side CLI (no sudo, drops into ~/.local/bin)
./install.sh

# 3. Configure
cp .env.example .env                              # fill in TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY
cp config/talond.example.yaml config/talond.yaml  # edit allowedChatIds at minimum

# 4. Run
docker compose up -d
talonctl status
```

Then message your Telegram bot. The daemon polls Telegram, queues the message,
runs the agent, and replies.

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

| File | Purpose |
| --- | --- |
| `.env` | Secrets (API keys, bot tokens). Never commit. |
| `config/talond.yaml` | Main config — channels, personas, providers, bindings. |
| `personas/<name>/system.md` | System prompt for each persona. |
| `data/` | Persistent state (SQLite DB, IPC socket). Back this up. |

The minimal `talond.yaml` enables Telegram + a Claude-powered assistant
persona. To use a different provider (OpenAI-compatible endpoint, Gemini CLI,
Codex CLI), see the full reference config at
[github.com/ivo-toby/talon](https://github.com/ivo-toby/talon/blob/main/config/talond.example.yaml).

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

## License

AGPL-3.0-only, same as the parent project. See
[LICENSE](https://github.com/ivo-toby/talon/blob/main/LICENSE).
