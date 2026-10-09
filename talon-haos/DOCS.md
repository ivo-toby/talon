# Talon Home Assistant add-on

## Configuration

The add-on settings select the **instance**, private **storage_path**, and secret credentials
**openai_api_key** and **telegram_bot_token**. Model, channel,
recipient and persona settings belong in the workspace's `talond.yaml`, not in
Home Assistant options. For Telegram, reference the credential in YAML as
`botToken: ${TELEGRAM_BOT_TOKEN}`. Updating a secret in Home Assistant takes
effect after restarting Talon. Talon keeps the existing configuration across restarts.

By default, Talon stores its configuration, workspace, and database in private
persistent storage under `/data/talon`. Use `storage_path` to select another
absolute directory inside `/data`.

Set `instance` to the workspace name you want to open (for example, `example`).
Leaving it empty selects `default`. The instance setting selects one workspace;
it does not start additional Talon daemons. Existing workspace configuration
and skill definitions are reused without copying files.

Model, Telegram and other channel settings are edited only in `talond.yaml` in
the private add-on terminal (`$TALON_WORKSPACE`). Home Assistant settings do
not silently override or regenerate the file. Existing installations retain
any original model and Telegram configuration when updating the add-on.
The API key and Telegram token are exported as `OPENAI_API_KEY` and
`TELEGRAM_BOT_TOKEN` for configurations that reference them. A workspace using
another provider does not need a dummy API key.
Normal restarts and upgrades preserve this configuration.\n\nEach named workspace receives its own `state` directory, SQLite database,\nthreads and IPC. For compatibility, the original `default` workspace continues\nusing legacy `/data/talon/state` if it already exists. The `instance` setting\n**selects** a workspace; this add-on still runs one daemon at a time.\n\nIf `talond.yaml` is invalid, the daemon stops but the ingress terminal stays\navailable for editing the private configuration and restarting the add-on.
Changing `storage_path` does not relocate existing files. Make a backup before\nany migration and update the absolute `storage.path`, `dataDir` and\n`systemPromptFile` paths in the moved `talond.yaml`. The add-on's CLI IPC link\nis resolved from the effective configured `dataDir`; ensure the chosen directory\nis inside private `/data`.

## Terminal

Open the add-on's Web UI:

```sh
talonctl status
talonctl list-channels
talonctl list-personas
talonctl list-skills
talonctl reload
```

## Startup verification

Version 1.0.10 omits the explicit `HEALTHCHECK NONE` instruction. Docker stores
that instruction as a nonempty `Config.Healthcheck` object with `Test: ["NONE"]`.
Supervisor versions that treat any such object as an enabled check can remain
in `startup`: Docker does not execute a disabled check or emit its health events.
The Node base image supplies no check; CI verifies the resulting image metadata.
`startup: application` controls boot order, and `timeout: 60` is the stop timeout;
neither setting nor the daemon's `READY` log releases that wait.

The ingress proxy still accepts only gateway `172.30.32.2` by default. It passes
HTTP and WebSockets to ttyd on loopback port 7682, which launches an unprivileged
`talond` shell. No host ports or wider subnet access are required. The launcher
stays in the foreground and keeps the recovery terminal alive if the daemon
configuration is invalid or the daemon exits.

Build and exercise the **actual** HA build context on a disposable Linux Docker
host (the test creates and removes only its own named containers/network/volume):

```sh
docker build -t talon-haos:1.0.10-check talon-haos
python3 talon-haos/smoke-image.py talon-haos:1.0.10-check
```

The test requires subnet `172.30.32.0/24` to be unused; do not run it on the live
Supervisor host. It reproduces the old disabled-healthcheck metadata, evaluates
the pinned upstream state method, and checks HTML, an interactive WebSocket,
rejection of other source IPs, startup without an API key, persistent YAML/SQLite
state across restart, and the recovery terminal. This is transport validation;
it does not run Supervisor or validate real HA authentication/session routing.

After an operator installs/rebuilds 1.0.10, verify on Home Assistant itself:

1. Record `ha supervisor info` and `ha addons info <slug>`; version must be
   1.0.10 and state must become `started`.
2. With host Docker access, inspect the add-on container's `Config.Healthcheck`
   and `State`; expect no healthcheck and a running container. Inspect only those
   fields, not environment variables containing credentials.
3. Open **Web UI** from the authenticated HA session. Confirm the terminal page
   loads and its WebSocket upgrades with HTTP 101, then execute `talonctl status`.
4. Check Supervisor logs if the state still remains `startup`. Record the actual
   installed image ID/version and metadata before attributing it to this fix.

Image/CI success alone must never be reported as a verified fix on a live HA
installation. No CI job here deploys or publishes the image.

## External tools and files

The add-on does not mount Home Assistant's shared folders. Integrate external
services and files through configured MCP servers and Talon permissions.

## Moving private storage safely

Changing `storage_path` selects a different private directory; it never copies or renames files. Stop the add-on and back up its `/data` contents first. Move the workspace, SQLite database and associated runtime state together, then update every absolute path in `talond.yaml` (`storage.path`, `dataDir`, and persona `systemPromptFile`). Reopen the add-on and inspect logs. If the configuration refers to the old directories, the add-on refuses to start the daemon but keeps its recovery terminal available; it does not delete or silently reuse the old database. The previous default state layout remains supported.

## Shutdown

On a Home Assistant stop or upgrade the launcher sends SIGTERM to the daemon process group and waits for shutdown to finish, with an add-on timeout of 60 seconds. The integration check asserts that the actual Talon process logs its clean shutdown. Outstanding AI calls and queued work can still exceed the allowed shutdown time; they are not guaranteed to finish before Home Assistant terminates the container.
