# Talon Home Assistant add-on

Run Talon in Home Assistant with a built-in management terminal.

## Features

- One Talon daemon and management CLI in a single add-on
- Private persistent configuration, workspace, and SQLite database
- Optional storage location within the add-on's private data directory
- Channel and model settings managed directly in each private workspace
- MCP integrations for external tools and files

## Installation

Add this repository to the Home Assistant add-on store, install **Talon**,
and configure an OpenAI API key if creating a new default workspace.
For existing workspaces, the existing `talond.yaml` is authoritative, including
model and Telegram settings. Configure channels using the private terminal.

The default storage root is `/data/talon`. The optional `storage_path` accepts
another absolute path below private `/data`, such as `/data/assistant`.
The daemon state is stored in `<storage_path>/state`. The `instance` setting
selects a workspace by name under `<storage_path>/workspaces/`. Leave it empty
to use `default`, or enter the name of an existing workspace to reuse it.
For example, `instance: example` selects `/data/talon/workspaces/example` with the
default storage location.

Each installation runs one daemon. A chosen storage path does not share files
with other add-ons or automatically start multiple instances.

Changing `storage_path` does not move data. Back up and transfer the existing
workspace and database before selecting another location.

## Management

Open **Talon > Open Web UI** and use the terminal:

```sh
talonctl status
talonctl list-personas
talonctl reload
```

The add-on does not mount Home Assistant's shared directories. Connect external
files through explicitly configured MCP servers.

See [DOCS.md](DOCS.md) for more information.
