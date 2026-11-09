# Design surface ownership

Concrete owners of the current design responsibilities. Broad design patterns are families; admission uses the plan's narrower domains. Service type widening belongs to TASK-013; TASK-012 owns provenance only.

| Design surface | Task owners |
| --- | --- |
| `package.json` | TASK-003 |
| `package-lock.json` | TASK-003 |
| `src/images/**` | TASK-001, TASK-003, TASK-004, TASK-005, TASK-010, TASK-011, TASK-015 |
| `src/core/database/migrations/*` | TASK-002, TASK-011 |
| `src/core/database/repositories/*` | TASK-002, TASK-011 |
| `src/core/config/*.ts` | TASK-001, TASK-012 |
| `src/channels/*.ts` | TASK-001, TASK-005, TASK-010 |
| `src/daemon/channel-factory.ts` | TASK-010 |
| `src/channels/connectors/telegram/**` | TASK-006 |
| `src/channels/connectors/whatsapp-business/**` | TASK-008 |
| `src/channels/connectors/whatsapp-baileys/**` | TASK-007 |
| `src/channels/connectors/email/**` | TASK-009 |
| `src/pipeline/*.ts` | TASK-005 |
| `src/queue/queue-manager.ts` | TASK-005 |
| `src/memory/thread-workspace.ts` | TASK-003 |
| `src/daemon/daemon*.ts` | TASK-010 |
| `src/subagents/default/vision/**` | TASK-013 |
| `src/subagents/subagent-types.ts` | TASK-012, TASK-013 |
| `src/subagents/subagent-runner.ts` | TASK-012 |
| `src/subagents/subagent-model-chain.ts` | TASK-012 |
| `src/subagents/model-resolver.ts` | TASK-012 |
| `src/tools/host-tools/*.ts` | TASK-012, TASK-016, TASK-017 |
| `src/tools/tool-filter.ts` | TASK-017 |
| `src/tools/host-tools-bridge.ts` | TASK-017 |
| `src/tools/host-tools-mcp-server.ts` | TASK-017 |
| `src/daemon/agent-runner.ts` | TASK-018 |
| `src/daemon/context-assembler.ts` | TASK-018 |
| `src/daemon/context-roller.ts` | TASK-018 |
| `templates/assistant/system.md` | TASK-020 |
| `templates/tool-instructions/image.read.md` | TASK-017 |
| `templates/tool-instructions/subagent.invoke.md` | TASK-017 |
| `config/talond.example.yaml` | TASK-020 |
| `README.md` | TASK-020 |
| `AGENTS.md` | TASK-020 |
| `CLAUDE.md` | TASK-020 |
| `.agents/skills/*/SKILL.md` | TASK-020 |
| `.claude/skills/*/SKILL.md` | TASK-020 |
| `deploy/Dockerfile` | TASK-021 |
| `.github/workflows/release.yaml` | TASK-021 |
| `tests/unit/deploy/dockerfile.test.ts` | TASK-021 |
| `tests/unit/**` | TASK-001, TASK-002, TASK-003, TASK-004, TASK-005, TASK-006, TASK-007, TASK-008, TASK-009, TASK-010, TASK-011, TASK-012, TASK-013, TASK-014, TASK-015, TASK-016, TASK-017, TASK-018, TASK-019, TASK-021 |
| `tests/integration/e2e/image-processing.test.ts` | TASK-019 |
