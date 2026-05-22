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
    model: claude-sonnet-4-6        # or claude-opus-4-7, claude-haiku-4-5
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

### Notes

- `claude-code` is Talon's wrapper around the
  [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python).
  The image ships with it preinstalled.
- For Claude Max subscription auth (no API key), set `auth.mode: subscription`
  and bind-mount `~/.claude` from the host into the container. Edit
  `docker-compose.yaml` and add `~/.claude:/home/talond/.claude:ro` under
  `volumes`.

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
as a subprocess inside the container, so the `gemini` binary must be on
the container's PATH.

### Caveat: not preinstalled

The starter image does **not** ship the `gemini` binary. To use this
provider you need a custom image. The simplest path is a small
Dockerfile that extends the upstream image:

```dockerfile
FROM ghcr.io/ivo-toby/talond:latest
USER root
RUN npm install -g @google/gemini-cli@latest && \
    chown -R talond:talond /usr/local/lib/node_modules
USER talond
```

Build + tag locally, then point `docker-compose.yaml` at it:
`image: my-talond-gemini:latest`.

For most users, accessing Gemini through the **OpenAI-compatible**
provider (above) pointing at Google's OpenAI-compatible endpoint is
simpler and doesn't need a custom image.

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

OpenAI's [Codex CLI](https://github.com/openai/codex). Same model as
Gemini CLI — runs as a subprocess, needs the binary on PATH.

### Caveat: not preinstalled

Same as Gemini. Custom image required:

```dockerfile
FROM ghcr.io/ivo-toby/talond:latest
USER root
RUN npm install -g @openai/codex@latest && \
    chown -R talond:talond /usr/local/lib/node_modules
USER talond
```

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
Gemini CLI, Codex CLI with the binary preinstalled in a custom image):

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
