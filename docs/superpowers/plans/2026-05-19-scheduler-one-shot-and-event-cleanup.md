# Scheduler One-Shot Exposure + Event Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose `one_shot` schedules to agents via the `schedule.manage` host-tool (so agents stop abusing `cron` for one-time reminders), add a janitor that deletes completed one-shot rows after a retention period, and remove the unused `event` schedule type.

**Architecture:** The scheduler runtime already supports `one_shot` end-to-end — it computes `next_run_at` from inserts, fires the schedule on tick, then disables the row via the existing `nextRun === null` branch. The work is therefore mostly at the edges: extend `schedule.manage` arg shape with a `type` discriminator + `runAt` / `runInSeconds` slots, validate them, insert with `type='one_shot'`. The janitor is a small periodic sweep on the same tick loop. `event` is deleted across the type union, scheduler switch, tool schema, tests, and DB CHECK constraint.

**Tech Stack:** TypeScript strict, better-sqlite3, Zod, Vitest. neverthrow `Result<T, E>` for all repository methods.

**Out of scope:**
- `interval` enhancements (no business-hour windows — use cron for those).
- CLI `add-schedule` command (operators continue to use cron; one-shot is an agent-driven need).
- Any change to interval semantics or the `Date.now()` drift in `computeNextRun`.

**Pre-flight notes for the implementer:**
- Current branch when this plan was written was `feat/postgram-notifications`. Cut a new branch (Task 1).
- Per `CLAUDE.md`: codex review is required before each commit. Each "Commit" step below has a `codex` review sub-step.
- Per `CLAUDE.md`: docs (README.md, `.claude/skills/`, tool-instructions) MUST be updated before the work is considered complete — Task 10 covers this.
- The full test suite is slow; per `CLAUDE.md` ask before running it. Run targeted file tests during TDD.

---

## File Structure

**New files:**
- `src/core/database/migrations/011-drop-event-schedule-type.sql` — migration recreating `schedules` table without `event` in the CHECK constraint.

**Modified files:**
- `src/core/database/repositories/schedule-repository.ts` — narrow `ScheduleType`, add `deleteOldOneShots(olderThan)` repo method.
- `src/scheduler/scheduler.ts` — remove `case 'event'`, add janitor sweep call in `tick()`.
- `src/scheduler/schedule-types.ts` — add `oneShotRetentionMs` + `oneShotSweepIntervalMs` to `ScheduleConfig`.
- `src/core/config/config-schema.ts` — extend `SchedulerConfigSchema` with the two new fields.
- `src/tools/host-tools/schedule-manage.ts` — accept `type`, `runAt`, `runInSeconds`; insert `one_shot` rows; allow `runAt`/`runInSeconds` on update.
- `src/tools/host-tools-mcp-server.ts` — extend `schedule_manage` MCP inputSchema.
- `templates/tool-instructions/schedule.manage.md` — document one-shot usage.
- `.claude/skills/manage-schedules/SKILL.md` — mention one-shot path.
- `README.md` — update the scheduler section + `schedule.manage` reference.
- `tests/unit/scheduler/scheduler.test.ts` — delete the event describe block, add janitor coverage.
- `tests/unit/scheduler/helpers.ts` — narrow the type union in the test helper.
- `tests/unit/tools/host-tools/schedule-manage.test.ts` — add one-shot create/update/list/cancel coverage and validation cases.

---

## Task 1: Branch setup

**Files:** none (git state only).

- [ ] **Step 1: Cut a new branch from `main`.**

Run:
```bash
git fetch origin
git checkout -b feat/scheduler-one-shot-cleanup origin/main
```

- [ ] **Step 2: Confirm branch.**

Run: `git status`
Expected: `On branch feat/scheduler-one-shot-cleanup` and a clean tree.

---

## Task 2: Migration — drop `event` from CHECK constraint

**Files:**
- Create: `src/core/database/migrations/011-drop-event-schedule-type.sql`

- [ ] **Step 1: Write the migration.**

Write to `src/core/database/migrations/011-drop-event-schedule-type.sql`:

```sql
-- Migration 011: Drop 'event' from schedules.type CHECK constraint.
--
-- The 'event' schedule type was reserved for an event-bus trigger mechanism
-- that was never wired up. No producer in the codebase inserts rows with
-- type='event'; the scheduler only fires + disables them if they exist.
-- Removing the value tightens the type system and the DB constraint together.
--
-- SQLite does not support ALTER on a CHECK constraint, so we recreate the
-- table. Any pre-existing event rows (none expected in production) are
-- deleted to satisfy the new CHECK.

DELETE FROM schedules WHERE type = 'event';

CREATE TABLE schedules_new (
  id          TEXT PRIMARY KEY,
  persona_id  TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  thread_id   TEXT REFERENCES threads(id),
  type        TEXT NOT NULL CHECK (type IN ('cron', 'interval', 'one_shot')),
  expression  TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

INSERT INTO schedules_new (
  id, persona_id, thread_id, type, expression, payload,
  enabled, last_run_at, next_run_at, created_at, updated_at
)
SELECT
  id, persona_id, thread_id, type, expression, payload,
  enabled, last_run_at, next_run_at, created_at, updated_at
FROM schedules;

DROP TABLE schedules;
ALTER TABLE schedules_new RENAME TO schedules;

CREATE INDEX idx_schedules_next ON schedules(enabled, next_run_at)
  WHERE enabled = 1;
CREATE INDEX idx_schedules_persona ON schedules(persona_id);
```

- [ ] **Step 2: Build to confirm the SQL copy step picks up the new file.**

Run: `npm run build`
Expected: build succeeds, `dist/core/database/migrations/011-drop-event-schedule-type.sql` exists.

Run: `ls dist/core/database/migrations/011-drop-event-schedule-type.sql`
Expected: file is present.

- [ ] **Step 3: Write a migration test.**

Append to `tests/unit/core/database/migrations.test.ts` (or create it if missing — check existing migration test files first with `ls tests/unit/core/database/`):

```typescript
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@talon/core/database/migrations/runner.js';

describe('migration 011 — drop event from schedules CHECK', () => {
  it('rejects inserts with type=event after migration', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    expect(() =>
      db.prepare(
        `INSERT INTO schedules (id, persona_id, thread_id, type, expression, payload,
                                enabled, last_run_at, next_run_at, created_at, updated_at)
         VALUES ('s1', 'p1', null, 'event', 'my-event', '{}', 1, null, null, 0, 0)`,
      ).run(),
    ).toThrow(/CHECK/);
  });

  it('still accepts cron, interval, and one_shot', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO personas (id, name, created_at, updated_at)
       VALUES ('p1', 'p1', 0, 0)`,
    ).run();

    for (const type of ['cron', 'interval', 'one_shot'] as const) {
      expect(() =>
        db.prepare(
          `INSERT INTO schedules (id, persona_id, thread_id, type, expression, payload,
                                  enabled, last_run_at, next_run_at, created_at, updated_at)
           VALUES (?, 'p1', null, ?, '*/5 * * * *', '{}', 1, null, null, 0, 0)`,
        ).run(`s-${type}`, type),
      ).not.toThrow();
    }
  });
});
```

Note: if `personas` requires non-null cols or the migration helper signature differs, follow the existing test conventions in `tests/unit/core/database/` rather than this skeleton verbatim.

- [ ] **Step 4: Run the migration test.**

Run: `npx vitest run tests/unit/core/database/migrations.test.ts`
Expected: both new test cases PASS.

- [ ] **Step 5: Codex review.**

Invoke the `skill-codex:codex` skill with the diff: ask GPT-5.4 to review `src/core/database/migrations/011-drop-event-schedule-type.sql` and the migration test for correctness, idempotency, and data-loss risk. Address any critical/high/medium issues before committing.

- [ ] **Step 6: Commit.**

```bash
git add src/core/database/migrations/011-drop-event-schedule-type.sql \
        tests/unit/core/database/migrations.test.ts
git commit -m "feat(scheduler): drop event from schedules CHECK constraint (migration 011)"
```

---

## Task 3: Narrow `ScheduleType` in TypeScript

**Files:**
- Modify: `src/core/database/repositories/schedule-repository.ts:14`
- Modify: `tests/unit/scheduler/helpers.ts:110`

- [ ] **Step 1: Narrow the type union.**

In `src/core/database/repositories/schedule-repository.ts`, change line 14:

```typescript
export type ScheduleType = 'cron' | 'interval' | 'one_shot' | 'event';
```
to:
```typescript
export type ScheduleType = 'cron' | 'interval' | 'one_shot';
```

- [ ] **Step 2: Narrow the test helper.**

In `tests/unit/scheduler/helpers.ts` around line 110, change:

```typescript
    type: 'cron' | 'interval' | 'one_shot' | 'event';
```
to:
```typescript
    type: 'cron' | 'interval' | 'one_shot';
```

- [ ] **Step 3: Typecheck.**

Run: `npx tsc --noEmit`
Expected: a small number of errors pointing at `case 'event':` in `src/scheduler/scheduler.ts` (handled in Task 4) and at the `event schedule` describe block in `tests/unit/scheduler/scheduler.test.ts` (handled in Task 4 as well). No other errors.

If unrelated errors appear, stop and investigate — they likely indicate another producer the survey missed.

- [ ] **Step 4: Hold the commit until Task 4 finishes.**

These three files (`schedule-repository.ts`, `helpers.ts`, `scheduler.ts`, `scheduler.test.ts`) form one coherent change. Continue to Task 4 and commit them together.

---

## Task 4: Remove `event` from scheduler runtime + tests

**Files:**
- Modify: `src/scheduler/scheduler.ts:306-308`
- Modify: `src/scheduler/scheduler.ts:6` (docstring)
- Modify: `tests/unit/scheduler/scheduler.test.ts:356-389`

- [ ] **Step 1: Delete the event case in `computeNextRun`.**

In `src/scheduler/scheduler.ts`, delete lines 306–308:

```typescript
      case 'event':
        // Event-triggered schedules are not time-based; disable after first fire.
        return null;
```

- [ ] **Step 2: Update the file docstring.**

In `src/scheduler/scheduler.ts`, change line 6 from:

```typescript
 * their next_run_at (or disables them for one-shot / event-triggered types).
```
to:
```typescript
 * their next_run_at (or disables them for one-shot types).
```

- [ ] **Step 3: Update the inline comment near the disable branch.**

In `src/scheduler/scheduler.ts`, find the comment near line 244–245 that says `// One-shot or event-triggered — disable the schedule.` and replace with `// One-shot — disable the schedule.`. (Look for the exact line; line numbers shift after edits.)

- [ ] **Step 4: Delete the event describe block in scheduler tests.**

In `tests/unit/scheduler/scheduler.test.ts`, delete the entire `describe('event schedule', ...)` block at lines 356–389 (the divider comment, the describe, both `it` cases). Keep the `interval schedule` divider that follows.

- [ ] **Step 5: Run scheduler tests.**

Run: `npx vitest run tests/unit/scheduler/`
Expected: all scheduler tests pass. Cron, interval, and one_shot describe blocks remain green.

- [ ] **Step 6: Typecheck.**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Codex review.**

Invoke `skill-codex:codex` with the diff of `schedule-repository.ts`, `scheduler.ts`, `helpers.ts`, and `scheduler.test.ts`. Address any non-trivial issues.

- [ ] **Step 8: Commit.**

```bash
git add src/core/database/repositories/schedule-repository.ts \
        src/scheduler/scheduler.ts \
        tests/unit/scheduler/helpers.ts \
        tests/unit/scheduler/scheduler.test.ts
git commit -m "refactor(scheduler): remove unused 'event' schedule type"
```

---

## Task 5: `schedule.manage` — add `type` arg and one-shot create path

**Files:**
- Modify: `src/tools/host-tools/schedule-manage.ts`
- Test: `tests/unit/tools/host-tools/schedule-manage.test.ts` (path may differ — check existing test layout with `ls tests/unit/tools/`)

- [ ] **Step 1: Write a failing test for one-shot create with `runInSeconds`.**

Add to the `handleCreate` describe block in `tests/unit/tools/host-tools/schedule-manage.test.ts`:

```typescript
it('creates a one-shot schedule when type=one_shot and runInSeconds is given', async () => {
  const before = Date.now();
  const result = await handler.execute(
    {
      action: 'create',
      type: 'one_shot',
      runInSeconds: 60,
      label: 'remind me in 1 minute',
      prompt: 'send a follow-up',
    },
    ctx,
  );

  expect(result.status).toBe('success');
  const row = db
    .prepare(`SELECT type, expression, next_run_at FROM schedules WHERE persona_id = ?`)
    .get(ctx.personaId) as { type: string; expression: string; next_run_at: number };
  expect(row.type).toBe('one_shot');
  expect(row.next_run_at).toBeGreaterThanOrEqual(before + 60_000);
  expect(row.next_run_at).toBeLessThan(before + 61_500);
  // expression stores a human-readable ISO timestamp for the run target
  expect(() => new Date(row.expression).toISOString()).not.toThrow();
});
```

- [ ] **Step 2: Run the test, confirm it fails.**

Run: `npx vitest run tests/unit/tools/host-tools/schedule-manage.test.ts -t "one-shot"`
Expected: FAIL — current handler rejects unknown `type` / requires `cronExpr`.

- [ ] **Step 3: Extend `ScheduleManageArgs`.**

In `src/tools/host-tools/schedule-manage.ts`, replace the interface around line 27:

```typescript
export interface ScheduleManageArgs {
  /** Action to perform on the schedule entry. */
  action: 'create' | 'update' | 'cancel' | 'delete' | 'list';
  /** Unique schedule identifier (required for update/cancel/delete). */
  scheduleId?: string;
  /**
   * Schedule type. Defaults to 'cron' for backward compatibility.
   * Use 'one_shot' for fire-once-then-forget reminders.
   */
  type?: 'cron' | 'one_shot';
  /** Cron expression defining when the task fires (required when type='cron'). */
  cronExpr?: string;
  /**
   * ISO-8601 timestamp at which a one_shot fires. Must be in the future.
   * Mutually exclusive with runInSeconds. Used when type='one_shot'.
   */
  runAt?: string;
  /**
   * Number of seconds from now at which a one_shot fires. Must be > 0.
   * Mutually exclusive with runAt. Used when type='one_shot'.
   */
  runInSeconds?: number;
  /** Human-readable label for the scheduled task. */
  label?: string;
  /** Prompt or instruction to execute when the schedule fires. */
  prompt?: string;
  /** Prompt file alias to resolve from the persona's prompts/ directory. */
  promptFile?: string;
}
```

- [ ] **Step 4: Add a helper that resolves the one-shot fire time.**

Add this private helper near `buildSchedulePayload` in `schedule-manage.ts`:

```typescript
/** Maximum one-shot scheduling horizon: 365 days. Prevents accidental "year-from-now" rows. */
private static readonly ONE_SHOT_MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

private resolveOneShotFireTime(
  args: Pick<ScheduleManageArgs, 'runAt' | 'runInSeconds'>,
): Result<{ fireAtMs: number; expression: string }, ToolError> {
  const hasRunAt = typeof args.runAt === 'string' && args.runAt.trim() !== '';
  const hasRunInSeconds = typeof args.runInSeconds === 'number';

  if (hasRunAt && hasRunInSeconds) {
    return err(new ToolError('schedule.manage: runAt and runInSeconds are mutually exclusive'));
  }
  if (!hasRunAt && !hasRunInSeconds) {
    return err(
      new ToolError(
        'schedule.manage: one_shot requires either runAt (ISO-8601 timestamp) or runInSeconds (positive number)',
      ),
    );
  }

  const now = Date.now();
  let fireAtMs: number;

  if (hasRunAt) {
    const parsed = Date.parse(args.runAt as string);
    if (Number.isNaN(parsed)) {
      return err(new ToolError(`schedule.manage: runAt "${args.runAt}" is not a valid ISO-8601 timestamp`));
    }
    fireAtMs = parsed;
  } else {
    const secs = args.runInSeconds as number;
    if (!Number.isFinite(secs) || secs <= 0) {
      return err(new ToolError(`schedule.manage: runInSeconds must be a positive finite number, got ${secs}`));
    }
    fireAtMs = now + Math.round(secs * 1000);
  }

  if (fireAtMs <= now) {
    return err(new ToolError('schedule.manage: one_shot fire time must be in the future'));
  }
  if (fireAtMs - now > ScheduleManageHandler.ONE_SHOT_MAX_AHEAD_MS) {
    return err(
      new ToolError(
        `schedule.manage: one_shot fire time is more than 365 days in the future — use a cron schedule instead`,
      ),
    );
  }

  return ok({ fireAtMs, expression: new Date(fireAtMs).toISOString() });
}
```

(Imports `ok` and `err` from `neverthrow` are already present in the file.)

- [ ] **Step 5: Branch `handleCreate` on `type`.**

In `handleCreate`, replace the cron-only opening block with a type discriminator. After the action check and `requestId`, change the start of the function from the existing `const { cronExpr } = args;` cron-only validation to:

```typescript
const scheduleType: 'cron' | 'one_shot' = args.type ?? 'cron';

// Compute the firing time and expression based on type.
let expression: string;
let nextRunAt: number;

if (scheduleType === 'cron') {
  const { cronExpr } = args;
  if (!cronExpr || typeof cronExpr !== 'string' || cronExpr.trim() === '') {
    const error = new ToolError('schedule.manage: cronExpr is required when type=cron');
    this.deps.logger.warn({ requestId }, error.message);
    return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
  }
  if (!CRON_PATTERN.test(cronExpr.trim())) {
    const error = new ToolError(
      `schedule.manage: invalid cron expression "${cronExpr}". Expected 5-field cron format (minute hour day month weekday)`,
    );
    this.deps.logger.warn({ requestId, cronExpr }, error.message);
    return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
  }
  const nextRunResult = getNextCronTime(cronExpr.trim());
  if (nextRunResult.isErr()) {
    const msg = `schedule.manage: failed to compute next run time — ${nextRunResult.error.message}`;
    this.deps.logger.warn({ requestId, cronExpr }, msg);
    return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
  }
  expression = cronExpr.trim();
  nextRunAt = nextRunResult.value;
} else {
  // one_shot
  if (args.cronExpr !== undefined) {
    const error = new ToolError('schedule.manage: cronExpr must not be set when type=one_shot');
    this.deps.logger.warn({ requestId }, error.message);
    return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
  }
  const fireTime = this.resolveOneShotFireTime(args);
  if (fireTime.isErr()) {
    this.deps.logger.warn({ requestId }, fireTime.error.message);
    return { requestId, tool: 'schedule.manage', status: 'error', error: fireTime.error.message };
  }
  expression = fireTime.value.expression;
  nextRunAt = fireTime.value.fireAtMs;
}
```

Then, further down where the existing code calls `this.deps.scheduleRepository.insert({...})`, change:

```typescript
type: 'cron',
expression: cronExpr.trim(),
```
to:
```typescript
type: scheduleType,
expression,
```

And change `next_run_at: nextRunResult.value,` to `next_run_at: nextRunAt,`.

Delete the now-dead `nextRunResult` local at the old call site (the new code computes `nextRunAt` above).

- [ ] **Step 6: Run the failing one-shot test.**

Run: `npx vitest run tests/unit/tools/host-tools/schedule-manage.test.ts -t "one-shot"`
Expected: PASS.

- [ ] **Step 7: Run all schedule-manage tests to confirm no cron regressions.**

Run: `npx vitest run tests/unit/tools/host-tools/schedule-manage.test.ts`
Expected: all tests pass, including the existing cron create/update/cancel/delete/list cases.

- [ ] **Step 8: Add coverage for one-shot edge cases.**

Add the following tests in the same describe block:

```typescript
it('rejects one_shot create when neither runAt nor runInSeconds is provided', async () => {
  const result = await handler.execute(
    { action: 'create', type: 'one_shot', prompt: 'hi' },
    ctx,
  );
  expect(result.status).toBe('error');
  expect(result.error).toMatch(/runAt.*runInSeconds/);
});

it('rejects one_shot create when both runAt and runInSeconds are provided', async () => {
  const result = await handler.execute(
    {
      action: 'create',
      type: 'one_shot',
      runAt: new Date(Date.now() + 60_000).toISOString(),
      runInSeconds: 60,
      prompt: 'hi',
    },
    ctx,
  );
  expect(result.status).toBe('error');
  expect(result.error).toMatch(/mutually exclusive/);
});

it('rejects one_shot create when runAt is in the past', async () => {
  const result = await handler.execute(
    {
      action: 'create',
      type: 'one_shot',
      runAt: new Date(Date.now() - 1000).toISOString(),
      prompt: 'hi',
    },
    ctx,
  );
  expect(result.status).toBe('error');
  expect(result.error).toMatch(/future/);
});

it('rejects one_shot create when cronExpr is also set', async () => {
  const result = await handler.execute(
    {
      action: 'create',
      type: 'one_shot',
      runInSeconds: 60,
      cronExpr: '*/5 * * * *',
      prompt: 'hi',
    },
    ctx,
  );
  expect(result.status).toBe('error');
  expect(result.error).toMatch(/cronExpr must not be set/);
});

it('creates a one-shot using an ISO runAt timestamp', async () => {
  const runAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const result = await handler.execute(
    { action: 'create', type: 'one_shot', runAt, prompt: 'hi' },
    ctx,
  );
  expect(result.status).toBe('success');
  const row = db
    .prepare(`SELECT expression, next_run_at FROM schedules WHERE persona_id = ?`)
    .get(ctx.personaId) as { expression: string; next_run_at: number };
  expect(row.expression).toBe(runAt);
  expect(row.next_run_at).toBe(Date.parse(runAt));
});
```

- [ ] **Step 9: Run the new tests.**

Run: `npx vitest run tests/unit/tools/host-tools/schedule-manage.test.ts -t "one-shot"`
Expected: all five new tests pass.

- [ ] **Step 10: Hold the commit until Task 6 finishes** (update path needs the same validation helpers).

---

## Task 6: `schedule.manage` — allow one-shot reschedule via `update`

**Files:**
- Modify: `src/tools/host-tools/schedule-manage.ts` (handleUpdate)
- Test: `tests/unit/tools/host-tools/schedule-manage.test.ts`

- [ ] **Step 1: Write a failing test — update a one-shot's fire time.**

Add to the update describe block:

```typescript
it('reschedules a one-shot by updating runInSeconds', async () => {
  const create = await handler.execute(
    { action: 'create', type: 'one_shot', runInSeconds: 60, prompt: 'hi' },
    ctx,
  );
  expect(create.status).toBe('success');
  const scheduleId = (create.result as { scheduleId: string }).scheduleId;

  const before = Date.now();
  const update = await handler.execute(
    { action: 'update', scheduleId, runInSeconds: 600 },
    ctx,
  );
  expect(update.status).toBe('success');

  const row = db
    .prepare(`SELECT next_run_at FROM schedules WHERE id = ?`)
    .get(scheduleId) as { next_run_at: number };
  expect(row.next_run_at).toBeGreaterThanOrEqual(before + 600_000);
});

it('rejects update of a cron schedule with runAt', async () => {
  const create = await handler.execute(
    { action: 'create', cronExpr: '*/5 * * * *', prompt: 'hi' },
    ctx,
  );
  const scheduleId = (create.result as { scheduleId: string }).scheduleId;

  const update = await handler.execute(
    {
      action: 'update',
      scheduleId,
      runAt: new Date(Date.now() + 60_000).toISOString(),
    },
    ctx,
  );
  expect(update.status).toBe('error');
  expect(update.error).toMatch(/runAt.*cron|type mismatch|not a one_shot/i);
});
```

- [ ] **Step 2: Run the failing tests.**

Run: `npx vitest run tests/unit/tools/host-tools/schedule-manage.test.ts -t "reschedules a one-shot|cron schedule with runAt"`
Expected: both FAIL.

- [ ] **Step 3: Teach `handleUpdate` about `runAt` / `runInSeconds`.**

In `handleUpdate`, after the existing `cronExpr`-handling block (around line 325–345) and before the label/prompt block (around line 346), insert:

```typescript
const hasRunAt = typeof args.runAt === 'string' && args.runAt.trim() !== '';
const hasRunInSeconds = typeof args.runInSeconds === 'number';

if (hasRunAt || hasRunInSeconds) {
  if (cronExpr !== undefined) {
    const error = new ToolError(
      'schedule.manage: cronExpr cannot be combined with runAt/runInSeconds on update',
    );
    this.deps.logger.warn({ requestId, scheduleId }, error.message);
    return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
  }

  // Load the existing schedule and verify it is a one_shot owned by this persona.
  const existing = this.deps.scheduleRepository.findById(scheduleId);
  if (existing.isErr()) {
    const msg = `schedule.manage: failed to load existing schedule — ${existing.error.message}`;
    this.deps.logger.error({ requestId, scheduleId, err: existing.error }, msg);
    return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
  }
  if (!existing.value) {
    const msg = `schedule.manage: schedule "${scheduleId}" not found`;
    return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
  }
  if (existing.value.persona_id !== context.personaId) {
    const msg = `schedule.manage: schedule "${scheduleId}" does not belong to this persona`;
    return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
  }
  if (existing.value.type !== 'one_shot') {
    const msg = `schedule.manage: cannot apply runAt/runInSeconds to a ${existing.value.type} schedule (type mismatch)`;
    this.deps.logger.warn({ requestId, scheduleId, type: existing.value.type }, msg);
    return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
  }

  const fireTime = this.resolveOneShotFireTime({
    runAt: args.runAt,
    runInSeconds: args.runInSeconds,
  });
  if (fireTime.isErr()) {
    this.deps.logger.warn({ requestId, scheduleId }, fireTime.error.message);
    return { requestId, tool: 'schedule.manage', status: 'error', error: fireTime.error.message };
  }

  fields['expression'] = fireTime.value.expression;
  fields['next_run_at'] = fireTime.value.fireAtMs;
}
```

- [ ] **Step 4: Run the update tests.**

Run: `npx vitest run tests/unit/tools/host-tools/schedule-manage.test.ts -t "reschedules a one-shot|cron schedule with runAt"`
Expected: both PASS.

- [ ] **Step 5: Re-check that updating only label/prompt still requires at least one field (the `if (Object.keys(fields).length === 0)` guard).**

The new branch adds to `fields` only when `runAt`/`runInSeconds` is provided, so the existing guard still fires correctly when nothing was provided. Run the whole test file:

Run: `npx vitest run tests/unit/tools/host-tools/schedule-manage.test.ts`
Expected: all tests pass.

- [ ] **Step 6: Codex review.**

Invoke `skill-codex:codex` with the diff of `schedule-manage.ts` and the test file. Address any non-trivial issues, particularly around argument coercion and ownership checks.

- [ ] **Step 7: Commit Tasks 5 + 6 together.**

```bash
git add src/tools/host-tools/schedule-manage.ts \
        tests/unit/tools/host-tools/schedule-manage.test.ts
git commit -m "feat(schedule.manage): expose one_shot schedules to agents"
```

---

## Task 7: Update MCP tool schema

**Files:**
- Modify: `src/tools/host-tools-mcp-server.ts:208-243`

- [ ] **Step 1: Extend the `schedule_manage` inputSchema.**

In `src/tools/host-tools-mcp-server.ts`, replace the `schedule_manage` entry (lines ~208–243) with:

```typescript
  {
    name: 'schedule_manage',
    description:
      'Creates, updates, cancels, or lists scheduled tasks on behalf of a persona. Schedules are durable — persisted in SQLite and survive session resets and daemon restarts. Use type="cron" (default) for recurring tasks and type="one_shot" for fire-once reminders that auto-clean themselves up. Prefer one_shot over a cron expression that "fires once next year" — those leak rows. Use this instead of CronCreate/CronDelete, which are session-bound and disappear when the conversation ends.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string' as const,
          enum: ['create', 'update', 'cancel', 'delete', 'list'],
          description:
            'Action to perform. "cancel" disables a schedule, "delete" removes it permanently. Use "list" to see your schedules.',
        },
        scheduleId: {
          type: 'string' as const,
          description: 'Unique schedule identifier (required for update/cancel/delete)',
        },
        type: {
          type: 'string' as const,
          enum: ['cron', 'one_shot'],
          description:
            'Schedule type. Defaults to "cron". Use "one_shot" for a single future fire that auto-disables and is cleaned up later by the scheduler janitor.',
        },
        cronExpr: {
          type: 'string' as const,
          description: 'Cron expression defining when the task fires (required when type=cron)',
        },
        runAt: {
          type: 'string' as const,
          description:
            'ISO-8601 timestamp for a one_shot fire (e.g. "2026-05-19T14:00:00Z"). Must be in the future and within 365 days. Mutually exclusive with runInSeconds.',
        },
        runInSeconds: {
          type: 'number' as const,
          description:
            'Seconds from now for a one_shot fire. Must be positive. Mutually exclusive with runAt.',
        },
        label: {
          type: 'string' as const,
          description: 'Human-readable label for the scheduled task',
        },
        prompt: {
          type: 'string' as const,
          description: 'Inline prompt to execute when the schedule fires. Mutually exclusive with promptFile.',
        },
        promptFile: {
          type: 'string' as const,
          description: 'Prompt file alias from the persona prompts/ directory. Mutually exclusive with prompt.',
        },
      },
      required: ['action'],
    },
  },
```

- [ ] **Step 2: Typecheck + build.**

Run: `npx tsc --noEmit && npm run build`
Expected: both succeed.

- [ ] **Step 3: Codex review.**

Invoke `skill-codex:codex` with the diff. Address any issues.

- [ ] **Step 4: Commit.**

```bash
git add src/tools/host-tools-mcp-server.ts
git commit -m "feat(mcp): expose one_shot params in schedule_manage tool schema"
```

---

## Task 8: Janitor config plumbing

**Files:**
- Modify: `src/scheduler/schedule-types.ts`
- Modify: `src/core/config/config-schema.ts:144-146`

- [ ] **Step 1: Extend `ScheduleConfig`.**

In `src/scheduler/schedule-types.ts`, replace the `ScheduleConfig` interface with:

```typescript
/** Runtime configuration for the Scheduler, derived from TalondConfig.scheduler. */
export interface ScheduleConfig {
  /** How often the scheduler ticks to check for due schedules (milliseconds). */
  tickIntervalMs: number;
  /**
   * How long after firing a completed one_shot row is retained before
   * the janitor deletes it. Defaults to 7 days.
   */
  oneShotRetentionMs: number;
  /**
   * How often the janitor sweeps for old one_shot rows to delete.
   * Defaults to 1 hour. The sweep is invoked from the scheduler tick loop
   * and is gated by a last-sweep timestamp so tick rate does not change
   * sweep frequency.
   */
  oneShotSweepIntervalMs: number;
}
```

- [ ] **Step 2: Extend the Zod schema.**

In `src/core/config/config-schema.ts`, replace lines 144–146:

```typescript
export const SchedulerConfigSchema = z.object({
  tickIntervalMs: z.number().int().min(1000).default(5000),
  oneShotRetentionMs: z
    .number()
    .int()
    .min(60_000)
    .default(7 * 24 * 60 * 60 * 1000),
  oneShotSweepIntervalMs: z
    .number()
    .int()
    .min(60_000)
    .default(60 * 60 * 1000),
});
```

- [ ] **Step 3: Update any sites that construct `ScheduleConfig` literally.**

Run: `grep -rn "ScheduleConfig" /home/talon/talon/src /home/talon/talon/tests | grep -v ".d.ts"`
Expected: a few hits. For each test/factory that builds a `ScheduleConfig` literal without the new fields, add `oneShotRetentionMs: 0, oneShotSweepIntervalMs: 0` (or sensible defaults) so the test still type-checks. If they go through `SchedulerConfigSchema.parse({})`, no edit is needed — the defaults apply.

- [ ] **Step 4: Typecheck.**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit.** (Janitor logic comes in Task 9; this just lands the config slot.)

```bash
git add src/scheduler/schedule-types.ts src/core/config/config-schema.ts
git commit -m "feat(scheduler): add one_shot retention + sweep interval config"
```

---

## Task 9: Janitor — sweep completed one-shots from the tick loop

**Files:**
- Modify: `src/core/database/repositories/schedule-repository.ts`
- Modify: `src/scheduler/scheduler.ts`
- Test: `tests/unit/scheduler/scheduler.test.ts`
- Test: `tests/unit/core/database/repositories/schedule-repository.test.ts` (path may differ)

- [ ] **Step 1: Write a failing repo test for `deleteOldOneShots`.**

Add to the schedule-repository test file:

```typescript
describe('deleteOldOneShots', () => {
  it('deletes one_shot rows whose last_run_at is older than the cutoff', () => {
    const repo = new ScheduleRepository(db);
    seedPersonaAndThread(db);

    const now = Date.now();
    const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000;
    const yesterday = now - 24 * 60 * 60 * 1000;

    db.prepare(
      `INSERT INTO schedules (id, persona_id, thread_id, type, expression, payload,
                              enabled, last_run_at, next_run_at, created_at, updated_at)
       VALUES (?, 'p1', 't1', 'one_shot', '...', '{}', 0, ?, null, ?, ?)`,
    ).run('old', twoWeeksAgo, twoWeeksAgo, twoWeeksAgo);

    db.prepare(
      `INSERT INTO schedules (id, persona_id, thread_id, type, expression, payload,
                              enabled, last_run_at, next_run_at, created_at, updated_at)
       VALUES (?, 'p1', 't1', 'one_shot', '...', '{}', 0, ?, null, ?, ?)`,
    ).run('recent', yesterday, yesterday, yesterday);

    db.prepare(
      `INSERT INTO schedules (id, persona_id, thread_id, type, expression, payload,
                              enabled, last_run_at, next_run_at, created_at, updated_at)
       VALUES (?, 'p1', 't1', 'cron', '*/5 * * * *', '{}', 0, ?, null, ?, ?)`,
    ).run('old-cron', twoWeeksAgo, twoWeeksAgo, twoWeeksAgo);

    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    const result = repo.deleteOldOneShots(cutoff);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(1);

    const ids = db.prepare(`SELECT id FROM schedules ORDER BY id`).all() as { id: string }[];
    expect(ids.map((r) => r.id)).toEqual(['old-cron', 'recent']);
  });

  it('does not delete active (enabled=1) one_shot rows even if old', () => {
    const repo = new ScheduleRepository(db);
    seedPersonaAndThread(db);
    const ancient = Date.now() - 100 * 24 * 60 * 60 * 1000;
    db.prepare(
      `INSERT INTO schedules (id, persona_id, thread_id, type, expression, payload,
                              enabled, last_run_at, next_run_at, created_at, updated_at)
       VALUES ('still-active', 'p1', 't1', 'one_shot', '...', '{}', 1, null, ?, ?, ?)`,
    ).run(ancient + 60_000, ancient, ancient);

    const result = repo.deleteOldOneShots(Date.now());
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(0);
    expect(db.prepare(`SELECT count(*) AS c FROM schedules`).get()).toEqual({ c: 1 });
  });
});
```

- [ ] **Step 2: Run the failing test.**

Run: `npx vitest run tests/unit/core/database/repositories/schedule-repository.test.ts -t "deleteOldOneShots"`
Expected: FAIL — method doesn't exist.

- [ ] **Step 3: Add `deleteOldOneShots` to the repository.**

In `src/core/database/repositories/schedule-repository.ts`, add a prepared statement next to the others:

```typescript
private readonly deleteOldOneShotsStmt: Database.Statement;
```

initialize it in the constructor:

```typescript
this.deleteOldOneShotsStmt = db.prepare(`
  DELETE FROM schedules
   WHERE type = 'one_shot'
     AND enabled = 0
     AND last_run_at IS NOT NULL
     AND last_run_at < @cutoff
`);
```

and add the public method:

```typescript
/**
 * Delete one_shot rows that fired (enabled=0, last_run_at set) before `cutoff`.
 * Returns the number of rows deleted.
 */
deleteOldOneShots(cutoff: number): Result<number, DbError> {
  try {
    const info = this.deleteOldOneShotsStmt.run({ cutoff });
    return ok(info.changes);
  } catch (cause) {
    return err(
      new DbError(
        `Failed to delete old one_shot schedules: ${String(cause)}`,
        cause instanceof Error ? cause : undefined,
      ),
    );
  }
}
```

(Imports `ok`/`err` from `neverthrow` and `DbError` are already present in the file.)

- [ ] **Step 4: Run the repo test.**

Run: `npx vitest run tests/unit/core/database/repositories/schedule-repository.test.ts -t "deleteOldOneShots"`
Expected: both cases PASS.

- [ ] **Step 5: Write a failing scheduler test for the sweep.**

Add to `tests/unit/scheduler/scheduler.test.ts`:

```typescript
describe('one-shot janitor', () => {
  it('deletes completed one-shots older than oneShotRetentionMs on tick', async () => {
    const ancient = Date.now() - 30 * 24 * 60 * 60 * 1000;
    db.prepare(
      `INSERT INTO schedules (id, persona_id, thread_id, type, expression, payload,
                              enabled, last_run_at, next_run_at, created_at, updated_at)
       VALUES ('expired', ?, ?, 'one_shot', '...', '{}', 0, ?, null, ?, ?)`,
    ).run(personaId, threadId, ancient, ancient, ancient);

    // Build a scheduler with a tight retention to force a sweep immediately.
    scheduler = makeScheduler(db, queueStub, personaLoaderStub, logger, {
      tickIntervalMs: 50,
      oneShotRetentionMs: 24 * 60 * 60 * 1000,
      oneShotSweepIntervalMs: 1, // sweep on the first tick
    });

    scheduler.start();
    await wait(150);
    scheduler.stop();

    const row = db.prepare(`SELECT id FROM schedules WHERE id = 'expired'`).get();
    expect(row).toBeUndefined();
  });

  it('does not sweep more often than oneShotSweepIntervalMs', async () => {
    const spy = vi.spyOn(scheduleRepo, 'deleteOldOneShots');

    scheduler = makeScheduler(db, queueStub, personaLoaderStub, logger, {
      tickIntervalMs: 25,
      oneShotRetentionMs: 60_000,
      oneShotSweepIntervalMs: 10 * 60_000, // 10 minutes
    });

    scheduler.start();
    await wait(200); // ~8 ticks at 25ms
    scheduler.stop();

    // First tick triggers the sweep; subsequent ticks should be skipped.
    expect(spy.mock.calls.length).toBe(1);
  });
});
```

The test references `makeScheduler` — check `tests/unit/scheduler/helpers.ts` for the existing scheduler factory and pass the new fields through it; if the helper doesn't accept a `ScheduleConfig` override, add one.

- [ ] **Step 6: Run the failing scheduler tests.**

Run: `npx vitest run tests/unit/scheduler/scheduler.test.ts -t "one-shot janitor"`
Expected: both FAIL.

- [ ] **Step 7: Implement the sweep in `Scheduler`.**

In `src/scheduler/scheduler.ts`, add a private field next to `generation`:

```typescript
/** Epoch ms of the last one_shot janitor sweep. 0 = never swept. */
private lastSweepAt = 0;
```

Then add a private method:

```typescript
/**
 * Delete completed one_shot rows older than the configured retention.
 * Gated by `oneShotSweepIntervalMs` so tick rate does not change sweep cost.
 */
private sweepCompletedOneShots(now: number): void {
  if (now - this.lastSweepAt < this.config.oneShotSweepIntervalMs) {
    return;
  }
  this.lastSweepAt = now;
  const cutoff = now - this.config.oneShotRetentionMs;
  const result = this.scheduleRepo.deleteOldOneShots(cutoff);
  if (result.isErr()) {
    this.logger.error(
      { err: result.error, cutoff },
      'scheduler: one_shot janitor sweep failed',
    );
    return;
  }
  if (result.value > 0) {
    this.logger.info(
      { deleted: result.value, cutoff },
      'scheduler: one_shot janitor swept expired rows',
    );
  }
}
```

In the existing `tick()` method, right after the `findDue` block completes (before the `finally` that re-arms the timer), call:

```typescript
this.sweepCompletedOneShots(now);
```

Make sure `now` is in scope (it's defined at the top of `tick` as `const now = Date.now();`).

- [ ] **Step 8: Run the scheduler tests.**

Run: `npx vitest run tests/unit/scheduler/scheduler.test.ts`
Expected: all scheduler tests pass, including the two new janitor cases.

- [ ] **Step 9: Codex review.**

Invoke `skill-codex:codex` with the diff of `schedule-repository.ts`, `scheduler.ts`, and the two test files. Pay attention to: index usage on the new DELETE, sweep gating correctness, and any race between sweep and a one_shot that just fired in the same tick.

- [ ] **Step 10: Commit.**

```bash
git add src/core/database/repositories/schedule-repository.ts \
        src/scheduler/scheduler.ts \
        tests/unit/scheduler/scheduler.test.ts \
        tests/unit/core/database/repositories/schedule-repository.test.ts
git commit -m "feat(scheduler): add janitor that deletes old completed one_shot rows"
```

---

## Task 10: Documentation

**Files:**
- Modify: `templates/tool-instructions/schedule.manage.md`
- Modify: `.claude/skills/manage-schedules/SKILL.md`
- Modify: `README.md`

- [ ] **Step 1: Update the tool instructions agents receive in their system prompt.**

Replace `templates/tool-instructions/schedule.manage.md` with:

```markdown
## Schedule Management

Use `schedule_manage` to create, list, update, cancel, or delete scheduled
tasks. Schedules are durable and execute under your persona context.

**Recurring tasks — use `type="cron"` (default):**

```json
{
  "action": "create",
  "type": "cron",
  "cronExpr": "*/30 9-17 * * 1-5",
  "label": "weekday standup nudge",
  "prompt": "send a standup reminder"
}
```

**One-time reminders — use `type="one_shot"`. Pick exactly one of `runAt`
(ISO-8601 timestamp) or `runInSeconds` (positive seconds from now).** One-shots
auto-disable after firing and are cleaned up by the janitor after the
configured retention period — do NOT use a cron expression for a one-time
reminder; those rows leak.

```json
{
  "action": "create",
  "type": "one_shot",
  "runInSeconds": 3600,
  "label": "follow-up in 1 hour",
  "prompt": "check whether the user replied to the previous question"
}
```

Bounds: `runAt` must be in the future and within 365 days from now.
```

- [ ] **Step 2: Update the `manage-schedules` skill.**

Edit `.claude/skills/manage-schedules/SKILL.md` to mention one-shots. Find the step that explains cron creation and add a note about `type=one_shot` with `runAt`/`runInSeconds`. Keep it concise — one paragraph + one example.

- [ ] **Step 3: Update the README scheduler section.**

In `README.md` at line 133 (the Scheduler bullet), no change needed — it already mentions "cron, interval, and one-shot scheduled tasks." But in the `schedules` table description at line 403 and `schedule.manage` row at line 892, ensure the description mentions one-shots are agent-creatable. Add a short subsection or note near line 1761 (`add-schedule` examples) that points to the host-tool for one-shots:

```markdown
> **Tip:** For one-time reminders triggered from inside an agent run, prefer
> the `schedule_manage` host-tool with `type="one_shot"` and `runInSeconds`
> or `runAt`. The scheduler auto-cleans completed one-shots after the
> configured retention (`scheduler.oneShotRetentionMs`, default 7 days).
> Avoid using `add-schedule` with a one-time cron expression — those rows
> are not auto-cleaned.
```

Also, in the config reference section, document the two new scheduler keys.

Find the existing `scheduler:` block (around line 349) and extend it:

```yaml
scheduler:
  tickIntervalMs: 5000
  oneShotRetentionMs: 604800000   # 7 days; how long to retain fired one_shot rows
  oneShotSweepIntervalMs: 3600000 # 1 hour; how often to sweep
```

- [ ] **Step 4: Run lint and a focused test sweep.**

Run:
```bash
npm run lint
npx vitest run tests/unit/scheduler/ tests/unit/tools/host-tools/schedule-manage.test.ts tests/unit/core/database/
```
Expected: lint clean, all targeted tests pass.

- [ ] **Step 5: Codex review.**

Invoke `skill-codex:codex` on the doc diffs. Address any clarity issues raised.

- [ ] **Step 6: Commit.**

```bash
git add templates/tool-instructions/schedule.manage.md \
        .claude/skills/manage-schedules/SKILL.md \
        README.md
git commit -m "docs(scheduler): document one_shot host-tool usage and janitor config"
```

---

## Task 11: Final QA

**Files:** none (verification only).

- [ ] **Step 1: Confirm the full test suite passes.**

Per CLAUDE.md, the full suite is slow — ask the user before kicking it off. If approved:

Run: `npm test`
Expected: full suite passes.

If the user prefers to skip, run at minimum:
```bash
npx vitest run tests/unit/scheduler/ \
                tests/unit/tools/host-tools/ \
                tests/unit/core/database/
```

- [ ] **Step 2: Lint + format.**

Run: `npm run lint && npm run format`
Expected: both clean.

- [ ] **Step 3: Build.**

Run: `npm run build`
Expected: build succeeds; the new migration SQL is copied to `dist/`.

- [ ] **Step 4: Diff vs `main`.**

Run: `git log --oneline origin/main..HEAD`
Expected: 6 commits (Tasks 2, 4, 6, 7, 8, 9, 10 — note Task 8 is its own commit).

- [ ] **Step 5: Final whole-branch codex review.**

Invoke `skill-codex:codex` and ask it to review the whole branch diff (`git diff origin/main...HEAD`). Confirm zero critical/high/medium issues remain per CLAUDE.md before merging.

- [ ] **Step 6: Open the PR (or hand back to the user).**

Don't push or open the PR yourself unless the user has explicitly asked for it. Summarize the work back to the user and offer to push.

---

## Spec coverage check

| Original requirement | Covered by |
| --- | --- |
| Remove `event` schedule type | Tasks 2, 3, 4 (migration + type narrowing + scheduler branch + tests) |
| Expose `one_shot` to agents via host-tools | Tasks 5, 6, 7 (create path, update path, MCP schema) |
| Auto-cleanup of one-shot rows | Tasks 8, 9 (config + repo method + scheduler sweep) |
| Leave `interval` alone | No interval-touching tasks in this plan |
| Docs reflect the new feature (per CLAUDE.md) | Task 10 |
| Codex review before each commit | Embedded in Tasks 2, 4, 6, 7, 9, 10, 11 |
