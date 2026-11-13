# Image processing implementation plan

Status: approved by Ivo with "Approved!" and applied. All 21 tasks are pending;
no implementation worker has started. The corrected design is also approved.

## Delivery order

The wave labels are an ordering guide, not finish-before-start barriers.
Dependencies follow actual available interfaces as clarified by Ivo's review.
Wave (a) is TASK-001–010, (b) TASK-011–014 and (c) TASK-015–019, with packaging
TASK-021 and documentation TASK-020 completing delivery. Component work can
overlap; runtime integration remains explicit at TASK-010, TASK-014 and TASK-019.

## Tasks

| Task | Deliverable | Depends on | Risk | Main conflict domains |
| --- | --- | --- | --- | --- |
| [TASK-001](../tasks/TASK-001.md) | Image configuration and inbound contracts | — | high | `src/images/image-types.ts`, `src/channels/channel-types.ts`, `src/core/config/*.ts` |
| [TASK-002](../tasks/TASK-002.md) | Durable Images and pending Ingestion repositories | 001 | high | `src/core/database/migrations/*`, `src/core/database/repositories/*` |
| [TASK-003](../tasks/TASK-003.md) | Owned image files and JPEG normalization | 001 | high | `package.json`, `package-lock.json`, `src/images/image-store.ts`, `src/images/image-normalizer.ts`, `src/images/image-metadata.ts`, `src/memory/thread-workspace.ts` |
| [TASK-004](../tasks/TASK-004.md) | Shared image selection and bounded media staging | 001, 003 | high | `src/images/image-selection.ts`, `src/images/image-transport.ts` |
| [TASK-005](../tasks/TASK-005.md) | Atomic image Admission and queue completion | 002, 003 | high | `src/pipeline/*.ts`, `src/images/image-ingestion.ts`, `src/queue/queue-manager.ts`, `src/channels/channel-setup.ts` |
| [TASK-006](../tasks/TASK-006.md) | Telegram photo and image-document ingestion | 004 | high | `src/channels/connectors/telegram/**` |
| [TASK-007](../tasks/TASK-007.md) | Baileys streamed image ingestion | 004 | high | `src/channels/connectors/whatsapp-baileys/**` |
| [TASK-008](../tasks/TASK-008.md) | WhatsApp Business verified media ingestion | 004 | high | `src/channels/connectors/whatsapp-business/**`, `.wdd/epics/image-processing/research/whatsapp-business-verified-contract.md` |
| [TASK-009](../tasks/TASK-009.md) | Email image attachments after authorization | 004 | high | `src/channels/connectors/email/**` |
| [TASK-010](../tasks/TASK-010.md) | Ingestion runtime integration and retention recovery | 005, 006, 007, 008, 009 | high | `src/images/image-lifecycle.ts`, `src/images/image-service.ts`, `src/channels/channel-setup.ts`, `src/channels/index.ts`, `src/daemon/channel-factory.ts`, `src/daemon/daemon*.ts` |
| [TASK-011](../tasks/TASK-011.md) | Canonical Finding persistence | 002 | high | `src/images/finding-types.ts`, `src/core/database/migrations/*`, `src/core/database/repositories/*` |
| [TASK-012](../tasks/TASK-012.md) | Vision model-chain validation and trusted run context | 001 | high | `src/subagents/model-resolver.ts`, `src/subagents/subagent-model-chain.ts`, `src/subagents/subagent-types.ts`, `src/subagents/subagent-runner.ts`, `src/subagents/index.ts`, `src/tools/host-tools/subagent-invoke.ts`, `src/core/config/*.ts` |
| [TASK-013](../tasks/TASK-013.md) | One-shot vision Inspection implementation | 003, 011, 012 | high | `src/subagents/default/vision/**`, `src/subagents/subagent-types.ts`, `src/subagents/index.ts` |
| [TASK-014](../tasks/TASK-014.md) | Inspection daemon integration | 010, 011, 012, 013 | high | `src/daemon/daemon-bootstrap.ts`, `src/daemon/daemon-types.ts`, `src/subagents/subagent-loader.ts` |
| [TASK-015](../tasks/TASK-015.md) | Bounded descriptor and Finding projections | 002, 011 | normal | `src/images/image-context-projection.ts` |
| [TASK-016](../tasks/TASK-016.md) | Thread-scoped model-free image_lookup handler | 015 | high | `src/tools/host-tools/image-lookup.ts` |
| [TASK-017](../tasks/TASK-017.md) | Lookup tool exposure and agent instructions | 016 | high | `src/tools/tool-filter.ts`, `src/tools/host-tools-bridge.ts`, `src/tools/host-tools-mcp-server.ts`, `src/tools/host-tools/index.ts`, `templates/tool-instructions/image.read.md`, `templates/tool-instructions/subagent.invoke.md` |
| [TASK-018](../tasks/TASK-018.md) | Live image descriptors and fresh-session context | 015, 017 | high | `src/daemon/agent-runner.ts`, `src/daemon/context-assembler.ts`, `src/daemon/context-roller.ts` |
| [TASK-019](../tasks/TASK-019.md) | Replay and lookup runtime integration and epic proof | 014, 017, 018 | high | `src/daemon/daemon-bootstrap.ts`, `src/daemon/daemon-types.ts` |
| [TASK-020](../tasks/TASK-020.md) | Image feature documentation in both agent trees | 019, 021 | normal | `README.md`, `AGENTS.md`, `CLAUDE.md`, `config/talond.example.yaml`, `templates/assistant/system.md`, `.agents/skills/*/SKILL.md`, `.claude/skills/*/SKILL.md` |
| [TASK-021](../tasks/TASK-021.md) | Sharp native packaging and image tool instructions | 003, 017 | high | `deploy/Dockerfile`, `.github/workflows/release.yaml` |

## Models and gates

Two normal tasks (bounded formatting and docs) inherit GPT-5.6-Luna max. Nineteen high-risk persistence, untrusted input, external contract, permissions and runtime tasks inherit GPT-6.1-sol high. Every task gets GPT-6.1-sol xhigh review. No model substitution is authorized. All briefs name the ratified build, exact focused tests, CLI startup, no-cost daemon/terminal smoke and an independent oracle.

TASK-010, TASK-014 and TASK-019 are runtime integration sinks. TASK-008 starts with current-version Business contract verification; unreadable evidence blocks mapper work. TASK-021 includes the missing Docker templates copy and active regression tests outside skipped legacy deployment groups. Multiarchitecture native checks remain release-tag-only, with the approved after-merge trade-off.

The base is wdd/image-processing, started from feat/image-processing when the plan is approved. Concurrency is three. The final merge into main stays human-owned. Workers use immutable snapshots; only the controller records state. After three blocking review rounds for a task, the controller asks for a human decision rather than automatically dispatching another fix.

ImageAccess is declared by TASK-001; Finding types/persistence by TASK-011. TASK-012 needs config/resolver/provenance only. TASK-013 widens subagent services against available ports and uses fakes until TASK-014 injects the real adapters. Formatter and lookup also consume typed inputs/ports rather than future runtime classes. TASK-018 waits for actual TASK-017 tool exposure.

Both migration briefs explicitly require the next free numeric prefix greater than the existing maximum. The two historical 007 files must not be copied or renumbered. Image/Finding migrations are distinct and sequential.

## Projected admission schedule

| Round | Tasks |
| --- | --- |
| 1 | TASK-001 |
| 2 | TASK-002, TASK-003, TASK-012 |
| 3 | TASK-004, TASK-005, TASK-011 |
| 4 | TASK-006, TASK-007, TASK-008 |
| 5 | TASK-009, TASK-013, TASK-015 |
| 6 | TASK-010, TASK-016 |
| 7 | TASK-014, TASK-017 |
| 8 | TASK-018, TASK-021 |
| 9 | TASK-019 |
| 10 | TASK-020 |

## Validation and disclosed lint findings

Preview projects **10 rounds**, down from 15, with the existing concurrency of
three. All 20 ACs remain mapped; all context references resolve; all 42 current
design surfaces have [concrete owners](plan-surface-ownership.md). Machine and
brief dependencies/domains agree, and new focused-test paths have declared
owners. No Talon implementation tests were run for planning-only changes.

Six advisory warnings remain, intentionally disclosed:

- TASK-012 lists five concrete top-level subagent files; other tasks own vision
  implementation/service widening and loader wiring. Concrete boundaries remain.
- TASK-010 shares daemon wiring with later runtime integration tasks. Conflict
  domains prevent overlapping bootstrap edits without blocking independent code.
- Four broad design families are matched as literal wildcard paths by the current
  linter: src/images/**, src/channels/*.ts, src/tools/host-tools/*.ts and
  tests/unit/**. Concrete owners are in the coverage table; broadening task
  domains merely to satisfy that check would serialize unrelated work.

The Docker-copy correction and revised plan were explicitly approved by Ivo.
The controller refreshed design approval, passed a dry-run apply, then applied
all 21 pending tasks. The earlier design-drift refusal was resolved through
approval, not bypassed. TASK-001 is the first eligible task; implementation is
held until these planning artifacts are committed and pushed as requested.

Evidence: [preview](plan-preview.json), [lint](plan-lint.json),
[successful dry run](plan-dry-run.json), [application](plan-apply.json), [review response](../reviews/plan-feedback-round-1.md).
Models, concurrency, review and verification configuration were not changed.
