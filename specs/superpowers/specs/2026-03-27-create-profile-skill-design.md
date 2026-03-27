# Interactive Persona/Profile Creation Skill

**Date:** 2026-03-27
**Status:** Draft
**Related:** PR #101 (background agent profiles), Issue #100
**Reviewed by:** GPT-5.4 (Codex) — findings addressed in this revision

## Problem

Creating a persona in Talon requires manually editing `talond.yaml` and scaffolding files. This is friction for both operators (configuring via terminal) and end users (wanting to spin up a background agent with a specific profile on the fly). PR #101 introduced the `profile` parameter to `background_agent spawn`, but there's no guided way to create the personas that serve as profiles.

## Key Insight

A "background agent profile" is just a persona used differently. The same persona entry can be bound to a channel for conversation, referenced as a `profile` in `background_agent spawn`, or both. There's no need for a separate concept — we just need a better way to create personas interactively.

## Approach: Intent-Driven Creation (Option B)

User describes what the persona should do in natural language. The skill infers sensible defaults (name, model, provider, capabilities, system prompt) from that description, presents a summary, and offers a refinement loop before executing. This plays to the agent's strengths and minimizes back-and-forth in chat channels.

## Deliverables

| Deliverable | Location | Description |
|---|---|---|
| Enhanced `add-persona` CLI | `src/cli/commands/add-persona.ts` | Accept model, provider, capabilities, require-approval, skills, system-prompt-file flags |
| Talon skill | `skills/create-profile/SKILL.md` | Runtime interactive flow driven by the daemon agent |
| Claude Code skill | `.claude/skills/create-profile/SKILL.md` | Operator-side interactive flow in terminal |
| CLI tests | `tests/unit/cli/add-persona.test.ts` | Tests for new flags and behaviour |
| Type updates | `src/cli/commands/add-persona.ts` | Widen `AddPersonaOptions` and `AddPersonaEntry` to include `provider` and new fields |

## Design

### 1. Enhanced `talonctl add-persona`

Current signature:

```
talonctl add-persona --name <name>
```

Proposed signature:

```
talonctl add-persona --name <name> \
  --model claude-opus-4-6 \
  --provider claude-code \
  --capabilities "fs.read:*,memory.access:*" \
  --require-approval "channel.send:*" \
  --skills "skill1,skill2" \
  --system-prompt-file /path/to/prompt.md
```

All new flags are optional. Defaults remain unchanged:
- `model`: `claude-sonnet-4-6`
- `provider`: omitted (inherits daemon default)
- `capabilities`: empty (default-deny)
- `require-approval`: empty
- `skills`: empty
- `system-prompt-file`: omitted (scaffolds template file as today)

Behaviour:
- When `--model` is provided, sets the `model` field in the YAML entry.
- When `--provider` is provided, sets the `provider` field in the YAML entry. The `AddPersonaEntry` type is widened to include `provider?: string` (currently missing, flagged in review).
- When `--capabilities` is provided (comma-separated), populates `capabilities.allow` in the YAML entry.
- When `--require-approval` is provided (comma-separated), populates `capabilities.requireApproval` in the YAML entry.
- When `--skills` is provided (comma-separated), populates the `skills` array in the YAML entry.
- When `--system-prompt-file` is provided, copies that file's content to `personas/{name}/system.md` instead of the default template. This avoids the quoting/arg-length issues of passing prompt content as a CLI argument.
- Personality folder and prompts folder are scaffolded only when the system prompt file is newly created (preserving existing `wx` behaviour — no change from current semantics).

The `addPersona()` function signature changes to accept these new optional fields in `AddPersonaOptions`. The `AddPersonaEntry` return type is widened to include `provider?: string`. The CLI wrapper adds the corresponding Commander.js options.

### 2. Talon Skill (Runtime, In-Chat)

**Location:** `skills/create-profile/SKILL.md`
**Format:** Single SKILL.md with YAML frontmatter (preferred format)

**Trigger phrases:** "create a profile", "add a persona", "new background agent", "set up an agent for code review", "create a persona"

**Prerequisites:** The agent running this skill needs provider-native shell/exec access to run `talonctl` commands. In the current architecture, background agents and Claude Code provider both run with `--dangerously-skip-permissions`, which grants this access. The skill documents this dependency and flags that it operates outside Talon's capability gating model.

> **Architectural note:** This shell-based approach intentionally bypasses Talon's host-tool capability gating. This is acceptable as a v1 because persona creation is an operator-level action (the user must already have a persona with shell access). Future versions should migrate to a `persona_manage` host tool with proper capability gates (e.g. `persona.manage:create`). See "Future Work" section.

**Flow:**

1. **Gather intent** — Ask: "What should this persona do?" Accept a natural language description.

2. **Infer defaults** from the description:
   - **Name**: Slugified from purpose (e.g. "code review" -> `code-reviewer`, "PR security audit" -> `security-auditor`)
   - **Model tier**: Inferred as an abstract tier (strong/balanced/fast), then mapped to a concrete model name based on the selected provider (see Inference Heuristics below). This avoids cross-provider model mismatches.
   - **Provider**: Inherit from the calling persona's provider
   - **Capabilities** (split into `allow` and `requireApproval`):
     - Read-only capabilities -> `allow` (e.g. `fs.read:*`, `memory.access:*`)
     - Write/send capabilities -> `requireApproval` by default (e.g. `fs.write:workspace`, `channel.send:*`)
     - User can promote `requireApproval` items to `allow` during refinement
   - **System prompt**: Generated based on the described purpose, written to a temp file, passed via `--system-prompt-file`

3. **Present summary** — Show all fields in a readable format:
   ```
   Name:            code-reviewer
   Model:           claude-opus-4-6
   Provider:        claude-code
   Allow:           fs.read:*
   Require approval: (none)
   Skills:          (none)
   System prompt:   (preview first 3 lines)
   ```

4. **Refinement loop** — User can request changes:
   - "change model to the fast one" / "use haiku" / "use the cheapest model"
   - "add fs.write capability"
   - "move channel.send to allow"
   - "rename to pr-checker"
   - "add the code-analysis skill"
   - "show me the full system prompt"
   - "looks good" / "create it" -> proceed to step 5

5. **Execute**:
   - Write the generated system prompt to a temp file
   - Run `talonctl add-persona --name X --model Y --provider Z --capabilities "..." --require-approval "..." --skills "..." --system-prompt-file /tmp/prompt.md`
   - Run `talonctl reload`
   - Confirm success with usage hints:
     - "Use as a background agent: `background_agent spawn profile=\"X\" prompt=\"...\"`"
     - "Or bind to a channel: ask your operator to run `talonctl bind`"

### 3. Claude Code Skill (Operator Setup)

**Location:** `.claude/skills/create-profile/SKILL.md`
**Trigger phrases:** "create a persona", "add a profile", "new persona", "add background agent profile"

Same intent-driven flow as the Talon skill (gather intent, infer defaults, present summary, refinement loop, execute `talonctl` commands).

Differences from the Talon skill:
- Operator can preview and edit generated files (`personas/{name}/system.md`, personality files) before running `talonctl reload`
- Skill suggests running the `create-personality` skill afterward for richer personality files
- Skill suggests binding to a channel with `talonctl bind` if the operator wants the persona for chat

### 4. Inference Heuristics

The skill's value comes from making good default choices.

#### Model selection (provider-aware)

The skill infers an abstract **tier** from the user's intent, then maps to a concrete model name based on the provider. This prevents cross-provider model mismatches (e.g. `claude-opus-4-6` on `gemini-cli`).

| Purpose keywords | Tier | Claude model | Gemini model |
|---|---|---|---|
| review, audit, analyze, plan, architect | strong | `claude-opus-4-6` | `gemini-2.5-pro` |
| summarize, draft, write, general, assist | balanced | `claude-sonnet-4-6` | `gemini-2.5-flash` |
| classify, tag, triage, quick, simple | fast | `claude-haiku-4-5` | `gemini-2.5-flash` |

If additional providers are added in the future, the skill should be updated with their model mappings. The refinement loop also accepts explicit model names for power users.

#### Capability inference

Uses actual Talon capability labels from the host tool registry and provider-native capability labels from config.

**Host tool capabilities** (exact labels from `tool-filter.ts`):

| Purpose keywords | `allow` | `requireApproval` |
|---|---|---|
| memory, remember, context, knowledge | `memory.access:*` | — |
| message, notify, send, communicate | — | `channel.send:*` (narrowed if channel specified) |
| search, fetch, http, api | `net.http` | — |
| spawn, delegate, orchestrate | `subagent.background` | — |
| schedule, cron, recurring | — | `schedule.manage` |
| query, database, sql | — | `db.query` |

**Provider-native capabilities** (used in persona config, not gated by host tools):

| Purpose keywords | `allow` | `requireApproval` |
|---|---|---|
| code, review, file, read, analyze source | `fs.read:*` | — |
| write, edit, fix, refactor, implement | `fs.read:*` | `fs.write:workspace` |

Write/send capabilities default to `requireApproval`. Users can promote them to `allow` during the refinement loop.

These are starting points — the refinement loop lets users adjust.

## Future Work

- **`persona_manage` host tool** — The shell-based approach should migrate to a proper host tool (`persona_manage` with actions `create`, `list`, `update`, `delete`) gated by a `persona.manage` capability. This removes the dependency on provider-native shell access and brings persona management into Talon's capability model. The current shell approach is flagged in the skill source with a `// TODO: migrate to persona_manage host tool` comment.
- **Persona editing and deletion** — Out of scope for v1, but natural extensions once the host tool exists.
- **Capability auto-discovery** — The skill could introspect available capabilities at runtime instead of using hardcoded heuristics.
- **Channel binding automation** — The skill suggests binding but doesn't automate it.

## Not in Scope

- **Changes to `background_agent spawn`** — PR #101 handles that.
- **New host tool for persona management** — Deferred to future work (see above).
- **Persona deletion or editing** — Separate concern.

## Testing

- **`add-persona` CLI tests**: Verify new flags (model, provider, capabilities, require-approval, skills, system-prompt-file) are written correctly to config and filesystem. Verify backward compatibility: calling with only `--name` produces identical output to current behaviour.
- **Talon skill**: Manual testing via terminal channel — run through the full flow, verify persona appears in config, verify `talonctl reload` picks it up, verify `background_agent spawn profile="X"` works.
- **Claude Code skill**: Manual testing in Claude Code terminal.

## Review Log

| Date | Reviewer | Findings | Resolution |
|---|---|---|---|
| 2026-03-27 | GPT-5.4 (Codex, high) | Shell exec bypasses capability model | Documented as architectural note, flagged for future host tool migration |
| 2026-03-27 | GPT-5.4 (Codex, high) | Model heuristics are Claude-specific | Changed to abstract tier system with per-provider model mapping |
| 2026-03-27 | GPT-5.4 (Codex, high) | Capability labels don't match actual registry | Rewrote heuristics using actual labels from `tool-filter.ts` and config |
| 2026-03-27 | GPT-5.4 (Codex, medium) | Missing `requireApproval` support | Added `--require-approval` flag; write/send capabilities default to requireApproval |
| 2026-03-27 | GPT-5.4 (Codex, medium) | Multiline system prompt via CLI arg is brittle | Changed to `--system-prompt-file` flag (reads from file path) |
| 2026-03-27 | GPT-5.4 (Codex, medium) | "Still scaffolded regardless" ambiguous | Clarified: scaffolding only on new persona (preserves existing `wx` behaviour) |
| 2026-03-27 | GPT-5.4 (Codex, low) | `AddPersonaEntry` missing `provider` field | Added to deliverables: widen type to include `provider?: string` |
