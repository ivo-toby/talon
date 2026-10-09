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

## Trusted attachment download servers

Telegram video/file attachments can be downloaded only from HTTP(S) origins
explicitly listed in Home Assistant's `attachment_allowed_origins` option.
The default empty list disables these downloads. Add a server's **origin**
(protocol, hostname or IP, and optional port), without a path or credentials:

```yaml
attachment_allowed_origins:
  - http://192.168.1.161:3300
```

Restart the add-on after changing this list. Every listed origin is explicitly
trusted for attachment downloads, even on a private network. The launcher
sets both `TALON_ATTACHMENT_ALLOWED_ORIGINS` and
`TALON_ATTACHMENT_PRIVATE_ORIGINS` to the validated origins. Invalid URLs
prevent startup instead of silently widening access. Redirects remain blocked;
the list does not grant access to other ports or IP addresses. The MCP
server's own authentication and Talon's `channel.send:attachments` capability
are still required. This option restricts only attachment fetching, **not**
arbitrary shell/network access available to a configured AI provider.

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
