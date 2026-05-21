# userdata/ — agent dropbox

A convenience folder for files you want the agent to access. Bind-mounted
into the container at `/userdata`.

## How it works

- The compose file bind-mounts this directory **read+write** into the
  container at `/userdata`.
- The agent reads/writes via the file tools of whatever provider you're
  using (Claude's `Read`/`Edit`/`Bash`, Codex's equivalents, etc.).
- This folder is the **convenient** place for user content — not a
  security boundary. The agent's file tools can also reach the
  container's other bind mounts (`/config`, `/personas`, `/data`) and
  application files in `/opt/talond`. Provider processes also inherit
  the container's environment variables. Treat the whole container as
  the trust boundary, not this directory.
- Don't put secrets here. `.env` is for secrets — the daemon reads it
  but the agent has no special path to it (and shouldn't need one).

## What to put here

- Documents you want the agent to summarize, search, or quote (PDFs,
  markdown, plain text).
- Repos or working trees the agent should code in.
- Output the agent should write back to you (drafts, reports, screenshots).

## Examples

Once the daemon is up, ask your bot something like:

> Read everything in `/userdata/notes/` and write a summary to
> `/userdata/summary.md`.

The agent uses its built-in file tools — no extra configuration needed.

## Permissions on Linux

Bind mounts on Linux use the host UID/GID directly. The container's
`talond` user is UID/GID 1000. If your host user isn't 1000, the agent
may be unable to write here. Either:

- Run as a host user with UID 1000 (the default for first-created users
  on most distros), or
- `chmod 0777 userdata/` (loose but works) or `chown 1000:1000 userdata/`.

macOS and Windows users on Docker Desktop don't hit this — the
file-sharing layer maps ownership automatically.
