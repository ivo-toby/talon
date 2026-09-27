# Postgram search-to-recall correctness (issue #283)

## Intent and evidence

Prevent Talon's bundled Postgram-enabled assistant from reporting a stale matched fragment as the current state of a decision, policy, task, or verification. The expected answer is based on the relevant complete entity, or explicitly says that the state cannot be confirmed.

- [Issue #283](https://github.com/ivo-toby/talon/issues/283) reports an agent answering from an older “not done” search fragment although the same document later said “completed.” This is a reported incident, not a locally reproduced agent run.
- `starter-stack/skills/postgram-memory/SKILL.md` currently says “Search first, then answer.” Its stale-memory warning only handles conflicts with information already visible to the agent; it never says that a search hit is partial or requires `postgram_recall` before a factual status answer.
- Postgram's [`postgram_search` tool description](https://github.com/ivo-toby/postgram) says compact results contain matched chunks, not complete entity content, and directs callers to recall a selected result by ID. [Postgram's own skill](https://github.com/ivo-toby/postgram/blob/main/skill/postgram/SKILL.md) documents search as discovery followed by selective recall, not `full_response` for ordinary reading.
- The starter persona lists `postgram-memory` in `starter-stack/config/talond.example.yaml`. `SkillLoader.loadFromSkillMd` puts its Markdown body in `promptContents`; `buildPersonaRuntimeContext` merges `eager: true` skills into the persona prompt; `AgentRunner` supplies that prompt and the skill's Postgram MCP server to the provider. No Talon code transforms Postgram search chunks into full entities. The failure boundary is the agent's search-result interpretation under the current instructions.

## Scope

Change the bundled _agent-facing instructions_ in `starter-stack/skills/postgram-memory/SKILL.md`, keeping the skill eager and its current search/store/task triggers. Update the relevant explanation in `starter-stack/README.md` and the main `README.md` skill guidance so the documented behavior matches. Do not change Postgram's search implementation, Talon's generic skill loader, MCP wiring, persona config, storage schema, or other skills.

## Required behavior

1. **Search is discovery.** Treat a `postgram_search` hit as a matched chunk with an entity ID, not as the entity's complete or necessarily current content. Keep the existing triggers to search silently for prior context.
2. **Recall before factual conclusions.** When the answer depends on stored knowledge about status, policy, completion, verification, or a decision's current outcome, call `postgram_recall` with the selected hit's ID and read the full entity before stating that conclusion. The same applies when a search chunk appears to answer the question outright. For lightweight discovery that does not claim a concrete factual state, do not require recall of every hit.
3. **Resolve conflicts using full sources.** If multiple plausible entities disagree, recall the relevant candidates, compare their actual content and available dates/context, and prefer the most recent _applicable evidence_, not merely the highest-ranked search hit. A later conclusion within one recalled entity supersedes an earlier provisional statement in that entity. Do not assume a newer timestamp alone makes unrelated or less authoritative material decisive.
4. **Fail honestly.** If recall fails, the entity is missing, or the recalled sources do not establish the requested state, say it cannot be confirmed from Postgram; do not infer an answer from the matched chunk. Current primary evidence supplied in the conversation can be considered alongside memory, with conflicts disclosed rather than silently overwritten.
5. **Stay selective.** Recall only IDs needed for the answer. Do not use `full_response: true` as a routine shortcut or retrieve every search result. Preserve the existing silent-search, concise-storage, and task guidance.

Suggested wording for the skill's search section (adapt to its existing style):

> Search results are discovery hints: compact hits contain matched chunks, not the complete entity. Before answering a concrete question about current status, policy, completion, verification, or a decision, call `postgram_recall` for the relevant hit ID and read the full source. If plausible hits disagree, recall the relevant candidates and use the newest applicable evidence, including later conclusions within a source. If recall fails or the full sources do not establish the answer, say that it cannot be confirmed; never turn a fragment into a confident current-state claim.

## Acceptance and verification for implementation

- A focused contract test loads the real bundled `SKILL.md` through `SkillLoader` and `buildPersonaRuntimeContext`, asserts that its body is present eagerly, and checks that it explicitly requires search-to-recall for factual status answers and the unconfirmed-answer fallback. This checks delivery of the instructions, **not** model compliance.
- A behavioral regression scenario supplies one entity whose search hit matches an earlier “verification not done” passage while `postgram_recall(id)` returns the full entity with a later “verification completed” conclusion. The observed tool trace must show recall of that ID **before** a final answer saying completed; the agent must not answer “not done” from the chunk alone. Also exercise conflicting plausible IDs and a failed/indeterminate recall: inspect relevant full entities before choosing the applicable conclusion, or answer that it cannot be confirmed. Run this as a controlled provider evaluation/manual smoke check if the repository has no deterministic agent-tool harness; do not mislabel text assertions as a behavioral regression test.
- Run the relevant lint/static checks, targeted skill-loading tests, and build. Check the release bundle still includes the updated skill and that the README descriptions match. No full-suite test or live daemon is required merely to validate a prompt edit.

## Limits

A prompt-only fix improves the agent's instruction contract but cannot guarantee every provider follows it. If the controlled behavior check still skips recall, collect the tool trace and consider enforcement separately; do not silently broaden this issue into a generic MCP interception or search API change. Adding or changing tests requires Ivo's approval under repository instructions before implementation.
