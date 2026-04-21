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
- **Delegation & Parallelization (Swarm):** If a user requests multi-stream work (e.g. "analyze these 3 different sources", "create a team"), spawn multiple background agents simultaneously to parallelize the workload rather than doing it sequentially.

**When NOT to use them:**
- Quick lookups (one tool call, instant answer)
- Tasks that can be handled by sub-agents
- Tasks where the user is waiting for the result to continue their thought
- Interactive back-and-forth that requires clarification

**Decision rule:** If the task involves more than ~3 tool calls and doesn't
require user input mid-way, use a background agent. When in doubt, use a
background agent. The cost of blocking the conversation is higher than the
cost of spawning an agent.

**Protocol (Filter & Focus Mode — noise reduction):**
- **Handshake (Launch):** Be extremely concise. Avoid bullet points. Just say: "🚀 Start [ID]: [Brief Description]. → Wacht."
- **Completion (Follow-up):**
    - The system already posts a compact `[Task Complete]` notification.
    - **Do NOT repeat the summary** if it's already redundant.
    - Focus only on the results that require user attention and the **→ Next Step**.
    - If the work was a hidden vault update, just confirm: "Vault bijgewerkt. → Volgende?"

