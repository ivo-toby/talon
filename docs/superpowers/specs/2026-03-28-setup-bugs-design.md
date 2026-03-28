# Fix: talonctl setup bugs (issue #106)

Three bugs block the first-run experience, plus a new `list-capabilities` CLI command and setup skill for capability configuration.

## Bug 1: `add-schedule` fails when persona/channel not in DB

### Problem

`addSchedule()` queries the DB for persona and channel rows. During first-time setup the daemon has never run, so the DB is empty. The command fails with `Unknown persona: "james"`.

### Fix

In `addScheduleCommand()` (the CLI wrapper), after loading config and opening the DB, seed the persona and channel from config into the DB before calling `addSchedule()`. This mirrors what the daemon does on boot.

Specifically:
1. Load config (already done).
2. Find the persona config entry by name.
3. Upsert the persona row via `PersonaRepository` (same pattern as `PersonaLoader.upsertPersona`).
4. Find the channel config entry by name.
5. Upsert the channel row via `ChannelRepository`.
6. Then call `addSchedule()` as before.

This keeps `addSchedule()` (the pure function) unchanged -- it still queries the DB. The CLI wrapper ensures the DB is populated first.

### Files changed

- `src/cli/commands/add-schedule.ts` -- add seeding logic in `addScheduleCommand()`

## Bug 2: Daemon does not sync bindings on config change

### Problem

`registerChannels()` only creates a default binding if none exists. If the YAML config changes (e.g., terminal channel moves from persona `assistant` to `james`), the stale DB binding persists. Messages route to the wrong persona.

The `bind` CLI command writes a `bindings` array to `talond.yaml`, but the daemon ignores it -- `bindings` is not in the Zod config schema.

### Fix

Two parts:

**A. Add `bindings` to the config schema.**

Add a `BindingConfigSchema` to `config-schema.ts`:

```typescript
const BindingConfigSchema = z.object({
  persona: z.string(),
  channel: z.string(),
  isDefault: z.boolean().default(false),
});
```

Add `bindings: z.array(BindingConfigSchema).default([])` to `TalondConfigSchema`.

Export the type from `config-types.ts`.

**B. Reconcile bindings on boot in `registerChannels()`.**

After seeding channel rows (existing logic), add a binding reconciliation step:

1. Read `config.bindings` (the YAML source of truth).
2. For each binding in config:
   - Look up channel and persona by name in the DB.
   - Check if a DB binding already exists for this channel (default or thread-scoped).
   - If the existing binding points to a different persona, update it (delete old, insert new).
   - If no binding exists, insert it.
   - Mark `isDefault` based on the config entry.
3. Remove any DB default bindings for channels that are NOT in `config.bindings` but DO have a config binding pointing elsewhere. (Don't remove bindings for channels with no config binding -- the auto-default-to-first-persona fallback still applies for those.)

The existing auto-default logic (bind to first persona if no binding exists) remains as a fallback for channels not explicitly bound in config.

### Files changed

- `src/core/config/config-schema.ts` -- add `BindingConfigSchema`, add `bindings` to `TalondConfigSchema`
- `src/core/config/config-types.ts` -- export `BindingConfig` type
- `src/channels/channel-setup.ts` -- add `reconcileBindings()` function, call it from `registerChannels()`
- `src/core/database/repositories/binding-repository.ts` -- add `deleteByChannelDefault()` method (delete default binding for a channel) and `updatePersona()` method

## Bug 3: `add-persona` creates empty capabilities

### Problem

`add-persona` scaffolds `capabilities: { allow: [], requireApproval: [] }`. Default-deny means the persona can't use any host tools. First-time users get a silent, non-functional agent.

### Fix

Use sensible defaults. Based on the host tool registry in `tool-filter.ts`, a reasonable starter set:

```typescript
capabilities: {
  allow: [
    'memory.read:thread',
    'memory.write:thread',
    'net.http:egress',
    'schedule.manage:own',
  ],
  requireApproval: [],
}
```

This gives the persona: memory access (essential for continuity), HTTP egress (web search/fetch), and schedule self-management. It does NOT give: `channel.send:*` (cross-channel messaging), `db.query` (raw DB), `subagent.invoke`, `subagent.background` -- those are opt-in.

Also add a console hint after persona creation:

```
Capabilities: memory, http, schedule (defaults). Edit talond.yaml or run `talonctl manage-capabilities` to customize.
```

### Files changed

- `src/cli/commands/add-persona.ts` -- change default capabilities, add console hint

## New: `list-capabilities` CLI command

### Purpose

Lists all available capability labels that can be used in persona config. Reads from the host tool registry (single source of truth) and formats them for human consumption.

### Output format

```
Available capability labels:

  Tool: memory.access (memory_access)
    memory.read:thread     Read per-thread memory items
    memory.write:thread    Write/delete per-thread memory items

  Tool: net.http (net_http)
    net.http:egress        Make outbound HTTP requests

  Tool: channel.send (channel_send)
    channel.send:*         Send messages to any channel

  Tool: schedule.manage (schedule_manage)
    schedule.manage:own    Create/update/delete schedules

  Tool: db.query (db_query)
    db.read:own            Query the database (read-only)

  Tool: subagent.invoke (subagent_invoke)
    subagent.invoke        Invoke sub-agents synchronously

  Tool: subagent.background (background_agent)
    subagent.background    Launch background agent tasks

Usage: Add labels to `capabilities.allow` in your persona config.
Example: capabilities: { allow: ["memory.read:thread", "net.http:egress"] }
```

### Implementation

The capability labels and their descriptions need a registry. Currently the host tools each declare their `capabilities` array in their handler classes, but there's no centralized description mapping.

Add a `CAPABILITY_DESCRIPTIONS` map to `tool-filter.ts`:

```typescript
export const CAPABILITY_DESCRIPTIONS: ReadonlyArray<{
  capabilityPrefix: string;
  labels: ReadonlyArray<{ label: string; description: string }>;
}> = [
  {
    capabilityPrefix: 'memory.access',
    labels: [
      { label: 'memory.read:thread', description: 'Read per-thread memory items' },
      { label: 'memory.write:thread', description: 'Write/delete per-thread memory items' },
    ],
  },
  // ... one entry per tool
];
```

The CLI command reads this registry and formats it.

### Files changed

- `src/tools/tool-filter.ts` -- add `CAPABILITY_DESCRIPTIONS` export
- `src/cli/commands/list-capabilities.ts` -- new file, CLI command
- `src/cli/index.ts` -- register the new command

## New: `set-capabilities` CLI command

### Purpose

Programmatically set capability labels on a persona without manually editing `talond.yaml`. Works as the write counterpart to `list-capabilities`.

### Usage

```bash
# Set capabilities (replaces the entire allow list)
npx talonctl set-capabilities --persona james --allow "memory.read:thread,memory.write:thread,net.http:egress"

# Add a single capability to the existing list
npx talonctl set-capabilities --persona james --add "channel.send:*"

# Remove a capability from the existing list
npx talonctl set-capabilities --persona james --remove "net.http:egress"

# Set requireApproval labels
npx talonctl set-capabilities --persona james --require-approval "channel.send:*"

# Show current capabilities for a persona
npx talonctl set-capabilities --persona james --show
```

### Flags

| Flag | Description |
|------|-------------|
| `--persona <name>` | Required. Target persona. |
| `--allow <labels>` | Comma-separated list. Replaces the entire `allow` array. |
| `--add <labels>` | Comma-separated. Appends to existing `allow` (no duplicates). |
| `--remove <labels>` | Comma-separated. Removes from `allow`. |
| `--require-approval <labels>` | Comma-separated. Replaces `requireApproval` array. |
| `--show` | Print current capabilities and exit. |

`--allow` and `--add`/`--remove` are mutually exclusive (replace vs. incremental).

### Validation

Before writing, validate every label against `CAPABILITY_DESCRIPTIONS`. Warn (not error) on unrecognized labels -- the user might have custom tools. Print what changed:

```
Updated capabilities for persona "james":
  allow:
    + memory.read:thread
    + memory.write:thread
    + net.http:egress
    - channel.send:*       (removed)
  requireApproval: (unchanged)
```

### Implementation

Same pattern as other CLI commands: pure function `setCapabilities()` + CLI wrapper `setCapabilitiesCommand()`. Reads config via `readConfig()`, finds the persona entry, mutates `capabilities`, writes back via `writeConfigAtomic()`.

### Files changed

- `src/cli/commands/set-capabilities.ts` -- new file
- `src/cli/index.ts` -- register the new command

## New: Setup skill update

### Purpose

Update the existing `talon-setup` skill (`.claude/skills/talon-setup/SKILL.md`) to include a capability configuration step. Add `list-capabilities` to the available commands table. Add a step between persona creation and scheduled tasks where the skill guides the user through capability selection.

### Skill flow addition (after Step 5: Persona configuration)

```
### Step 5b: Capabilities

After creating a persona, show available capabilities:

Run: `npx talonctl list-capabilities`

The persona was created with sensible defaults (memory, http, schedule).
Ask: "Want to adjust capabilities for {name}? Here's what's available."

Show the output and help the user decide which to enable/disable.
Use `npx talonctl set-capabilities --persona {name} --add <labels>` to apply changes.
```

### Files changed

- `.claude/skills/talon-setup/SKILL.md` -- add `list-capabilities` and `set-capabilities` to commands table, add Step 5b

## Testing strategy

- **Bug 1**: Unit test that `addSchedule()` succeeds when persona/channel rows are pre-seeded. Integration test that `addScheduleCommand()` seeds from config.
- **Bug 2**: Unit test for `reconcileBindings()` -- verify it updates stale bindings, removes orphans, adds new ones. Test the auto-default fallback still works when no explicit binding exists.
- **Bug 3**: Snapshot test that `addPersona()` returns non-empty capabilities.
- **list-capabilities**: Unit test that the command outputs all known capability labels.
- **set-capabilities**: Unit test for `--allow` (replace), `--add` (append), `--remove` (delete), `--show` (read-only). Test validation warns on unknown labels. Test mutual exclusivity of `--allow` vs `--add`/`--remove`.
