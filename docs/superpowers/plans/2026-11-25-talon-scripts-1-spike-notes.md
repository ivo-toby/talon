# Talon scripts, part 1: spike notes

Date: 2026-11-25. Host: the development machine, Docker 26.1.5. The spike code was throwaway and is not in the repository.

## Spike A: tool channel on real Docker

Result: go. All criteria passed.

Image: `node@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530` (official `node:24-slim`). The container used the posture of `docker-backend.ts` and one read-only bind mount at `/scripts`.

| Criterion | Result |
| --------- | ------ |
| Line to standard input reaches the script, reply comes back, `NetworkMode: none` | Passed |
| Output arrives in multiplexed frames during the exec | Passed. The first frame came 603 ms after exec start |
| Half-close of the socket ends standard input in the script | Passed |
| `node` runs `script.ts` with type annotations as uid 10001 on a read-only root | Passed |
| `import { call } from 'talon'` resolves from `/scripts/node_modules/talon` | Passed |
| Abort of the request ends the exec stream | Passed for the stream. See the first finding |

Other measurements:

- Exec start with `Connection: Upgrade` and `Upgrade: tcp` returns status 101. The upgrade head buffer was empty.
- `fetch` to an outside address failed inside the container.
- A write to `/scripts` failed inside the container.
- Start of Node.js plus the first call took about 600 ms.

Findings that change the build:

1. After the host destroys the stream, the process in the container continues. Docker reports the exec as running. The process stops only at container removal. The runner must therefore always revoke the lease, and the plan already says this. If standard input closes, `run.js` must also exit.
2. No custom image is necessary. The official Node.js image is sufficient.

## Spike B: MCP helper start time

Result: go for a helper process per script run, for stdio servers.

Versions: `@mastra/mcp` 1.18.0, `@mastra/core` 1.83.0. One local stdio server with two tools.

- `new MCPClient` plus `listTools()`: 290, 346, 368, 505 and 736 ms. The median is 368 ms.
- One tool call: 47 to 83 ms.
- `disconnect()`: 9 to 17 ms.
- A tool object exposes the MCP annotations at `tool.mcp.annotations`. `readOnlyHint: true` was present for the tool that set it. A tool with no annotations has no `mcp.annotations` value.
- Tool names get the server name as a prefix: `demo_list_items`.

Not measured:

- Servers with OAuth login. Their tokens are on `talon-vm`. A test there can refresh a live token, and that needs permission from Ivo.
- HTTP servers and slow servers. The real servers of the assistant can start slower than this local server.
- Whether the real servers in use set `readOnlyHint`.
