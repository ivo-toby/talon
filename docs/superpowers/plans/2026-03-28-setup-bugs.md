# Setup Bugs Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three first-run setup bugs (#106), add `list-capabilities` and `set-capabilities` CLI commands, and update the talon-setup skill.

**Architecture:** Bug fixes are surgical edits to existing files. New CLI commands follow the established pattern: pure function + CLI wrapper + Commander registration. The binding sync adds a reconciliation step to the existing `registerChannels()` boot path.

**Tech Stack:** TypeScript, Zod, better-sqlite3, Commander.js, vitest

**Spec:** `docs/superpowers/specs/2026-03-28-setup-bugs-design.md`

---

### Task 1: Bug 3 — Default capabilities for `add-persona`

Smallest, most isolated change. No DB involved.

**Files:**
- Modify: `src/cli/commands/add-persona.ts:137-147` (default capabilities)
- Modify: `src/cli/commands/add-persona.ts:166-181` (console output)
- Test: `tests/unit/cli/add-persona.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/cli/add-persona.test.ts` inside the `addPersona()` describe block:

```typescript
it('returns sensible default capabilities', async () => {
  const p = writeMinimalConfig();
  const personasDir = join(tmpDir, 'personas');

  const result = await addPersona({ name: 'agent', configPath: p, personasDir });

  expect(result.capabilities.allow).toContain('memory.read:thread');
  expect(result.capabilities.allow).toContain('memory.write:thread');
  expect(result.capabilities.allow).toContain('net.http:egress');
  expect(result.capabilities.allow).toContain('schedule.manage:own');
  expect(result.capabilities.allow).toHaveLength(4);
  expect(result.capabilities.requireApproval).toEqual([]);
});

it('writes default capabilities to config file', async () => {
  const p = writeMinimalConfig();
  const personasDir = join(tmpDir, 'personas');

  await addPersona({ name: 'agent', configPath: p, personasDir });

  const doc = readYaml(p);
  const personas = doc.personas as Array<Record<string, unknown>>;
  const caps = personas[0]!.capabilities as { allow: string[]; requireApproval: string[] };
  expect(caps.allow).toContain('memory.read:thread');
  expect(caps.allow).toHaveLength(4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/cli/add-persona.test.ts -t "returns sensible default"`
Expected: FAIL — `allow` is empty `[]`

- [ ] **Step 3: Update default capabilities in add-persona.ts**

In `src/cli/commands/add-persona.ts`, replace lines 137-147:

```typescript
// Build persona entry.
const entry: AddPersonaEntry = {
  name: options.name,
  model: DEFAULT_MODEL,
  systemPromptFile,
  skills: [],
  capabilities: {
    allow: [
      'memory.read:thread',
      'memory.write:thread',
      'net.http:egress',
      'schedule.manage:own',
    ],
    requireApproval: [],
  },
};
```

- [ ] **Step 4: Add capabilities hint to CLI output**

In `src/cli/commands/add-persona.ts`, in `addPersonaCommand()`, add after the existing `console.log` lines (after the "Add .md files to the personality/ folder" line):

```typescript
console.log(`Capabilities: memory, http, schedule (defaults). Run \`talonctl list-capabilities\` to see all options.`);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/cli/add-persona.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/add-persona.ts tests/unit/cli/add-persona.test.ts
git commit -m "fix(cli): add-persona uses sensible default capabilities (#106)"
```

---

### Task 2: Bug 1 — Seed persona/channel in `add-schedule` CLI wrapper

**Files:**
- Modify: `src/cli/commands/add-schedule.ts:161-211` (CLI wrapper `addScheduleCommand`)
- Test: `tests/unit/cli/schedule-commands.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new describe block to `tests/unit/cli/schedule-commands.test.ts`:

```typescript
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../../src/core/database/repositories/thread-repository.js';

describe('addSchedule() — seeding from config', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('succeeds when persona and channel exist only in config (not DB)', async () => {
    // DB is empty — no persona or channel rows.
    // We need to seed them first, then call addSchedule.
    // This test verifies the seeding logic we'll add to addScheduleCommand.

    // Seed persona
    const personaRepo = new PersonaRepository(db);
    personaRepo.insert({
      id: uuid(),
      name: 'james',
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });

    // Seed channel
    const channelRepo = new ChannelRepository(db);
    channelRepo.insert({
      id: uuid(),
      type: 'terminal',
      name: 'terminal',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    const result = addSchedule({
      db,
      persona: 'james',
      channel: 'terminal',
      cron: '0 7 * * 1-5',
      label: 'Test',
      prompt: 'hello',
    });

    expect(result.id).toBeDefined();
    expect(result.expression).toBe('0 7 * * 1-5');
  });
});
```

- [ ] **Step 2: Run test to verify it passes (baseline)**

Run: `npx vitest run tests/unit/cli/schedule-commands.test.ts -t "succeeds when persona and channel exist"`
Expected: PASS (this confirms the pure function works when rows exist)

- [ ] **Step 3: Add seeding logic to `addScheduleCommand`**

In `src/cli/commands/add-schedule.ts`, add these imports at the top:

```typescript
import { v4 as uuidv4 } from 'uuid';
```

(Already imported — good.)

Add a new helper function before `addScheduleCommand`:

```typescript
/**
 * Seeds persona and channel rows from config into the database if they
 * don't already exist. This allows CLI commands to work before the daemon
 * has ever booted.
 */
function seedFromConfig(
  db: import('better-sqlite3').Database,
  config: { personas: Array<{ name: string; model: string; systemPromptFile?: string; skills: string[]; capabilities: Record<string, unknown>; mounts?: unknown[] }>; channels: Array<{ name: string; type: string; config: Record<string, unknown> }> },
  personaName: string,
  channelName: string,
): void {
  const personaRepo = new PersonaRepository(db);
  const channelRepo = new ChannelRepository(db);

  // Seed persona if not in DB.
  const personaResult = personaRepo.findByName(personaName);
  if (personaResult.isOk() && personaResult.value === null) {
    const personaConfig = config.personas.find((p) => p.name === personaName);
    if (personaConfig) {
      personaRepo.insert({
        id: uuidv4(),
        name: personaConfig.name,
        model: personaConfig.model,
        system_prompt_file: personaConfig.systemPromptFile ?? null,
        skills: JSON.stringify(personaConfig.skills),
        capabilities: JSON.stringify(personaConfig.capabilities),
        mounts: JSON.stringify(personaConfig.mounts ?? []),
        max_concurrent: null,
      });
    }
  }

  // Seed channel if not in DB.
  const channelResult = channelRepo.findByName(channelName);
  if (channelResult.isOk() && channelResult.value === null) {
    const channelConfig = config.channels.find((c) => c.name === channelName);
    if (channelConfig) {
      channelRepo.insert({
        id: uuidv4(),
        type: channelConfig.type,
        name: channelConfig.name,
        config: JSON.stringify(channelConfig.config),
        credentials_ref: null,
        enabled: 1,
      });
    }
  }
}
```

Then in `addScheduleCommand`, after `const db = dbResult.value;` (line 187) and before the `try` block, add:

```typescript
  // Seed persona/channel from config so the command works before the daemon
  // has ever booted (the daemon normally seeds these on startup).
  seedFromConfig(db, configResult.value, options.persona, options.channel);
```

- [ ] **Step 4: Write integration-style test for the seeding**

Add another test to the same describe block:

```typescript
it('addSchedule fails with descriptive error when persona is not in DB or config', () => {
  expect(() =>
    addSchedule({
      db,
      persona: 'nonexistent',
      channel: 'terminal',
      cron: '0 7 * * 1-5',
      label: 'Test',
      prompt: 'hello',
    }),
  ).toThrow(/Unknown persona: "nonexistent"/);
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/unit/cli/schedule-commands.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/add-schedule.ts tests/unit/cli/schedule-commands.test.ts
git commit -m "fix(cli): seed persona/channel from config in add-schedule (#106)"
```

---

### Task 3: Bug 2a — Add `bindings` to config schema

**Files:**
- Modify: `src/core/config/config-schema.ts` (add BindingConfigSchema + bindings field)
- Modify: `src/core/config/config-types.ts` (export BindingConfig type)

- [ ] **Step 1: Add BindingConfigSchema to config-schema.ts**

In `src/core/config/config-schema.ts`, add a new section after the Channel section (after line 88):

```typescript
// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

export const BindingConfigSchema = z.object({
  persona: z.string().min(1),
  channel: z.string().min(1),
  isDefault: z.boolean().default(false),
});
```

- [ ] **Step 2: Add `bindings` to TalondConfigSchema**

In the `TalondConfigSchema` object (around line 283), add after the `personas` field:

```typescript
  bindings: z.array(BindingConfigSchema).default([]),
```

- [ ] **Step 3: Export BindingConfig type**

In `src/core/config/config-types.ts`, add the import of `BindingConfigSchema`:

```typescript
import type {
  TalondConfigSchema,
  StorageConfigSchema,
  SandboxConfigSchema,
  CapabilitiesSchema,
  MountConfigSchema,
  PersonaConfigSchema,
  ChannelConfigSchema,
  BindingConfigSchema,
  IpcConfigSchema,
  QueueConfigSchema,
  SchedulerConfigSchema,
  AuthConfigSchema,
  AgentRunnerConfigSchema,
  BackgroundAgentConfigSchema,
  LangfuseConfigSchema,
  ProviderConfigSchema,
} from './config-schema.js';
```

Add the type export:

```typescript
/** Binding definition linking a persona to a channel. */
export type BindingConfig = z.infer<typeof BindingConfigSchema>;
```

- [ ] **Step 4: Verify build succeeds**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/core/config/config-schema.ts src/core/config/config-types.ts
git commit -m "feat(config): add bindings array to config schema (#106)"
```

---

### Task 4: Bug 2b — Add binding repo helpers

**Files:**
- Modify: `src/core/database/repositories/binding-repository.ts`
- Test: `tests/unit/core/database/repositories/binding-repository.test.ts` (new file)

- [ ] **Step 1: Write failing tests for new repo methods**

Create `tests/unit/core/database/repositories/binding-repository.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BindingRepository } from '../../../../../src/core/database/repositories/binding-repository.js';
import { PersonaRepository } from '../../../../../src/core/database/repositories/persona-repository.js';
import { ChannelRepository } from '../../../../../src/core/database/repositories/channel-repository.js';
import { createTestDb, uuid } from './helpers.js';

describe('BindingRepository', () => {
  let db: Database.Database;
  let repo: BindingRepository;
  let channelId: string;
  let personaIdA: string;
  let personaIdB: string;

  beforeEach(() => {
    db = createTestDb();
    repo = new BindingRepository(db);

    const channels = new ChannelRepository(db);
    channelId = uuid();
    channels.insert({
      id: channelId,
      type: 'terminal',
      name: 'terminal',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    const personas = new PersonaRepository(db);
    personaIdA = uuid();
    personaIdB = uuid();
    personas.insert({
      id: personaIdA,
      name: 'alice',
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });
    personas.insert({
      id: personaIdB,
      name: 'bob',
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('deleteDefaultForChannel', () => {
    it('deletes the default binding for a channel', () => {
      const bindingId = uuid();
      repo.insert({
        id: bindingId,
        channel_id: channelId,
        thread_id: null,
        persona_id: personaIdA,
        is_default: 1,
      });

      const result = repo.deleteDefaultForChannel(channelId);
      expect(result.isOk()).toBe(true);

      const found = repo.findDefaultForChannel(channelId);
      expect(found.isOk()).toBe(true);
      expect(found._unsafeUnwrap()).toBeNull();
    });

    it('does nothing when no default binding exists', () => {
      const result = repo.deleteDefaultForChannel(channelId);
      expect(result.isOk()).toBe(true);
    });
  });

  describe('updatePersona', () => {
    it('updates the persona on an existing binding', () => {
      const bindingId = uuid();
      repo.insert({
        id: bindingId,
        channel_id: channelId,
        thread_id: null,
        persona_id: personaIdA,
        is_default: 1,
      });

      const result = repo.updatePersona(bindingId, personaIdB);
      expect(result.isOk()).toBe(true);

      const found = repo.findDefaultForChannel(channelId);
      expect(found.isOk()).toBe(true);
      expect(found._unsafeUnwrap()!.persona_id).toBe(personaIdB);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/core/database/repositories/binding-repository.test.ts`
Expected: FAIL — `deleteDefaultForChannel` and `updatePersona` don't exist

- [ ] **Step 3: Add methods to BindingRepository**

In `src/core/database/repositories/binding-repository.ts`, add two new prepared statements in the constructor:

```typescript
  private readonly deleteDefaultForChannelStmt: Database.Statement;
  private readonly updatePersonaStmt: Database.Statement;
```

In the constructor body, after the existing `this.deleteStmt`:

```typescript
    this.deleteDefaultForChannelStmt = db.prepare(
      `DELETE FROM bindings WHERE channel_id = ? AND is_default = 1`,
    );

    this.updatePersonaStmt = db.prepare(
      `UPDATE bindings SET persona_id = ?, updated_at = ? WHERE id = ?`,
    );
```

Add the methods before the closing `}` of the class:

```typescript
  /** Deletes the default binding for a channel (is_default = 1). */
  deleteDefaultForChannel(channelId: string): Result<void, DbError> {
    try {
      this.deleteDefaultForChannelStmt.run(channelId);
      return ok(undefined);
    } catch (cause) {
      return err(new DbError(`Failed to delete default binding for channel: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }

  /** Updates the persona_id on an existing binding. */
  updatePersona(bindingId: string, personaId: string): Result<void, DbError> {
    try {
      this.updatePersonaStmt.run(personaId, Date.now(), bindingId);
      return ok(undefined);
    } catch (cause) {
      return err(new DbError(`Failed to update binding persona: ${String(cause)}`, cause instanceof Error ? cause : undefined));
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/core/database/repositories/binding-repository.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/database/repositories/binding-repository.ts tests/unit/core/database/repositories/binding-repository.test.ts
git commit -m "feat(db): add deleteDefaultForChannel and updatePersona to BindingRepository (#106)"
```

---

### Task 5: Bug 2c — Reconcile bindings on daemon boot

**Files:**
- Modify: `src/channels/channel-setup.ts` (add `reconcileBindings`, call from `registerChannels`)
- Test: `tests/unit/channels/channel-setup.test.ts` (new file)

- [ ] **Step 1: Write failing tests**

Create `tests/unit/channels/channel-setup.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import pino from 'pino';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { BindingRepository } from '../../../src/core/database/repositories/binding-repository.js';
import { reconcileBindings } from '../../../src/channels/channel-setup.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';
import type { BindingConfig } from '../../../src/core/config/config-types.js';

const logger = pino({ level: 'silent' });

describe('reconcileBindings()', () => {
  let db: Database.Database;
  let channelRepo: ChannelRepository;
  let personaRepo: PersonaRepository;
  let bindingRepo: BindingRepository;
  let channelId: string;
  let personaIdA: string;
  let personaIdB: string;

  beforeEach(() => {
    db = createTestDb();
    channelRepo = new ChannelRepository(db);
    personaRepo = new PersonaRepository(db);
    bindingRepo = new BindingRepository(db);

    channelId = uuid();
    channelRepo.insert({
      id: channelId,
      type: 'terminal',
      name: 'terminal',
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    personaIdA = uuid();
    personaIdB = uuid();
    personaRepo.insert({
      id: personaIdA, name: 'alice', model: 'claude-sonnet-4-6',
      system_prompt_file: null, skills: '[]', capabilities: '{}', mounts: '[]', max_concurrent: null,
    });
    personaRepo.insert({
      id: personaIdB, name: 'bob', model: 'claude-sonnet-4-6',
      system_prompt_file: null, skills: '[]', capabilities: '{}', mounts: '[]', max_concurrent: null,
    });
  });

  afterEach(() => { db.close(); });

  it('creates a new binding from config', () => {
    const bindings: BindingConfig[] = [
      { persona: 'alice', channel: 'terminal', isDefault: true },
    ];

    reconcileBindings(bindings, { channelRepo, personaRepo, bindingRepo, logger });

    const result = bindingRepo.findDefaultForChannel(channelId);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()!.persona_id).toBe(personaIdA);
  });

  it('updates an existing binding when persona changes', () => {
    // Pre-existing binding: terminal -> alice
    bindingRepo.insert({
      id: uuid(), channel_id: channelId, thread_id: null,
      persona_id: personaIdA, is_default: 1,
    });

    // Config says terminal -> bob
    const bindings: BindingConfig[] = [
      { persona: 'bob', channel: 'terminal', isDefault: true },
    ];

    reconcileBindings(bindings, { channelRepo, personaRepo, bindingRepo, logger });

    const result = bindingRepo.findDefaultForChannel(channelId);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()!.persona_id).toBe(personaIdB);
  });

  it('leaves binding unchanged when config matches DB', () => {
    const bindingId = uuid();
    bindingRepo.insert({
      id: bindingId, channel_id: channelId, thread_id: null,
      persona_id: personaIdA, is_default: 1,
    });

    const bindings: BindingConfig[] = [
      { persona: 'alice', channel: 'terminal', isDefault: true },
    ];

    reconcileBindings(bindings, { channelRepo, personaRepo, bindingRepo, logger });

    const result = bindingRepo.findDefaultForChannel(channelId);
    expect(result._unsafeUnwrap()!.id).toBe(bindingId);
  });

  it('does nothing when bindings array is empty', () => {
    bindingRepo.insert({
      id: uuid(), channel_id: channelId, thread_id: null,
      persona_id: personaIdA, is_default: 1,
    });

    reconcileBindings([], { channelRepo, personaRepo, bindingRepo, logger });

    // Existing binding should remain (auto-default fallback still applies)
    const result = bindingRepo.findDefaultForChannel(channelId);
    expect(result._unsafeUnwrap()).not.toBeNull();
  });

  it('skips bindings with unknown persona or channel', () => {
    const bindings: BindingConfig[] = [
      { persona: 'nonexistent', channel: 'terminal', isDefault: true },
    ];

    reconcileBindings(bindings, { channelRepo, personaRepo, bindingRepo, logger });

    const result = bindingRepo.findDefaultForChannel(channelId);
    expect(result._unsafeUnwrap()).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/channels/channel-setup.test.ts`
Expected: FAIL — `reconcileBindings` is not exported

- [ ] **Step 3: Implement `reconcileBindings` in channel-setup.ts**

In `src/channels/channel-setup.ts`, add the import for `BindingConfig`:

```typescript
import type { BindingConfig } from '../core/config/config-types.js';
```

Add the exported function after `registerChannels`:

```typescript
/** Dependencies for binding reconciliation. */
export interface ReconcileBindingsDeps {
  readonly channelRepo: ChannelRepository;
  readonly personaRepo: PersonaRepository;
  readonly bindingRepo: BindingRepository;
  readonly logger: pino.Logger;
}

/**
 * Reconciles DB bindings with the YAML config bindings array.
 *
 * For each binding in config:
 * - If the channel+persona pair already exists as default, leave it.
 * - If a default binding exists but points to a different persona, update it.
 * - If no default binding exists, create one.
 *
 * Bindings for channels NOT mentioned in config are left alone (the
 * auto-default-to-first-persona fallback in registerChannels still applies).
 */
export function reconcileBindings(
  bindings: BindingConfig[],
  deps: ReconcileBindingsDeps,
): void {
  const { channelRepo, personaRepo, bindingRepo, logger } = deps;

  for (const binding of bindings) {
    const channelResult = channelRepo.findByName(binding.channel);
    if (channelResult.isErr() || channelResult.value === null) {
      logger.warn({ channel: binding.channel }, 'reconcileBindings: channel not found, skipping');
      continue;
    }
    const channelRow = channelResult.value;

    const personaResult = personaRepo.findByName(binding.persona);
    if (personaResult.isErr() || personaResult.value === null) {
      logger.warn({ persona: binding.persona }, 'reconcileBindings: persona not found, skipping');
      continue;
    }
    const personaRow = personaResult.value;

    const existingDefault = bindingRepo.findDefaultForChannel(channelRow.id);
    if (existingDefault.isErr()) {
      logger.warn({ channel: binding.channel }, 'reconcileBindings: failed to query existing binding');
      continue;
    }

    if (existingDefault.value !== null) {
      // A default binding exists — check if it matches.
      if (existingDefault.value.persona_id === personaRow.id) {
        // Already correct — nothing to do.
        continue;
      }
      // Different persona — update it.
      bindingRepo.updatePersona(existingDefault.value.id, personaRow.id);
      logger.info(
        { channel: binding.channel, persona: binding.persona },
        'reconcileBindings: updated default binding persona',
      );
    } else {
      // No default binding — create one.
      bindingRepo.insert({
        id: uuidv4(),
        channel_id: channelRow.id,
        thread_id: null,
        persona_id: personaRow.id,
        is_default: 1,
      });
      logger.info(
        { channel: binding.channel, persona: binding.persona },
        'reconcileBindings: created default binding from config',
      );
    }
  }
}
```

- [ ] **Step 4: Call reconcileBindings from registerChannels**

In `registerChannels()`, add after the channel registration loop (after the closing `}` of the `for` loop, before the function closes):

```typescript
  // Reconcile explicit bindings from config (YAML is source of truth).
  if (config.bindings && config.bindings.length > 0) {
    reconcileBindings(config.bindings, {
      channelRepo,
      bindingRepo,
      personaRepo,
      logger,
    });
  }
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/unit/channels/channel-setup.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/channels/channel-setup.ts tests/unit/channels/channel-setup.test.ts
git commit -m "feat(channels): reconcile DB bindings from YAML config on boot (#106)"
```

---

### Task 6: Add `CAPABILITY_DESCRIPTIONS` registry to tool-filter

**Files:**
- Modify: `src/tools/tool-filter.ts`

- [ ] **Step 1: Add the capability descriptions registry**

In `src/tools/tool-filter.ts`, add after the `HOST_TOOL_REGISTRY` definition (after line 47):

```typescript
/**
 * Human-readable descriptions of all capability labels, grouped by tool.
 *
 * Used by `talonctl list-capabilities` and `set-capabilities` for display
 * and validation. Add new entries here when adding new host tools.
 */
export const CAPABILITY_DESCRIPTIONS: ReadonlyArray<{
  /** The tool's capability prefix (matches HOST_TOOL_REGISTRY capabilityPrefix). */
  toolPrefix: string;
  /** MCP tool name for display. */
  mcpName: string;
  /** Individual capability labels with descriptions. */
  labels: ReadonlyArray<{ label: string; description: string }>;
}> = [
  {
    toolPrefix: 'memory.access',
    mcpName: 'memory_access',
    labels: [
      { label: 'memory.read:thread', description: 'Read per-thread memory items' },
      { label: 'memory.write:thread', description: 'Write/delete per-thread memory items' },
    ],
  },
  {
    toolPrefix: 'net.http',
    mcpName: 'net_http',
    labels: [
      { label: 'net.http:egress', description: 'Make outbound HTTP requests' },
    ],
  },
  {
    toolPrefix: 'channel.send',
    mcpName: 'channel_send',
    labels: [
      { label: 'channel.send:*', description: 'Send messages to any channel' },
    ],
  },
  {
    toolPrefix: 'schedule.manage',
    mcpName: 'schedule_manage',
    labels: [
      { label: 'schedule.manage:own', description: 'Create/update/delete schedules' },
    ],
  },
  {
    toolPrefix: 'db.query',
    mcpName: 'db_query',
    labels: [
      { label: 'db.read:own', description: 'Query the database (read-only)' },
    ],
  },
  {
    toolPrefix: 'subagent.invoke',
    mcpName: 'subagent_invoke',
    labels: [
      { label: 'subagent.invoke', description: 'Invoke sub-agents synchronously' },
    ],
  },
  {
    toolPrefix: 'subagent.background',
    mcpName: 'background_agent',
    labels: [
      { label: 'subagent.background', description: 'Launch background agent tasks' },
    ],
  },
];

/** All known capability labels (flat list). Used for validation. */
export const ALL_CAPABILITY_LABELS = CAPABILITY_DESCRIPTIONS.flatMap(
  (tool) => tool.labels.map((l) => l.label),
);
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/tools/tool-filter.ts
git commit -m "feat(tools): add CAPABILITY_DESCRIPTIONS registry for CLI tooling (#106)"
```

---

### Task 7: `list-capabilities` CLI command

**Files:**
- Create: `src/cli/commands/list-capabilities.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/unit/cli/list-capabilities.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/cli/list-capabilities.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { listCapabilities, formatCapabilities } from '../../../src/cli/commands/list-capabilities.js';

describe('formatCapabilities()', () => {
  it('includes all tool groups', () => {
    const output = formatCapabilities();

    expect(output).toContain('memory.access');
    expect(output).toContain('net.http');
    expect(output).toContain('channel.send');
    expect(output).toContain('schedule.manage');
    expect(output).toContain('db.query');
    expect(output).toContain('subagent.invoke');
    expect(output).toContain('subagent.background');
  });

  it('includes capability labels with descriptions', () => {
    const output = formatCapabilities();

    expect(output).toContain('memory.read:thread');
    expect(output).toContain('Read per-thread memory items');
    expect(output).toContain('net.http:egress');
  });

  it('includes usage instructions', () => {
    const output = formatCapabilities();

    expect(output).toContain('capabilities.allow');
  });
});

describe('listCapabilities()', () => {
  it('prints to console', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    listCapabilities();

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('memory.read:thread');

    consoleSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/cli/list-capabilities.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create list-capabilities.ts**

Create `src/cli/commands/list-capabilities.ts`:

```typescript
/**
 * `talonctl list-capabilities` command.
 *
 * Prints all available capability labels grouped by host tool.
 */

import { CAPABILITY_DESCRIPTIONS } from '../../tools/tool-filter.js';

/**
 * Formats all available capabilities as a human-readable string.
 */
export function formatCapabilities(): string {
  const lines: string[] = ['Available capability labels:', ''];

  for (const tool of CAPABILITY_DESCRIPTIONS) {
    lines.push(`  Tool: ${tool.toolPrefix} (${tool.mcpName})`);
    for (const { label, description } of tool.labels) {
      lines.push(`    ${label.padEnd(28)} ${description}`);
    }
    lines.push('');
  }

  lines.push('Usage: Add labels to `capabilities.allow` in your persona config.');
  lines.push('       Run `talonctl set-capabilities --persona <name> --add <labels>` to modify.');
  lines.push('Example: talonctl set-capabilities --persona assistant --allow "memory.read:thread,net.http:egress"');

  return lines.join('\n');
}

/**
 * CLI entrypoint for `talonctl list-capabilities`.
 */
export function listCapabilities(): void {
  console.log(formatCapabilities());
}

/**
 * CLI command handler (matches Commander action signature).
 */
export async function listCapabilitiesCommand(): Promise<void> {
  listCapabilities();
}
```

- [ ] **Step 4: Register in cli/index.ts**

In `src/cli/index.ts`, add the import:

```typescript
import { listCapabilitiesCommand } from './commands/list-capabilities.js';
```

Add the command registration (after the `list-skills` block):

```typescript
program
  .command('list-capabilities')
  .description('List all available capability labels for persona config')
  .action(async () => {
    await listCapabilitiesCommand();
  });
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/unit/cli/list-capabilities.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/list-capabilities.ts tests/unit/cli/list-capabilities.test.ts src/cli/index.ts
git commit -m "feat(cli): add list-capabilities command (#106)"
```

---

### Task 8: `set-capabilities` CLI command

**Files:**
- Create: `src/cli/commands/set-capabilities.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/unit/cli/set-capabilities.test.ts` (new file)

- [ ] **Step 1: Write failing tests**

Create `tests/unit/cli/set-capabilities.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import { setCapabilities, type SetCapabilitiesOptions } from '../../../src/cli/commands/set-capabilities.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-set-caps-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function configPath(): string {
  return join(tmpDir, 'talond.yaml');
}

function writeConfig(personas: Array<{ name: string; capabilities?: { allow?: string[]; requireApproval?: string[] } }>): string {
  const p = configPath();
  const doc = { personas: personas.map((per) => ({ ...per, model: 'claude-sonnet-4-6' })) };
  writeFileSync(p, yaml.dump(doc));
  return p;
}

function readCaps(p: string, personaName: string): { allow: string[]; requireApproval: string[] } {
  const doc = yaml.load(readFileSync(p, 'utf-8')) as Record<string, unknown>;
  const personas = doc.personas as Array<{ name: string; capabilities: { allow: string[]; requireApproval: string[] } }>;
  return personas.find((per) => per.name === personaName)!.capabilities;
}

describe('setCapabilities()', () => {
  it('replaces allow list with --allow', async () => {
    const p = writeConfig([{ name: 'james', capabilities: { allow: ['old.cap:x'], requireApproval: [] } }]);

    await setCapabilities({ persona: 'james', allow: 'memory.read:thread,net.http:egress', configPath: p });

    const caps = readCaps(p, 'james');
    expect(caps.allow).toEqual(['memory.read:thread', 'net.http:egress']);
  });

  it('adds capabilities with --add', async () => {
    const p = writeConfig([{ name: 'james', capabilities: { allow: ['memory.read:thread'], requireApproval: [] } }]);

    await setCapabilities({ persona: 'james', add: 'net.http:egress', configPath: p });

    const caps = readCaps(p, 'james');
    expect(caps.allow).toContain('memory.read:thread');
    expect(caps.allow).toContain('net.http:egress');
  });

  it('does not add duplicates with --add', async () => {
    const p = writeConfig([{ name: 'james', capabilities: { allow: ['memory.read:thread'], requireApproval: [] } }]);

    await setCapabilities({ persona: 'james', add: 'memory.read:thread', configPath: p });

    const caps = readCaps(p, 'james');
    expect(caps.allow).toEqual(['memory.read:thread']);
  });

  it('removes capabilities with --remove', async () => {
    const p = writeConfig([{ name: 'james', capabilities: { allow: ['memory.read:thread', 'net.http:egress'], requireApproval: [] } }]);

    await setCapabilities({ persona: 'james', remove: 'net.http:egress', configPath: p });

    const caps = readCaps(p, 'james');
    expect(caps.allow).toEqual(['memory.read:thread']);
  });

  it('replaces requireApproval with --requireApproval', async () => {
    const p = writeConfig([{ name: 'james', capabilities: { allow: [], requireApproval: [] } }]);

    await setCapabilities({ persona: 'james', requireApproval: 'channel.send:*', configPath: p });

    const caps = readCaps(p, 'james');
    expect(caps.requireApproval).toEqual(['channel.send:*']);
  });

  it('throws when --allow and --add are both provided', async () => {
    const p = writeConfig([{ name: 'james' }]);

    await expect(setCapabilities({ persona: 'james', allow: 'a', add: 'b', configPath: p }))
      .rejects.toThrow(/mutually exclusive/);
  });

  it('throws when persona not found', async () => {
    const p = writeConfig([{ name: 'james' }]);

    await expect(setCapabilities({ persona: 'nobody', allow: 'a', configPath: p }))
      .rejects.toThrow(/not found/);
  });

  it('returns current capabilities with --show', async () => {
    const p = writeConfig([{ name: 'james', capabilities: { allow: ['memory.read:thread'], requireApproval: ['channel.send:*'] } }]);

    const result = await setCapabilities({ persona: 'james', show: true, configPath: p });

    expect(result.allow).toEqual(['memory.read:thread']);
    expect(result.requireApproval).toEqual(['channel.send:*']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/cli/set-capabilities.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create set-capabilities.ts**

Create `src/cli/commands/set-capabilities.ts`:

```typescript
/**
 * `talonctl set-capabilities` command.
 *
 * Programmatically set capability labels on a persona.
 */

import {
  DEFAULT_CONFIG_PATH,
  readConfig,
  writeConfigAtomic,
} from '../config-utils.js';
import { ALL_CAPABILITY_LABELS } from '../../tools/tool-filter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SetCapabilitiesOptions {
  persona: string;
  configPath?: string;
  /** Replace entire allow list (comma-separated). */
  allow?: string;
  /** Append to allow list (comma-separated). */
  add?: string;
  /** Remove from allow list (comma-separated). */
  remove?: string;
  /** Replace entire requireApproval list (comma-separated). */
  requireApproval?: string;
  /** Print current capabilities and return without writing. */
  show?: boolean;
}

export interface CapabilitiesResult {
  allow: string[];
  requireApproval: string[];
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Sets capabilities on a persona in the config file.
 *
 * @returns The final capabilities after modification.
 * @throws Error on validation failures or config errors.
 */
export async function setCapabilities(options: SetCapabilitiesOptions): Promise<CapabilitiesResult> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const doc = await readConfig(configPath);

  // Find persona.
  const personas = Array.isArray(doc.personas) ? doc.personas : [];
  const persona = personas.find((p) => p.name === options.persona);
  if (!persona) {
    throw new Error(`Persona "${options.persona}" not found in "${configPath}".`);
  }

  // Ensure capabilities object exists.
  if (!persona.capabilities) {
    persona.capabilities = { allow: [], requireApproval: [] };
  }
  const caps = persona.capabilities as { allow?: string[]; requireApproval?: string[] };
  if (!Array.isArray(caps.allow)) caps.allow = [];
  if (!Array.isArray(caps.requireApproval)) caps.requireApproval = [];

  // --show: read-only mode.
  if (options.show) {
    return { allow: caps.allow, requireApproval: caps.requireApproval };
  }

  // Validate mutual exclusivity.
  if (options.allow && (options.add || options.remove)) {
    throw new Error('--allow and --add/--remove are mutually exclusive. Use --allow to replace, or --add/--remove for incremental changes.');
  }

  // Apply changes.
  if (options.allow !== undefined) {
    caps.allow = parseLabels(options.allow);
  }

  if (options.add !== undefined) {
    const toAdd = parseLabels(options.add);
    for (const label of toAdd) {
      if (!caps.allow!.includes(label)) {
        caps.allow!.push(label);
      }
    }
  }

  if (options.remove !== undefined) {
    const toRemove = new Set(parseLabels(options.remove));
    caps.allow = caps.allow!.filter((l) => !toRemove.has(l));
  }

  if (options.requireApproval !== undefined) {
    caps.requireApproval = parseLabels(options.requireApproval);
  }

  // Warn on unrecognized labels.
  const allLabels = [...caps.allow!, ...caps.requireApproval!];
  const unknown = allLabels.filter((l) => !ALL_CAPABILITY_LABELS.includes(l));
  if (unknown.length > 0) {
    console.warn(`Warning: unrecognized capability label(s): ${unknown.join(', ')}`);
  }

  await writeConfigAtomic(configPath, doc);

  return { allow: caps.allow!, requireApproval: caps.requireApproval! };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function setCapabilitiesCommand(options: SetCapabilitiesOptions): Promise<void> {
  try {
    const result = await setCapabilities(options);

    if (options.show) {
      console.log(`Capabilities for persona "${options.persona}":`);
      console.log(`  allow: ${result.allow.length > 0 ? result.allow.join(', ') : '(none)'}`);
      console.log(`  requireApproval: ${result.requireApproval.length > 0 ? result.requireApproval.join(', ') : '(none)'}`);
      return;
    }

    console.log(`Updated capabilities for persona "${options.persona}":`);
    console.log(`  allow: ${result.allow.length > 0 ? result.allow.join(', ') : '(none)'}`);
    console.log(`  requireApproval: ${result.requireApproval.length > 0 ? result.requireApproval.join(', ') : '(none)'}`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLabels(input: string): string[] {
  return input.split(',').map((l) => l.trim()).filter((l) => l.length > 0);
}
```

- [ ] **Step 4: Register in cli/index.ts**

In `src/cli/index.ts`, add the import:

```typescript
import { setCapabilitiesCommand } from './commands/set-capabilities.js';
```

Add the command registration:

```typescript
program
  .command('set-capabilities')
  .description('Set capability labels on a persona')
  .requiredOption('--persona <name>', 'Persona name')
  .option('--allow <labels>', 'Replace allow list (comma-separated)')
  .option('--add <labels>', 'Add to allow list (comma-separated)')
  .option('--remove <labels>', 'Remove from allow list (comma-separated)')
  .option('--require-approval <labels>', 'Replace requireApproval list (comma-separated)')
  .option('--show', 'Show current capabilities without modifying')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: {
    persona: string;
    allow?: string;
    add?: string;
    remove?: string;
    requireApproval?: string;
    show?: boolean;
    config: string;
  }) => {
    await setCapabilitiesCommand({
      persona: opts.persona,
      allow: opts.allow,
      add: opts.add,
      remove: opts.remove,
      requireApproval: opts.requireApproval,
      show: opts.show,
      configPath: opts.config,
    });
  });
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/unit/cli/set-capabilities.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/set-capabilities.ts tests/unit/cli/set-capabilities.test.ts src/cli/index.ts
git commit -m "feat(cli): add set-capabilities command (#106)"
```

---

### Task 9: Update talon-setup skill

**Files:**
- Modify: `.claude/skills/talon-setup/SKILL.md`

- [ ] **Step 1: Add new commands to the available commands table**

In `.claude/skills/talon-setup/SKILL.md`, add two rows to the commands table (after the `list-schedules` row):

```markdown
| `npx talonctl list-capabilities` | Show all available capability labels |
| `npx talonctl set-capabilities --persona <p> --allow <labels>` | Set persona capabilities |
| `npx talonctl set-capabilities --persona <p> --add <labels>` | Add capabilities to persona |
| `npx talonctl set-capabilities --persona <p> --remove <labels>` | Remove capabilities from persona |
| `npx talonctl set-capabilities --persona <p> --show` | Show persona's current capabilities |
```

- [ ] **Step 2: Add Step 5b after persona configuration**

In `.claude/skills/talon-setup/SKILL.md`, after Step 5 (Persona configuration) and before Step 6 (Scheduled tasks), add:

```markdown
### Step 5b: Capability configuration

After creating a persona, show what capabilities it has and what's available.

1. Run: `npx talonctl set-capabilities --persona <name> --show`
2. Run: `npx talonctl list-capabilities`
3. Explain: "Your persona was created with sensible defaults: memory access, HTTP requests,
   and schedule management. Here are all available capabilities."
4. Ask: **"Want to adjust capabilities for {name}?"**

If yes, help the user decide which to add or remove:

- For agents that should message other channels: `npx talonctl set-capabilities --persona <name> --add "channel.send:*"`
- For agents that need database access: `npx talonctl set-capabilities --persona <name> --add "db.read:own"`
- For agents that run background tasks: `npx talonctl set-capabilities --persona <name> --add "subagent.background"`
- For agents that invoke sub-agents: `npx talonctl set-capabilities --persona <name> --add "subagent.invoke"`

Repeat for each persona.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/talon-setup/SKILL.md
git commit -m "docs(skill): add capability management to talon-setup skill (#106)"
```

---

### Task 10: Final verification

- [ ] **Step 1: Run all affected tests**

Run: `npx vitest run tests/unit/cli/add-persona.test.ts tests/unit/cli/schedule-commands.test.ts tests/unit/core/database/repositories/binding-repository.test.ts tests/unit/channels/channel-setup.test.ts tests/unit/cli/list-capabilities.test.ts tests/unit/cli/set-capabilities.test.ts`
Expected: ALL PASS

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: No errors (or only pre-existing warnings)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: Builds successfully
