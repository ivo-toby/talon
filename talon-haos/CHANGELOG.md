# Changelog

## 1.0.11

- Refresh source-built add-on packaging and management terminal integration.
- Preserve existing workspaces, private state and credentials across upgrades.

## 1.0.10

- Omit disabled Docker healthcheck metadata that can leave Supervisor in startup
  while the daemon and terminal are already running.
- Verify the actual Home Assistant image's metadata, terminal HTTP/WebSocket
  transport, gateway access restriction, keyless startup and persistent state.
- Keep the recovery terminal and all existing ingress restrictions unchanged.

## 1.0.1

- Support selecting an existing workspace with the `instance` add-on setting.
- Document how to reopen named workspaces without moving data.

## 1.0.0

Initial public release of the Talon Home Assistant add-on.

- Single Talon daemon with an integrated management terminal.
- Private persistent workspace, database, and configuration.
- Configurable private storage location.
- Optional Telegram configuration and MCP integrations.
