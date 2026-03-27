---
name: create-profile
version: 0.1.0
description: "Create a Talon persona/profile interactively from a natural-language description, confirm inferred defaults, then scaffold and reload it."
---

# Create Profile

Create a Talon persona that can be used as a chat persona, a background agent
profile, or both.

## Operating constraints

- Ask one question at a time.
- Do not edit `talond.yaml` directly for this workflow.
- Use `talonctl add-persona` to scaffold the persona, then `talonctl reload`.
- Do not execute until the user explicitly confirms the summary.

> Architectural note: this workflow relies on provider-native shell/exec access
> to run `talonctl`, so it operates outside Talon's host-tool capability model.
> Treat persona creation as an operator-level action and say so clearly if the
> current persona cannot run shell commands.

<!-- TODO: this should migrate to a persona_manage host tool in the future -->

## Phase 1: Gather intent

Ask: **"What should this persona do?"**

Accept a natural-language description. If needed, ask short follow-ups for:

- Primary job
- Whether it needs to read files, write files, send messages, call APIs, use
  memory, query a database, schedule work, or delegate to subagents
- Whether speed/cost or depth/quality matters more

## Phase 2: Infer defaults

Infer a first draft from the description.

### Name

- Slugify the purpose into a short persona name.
- Examples: `code review` -> `code-reviewer`, `PR security audit` ->
  `security-auditor`.

### Provider and model

- Default provider: inherit from the calling persona's provider.
- Infer an abstract tier first, then map it to a provider-specific model.
- If the description is ambiguous, default to the `balanced` tier.

| Tier | Use when intent suggests | Claude provider | Gemini provider |
|---|---|---|---|
| `strong` | review, audit, analyze, plan, architect | `claude-opus-4-6` | `gemini-2.5-pro` |
| `balanced` | summarize, draft, write, general assistance | `claude-sonnet-4-6` | `gemini-2.5-flash` |
| `fast` | classify, tag, triage, quick, simple | `claude-haiku-4-5` | `gemini-2.5-flash` |

### Capabilities

Use these exact capability labels when inferring access.

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

- Write/send capabilities go to `requireApproval` by default.
- Users may later promote items from `requireApproval` to `allow`.
- If no capability is clearly needed, keep both lists empty.
- Note: `requireApproval` currently records configuration intent only. Runtime
  approval enforcement is not yet implemented — tools listed there are still
  accessible. Inform the user of this when presenting the summary.

### Skills

- Default to no skills unless the user explicitly asks for one or the need is
  obvious from the request.

### System prompt

Generate a concise system prompt that covers:

- The persona's job and success criteria
- Preferred working style
- Key boundaries
- Any capability-sensitive constraints

## Phase 3: Present summary

Show the inferred draft in a readable block and ask for confirmation.

```text
Name:             code-reviewer
Provider:         claude-code
Model:            claude-opus-4-6
Allow:            fs.read:*, memory.access:*
Require approval: channel.send:*, fs.write:workspace
Skills:           (none)
System prompt:    [preview first 3 lines]
```

Then ask what to change or whether to create it.

## Phase 4: Refinement loop

Support direct edits such as:

- "rename it to pr-checker"
- "use the fast tier"
- "switch to gemini"
- "add fs.write capability"
- "move channel.send to allow"
- "add memory access"
- "show me the full system prompt"
- "looks good"

Apply the requested changes, re-show the summary, and keep looping until the
user explicitly approves creation.

## Phase 5: Execute

After approval:

1. Write the generated system prompt to a temporary file.
2. Run `talonctl add-persona` with explicit flags for the approved values.
3. Include `--capabilities`, `--require-approval`, and `--skills` only when
   those lists are non-empty.
4. Pass the prompt file with `--system-prompt-file`.
5. Run `talonctl reload`.

Command shape:

```bash
talonctl add-persona --name <name> \
  --model <model> \
  --provider <provider> \
  --capabilities "<comma-separated allow>" \
  --require-approval "<comma-separated requireApproval>" \
  --skills "<comma-separated skills>" \
  --system-prompt-file /tmp/<name>-system.md

talonctl reload
```

If `talonctl` is not on PATH, use the equivalent repo-local invocation the
environment already uses.

## After creation

Confirm success and give short usage hints:

- Background agent: `background_agent spawn profile="<name>" prompt="..."`
- Chat binding: ask an operator to run `talonctl bind --persona <name> --channel <channel>`
- Further customization: add personality files or other persona-specific assets
