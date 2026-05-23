# Talon + Postgram — Stack

A self-hosted AI agent ([Talon](https://github.com/ivo-toby/talon)) wired
to a persistent knowledge store ([Postgram](https://github.com/ivo-toby/postgram))
so the agent **remembers across conversations** out of the box.

Four containers, all from published images — nothing to build:

| Service | Image | Role |
| --- | --- | --- |
| `postgres` | `pgvector/pgvector:pg17` | Postgram's database |
| `postgram` | `ghcr.io/ivo-toby/postgram` | Knowledge store (REST + MCP) |
| `talond` | `ghcr.io/ivo-toby/talond` | The Talon agent daemon |

The bundled `postgram-memory` skill connects Talon's agent to Postgram
over MCP — the agent gets `search` / `store` / `recall` / task tools and
guidance on when to use them.

## Requirements

- Docker (Engine on Linux, or Docker Desktop on macOS/Windows) with `docker compose`
- An OpenAI API key — Postgram uses it to embed knowledge for semantic search
- An AI provider for Talon itself (Claude API key by default)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))

## Quickstart

```bash
# 1. Download and extract
curl -fsSL https://github.com/ivo-toby/talon/releases/latest/download/talon-postgram-stack.tar.gz | tar xz
cd talon-postgram-stack

# 2. Install the talonctl helper (optional, no sudo)
./install.sh

# 3. Configure
cp .env.example .env                              # POSTGRES_PASSWORD, OPENAI_API_KEY,
                                                  # ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN
cp config/talond.example.yaml config/talond.yaml  # set allowedChatIds

# 4. Bring up the stack
./bootstrap.sh
```

Then message your Telegram bot. Ask it to remember something, start a
fresh conversation, and ask it to recall — it goes through Postgram.

## Why `bootstrap.sh` instead of `docker compose up`

Postgram API keys must be **minted after** its server is running — you
can't pre-set one in `.env`. `bootstrap.sh` handles the ordering:

1. Starts `postgres` + `postgram`, waits until Postgram is healthy.
2. Mints a Postgram API key via its admin CLI
   (`docker compose exec postgram pgm-admin key create …`).
3. Writes the key into `.env` and renders it into the `postgram-memory`
   skill's MCP definition (`skills/postgram-memory/mcp/postgram.json`).
4. Starts `talond`.

It's safe to re-run — if `PGM_API_KEY` is already set it skips step 2.

## How the agent uses Postgram

`skills/postgram-memory/` is a Talon skill with two parts:

- `mcp/postgram.json` — the MCP client pointing at `http://postgram:3100/mcp`
  (rendered from `.template` by `bootstrap.sh` with your API key).
- `SKILL.md` — usage guidance, marked `eager: true` so it's always in the
  agent's system prompt. Memory use is reflexive — the agent shouldn't
  have to decide to "load" it.

The `assistant` persona in `config/talond.yaml` lists `postgram-memory`
in its `skills:`, so the agent gets the Postgram tools and the guidance.

## Configuration

| File or dir | Purpose |
| --- | --- |
| `.env` | Secrets. `bootstrap.sh` fills in `PGM_API_KEY`. Never commit. |
| `config/talond.yaml` | Talon config — channels, persona, provider. |
| `personas/<name>/system.md` | Persona system prompts. |
| `skills/postgram-memory/` | The skill wiring Talon ↔ Postgram. |
| `userdata/` | Files for the agent to read (bind-mounted at `/userdata`). |
| `data/` | Talon's SQLite DB + state. Postgram's data is in the `pgdata` volume. |

To use a non-Claude provider for Talon, see
[the provider cookbook](https://github.com/ivo-toby/talon/blob/main/starter/docs/providers.md).

## Guided setup with Claude Code

The bundle ships `.claude/skills/` — interactive setup guides that Claude Code
reads when you ask for help. Open the project in Claude Code and say things
like "set up talon" or "add telegram" and it walks you through one question
at a time.

| Skill | Say this in Claude Code |
|-------|------------------------|
| `talon-setup-docker` | "set up talon", "configure talon", "talon doctor" |
| `add-telegram` | "add telegram", "connect telegram" |
| `add-slack` | "add slack", "connect slack" |
| `add-discord` | "add discord", "connect discord" |
| `add-whatsapp` | "add whatsapp", "connect whatsapp" |
| `add-email` | "add email", "connect email" |
| `add-terminal` | "add terminal", "cli chat", "talonctl chat" |
| `create-profile` | "create a profile", "add a persona", "new background agent" |
| `create-personality` | "create a personality", "add personality files" |
| `manage-schedules` | "manage schedules", "add a schedule", "cron job" |

These skills are **not** loaded by the Talon daemon — they are for the
operator's local Claude Code session. They know the bundle layout, use the
bundled `talonctl` wrapper, and never ask you to run `npm install` or
`npx talonctl`.

## Common operations

```bash
docker compose ps                       # all four services
docker compose logs -f talond           # Talon logs
docker compose logs -f postgram         # Postgram logs
talonctl status                         # daemon health
docker compose down                     # stop (data persists in volumes)
docker compose pull && ./bootstrap.sh   # update images, re-run bootstrap
```

## Troubleshooting

**`bootstrap.sh` says Postgram didn't become healthy** — check
`docker compose logs postgram`. Most common cause: `OPENAI_API_KEY`
missing or invalid (Postgram needs it for embeddings).

**Agent doesn't seem to remember** — confirm the skill's MCP file was
rendered: `skills/postgram-memory/mcp/postgram.json` should exist and
contain a real key, not `__PGM_API_KEY__`. Re-run `./bootstrap.sh` if not.
Check `docker compose logs talond` for MCP connection errors.

**Telegram errors** — see the
[troubleshooting guide](https://github.com/ivo-toby/talon/blob/main/starter/docs/troubleshooting.md).

## License

AGPL-3.0-only, same as the parent projects.
