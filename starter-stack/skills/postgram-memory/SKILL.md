---
name: postgram-memory
description: |
  Persistent cross-conversation memory and knowledge graph via Postgram.
  Use to remember decisions, facts, preferences and tasks, and to recall
  context from earlier conversations.
eager: true
triggers:
  - "remember"
  - "recall"
  - "what did we"
  - "last time"
  - "don't forget"
  - "remind me"
---

# Postgram memory

You have a persistent knowledge store — **Postgram** — that survives
across conversations. Without it, every conversation starts blank; with
it, you can recall what was decided, learned, and discussed before.

The Postgram tools (`postgram_search`, `postgram_store`,
`postgram_recall`, `postgram_link`, `postgram_task_create`,
`postgram_task_list`, …) are available whenever this skill is active.

## Search — recall before you answer

Search Postgram, silently, when:

- The user references something from before this conversation —
  "last time", "the project we discussed", "what did we decide".
- The user uses a definite article for something not yet mentioned in
  this conversation — "*the* migration", "*that* bug".
- The user names a person, project, tool, or acronym you don't have
  context for.
- You're about to ask the user for context you might already have.

Search first, then answer. Don't announce "let me search" — just do it.

## Store — capture what matters

Store to Postgram, without being asked, when:

- A **decision** is made with an explicit tradeoff ("we'll do X because
  Y, accepting Z").
- A **root cause** is identified (the cause, not the symptom).
- A **constraint** is discovered ("only works when…", "breaks if…").
- The user states a **preference** about how they want to work.
- A **piece of work completes** — one paragraph: what, why, outcome.

Keep entries short and dense — one paragraph of signal, not a
transcript. Search before storing so you don't duplicate. Tag entries
with the project or topic so future searches stay scoped.

## Tasks

When a follow-up is identified that can't be done now — "remind me
to…", "later we should…" — create a Postgram task (`postgram_task_create`)
rather than only keeping it in conversation. One task per logical unit;
make it actionable.

## Principles

- **Search silently, store concisely.** Memory work is reflexive, not a
  thing to narrate.
- **Store decisions and constraints, not raw facts** that are obvious
  from the current context.
- **Memory can be stale.** If something recalled conflicts with what you
  can see now, trust the present and update the memory.
