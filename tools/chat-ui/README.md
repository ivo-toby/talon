# Talon Chat UI

A minimal React frontend for any Talon `aisdk-http` channel.

## Setup

1. Copy env file and configure:
   ```bash
   cp .env.example .env
   # Edit .env: set VITE_TALON_URL and VITE_AGENT_ID
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start Talon with an `aisdk-http` channel on the configured port.

4. Start dev server:
   ```bash
   npm run dev
   ```
   Open http://localhost:5173.

## Build

```bash
npm run build
npm run preview   # preview the production build
```

## Features

- Streams responses in real-time via AI SDK v5 UI Message Stream protocol
- Thread ID persisted across page reloads (localStorage)
- Custom `data-*` artifact chunks rendered in the Artifact Panel
- New Thread button to start fresh conversations
- Shift+Enter for multi-line input, Enter to send

## Connecting to Talon

In `talond.yaml`:
```yaml
channels:
  - name: my-chat
    type: aisdk-http
    config:
      port: 4100
      routePattern: "/agents/:agentId/stream"

bindings:
  - channel: my-chat
    persona: my-persona
    isDefault: true
```

Set `VITE_TALON_URL=http://localhost:4100` and `VITE_AGENT_ID=my-persona` in `.env`.

## Remote access

To connect from a different machine, set `host: '0.0.0.0'` in the channel config and add the remote origin to `cors.allowOrigins`. Start the dev server with `npm run dev -- --host 0.0.0.0`.
