# Talon Home Assistant add-on

Run Talon in Home Assistant with a built-in management terminal.

## Features

- One Talon daemon and management CLI in a single add-on
- Private persistent configuration, workspace, and SQLite database
- Optional storage location within the add-on's private data directory
- Channel and model settings managed directly in each private workspace
- MCP integrations for external tools and files

## Installation

Add this repository to the Home Assistant add-on store and install **Talon**.
A new workspace defaults to Codex CLI when no OpenAI API key is supplied;
provider login is separate from opening the management terminal.
For existing workspaces, the existing `talond.yaml` is authoritative, including
model, channel and recipient settings. Secret API keys and bot tokens may stay
in Home Assistant's password settings and be referenced as environment variables. Configure channels using the private terminal.

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

## Trusted attachment download origins (PR #289)

Home Assistant exposes `attachment_allowed_origins` as a default-empty list of
trusted HTTP(S) origins for Telegram file downloads. This depends on
[PR #289](https://github.com/ivo-toby/talon/pull/289), which adds the
`attachments.allowedOrigins` and `attachments.privateOrigins` settings to Talon.

Example add-on configuration:

```yaml
attachment_allowed_origins:
  - "http://192.168.1.161:3300"
```

At startup, the add-on validates every origin and synchronizes a **marked
Home Assistant-managed block** in the selected workspace's `talond.yaml`.
This keeps the rest of the file intact. The trusted origins populate both
allowed and private origin lists; allowing a private origin is an explicit
per-server exception to Talon's public-IP restriction. Redirects remain blocked.
Removing all origins removes only the managed block.

If you already have an independently managed top-level `attachments:` block
in `talond.yaml`, configure origins there instead; the add-on refuses to
overwrite it when its HA origin list is nonempty. Invalid settings prevent
the daemon from starting, but the recovery terminal remains accessible.
Restart the add-on after changing these settings.

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
