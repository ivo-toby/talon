# Image processing design feedback: round 1

Source: feedback supplied by Ivo on 2026-10-14. This records revisions to the
design draft, not design approval or an independent model review.

| Feedback | Resolution |
| --- | --- |
| 1: Full replay on resumed Codex queries grows session history | Current-message descriptors enter live content; full inventory/Findings remain fresh-session/rotation-only. Current message/thread scope, expiry refresh, shared budgets and retry limits are explicit. Resumed older-data access uses image_lookup; proposed ADR-0002 records the trade-off |
| 2: Skill documentation exists in two trees | Add .claude/skills/*/SKILL.md and CLAUDE.md alongside their Codex counterparts. New image guidance must agree in both copies; preserve existing agent-specific content |
| 3: Connector checks conflict with Admission | Rename Attachment transport responsibility to connector authorization/trigger checks; Admission keeps the glossary's durable pipeline meaning |
| Telegram rendition selection | Largest pixel area within configured bytes and Bot API cap; unknown-size overflow may try smaller renditions within the shared deadline. One Image; no fitting rendition yields size_limit |
| Vision input instructions missing | Add templates/tool-instructions/subagent.invoke.md as an owned surface for {imageIds, question} and saved-Finding lookup guidance |
| Temporary source citations | Clearly identify primary URLs and source-manifest.json version/integrity pins as the lasting references; cache paths record where source was read and can be regenerated |
| Business media response unread | Record an exact mandatory first step for the future task brief: verify configured-version request/response/download contracts before implementing the mapper; never substitute the historical v13 example |
| Sharp target-platform binaries | Source declares glibc/musl x64/arm64 optional binaries. Actual release targets are glibc amd64/arm64; require a native production-stage load/JPEG normalization check for each. Future musl support requires its own check |
| Enqueue success logged before commit | Transactional enqueue defers the success log until outer commit. Rollback has no success log; ordinary autocommit enqueue keeps existing behavior |

Code/source checks: codex-cli-provider.ts:328–329, agent-runner.ts:552 and
1101–1111, queue-manager.ts:132–134, deploy/Dockerfile:12–32 and
.github/workflows/release.yaml:44–49. Affected skill paths exist in both trees
as distinct files; several already differ, so whole-file equality is not a new
requirement. Sharp 0.34.5 package.json:146–170 was read from the pinned source cache.

The spec's routing decision and ADR-0001 are unchanged. Design remains a draft.
