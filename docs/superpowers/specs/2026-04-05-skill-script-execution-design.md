# Skill Script Execution — Design

**Date:** 2026-04-05
**Branch:** `feat/skill-scripts`
**Status:** Draft — for review

## Problem

Talon skills today are purely declarative: prompt fragments, tool manifests, MCP server definitions, migrations. There is no way for a skill to ship executable scripts that an agent can invoke during a conversation.

Real-world skills almost always want to run scripts. Research across spec-kit, OpenSpec, Jesse Vincent's superpowers, and the planned Contentful skill shows a consistent pattern: skills are thin orchestrations of real tools (`git`, `gh`, `contentful`, `npm`, language toolchains) operating on a repository, with credentials from environment variables, and talking to specific services over HTTPS. The "script" is usually a short bash snippet in a markdown code fence that calls one of these tools.

We want Talon skills to support this pattern without:

- Running scripts on the bare host (unbounded blast radius)
- Requiring skill authors to hand-author a YAML registry of scripts
- Forcing a heavy container runtime dependency (Docker daemon, image management)
- Breaking backward compatibility with existing prompt-only Talon skills

## Goals

1. Skills can declare a sandbox profile and expose a scoped shell execution tool that the agent can call to run arbitrary commands inside the sandbox.
2. Existing Claude Code / superpowers skills are installable with minimal changes — just add a `sandbox:` block to the frontmatter.
3. Scripts always run inside a sandbox. There is no host fallback. Ever.
4. Operators have a single place to review what a skill can touch: the `sandbox:` block. Capability grants are per-skill.
5. Every script invocation is audit-logged with the exact command and the secrets used (by name).
6. Works on Linux (bubblewrap) and macOS (Apple Container). Older macOS or systems without either are explicitly unsupported for script execution.

## Non-Goals (v1)

- Lifecycle scripts (on-skill-load, on-persona-start). Deferred until a concrete use case appears.
- Per-host egress allowlist for `<skill>_exec`. v1 supports only `network: on` (full egress via shared netns) or `network: off` (no network). Skills needing allowlisted HTTP should use `network: off` and route requests through the existing `net.http` host-tool, which already enforces an operator-level domain allowlist centrally. A proxy-based allowlist for skill-exec itself is a future refinement.
- Removing the dormant local Docker sandbox code and persona `mounts` field. Separate prerequisite cleanup PR.
- Structured per-script MCP tool wrappers with individual param schemas.
- Windows support.
- Warm sandbox pools, image caching, reproducible toolchains across Linux/macOS.
- OS keychain integration for secret resolution.

## Design Overview

A new skill subsystem: **skill-exec**. Skills that want script execution add a `sandbox:` block to their SKILL.md frontmatter. Talon registers one MCP tool per such skill — `<skillname>_exec(command)` — that runs the supplied command in a sandbox profile derived from the block. The sandbox is bubblewrap on Linux, Apple Container on macOS. A `skill.exec:<name>` capability gates whether the tool is exposed to a given persona.

The agent interacts with the skill the same way it interacts with a Claude Code skill: read the prose via `skill_load`, see example bash commands in fenced code blocks, pick the right commands, call `<skill>_exec` with them. No per-script registry, no structured param schemas.

```
┌─────────┐     skill_load        ┌────────────────────┐
│  Agent  │──────────────────────▶│  SKILL.md prose    │
│         │                       │  + bash examples   │
│         │                       └────────────────────┘
│         │
│         │  <skill>_exec(command)  ┌──────────────────┐    bwrap / container run
│         │────────────────────────▶│  skill.exec      │──────────────────▶ sandboxed process
│         │                         │  bridge handler  │                    (workdir mounted,
│         │◀────────────────────────│                  │◀───────────────────  secrets injected,
│         │  {stdout, stderr, exit} └──────────────────┘   stdout/stderr     network on or off)
└─────────┘
```

## Components

### 1. Skill manifest extension

New optional `sandbox` field in `SKILL.md` frontmatter. When present, the skill is a "script-enabled skill" and participates in exec tool registration. When absent, the skill is prompt-only (current behavior, fully backward compatible).

```yaml
---
name: contentful
version: 0.1.0
description: Manage Contentful content via the Contentful CLI
requiredCapabilities:
  - skill.exec:contentful

sandbox:
  workdir: repo                    # "repo" | "skill-bundle" | absolute path. default: "repo"
  mounts:                          # extra bind-mounts beyond workdir. See validation rules.
    - source: ${skill.dir}/fixtures
      target: /skill/fixtures
      mode: ro
  network: on                      # "off" | "on". default: "off". No allowlist in v1.
  secrets:                         # env var names; values resolved from secret store
    - CONTENTFUL_MANAGEMENT_TOKEN
  env:                             # non-secret env vars
    CONTENTFUL_HOST: https://api.contentful.com
  bins:                            # explicit enforced allowlist. Only these are on PATH.
    - bash
    - sh
    - node
    - npx
    - git
    - ls
    - cat
    - grep
    - sed
    - awk
  image: talon-skill-runtime:latest  # apple-container only; ignored by bwrap
  shell: /bin/bash                 # must also appear in bins
  timeoutSeconds: 60               # per-invocation, default 60, clamped [1, 600]
  resourceLimits:
    memoryMb: 1024
    cpus: 1
    pidsLimit: 256
---

# Skill prose with inline bash examples...
```

Zod schema lives in `src/skills/skill-sandbox-schema.ts` and is composed into the existing `SkillMdFrontmatterSchema` / `SkillManifestSchema` in `src/skills/skill-schema.ts`. Validation rules:

- `workdir: repo` requires the persona binding the skill to have a configured repo path (see §5). Otherwise load fails for that persona binding with a clear error.
- `mounts[].source` substitution is restricted to `${skill.dir}` only. **No `${HOME}`, no `${persona.dataDir}`, no arbitrary env expansion.** Absolute paths outside `${skill.dir}` are allowed but flagged by `install-skill` for explicit operator approval (see §8). `${persona.dataDir}` is specifically forbidden because the secret store reads `.env` from it and mounting it would bypass the declared `secrets[]` audit trail.
- `mounts[].source` is resolved to an absolute canonical path via `fs.realpath()` at daemon startup. The resolved path must be contained within an allowed base (either the verbatim absolute path the operator approved at install time, or fully inside the skill bundle directory). Symlinks whose target escapes the containment base cause skill load to fail. This reuses the realpath-based containment logic already present in `src/execution-env/path-policy.ts` — the new code calls into a shared helper.
- `mounts[].target` must be absolute and must not land on, inside, or above any of the runner's reserved targets, with one narrow exception. The reserved targets are: `/workspace`, `/skill`, `/skill/bin`, `/usr`, `/usr/lib`, `/lib`, `/lib64`, `/bin`, `/proc`, `/dev`, `/tmp`, `/run`, `/etc`. A declared target is **rejected** if it satisfies any of:
  1. it equals a reserved target, OR
  2. it is an ancestor of a reserved target (e.g., `/` or `/us`), OR
  3. it is a descendant of a reserved target (e.g., `/usr/lib/foo`, `/etc/hosts`, `/skill/bin/curl`).

  **Exception:** descendants of `/skill` that are **not** descendants of `/skill/bin` are allowed — e.g., `/skill/fixtures`, `/skill/data/seed`. This carveout is safe because: (a) `/skill/bin` — the backbone of the PATH allowlist — remains fully reserved and cannot be shadowed; (b) any additional subpaths under `/skill` would themselves have gone through operator review at install time as part of the skill bundle declarations; (c) the rest of the sandbox's execution model (see `bins[]` above) already treats `/skill` as operator-reviewed trusted content.

  Mounts are applied after the base runtime binds, but the validator rejects any conflict before the runner is invoked, so a skill cannot override `/usr/lib` shared libraries, shadow `/etc` to change DNS/hosts resolution, or introduce new binaries into `/skill/bin`.
- `mounts[].target` must not duplicate or shadow another mount target in the same profile.
- `network` is `"off"` or `"on"`. No allowlist mode in v1 (see Open Questions and §2). `network: on` means full egress via `--share-net`; skills that need controlled access should use `network: off` and call the existing `net.http` host-tool through the host-tools bridge, which already enforces an operator-level domain allowlist.
- `secrets[]` entries must match `[A-Z_][A-Z0-9_]*` and must not collide with `env[]` keys. Values are injected as environment variables; the only way a skill should see a secret is if it is listed here.
- `bins[]` is a **PATH-based allowlist**, not a full execve filter. At skill load time Talon resolves each name via `which` against the daemon's `$PATH`, creates a per-skill bin directory at `{dataDir}/skills/<name>/.bin/` containing symlinks only to the resolved targets, and binds that directory into the sandbox at `/skill/bin`. The sandbox's `PATH` is set to `/skill/bin` only. Host `/usr/bin` and `/bin` are **not** bind-mounted into the sandbox (only `/usr/lib`, `/lib`, `/lib64` are, read-only, so dynamically linked bins can find their shared libraries).

  **What `bins[]` guarantees:** nothing outside `/workspace` and `/skill` can be executed by any means. The only binaries reachable via name lookup (`node`, `git`, etc.) are those in `bins[]`. Binaries not in `bins[]` cannot be invoked from host locations like `/usr/bin`, because those locations are not present in the sandbox at all.

  **What `bins[]` does not guarantee:** executables that live inside `/workspace` (the operator's trusted repo) or `/skill` (the operator-reviewed skill bundle) can still be invoked by absolute or relative path (`./scripts/deploy.sh`, `/workspace/tools/build`, `/skill/helpers/fix.sh`). This is by design — skills need to run repo code (`./gradlew`, `node_modules/.bin/*`, `scripts/*.sh`), and the operator reviews the skill bundle at `install-skill` time. Per-bind `noexec` is not available in bubblewrap, and a seccomp/Landlock-based execve filter that only permits `/skill/bin/*` is deferred to phase 2 as a hardening step for untrusted skill bundles.

  The effective execution surface inside a sandbox is therefore: `bins[]` (by name via PATH) ∪ executables in the mounted repo (`/workspace`) ∪ executables in the mounted skill bundle (`/skill`). The operator's trust boundary is the install-skill review plus the repo they chose to mount.

  An empty `bins[]` is a validation error when a `sandbox:` block is present (the sandbox would have no executable entry point by name, including no shell).
- `bins[]` must include the shell specified in `shell` (default `bash`). Validation enforces this.
- If any declared binary cannot be resolved on the daemon's `$PATH` at startup, the skill's `_exec` tool is not registered, a warning is logged, and other skills continue to load normally.
- `image` is ignored (with a warning) on bubblewrap; a runtime warning is logged noting the Linux/macOS asymmetry.
- `requiredCapabilities` must include `skill.exec:<ownName>` when a `sandbox:` block is present. Structural consistency check.
- `timeoutSeconds` clamped to `[1, 600]`.
- `resourceLimits` reuses the existing `ResourceLimitsSchema` shape.
- Unknown keys in `sandbox:` → validation error.

The default profile (empty `sandbox: {}` block): `workdir: repo`, `network: off`, no secrets, no env, no extra mounts, a minimal default `bins: [bash, sh, ls, cat]`, `timeoutSeconds: 60`, `memoryMb: 1024`, `cpus: 1`, `pidsLimit: 256`.

**Skill-name/capability-scope compatibility.** Skill names can contain hyphens (e.g., `git-flow`). Two existing capability-scope regexes accept only `\w+` in the scope segment and would reject `skill.exec:git-flow`:

- `CAPABILITY_WITH_SCOPE_RE` in `src/skills/skill-loader.ts:41` (skill manifest `requiredCapabilities` validation)
- `CAPABILITY_WITH_SCOPE_RE` in `src/personas/capability-merger.ts:32` (resolved persona capability validation; already accepts `*` as a wildcard)

Both must be extended to allow `[A-Za-z0-9_-]+` (or `*`) as a scope, landing in the same PR as the skill-exec feature. The MCP tool name is a separately sanitized form (`git-flow` → `git_flow_exec`); the capability scope keeps the original skill name verbatim. `src/cli/config-utils.ts` does not need changes — its name regex already allows hyphens.

### 2. Sandbox runner

New module `src/skills/script-runner/`. Exports a `SkillScriptRunner` interface:

```typescript
interface SkillScriptRunner {
  readonly backend: 'bubblewrap' | 'apple-container';
  isAvailable(): boolean;
  validateSkill(profile: SkillSandboxProfile): Result<void, SandboxValidationError>;
  execute(input: SkillExecInput): Promise<SkillExecResult>;
}

interface SkillExecInput {
  skillName: string;
  skillDir: string;
  profile: SkillSandboxProfile;
  command: string;
  timeoutSeconds?: number;
  context: { threadId: string; personaId: string; requestId: string; repoPath: string | null };
  resolvedSecrets: Record<string, string>;   // resolved by the secret store, never logged
}

interface SkillExecResult {
  status: 'success' | 'error' | 'timeout';
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  artifactPath: string | null;
}
```

Two implementations:

**BubblewrapRunner** (`bubblewrap-runner.ts`): invokes `bwrap` with an arg list equivalent to:

```
bwrap \
  --die-with-parent \
  --unshare-all \
  [--share-net]                              # only when network == "on"
  --new-session \
  --proc /proc --dev /dev \
  --tmpfs /tmp --tmpfs /run \
  --ro-bind /etc/resolv.conf /etc/resolv.conf \   # only when network == "on", minimal
  --ro-bind /usr/lib /usr/lib \
  --ro-bind /lib /lib [--ro-bind /lib64 /lib64] \
  --bind <workdirSource> /workspace \
  --ro-bind <skillDir> /skill \
  --ro-bind {dataDir}/skills/<name>/.bin /skill/bin \   # curated bin allowlist; see §1 bins[]
  [--ro-bind | --bind <canonicalExtraSource> <extraTarget> ...] \
  --setenv HOME /tmp \
  --setenv PATH /skill/bin \
  [--setenv <KEY> <VALUE> ...]              # env + secrets
  --chdir /workspace \
  /skill/bin/bash -c "<command>"
```

**Explicitly not mounted:** `/usr/bin`, `/bin`, `/etc` (as a whole), `/home`, `/root`, `/var`, `/opt`, the operator's home directory, the persona data directory, the Talon data root. Everything the sandboxed process sees on the filesystem is either the workdir, the skill bundle, the curated `/skill/bin`, the minimal `/usr/lib`+`/lib`(+`/lib64`) needed for dynamic linking, kernel pseudo-filesystems (`/proc`, `/dev`), a tmpfs `/tmp`+`/run`, or a mount the skill explicitly declared and the operator approved.

Resource limits applied via a `systemd-run --scope --user --quiet --property=MemoryMax=... --property=CPUQuota=... --property=TasksMax=...` wrapper when systemd is available, with a `prlimit` fallback. Timeout enforced by a Node-side timer that sends `SIGTERM`, then `SIGKILL` after a short grace period.

**AppleContainerRunner** (`apple-container-runner.ts`): invokes the `container run --rm ...` CLI with equivalent `--volume`, `--network none|bridge`, `--env`, `--workdir`, `--image`, timeout, and resource limit flags. `network: on` → `--network bridge`. `network: off` → `--network none`. `PATH` inside the container is set to `/skill/bin` and `bins[]` are staged into the same curated directory that gets bind-mounted in, so the allowlist semantics match the Linux path.

Availability check: runs at daemon boot. If neither backend is available, skill-exec is disabled daemon-wide and a warning is logged; any skill with a `sandbox:` block gets its `_exec` tool unregistered with a clear per-skill warning. The daemon still starts normally.

**Critical invariant:** there is no third implementation that runs on the bare host. If both runners report unavailable, scripts do not run. Enforced by the fact that the `SkillScriptRunner` interface is the only execution path and the factory returns `null` when nothing is available.

### 3. Secret store

New module `src/core/secrets/`. v1 is a simple env-var pass-through store:

```typescript
interface SecretStore {
  resolve(names: readonly string[], context: SecretResolveContext): Result<Record<string, string>, SecretError>;
}
```

Resolution order for v1:
1. `process.env[name]` (the daemon's environment)
2. A dedicated operator-managed secrets file at `{dataDir}/secrets.env`, loaded at daemon startup into an in-memory map (never re-read from disk per-request, never accessible from the sandbox, never inside a persona directory that could be mounted). Permissions checked at startup (`0600` or stricter, owned by the daemon user); looser permissions cause the file to be ignored with a warning.
3. Failure → `SecretError` with the name that failed

Secret values are never logged, never written to audit metadata, never included in tool descriptions. Only names appear in audit entries. The secrets file location is intentionally outside any persona data directory and outside anything mountable by a skill — resolution happens in the daemon, never inside the sandbox.

Future phases add keychain, HashiCorp Vault, AWS Secrets Manager adapters behind the same interface. Out of scope for v1.

### 4. Bridge handler & MCP tool registration

New internal tool in `HOST_TOOL_REGISTRY`: capability prefix `skill.exec`, internal name `skill.exec`. One handler class: `SkillExecHandler` in `src/tools/host-tools/skill-exec.ts`.

**Dynamic registration is a change from the current static pattern.** Existing entries in `HOST_TOOL_REGISTRY` (`src/tools/tool-filter.ts:32`) are 1-to-1 between capability prefix, internal name, and MCP name. `skill.exec` introduces a **1-to-many** mapping: one capability prefix, one internal handler, but an MCP name set that is computed at agent-run start from the persona's loaded script-enabled skills.

This requires the following refactors:

- `HOST_TOOL_REGISTRY` entries gain an optional `expand(context)` function that returns a list of MCP tool names derived from loaded-skill state. Existing entries default to returning their single static `mcpName`; the new `skill.exec` entry returns `<sanitizedName>_exec` for every loaded script-enabled skill the persona has `skill.exec:<name>` or `skill.exec:*` access to.
- `filterAllowedMcpTools` in `src/tools/tool-filter.ts` and the per-agent bootstrap in `src/daemon/agent-runner.ts:331` are updated to consume the expanded list.
- The MCP server layer (`host-tools-mcp-server.ts`, in-process SDK server) receives the expanded names and per-name descriptions at agent-run start via the existing `TALOND_ALLOWED_TOOLS` env var / programmatic config path. The bridge's reverse lookup maps an MCP name (`contentful_exec`) back to `{internal: "skill.exec", skillName: "contentful"}` before dispatching to `SkillExecHandler`.
- Tool-list changes are per-agent-run only; there is no mid-run dynamic tool registration. A new conversation picks up a freshly expanded tool list.

Dispatch example:

```
contentful_exec   → SkillExecHandler (skillName="contentful")
git_flow_exec     → SkillExecHandler (skillName="git-flow")
...
```

Tool name sanitization: skill name lowercased, `-` → `_`, suffix `_exec`. Collisions are a load-time error. The **capability** scope keeps the original skill name (`skill.exec:git-flow`); only the MCP tool name is sanitized.

Each `<skill>_exec` tool has an auto-generated description enumerating the sandbox profile contents:

> "Run bash commands in the 'contentful' skill sandbox. Repo mounted at /workspace. Secrets injected (names only): CONTENTFUL_MANAGEMENT_TOKEN. Network: on (egress unrestricted; use `net.http` for allowlisted requests instead when possible). Allowed binaries: bash, node, npx, git. Timeout 60s. See `skill_load contentful` for usage instructions."

Tool input schema:

```json
{
  "type": "object",
  "properties": {
    "command": { "type": "string", "description": "Shell command to execute..." },
    "timeoutSeconds": { "type": "integer", "minimum": 1 }
  },
  "required": ["command"],
  "additionalProperties": false
}
```

Tool result (returned via MCP content blocks):

```json
{
  "status": "success",
  "exitCode": 0,
  "stdout": "...",
  "stderr": "...",
  "durationMs": 1234,
  "truncated": false,
  "artifactPath": null
}
```

Stdout is truncated to 64KB, stderr to 16KB. On truncation, full output is written to `{dataDir}/threads/{threadId}/artifacts/<skill>-<timestamp>.log` and the path returned.

Handler flow per invocation:

1. Look up skill in loaded skills cache. If not loaded for this persona → error.
2. Check persona has `skill.exec:<name>` or `skill.exec:*`. If not → error. (Defense-in-depth; the tool shouldn't have been registered in the first place.)
3. Resolve secrets via `SecretStore`. Fail fast if any are missing.
4. Resolve workdir: if `profile.workdir === 'repo'`, use the persona's `repoPath` (§5). If unset, fail. Thread-level repo paths are out of scope for v1 (see Open Questions).
5. Build `SkillExecInput` and invoke the active `SkillScriptRunner`.
6. Capture stdout/stderr, enforce truncation, spill to artifact if needed.
7. Write audit log entry.
8. Return `SkillExecResult` via MCP content blocks.

### 5. Repo path binding

New optional field on persona config: `repoPath` (absolute path). When set, skills with `workdir: repo` bind this path at `/workspace`. When unset, skills with `workdir: repo` fail to load for that persona with a clear error during daemon bootstrap.

```yaml
personas:
  - name: dev-assistant
    repoPath: /home/ivo/projects/talon
    capabilities:
      allow:
        - skill.exec:contentful
    skills:
      - contentful
```

Alternative per-thread repo path (thread workspaces carrying their own repo binding) is out of scope for v1. All repo paths are persona-level.

### 6. Capability model

New capability family: `skill.exec`.

- `skill.exec:<name>` — exposes `<name>_exec` for that skill specifically.
- `skill.exec:*` — exposes `_exec` for every loaded skill that has a sandbox block.
- Absent → no script execution for that persona.

Wildcard is for power personas only; documentation recommends per-skill grants.

`CAPABILITY_DESCRIPTIONS` gets new entries for `skill.exec:*` and `skill.exec:<name>` describing the blast radius.

### 7. Audit logging

Every `<skill>_exec` invocation writes one `AuditEntry` (see `src/core/logging/audit-logger.ts` and the `audit_log` table in `src/core/database/migrations/001-initial-schema.sql`):

```typescript
{
  runId:     "<runId>",
  threadId:  "<threadId>",
  personaId: "<personaId>",
  action:    "skill.exec",
  tool:      "<skillName>_exec",
  requestId: "<requestId>",
  details: {
    skillName:      "contentful",
    command:        "<raw command string, full>",
    exitCode:       0,
    durationMs:     1234,
    timeoutSeconds: 60,
    network:        "on",                          // "on" | "off"
    secretsUsed:    ["CONTENTFUL_MANAGEMENT_TOKEN"], // names only
    bins:           ["bash", "node", "npx", "git"],
    mounts:         [{ target: "/workspace", mode: "rw" }], // targets only, not sources
    stdoutHash:     "sha256:...",
    stderrHash:     "sha256:...",
    truncated:      false,
    artifactPath:   null
  }
}
```

Secret *values* are never logged. Mount *sources* (host paths) are not logged either — only the in-sandbox target paths, so the audit log can't be used to leak operator filesystem layout to an attacker who gains read access to the log. The command string is logged verbatim — operators auditing a skill need to see exactly what ran.

### 8. CLI: install-skill

New command: `talonctl install-skill <source> [--persona <name>] [--format auto]`.

Source types:
- Local path: `./my-skill/` or absolute path
- Git URL: `https://github.com/user/repo` (optionally `#ref` for specific branch/tag)
- Registry shorthand: deferred (v2)

Flow:
1. Fetch (copy or `git clone`) to a **staging directory**. Nothing is copied into `{dataDir}/skills/` until the operator approves.
2. Locate the skill root (directory containing `SKILL.md` or `skill.yaml`)
3. Parse SKILL.md frontmatter
4. **Sandbox review (mandatory, always runs):**
   - **Case A — block is present**: render the existing `sandbox:` block to the operator with a summary of its effects (mounts, network, secrets, bins, any absolute-path mounts flagged as "outside skill bundle"). Require explicit confirmation. Offer an interactive edit before accepting. Installing a remote skill without reviewing its sandbox block is not possible.
   - **Case B — block is missing**: scan the skill body's executable fenced code blocks (`bash`, `sh`, `shell`, `zsh`, `node`, `javascript`, `python`, `py`) for:
     - Referenced binaries (first token of each command line)
     - Env vars (`$FOO` / `${FOO}` / `process.env.FOO` / `os.environ[...]`)
     - URLs (to infer whether network access is needed)
     Propose a `sandbox:` block (bins, secrets/env classification by operator, network on/off), prompt operator to confirm/edit, write it into SKILL.md frontmatter.
5. **Mount review:** any `mounts[]` entry whose resolved canonical path falls outside `${skill.dir}` is flagged individually, displayed with its fully resolved target, and requires per-entry operator approval. Non-approved mounts are removed.
6. **Bin review:** the resolved path for each `bins[]` entry (from `which`) is displayed; operator can drop entries.
7. Copy approved skill bundle from staging to `{dataDir}/skills/<name>/`
8. Build the curated `.bin/` directory with symlinks to the approved binaries
9. Prompt for target persona(s); add `skill.exec:<name>` to their capabilities
10. Validate the full config; write it
11. Staging directory is deleted

Installing a skill is a trust decision. The CLI never auto-accepts a sandbox profile from a remote source, never mounts anything outside the skill bundle without explicit per-entry approval, and never grants the `skill.exec:<name>` capability automatically.

The Claude Code `talon-setup` skill gets a new prose section wrapping this CLI with interactive guidance. That wrapping is out of the daemon's code scope — it's a skill file change in `.claude/skills/talon-setup/`.

## Data Flow

### Happy path: agent runs a contentful migration

1. Persona `dev-assistant` has `skill.exec:contentful` in capabilities, `contentful` in skills, `repoPath: /home/ivo/projects/foo` set.
2. Daemon startup:
   - Loads `contentful` skill, parses sandbox block, validates bins (`node`, `npx`, `git` on PATH — OK).
   - Resolves `CONTENTFUL_MANAGEMENT_TOKEN` availability check (found in `process.env` — OK).
   - Registers `contentful_exec` as an available MCP tool for this persona.
3. Agent run starts. Tool list sent to agent includes `contentful_exec` with its auto-generated description.
4. Agent receives a user message: "Add an `author` field to the `Article` content type."
5. Agent calls `skill_load contentful` → receives skill prose with example commands.
6. Agent calls `contentful_exec({ command: "npx contentful space migration create --name add-author-field" })`.
7. `SkillExecHandler` resolves secrets, builds `SkillExecInput`, invokes `BubblewrapRunner`.
8. `bwrap` spawns a sandboxed bash with `/home/ivo/projects/foo` bind-mounted at `/workspace`, the curated `.bin/` dir mounted at `/skill/bin`, `PATH=/skill/bin`, `CONTENTFUL_MANAGEMENT_TOKEN` in env, network shared (`network: on`), 60s timeout.
9. Command runs, writes a migration file into `/workspace/migrations/<timestamp>-add-author-field.js`.
10. stdout/stderr captured, exit code 0, result returned to agent.
11. Audit log entry written.
12. Agent reads the generated file (via its repo access — outside the sandbox, through Talon's file-read tools) and edits it.
13. Agent calls `contentful_exec({ command: "npx contentful space migration apply migrations/<timestamp>-add-author-field.js" })` to apply it.

### Failure modes

- **Secret missing at invocation time:** resolution fails fast, `_exec` returns `status: error` with `"secret not resolvable: CONTENTFUL_MANAGEMENT_TOKEN"`. No sandbox spawned.
- **Repo path unset:** skill fails to load for that persona at daemon startup with a clear error. `_exec` tool not registered.
- **Binary missing (`bins` check):** skill fails to load at daemon startup, warning logged, `_exec` tool not registered. Other skills continue to load normally.
- **Neither bwrap nor apple-container available:** daemon-wide skill-exec disabled, warning logged, all `_exec` tools unregistered. Daemon continues running normally (prompt-only skills still work).
- **Command exceeds timeout:** sandbox killed (SIGTERM then SIGKILL), `status: timeout`, partial stdout/stderr returned, exit code -1.
- **Command exits non-zero:** `status: error`, `exitCode` set, stdout/stderr returned. Agent sees the failure and can react.
- **Output exceeds 64KB stdout / 16KB stderr:** truncated to limits, full output written to artifact, `artifactPath` set in result.

## File & Module Layout

```
src/
  skills/
    skill-schema.ts                  # extend with sandbox block
    skill-sandbox-schema.ts          # NEW — Zod schema for sandbox block
    skill-loader.ts                  # extend to resolve bins, build .bin dir, validate mounts
    skill-sandbox-staging.ts         # NEW — build per-skill .bin dir with symlinks
    script-runner/
      index.ts                       # NEW — runner factory + interface
      runner-types.ts                # NEW — SkillScriptRunner, SkillExecInput, SkillExecResult
      bubblewrap-runner.ts           # NEW — Linux backend
      apple-container-runner.ts      # NEW — macOS backend
      availability.ts                # NEW — detect which backend is usable
  tools/
    host-tools/
      skill-exec.ts                  # NEW — SkillExecHandler
    tool-filter.ts                   # extend HOST_TOOL_REGISTRY with dynamic expand()
  core/
    secrets/
      index.ts                       # NEW — SecretStore interface
      env-secret-store.ts            # NEW — v1 daemon-env + secrets.env impl
    fs/
      path-containment.ts            # NEW — shared realpath + containment helper
                                     #        (extracted from path-policy.ts)
  execution-env/
    path-policy.ts                   # refactor to use shared path-containment helper
  skills/
    skill-loader.ts                  # relax CAPABILITY_WITH_SCOPE_RE to allow hyphens
  personas/
    capability-merger.ts             # relax CAPABILITY_WITH_SCOPE_RE to allow hyphens
  cli/
    commands/
      install-skill.ts               # NEW — talonctl install-skill
      install-skill-scanner.ts       # NEW — fenced code block scanner
  daemon/
    agent-runner.ts                  # extend to expand <skill>_exec tool names per loaded skill

tests/
  unit/
    skills/
      script-runner/
        bubblewrap-runner.test.ts
        apple-container-runner.test.ts
        availability.test.ts
      skill-sandbox-schema.test.ts
    tools/
      host-tools/
        skill-exec.test.ts
    core/
      secrets/
        env-secret-store.test.ts
    cli/
      install-skill-scanner.test.ts
  integration/
    skill-exec-end-to-end.test.ts    # real bwrap on Linux CI; skipped on macOS CI
```

## Testing Strategy

- **Unit tests** for Zod schema validation, tool filter registry, secret store, scanner, handler (with mocked runner).
- **Unit tests with fake runner** for the SkillExecHandler flow: capability gating, secret resolution, audit writes, result truncation, artifact spill.
- **Integration tests** for `BubblewrapRunner` that shell out to real `bwrap` with a test skill. Gated on Linux + bwrap availability. Cover: happy path, timeout, stdout/stderr capture, resource limits, workdir mount, extra mounts, network off vs on, secret injection.
- **Integration tests** for `AppleContainerRunner` — same coverage, gated on macOS + `container` CLI availability. May run manually initially if CI macOS runners lack Apple Silicon.
- **Negative security tests**: attempt to read `/etc/shadow`, read `/etc/passwd`, list `/home`, list `/root`, write outside `/workspace`, make a network call when `network: off`, escape via `..` in mount source, escape via symlink in mount source (resolved path outside skill dir must be rejected at load time, not at runtime), call a binary not in `bins[]` (e.g., `curl` when not declared), read the operator's secrets file via any mount. All must fail and be observable.
- **Install-skill tests**: scanner correctness on representative superpowers and spec-kit skill bodies, frontmatter rewrite idempotence, validation of generated sandbox blocks.
- Coverage threshold remains 80%. New modules meet or exceed.

## Migration & Rollout

**Prerequisite PR — dormant sandbox cleanup:**
- Remove `SandboxConfigSchema` from `config-schema.ts` and its root wiring
- Remove persona `mounts` field (verify unused, then delete)
- Remove `runtime: 'docker' | 'apple-container'` enum
- Lands before the skill-exec feature PR to keep diffs focused

**Feature PR — skill-exec:**
- All new files and extensions listed above
- Backward compatible: existing skills without `sandbox:` blocks are unaffected
- Docs updated: README skill section, `config/talond.example.yaml` with a skill-exec example, `CLAUDE.md` architecture section, skill format docs
- `talon-setup` Claude Code skill gets an install-skill section

**Follow-up PRs (deferred):**
- Proxy-based egress allowlist enforcement
- OS keychain secret store adapter
- Lifecycle scripts (on-skill-load, on-persona-start)
- Warm sandbox pools
- Registry shorthand for `install-skill`
- **Execve filter for untrusted skills:** a seccomp-bpf or Landlock-based execution boundary that restricts execve to `/skill/bin/*` only. Turns `bins[]` into a full execution allowlist even against skill bundles that contain smuggled binaries. Not needed in v1 because the install-skill review gates what enters the bundle, but valuable when Talon starts pulling skills from less trusted sources.

## Open Questions

None blocking. Documented asymmetries and deferrals:

1. **`image:` is macOS-only** in v1 (apple-container honors it, bwrap ignores it). Skills that need specific toolchains on Linux must rely on host-installed bins declared in `bins`, or gate themselves to macOS via a future `platforms:` field.
2. **No network allowlist in v1.** Network is `on` or `off`. A true per-host egress allowlist requires a forward proxy (routing the sandbox's traffic through the existing `net.http` allowlist or a new dedicated HTTPS proxy) and is deferred. Skills that need allowlisted HTTP should use `network: off` and call `net.http` through the host-tools bridge, which already enforces an operator-level domain allowlist centrally. Skills that need `network: on` are trusted with unrestricted egress — this is a deliberate v1 tradeoff, called out clearly in `install-skill` review.
3. **Thread-level repo paths** are not supported. If a persona serves multiple conversations against different repos, they need separate personas. Revisit if this becomes painful.
4. **Mount substitution is limited to `${skill.dir}`.** Other substitutions (`${HOME}`, `${persona.dataDir}`) are forbidden. Skills that need to mount a specific operator-owned file (e.g., `~/.contentfulrc.json`) must declare an absolute path; the operator approves it individually during `install-skill`. This keeps the mount contract explicit and auditable.

## Success Criteria

- A new Contentful skill can be installed via `talonctl install-skill`, declare its sandbox profile, and the agent can create and apply migrations through `contentful_exec`, all without running anything on the bare host.
- An existing superpowers skill (e.g., `using-git-worktrees`) can be installed with just a `sandbox:` block added to its frontmatter and works end-to-end.
- Attempting to exploit a sandbox (read `/etc/shadow`, write outside `/workspace`, escape a mount via symlink, call a binary not in `bins[]`, read the operator's secrets file) fails and is visible in logs.
- Installing a skill with a pre-existing sandbox block surfaces the block for explicit operator review; the install cannot proceed silently.
- `skill.exec` is either disabled or functional — never partially working, never silently degrading to host execution.
- Test coverage at or above 80% for all new modules.
