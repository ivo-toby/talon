---
name: create-profile
description: |
  Create a Talon persona/profile interactively from a natural-language
  description. Use when the user says "create a profile", "add a persona",
  "new background agent", "create a persona", "add a profile", or
  "background agent profile".
triggers:
  - "create a profile"
  - "add a persona"
  - "new background agent"
  - "create a persona"
  - "add a profile"
  - "background agent profile"
---

# Create Profile

Guide the user through creating a Talon persona/profile interactively. This is
a conversational wizard. Ask one question at a time, infer sensible defaults,
show the draft, refine it, then scaffold it.

## Core principles

- **One question at a time.** Keep the interaction tight.
- **Use `talonctl add-persona`.** Do not edit `talond.yaml` directly.
- **Confirm before mutating files.** Show the inferred summary first.
- **Write/send defaults are gated.** Put write/send capabilities in
  `requireApproval` unless the user explicitly wants broader access.
- **Lifecycle behavior changes are governed.** If the persona should learn from
  behavior feedback, mention lifecycle subscriptions as an advanced config step;
  do not instruct model-backed agents to rewrite prompt files directly.
- **Preview before reload.** The operator can inspect and edit generated files
  before running `talonctl reload`.

> Architectural note: this workflow relies on shell execution of `talonctl`,
> which bypasses Talon's host-tool capability model. Treat it as an operator
> action.

<!-- TODO: this should migrate to a persona_manage host tool in the future -->

## Phase 1: Gather intent

Ask: **"What should this persona do?"**

If needed, follow up one question at a time to learn:

- Main purpose
- Whether it needs file read/write, messaging, HTTP/API access, memory,
  subagent delegation, scheduling, or database access
- Whether it should participate in lifecycle behavior review/prompt promotion
  after setup
- Whether quality or speed/cost matters more

## Phase 2: Infer defaults

Build a first draft from the user's description.

### Name

Slugify the purpose into a short persona name.

Examples:

- `code review` -> `code-reviewer`
- `PR security audit` -> `security-auditor`

### Provider and model

- Default provider: inherit from the current operator context if one is
  already implied; otherwise ask.
- Infer a tier first, then map it to a provider-specific model.
- If unclear, default to `balanced`.

| Tier | Use when intent suggests | Claude provider | Gemini provider |
|---|---|---|---|
| `strong` | review, audit, analyze, plan, architect | `claude-opus-4-6` | `gemini-2.5-pro` |
| `balanced` | summarize, draft, write, general assistance | `claude-sonnet-4-6` | `gemini-2.5-flash` |
| `fast` | classify, tag, triage, quick, simple | `claude-haiku-4-5` | `gemini-2.5-flash` |

**`backgroundProvider`** *(optional)* — provider used when this persona spawns a background agent. Resolution order: explicit tool arg → `backgroundProvider` → persona's foreground `provider` (only if it is also enabled under `backgroundAgent.providers`) → `backgroundAgent.defaultProvider`. Set when the foreground provider is unsuitable for background work (e.g. local Ollama running short-context models). Must be enabled under `backgroundAgent.providers` — the daemon refuses to start otherwise.

**`backgroundModel`** *(optional)* — model passed to the background provider. Paired with `backgroundProvider`; the daemon refuses to start if `backgroundModel` is set without `backgroundProvider`. Useful for sending background work to a more capable model than the foreground.

### Capabilities

Use these exact labels.

**Host tools**

| Intent hints | `allow` | `requireApproval` |
|---|---|---|
| memory, remember, context, knowledge | `memory.access:*` | |
| message, notify, send, communicate | | `channel.send:*` |
| search, fetch, http, api | `net.http` | |
| queue async work, background jobs | `subagent.background` | |
| ask another agent inline, specialist consultation | `subagent.invoke` | |
| schedule, cron, recurring tasks | | `schedule.manage` |
| query, database, SQL | | `db.query` |

**Provider-native**

| Intent hints | `allow` | `requireApproval` |
|---|---|---|
| code, review, file, read, analyze source | `fs.read:*` | |
| write, edit, fix, refactor, implement | `fs.read:*` | `fs.write:workspace` |

Rules:

- Write/send capabilities default to `requireApproval`.
- Users can later promote items to `allow`.
- If no capability is clearly needed, leave the lists empty.
- Note: `requireApproval` currently records configuration intent only. Runtime
  approval enforcement is not yet implemented — tools listed there are still
  accessible. Mention this when presenting the summary.

### Skills

Default to no skills unless the user explicitly asks for one.

### Lifecycle behavior review

If the user wants the persona to learn preferences over time, explain that this
is not part of `talonctl add-persona` yet. It requires explicit
`personas[].lifecycle.subscriptions` to the configured behavior handlers, then
operator review through:

```bash
npx talonctl lifecycle candidates <persona> --limit 25
npx talonctl lifecycle promote <persona> <promotion-id> --approved-by <operator-id>
npx talonctl lifecycle rollback-promotion <persona> <activation-id> --reason operator-rejected
```

Summarize this as a follow-up config step instead of editing the lifecycle YAML
implicitly during profile creation.

### Description

Generate a 1-2 sentence description of the persona's purpose and strengths.
This is written as YAML frontmatter in `system.md` and exposed via the
`background_agent profiles` action so that agents can discover available
profiles at runtime.

Good descriptions are specific enough to differentiate profiles:

- "Senior code reviewer — focused security and performance analysis with PR review expertise"
- "Deep web research — multi-source search, cross-referencing, synthesized answers with citations"
- "Personal butler — formal, anticipatory, handles daily tasks with understated charm"

### System prompt

The system prompt file (`system.md`) uses YAML frontmatter for metadata:

```markdown
---
description: "<the description from above>"
---

# <name> — System Prompt

<prompt body>
```

Generate a concise prompt body covering:

- Role and goals
- Working style
- Boundaries
- Any important constraints implied by the capability choices

## Phase 3: Present summary

Show a readable summary before doing anything:

```text
Name:             code-reviewer
Description:      Senior code reviewer — focused security and performance analysis
Provider:         claude-code
Model:            claude-opus-4-6
Allow:            fs.read:*, memory.access:*
Require approval: channel.send:*, fs.write:workspace
Skills:           (none)
System prompt:    [preview first 3 lines]
```

Then ask what should change, or whether to create it.

## Phase 4: Refinement loop

Handle edits such as:

- "rename it to pr-checker"
- "use the fast one"
- "switch to gemini"
- "add fs.write"
- "move channel.send to allow"
- "show me the full system prompt"
- "create it"

After each change, re-show the summary and wait for approval.

## Phase 5: Create and preview

After approval:

1. Write the generated prompt to a temporary file.
2. Run:

```bash
talonctl add-persona --name <name> \
  --description "<description>" \
  --model <model> \
  --provider <provider> \
  --capabilities "<comma-separated allow>" \
  --require-approval "<comma-separated requireApproval>" \
  --skills "<comma-separated skills>" \
  --system-prompt-file /tmp/<name>-system.md
```

3. Show the generated `personas/<name>/system.md`.
4. Offer to edit `personas/<name>/system.md` before reload.
5. If the user wants richer tone/personality files, suggest running the
   `create-personality` skill next and add those files before reload.
6. When the user confirms the generated files look right, run:

```bash
talonctl reload
```

If `talonctl` is not on PATH, use the repo-local equivalent the environment
already uses.

## After creation

Give short next-step suggestions:

- Use it as a background profile:
  `background_agent spawn profile="<name>" prompt="..."`
- Bind it to a chat channel if desired:
  `talonctl bind --persona <name> --channel <channel>`
- For richer voice/tone files, run the `create-personality` skill
