# Provider cookbook

Talon supports four AI provider strategies. This file shows the YAML
snippet for each, plus the matching `.env` entries. The starter ships
configured for Claude — pick whichever provider you actually want, edit
`config/talond.yaml`, and restart with `docker compose restart talond`.

For complete schema reference, see
[`config/talond.example.yaml`](https://github.com/ivo-toby/talon/blob/main/config/talond.example.yaml)
in the source repo.

---

## Claude (Anthropic API)

**Default in the starter.** Smartest, most capable, costs the most per
token. Good first choice if you have an Anthropic API key.

### `config/talond.yaml`

```yaml
personas:
  - name: assistant
    model: claude-sonnet-4-6        # or claude-opus-4-7, claude-haiku-4-5-20251001
    provider: claude-code

agentRunner:
  defaultProvider: claude-code
  providers:
    claude-code:
      enabled: true
      command: claude
      contextWindowTokens: 200000

auth:
  mode: api_key
  providers:
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
```

### `.env`

```ini
ANTHROPIC_API_KEY=sk-ant-...
```

### Authentication

The `claude-code` provider is a thin wrapper: Talon runs the Claude Code
CLI (bundled inside the `@anthropic-ai/claude-agent-sdk` npm dependency,
so nothing extra to install) and the CLI does its own auth resolution
from the container's environment and `~/.claude`. **Anything the Claude
Code CLI supports natively works here** — you just have to get the
credentials in. Three options:

#### API key (simplest)

```ini
# .env
ANTHROPIC_API_KEY=sk-ant-...
```

docker-compose puts it in the container environment; the CLI reads it.
Nothing else to do.

#### AWS Bedrock (best fit for a server/container)

Entirely env-var driven — no mounts, no OAuth refresh, no state:

```ini
# .env
CLAUDE_CODE_USE_BEDROCK=1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-...   # a Bedrock model ID
```

The CLI inherits these and honors Bedrock natively. If the container
runs *on* AWS (ECS/EC2), drop the keys and let it use the instance
role. This is the recommended path for an always-on deployment.

#### Claude Max / Pro subscription

Possible, but the awkward path in docker:

- Credentials live in `~/.claude/`. On **Linux** that's a file
  (`~/.claude/.credentials.json`); on **macOS** it's the **Keychain** —
  not a file, so it cannot be bind-mounted.
- Bind-mount the host's `~/.claude` into the container, **read-write**
  (the OAuth token refreshes and the CLI must write the new one back):
  ```yaml
  # docker-compose.yaml, under the talond service `volumes:`
  - ~/.claude:/home/talond/.claude
  ```
- This only works when the host has the file form — i.e. a Linux host
  where `claude login` was run. A macOS host can't share its Keychain
  credentials with a Linux container.
- **One subscription per daemon.** The claude-code provider has no
  per-persona home isolation — a single daemon shares one `~/.claude`,
  hence one Max account. For multiple subscriptions, run separate
  daemon instances (one container each).

For a containerized deployment, prefer **API key or Bedrock**. Max works
on a Linux host with a read-write `~/.claude` mount, but it is the
fragile path (token refresh, the macOS Keychain wall, no multi-account).

---

## OpenAI-compatible endpoint

The most flexible provider. Works with:

- **Local Ollama** (`http://host.docker.internal:11434/v1`)
- **Local vLLM / llama.cpp / LM Studio** (any OpenAI-compatible server)
- **Groq, Together, Fireworks, OpenAI itself** (hosted endpoints)
- **OpenAI-compatible CDN endpoints** (Cloudflare, custom proxies)

### `config/talond.yaml`

```yaml
personas:
  - name: assistant
    model: <whatever the endpoint serves>      # e.g. "llama-3.3-70b-versatile", "qwen3-coder:30b"
    provider: openai-compatible

agentRunner:
  defaultProvider: openai-compatible
  providers:
    openai-compatible:
      enabled: true
      command: node                            # in-process; "node" is just a placeholder
      contextWindowTokens: 32000               # adjust to the model's actual window
      options:
        baseUrl: https://api.groq.com/openai/v1
        defaultModel: llama-3.3-70b-versatile
        providerId: groq                       # short slot name — pick anything
        toolOutputCap: 4000

backgroundAgent:
  enabled: false                               # or mirror the above

auth:
  mode: api_key
  providers:
    groq:                                      # matches providerId above
      baseURL: https://api.groq.com/openai/v1
      apiKey: ${GROQ_API_KEY}                  # omit if endpoint needs no key
```

### `.env`

```ini
GROQ_API_KEY=gsk_...                           # name matches whatever you used above
```

### Notes

- `providerId` (under `options:`) and the slot under `auth.providers:`
  must match. Talon resolves credentials by looking up
  `auth.providers.<providerId>`.
- `toolOutputCap` caps a single tool result's size before it enters the
  agent's message history. Recommended for small-window models. Set to
  `0` to disable.
- For local Ollama on macOS Docker Desktop, use
  `http://host.docker.internal:11434/v1` (the special Docker DNS name).
  On Linux you may need `--network host` or `--add-host` instead.
- No API key is needed for local Ollama / vLLM / llama.cpp — omit
  `apiKey` in the `auth.providers.<slot>` block.

---

## Gemini CLI

Google's [Gemini CLI](https://github.com/google-gemini/gemini-cli). Runs
as a subprocess inside the container — the `gemini` binary is
**preinstalled** in the image, so no custom build is needed.

> **Auth state does not persist.** Gemini CLI stores OAuth credentials
> under `~/.gemini` inside the container, which is wiped on every
> container recreation. Use `GOOGLE_AI_API_KEY` (read fresh from `.env`
> each run) for a stateless setup, or bind-mount `/home/talond` in
> `docker-compose.yaml` if you need OAuth state to survive restarts.

### `config/talond.yaml`

```yaml
personas:
  - name: assistant
    model: gemini-2.5-pro
    provider: gemini-cli

agentRunner:
  defaultProvider: gemini-cli
  providers:
    gemini-cli:
      enabled: true
      command: gemini
      contextWindowTokens: 1000000
      options:
        defaultModel: gemini-2.5-pro
```

### `.env`

```ini
GOOGLE_AI_API_KEY=...                          # or rely on interactive OAuth (more setup)
```

---

## Codex CLI

OpenAI's [Codex CLI](https://github.com/openai/codex). Runs as a
subprocess — the `codex` binary is **preinstalled** in the image.

> **Auth state does not persist.** Codex CLI stores config and auth
> under `~/.codex` inside the container, wiped on container recreation.
> Use `OPENAI_API_KEY` from `.env` for a stateless setup, or bind-mount
> `/home/talond` to persist it.

### `config/talond.yaml`

```yaml
personas:
  - name: assistant
    model: gpt-5.4
    provider: codex-cli

agentRunner:
  defaultProvider: codex-cli
  providers:
    codex-cli:
      enabled: true
      command: codex
      contextWindowTokens: 1048576
      options:
        defaultModel: gpt-5.4
```

### `.env`

```ini
OPENAI_API_KEY=sk-...
```

---

## Using your host's codex / gemini auth in the container

If you've already authenticated `codex` (or `gemini`) on your host —
e.g. `codex login` — you can reuse that login inside the container
instead of putting an API key in `.env`.

### Codex

Talon's codex provider seeds each run from the *operator's* `~/.codex`:
before every invocation it copies `auth.json` (and the model/version
caches and state) into a fresh per-run codex home, then runs the CLI
against that copy. So you only need to make your host's `~/.codex`
visible to the daemon at the path it looks for — `~/.codex` relative to
the container user's home, i.e. `/home/talond/.codex`:

```yaml
# docker-compose.yaml, under the talond service `volumes:`
- ~/.codex:/home/talond/.codex:ro
```

**Read-only is correct** — Talon never writes back to this directory, it
only reads and copies. A read-only mount keeps your host credentials
safe and still works fully.

Caveats:

- **OAuth vs API key.** If your host codex login is an OAuth token that
  expires, the container uses a per-run snapshot — it picks up a
  refreshed token on the next run *after* your host refreshes it, but
  the container itself can't refresh (read-only, and it's a copy). A
  static API key has no expiry concern.
- **Linux permissions.** The container runs as UID 1000; the host
  `~/.codex` files must be readable by it. Transparent on macOS Docker
  Desktop; on Linux the host user should be UID 1000 or you adjust
  permissions.

### Gemini

Gemini CLI keeps its auth/config under `~/.gemini` and Talon does not
seed it per-run. To reuse a host login, bind-mount the directory
**read-write** (so token refresh can persist):

```yaml
- ~/.gemini:/home/talond/.gemini
```

For most setups, `GOOGLE_AI_API_KEY` in `.env` is simpler and stateless.

---

## Switching providers without redeploying

Once the daemon is running, you can swap providers via `talonctl`. The
exact flag set depends on the provider — for OpenAI-compatible, the
required options aren't all exposed as flags on `add-provider` today,
so the cleanest path is:

1. Edit `agentRunner.providers.<name>` in `config/talond.yaml` directly
   (use the snippets above as a template).
2. Edit `auth.providers.<slot>` in the same file.
3. Reload:
   ```bash
   talonctl reload
   talonctl test-provider --name openai-compatible
   ```

For providers that *are* fully covered by `add-provider` flags (Claude,
Gemini CLI, Codex CLI — all preinstalled in the image):

```bash
talonctl list-providers
talonctl add-provider --name claude-code \
  --command claude --context both \
  --context-window 200000 --enabled
talonctl set-default-provider --name claude-code --context agent-runner
talonctl set-default-provider --name claude-code --context background
talonctl env-check                           # confirm $ANTHROPIC_API_KEY is set
talonctl test-provider --name claude-code    # real round-trip
```

`--enabled` is important — `add-provider` writes the entry as disabled
unless you opt in.

After any provider change, `talonctl reload` applies it without a
container restart.
