---
name: optimize-personas
description: |
  Audit the personas of a running Talon setup and move prompt content to the
  cheapest place that still works: personality file, skill, separate persona,
  or sub-agent. Use when the user says "optimize personas", "persona audit",
  "split my assistant", "offload personality files", "slim down the system
  prompt", or after a model change.
triggers:
  - "optimize personas"
  - "persona audit"
  - "split my assistant"
  - "offload personality"
  - "slim down the system prompt"
---

# Optimize personas

This skill reviews what each persona carries in its prompt and proposes a
better place for each part. The user approves each move before you change a
file.

Do not run this skill during a first setup. The audit needs real usage. If the
setup has one persona and fewer than about 50 runs, say so and stop.

## Core principles

- **Propose first.** Change nothing before the user approves the row.
- **Move, never delete.** Keep the old file with a `.bak` extension.
- **Use talonctl commands.** Do not edit `talond.yaml` directly.
- **One question at a time.**
- **The cheapest place wins.** A separate persona costs a handoff and a model
  call. Use one only if the reasons in the placement rule apply.

## How Talon loads prompt content

These facts decide what each move saves.

- `personas/<name>/system.md` and each `.md` file in
  `personas/<name>/personality/` go into the system prompt on each run.
- A skill adds only its name and description to the prompt. The agent loads
  the body with `skill_load` at the moment of need. A skill with `eager: true`
  is always in the prompt.
- A background agent gets all skill bodies at spawn. If the call has no
  `profile`, the background agent also gets the full prompt of the persona
  that owns the thread.
- A persona that receives a `persona_send` task sees only the `message`. It
  gets no history, summary, images, or findings from the thread of the caller.
- A sub-agent is one model call with structured input and output. It has no
  tool loop.

## Placement rule

| Content | Place |
|---|---|
| Identity, tone, user preferences, privacy and safety rules | Personality file of the persona |
| Knowledge or a procedure that only some tasks need | Skill of the same persona |
| Work that needs a different model, different capabilities or mounts, or that runs in parallel or in the background | Separate persona |
| One step with fixed input and fixed output | Sub-agent |
| Content that no task used, or that repeats another file | Remove |

Apply the rule from top to bottom and stop at the first row that fits.

Keep a rule in the personality file if the agent must follow it without a
decision to load it. Privacy rules are the main example. If a separate persona
touches the same data, repeat those rules in that persona.

## Phase 1: Inventory

1. Run `npx talonctl list-personas`, `npx talonctl list-skills`, and
   `npx talonctl config-show`.
2. For each persona, record the model, the provider, the skills, the
   sub-agents, and the capabilities.
3. Measure the size of each always-loaded file:

```bash
wc -c personas/*/system.md personas/*/personality/*.md
```

4. List the skills with `eager: true`. Those count as always-loaded too.

Show the user one table per persona: file, size in characters, and a one-line
summary of the content.

## Phase 2: Evidence

Read the usage from the database. The path comes from `storage.path` in
`talond.yaml` (default `data/talond.sqlite`). Open it read-only.

The tables `background_tasks` and `a2a_tasks` and the column `runs.model_name`
come from later migrations. If a query fails with `no such table` or
`no such column`, the database is behind on migrations. Tell the user to run
`npx talonctl migrate`, and continue without that evidence.

Runs and input tokens per persona, last 30 days:

```bash
sqlite3 -readonly data/talond.sqlite "
SELECT p.name, r.model_name, COUNT(*) AS runs,
       CAST(AVG(r.input_tokens + r.cache_read_tokens + r.cache_write_tokens) AS INT) AS avg_input
FROM runs r JOIN personas p ON p.id = r.persona_id
WHERE r.created_at > (strftime('%s','now') - 30*86400) * 1000
GROUP BY p.name, r.model_name ORDER BY runs DESC;"
```

Delegations between personas:

```bash
sqlite3 -readonly data/talond.sqlite "
SELECT source_persona, target_persona, state, COUNT(*) AS tasks
FROM a2a_tasks GROUP BY 1, 2, 3 ORDER BY tasks DESC;"
```

Background tasks per persona:

```bash
sqlite3 -readonly data/talond.sqlite "
SELECT p.name, b.status, COUNT(*) AS tasks
FROM background_tasks b JOIN personas p ON p.id = b.persona_id
GROUP BY 1, 2 ORDER BY tasks DESC;"
```

Talon does not record `skill_load` calls. For each large personality file and
each skill, ask the user how often the content matters: on most messages,
weekly, or rarely.

Do not print message text, memory items, or task payloads from the database.
The counts are enough.

## Phase 3: Classify

For each personality file, and for each clearly separate section in
`system.md`, pick one place from the placement rule. Split a file if its
sections belong in different places.

Signs that a separate persona is correct:

- The work runs for many tool calls and fills the context of the caller.
- A cheaper or faster model can do the work.
- The work needs capabilities that the main persona must not have.
- The main persona often starts background agents for this kind of work. A
  lean persona as `profile` keeps those agents small.

Signs that a separate persona is wrong:

- The work needs the conversation history to do the job.
- The answer takes one or two tool calls.
- The user waits for the answer and expects the tone of the main persona.

## Phase 4: Proposal

Show one table. The user approves or rejects each row.

```
#  From                                   To                         Saves per run   Cost
1  assistant/personality/04-jira.md       skill jira-workflow        ~2,100 chars    one skill_load per Jira task
2  assistant/personality/06-research.md   persona researcher         ~3,400 chars    one handoff per research task
3  assistant/personality/02-voice.md      stays                      -               -
```

For a new persona, also show its model, its description line, and its
capabilities. For a new skill, show the description line. The agent decides
from that line alone to load the skill, so name the tasks it covers.

Ask: **"Which rows do you approve?"**

## Phase 5: Apply

Do the approved rows one at a time.

**To a skill**

1. Run `npx talonctl add-skill --name <skill> --persona <persona> --format skillmd`.
2. Write the content into the body of the new `SKILL.md`. Rewrite it as
   instructions for the task, and write a description that names the tasks.
3. Rename the personality file from `<file>.md` to `<file>.md.bak`. The loader
   reads only files that end in `.md`.

**To a separate persona**

1. Use the `create-profile` skill to create the persona. Give it the model,
   the description, and the smallest set of capabilities that the work needs.
2. Write the moved content into `system.md` of the new persona. Add what the
   new persona cannot see from a `message`: the output format, the privacy
   rules for the data it touches, and where it finds its sources.
3. Give the calling persona access to the new persona:
   `npx talonctl set-capabilities --persona <caller> --add "persona.send:<new-persona>"`.
4. Leave two or three lines in the calling persona that say when to delegate
   and what a complete brief contains: goal, facts and identifiers,
   constraints, and output format.
5. Rename the old personality file to `<file>.md.bak`.

**To a sub-agent**

Talon has no `talonctl` command that assigns a sub-agent to a persona. Describe
the change and let the user decide. Do not edit `talond.yaml`.

**Remove**

Rename the file to `<file>.md.bak`. Do not delete it.

## Phase 6: Make sure that it works

1. Run `npx talonctl doctor` and `npx talonctl config-show`.
2. Ask the user for permission, then run `npx talonctl reload`.
3. For each changed persona, ask the user to send one message that needs the
   moved content. The persona must load the skill or delegate the task, and
   the answer must still be correct.
4. If a test fails, rename the `.bak` file back to `.md`, reload, and report
   the failure.

## Phase 7: Record

Append a short entry to `personas/OPTIMIZATION-LOG.md`: the date, the model of
each persona, and the approved rows. Talon does not load this file.

A layout fits the model it was made for. A smaller model needs more of its
rules in the always-loaded prompt, and narrower skills. Tell the user to run
this skill again after a model change.

## Rules

1. Never change a file before the user approves the row.
2. Never delete a prompt file. Rename it to `.bak`.
3. Never move identity, user preferences, or privacy and safety rules out of
   the always-loaded prompt.
4. Never print message text or task payloads from the database.
5. Do not start or restart the daemon. `reload` needs permission from the user.
