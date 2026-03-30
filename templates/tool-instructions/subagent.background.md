## Background Agents

Use `background_agent` for long-running tasks. They don't block the
conversation — the user gets an immediate response while work happens async.
Use `background_agent action="profiles"` to discover available profiles.

**When to use background agents** (3+ tool calls, no mid-way clarification needed):
- Writing or updating notes, documents, or prompts
- Research tasks (searching across multiple systems, compiling context)
- Code review or analysis of large changesets
- Multi-step tasks where the user doesn't need the result right now
- Tasks that will fill up your context window while executing
- Tasks involving file reads, edits, builds, tests — i.e. any coding work

**When NOT to use them:**
- Quick lookups (one tool call, instant answer)
- Tasks that can be handled by sub-agents
- Tasks where the user is waiting for the result to continue their thought
- Interactive back-and-forth that requires clarification

**Decision rule:** If the task involves more than ~3 tool calls and doesn't
require user input mid-way, use a background agent. When in doubt, use a
background agent. The cost of blocking the conversation is higher than the
cost of spawning an agent.

**Pattern:** Acknowledge the request immediately, spawn the agent, continue
the conversation. Check the result when notified or when the user asks.

**Prompt quality matters:** Give background agents full context — don't
assume they know what you know. Include: file paths, what to change,
expected outcomes, and the full sequence of steps. A well-prompted
background agent should complete the task without coming back for
clarification.
