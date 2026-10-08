# Talon Home Assistant add-on

## Configuration

The add-on settings select the **instance**, private **storage_path**, and optional
**openai_api_key** (used for bootstrapping a new workspace). Model, channel,
recipient and persona settings belong in the workspace's `talond.yaml`, not in
Home Assistant options. Talon keeps the existing configuration across restarts.

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
`openai_api_key` is exported as `OPENAI_API_KEY` for configurations that use
it; a workspace using another provider does not need a dummy key.
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

## External tools and files

The add-on does not mount Home Assistant's shared folders. Integrate external
services and files through configured MCP servers and Talon permissions.
