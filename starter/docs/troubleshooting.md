# Troubleshooting

Common issues hit during real Talon installations. The bundle README's
"Troubleshooting" section is the short list; this file is the long one.

If you find something not covered here, please open an issue at
[github.com/ivo-toby/talon/issues](https://github.com/ivo-toby/talon/issues).

---

## Container won't start

### `docker compose up` exits immediately

`docker compose logs talond` will show the error. Common causes:

- **Config validation error.** The schema is strict — typos in YAML keys
  cause the daemon to refuse to start. Run with the bundled example
  config first to confirm the image is fine, then bisect your edits.
- **`/config/talond.yaml` not bind-mounted.** Check
  `docker-compose.yaml` — the bind source `./config/talond.yaml` must
  exist on the host. `cp config/talond.example.yaml config/talond.yaml`
  before `docker compose up`.
- **`personas/<name>/system.md` missing.** If your persona's
  `systemPromptFile` points at a path that doesn't exist on the host,
  the daemon refuses to load. The starter ships
  `personas/assistant/system.md`; if you add personas, make sure their
  system prompt files exist.

### Healthcheck reports `unhealthy`

The healthcheck looks for `/data/talond.pid` and tests that the PID is
alive. Causes:

- **Daemon failed to write the PID file.** Usually a permission issue on
  `/data` — the container runs as UID 1000. On Linux, `chown 1000:1000
  data/` on the host.
- **Daemon crashed.** `docker compose logs talond` will show why. Common
  trigger: a sub-agent referenced by a persona doesn't have its required
  env var (e.g. `OPENAI_API_KEY` for the `spark-coder` sub-agent).

---

## Telegram

### `Telegram getUpdates failed (404): Not Found`

Your `botToken` is wrong, empty, or never reached the container.

Verify the token directly:
```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"
```

`{"ok":true,...}` means the token is good. If you get 404, the token
itself is bad. If `getMe` works but the daemon still 404s, check:

- `.env` actually contains `TELEGRAM_BOT_TOKEN=...` (no quotes, no
  trailing spaces)
- `docker-compose.yaml` has `env_file: .env`
- Restart the container after editing `.env`:
  `docker compose restart talond` (env vars are only read at boot)

### `Telegram getUpdates conflict (409)`

Another process is polling the same bot. Telegram allows exactly one
poller per bot. Either:

- Stop the other process (e.g. another talond instance on a VM)
- Use a different bot token for this instance — create a second bot via
  @BotFather

### Bot replies to me but I never sent a message

Your `allowedChatIds` is empty or wrong, so messages from your account
are being filtered out, but messages from `/start`-like Telegram
mechanics still reach the bot. Confirm:

```bash
talonctl config-show | grep -A4 allowedChatIds
```

`allowedChatIds` must be an array of **strings**, not numbers. Get your
Telegram user ID via [@userinfobot](https://t.me/userinfobot).

### `Telegram sendMessage failed (400/404)`

Most often:

- **400** — `parse_mode: MarkdownV2` rejected because the response
  contains an unescaped special character. Known issue with some
  models. Workarounds: edit the persona's system prompt to discourage
  markdown, or open an issue.
- **404** — the chat ID being sent to is wrong. The starter normally
  uses the inbound chat's ID for the outbound, so this is rare. If you
  see it, check `runs.error` in the SQLite DB:
  ```bash
  docker exec talond sh -c "sqlite3 /data/talond.sqlite \
    'SELECT id, error FROM runs WHERE status=\"failed\" ORDER BY created_at DESC LIMIT 5;'"
  ```

---

## Providers

### `Cannot find module '/opt/talond/dist/index.js'`

Image is from a different (or broken) build. Pull the latest:
```bash
docker compose pull
docker compose up -d
```

### `OpenAI-compatible provider requires options.baseUrl, or auth.providers.<options.providerId>.baseURL`

Your provider config is missing the base URL. See
[`providers.md`](providers.md) for the correct structure.

### Provider response times out

- Increase `contextWindowTokens` if model's actual window is larger than
  the configured limit (Talon caps history at the configured window).
- Increase the agent's timeout: most providers don't expose this in the
  starter config; for very slow local models, comment out
  `backgroundAgent` (timeouts there cascade to the foreground).
- Check the model is actually returning — `curl` the endpoint directly:
  ```bash
  curl -sS https://your-endpoint/v1/chat/completions \
    -H "Authorization: Bearer $YOUR_KEY" \
    -H "Content-Type: application/json" \
    -d '{"model":"your-model","messages":[{"role":"user","content":"hi"}]}'
  ```

### Two messages in a row — second one dead-letters

Symptom: first message replies fine, second one fails with no
`agent-runner: query completed` log. Check the queue:

```bash
docker exec talond sh -c "sqlite3 /data/talond.sqlite \
  'SELECT id,status,attempts,error FROM queue_items ORDER BY created_at DESC LIMIT 5;'"
```

`status: dead_letter` with `error: ... sendMessage ... (404)` is a known
artifact of `parse_mode: MarkdownV2`. The agent's response contained an
unescaped character that Telegram rejected. The pipeline retries 3
times then dead-letters. Subsequent messages should work — the queue
is per-thread but doesn't block on dead-letters.

---

## Permissions (Linux)

### `Permission denied` writing to `data/` or `userdata/`

Container runs as UID/GID 1000. If your host user isn't 1000, the
container can't write to bind-mounted host directories.

Fix once:
```bash
chown -R 1000:1000 data/ userdata/
```

Or loosen:
```bash
chmod 0777 data/ userdata/
```

macOS and Windows on Docker Desktop don't hit this — Docker Desktop's
file-sharing layer maps ownership transparently.

---

## Talonctl wrapper

### `talonctl: container 'talond' not found`

The daemon isn't running yet. `docker compose up -d` first.

### `talonctl: container 'talond' is exited, not running`

Container crashed or was stopped. `docker compose logs talond` for the
reason; `docker compose up -d` to restart.

### Pipes don't work — `talonctl list-channels | jq` shows nothing

The wrapper should handle this; if it doesn't, you're on an older
bundle. Reinstall with `./install.sh` from the current bundle, or use
the full form: `docker exec talond node /opt/talond/dist/cli/index.js list-channels | jq`.

---

## MCP servers

### Adding common MCP servers

The bundle preinstalls `git`, `curl`, `jq`, and `ca-certificates` for
general agent use. Specialized integrations come through MCP servers.
Add them via `talonctl add-mcp`:

`--args` is variadic — pass each argv token as a separate value, no
shell-quoted bundle (Commander does not split a single quoted string):

```bash
# GitHub (issues, PRs, repos)
talonctl add-mcp --skill <skill-name> --name github \
  --transport stdio --command npx \
  --args -y @modelcontextprotocol/server-github

# Filesystem (within /userdata)
talonctl add-mcp --skill <skill-name> --name filesystem \
  --transport stdio --command npx \
  --args -y @modelcontextprotocol/server-filesystem /userdata

# PostgreSQL — use environment variable for the connection string
talonctl add-mcp --skill <skill-name> --name postgres \
  --transport stdio --command npx \
  --args -y @modelcontextprotocol/server-postgres '${POSTGRES_DSN}'
```

Then grant the persona access:
```bash
talonctl set-capabilities --persona assistant --add "mcp.github:*"
```

Most popular MCP servers are listed at
[modelcontextprotocol.io/servers](https://modelcontextprotocol.io/servers).

---

## Where to dig deeper

- `docker compose logs -f talond` — live daemon logs
- `talonctl doctor` — config + environment validation
- `talonctl env-check` — list env-var placeholders the config expects
- `talonctl config-show` — effective config (secrets masked)
- SQLite shell inside the container — for queue, runs, messages
  inspection: `docker exec -it talond sh -c "sqlite3 /data/talond.sqlite"`
