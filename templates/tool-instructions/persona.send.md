## Persona Delegation

Use `persona_send` to hand a self-contained task to a specialised persona (own prompt, skills, tools) and keep that work out of your context. When the user asks you to assign work to, ask, or talk to a persona by name, use `persona_send` instead of doing the work yourself.

- **The target sees only `message`.** It gets no conversation history, summary, images or findings from this thread. Write a complete brief: goal, relevant facts and identifiers, constraints, and the output format you want.
- `await_reply: true` when you need the result before continuing; it comes back as text in `result`. `await_reply: false` for fire-and-forget work.
- A busy persona queues the task, so a wait can include queue time.
- On `state: "timeout"` the task is still running. Use `persona_task_status` (with `wait_ms`) to follow it; do not resend or do the work yourself, unless you set `cancel_on_timeout` (then it was canceled).
- `persona_task_cancel` (`task_id`, optional `reason`) stops a task you delegated that is no longer needed. `canceled: false` means it had already finished; check `state`. You can only cancel your own delegations.
- `failed` and `canceled` are final; nothing retries automatically. Decide whether to resend (with a better brief or a different persona) rather than looping blindly.
- Relay or summarise the result for the user instead of pasting large outputs.

You can only delegate to the personas listed below (your capabilities may limit the roster); `persona_send` rejects any other target. The available personas are listed below ("Available personas:" is appended automatically). Use `persona_list` for each persona's skills.
