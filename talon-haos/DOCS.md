# Talon Home Assistant add-on

## Configuration

Configure an OpenAI API key in the add-on settings. The model and Telegram
credentials are optional.

By default, Talon stores its configuration, workspace, and database in private
persistent storage under `/data/talon`. Use `storage_path` to select another
absolute directory inside `/data`.

Set `instance` to the workspace name you want to open (for example, `example`).
Leaving it empty selects `default`. The instance setting selects one workspace;
it does not start additional Talon daemons. Existing workspace configuration
and skill definitions are reused without copying files.

The initial workspace configuration is created only when `talond.yaml` is
absent. Normal restarts and upgrades retain existing state and settings.
Changing `storage_path` does not relocate existing files; move the workspace
and database yourself after making a backup.

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
