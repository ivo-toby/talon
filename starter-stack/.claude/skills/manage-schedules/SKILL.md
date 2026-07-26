---
name: manage-schedules
description: |
  Manage scheduled tasks for Talon personas. Use when the user says
  "add schedule", "create schedule", "list schedules", "remove schedule",
  "scheduled task", or "cron job".
triggers:
  - "add schedule"
  - "create schedule"
  - "list schedules"
  - "remove schedule"
  - "scheduled task"
  - "cron job"
---

# Manage Schedules

Guide the user through creating, listing, or removing scheduled tasks.
Schedules live in the database (not the config file) and require a running daemon to fire.

## Phase 1: Determine Action

Ask what they want to do:
1. **Create** a new scheduled task
2. **List** existing schedules
3. **Remove** a schedule
4. **Create a behavior-review reminder** for lifecycle candidates

## Phase 2a: Create Schedule

1. Run `npx talonctl list-personas` to show available personas.
2. Ask which persona should run the task.
3. Run `npx talonctl list-channels` to show available channels.
4. Ask which channel to bind the schedule to (this creates a thread for the schedule on that channel).
5. Ask for the cron expression. Offer common presets:
   - Every hour: `0 * * * *`
   - Twice daily (9am, 9pm): `0 9,21 * * *`
   - Daily at 9am: `0 9 * * *`
   - Every Monday at 9am: `0 9 * * 1`
   - Every 30 minutes: `*/30 * * * *`
6. Ask for a label (short name like `memory-grooming` or `git-pull-notes`).
7. Ask for the prompt (what the agent should do when triggered).
8. Run: `npx talonctl add-schedule --persona <name> --channel <channel> --cron "<expr>" --label "<label>" --prompt "<prompt>" --config talond.yaml`
9. Confirm with schedule ID and next run time.

For behavior-review reminders, suggest a narrow operator-facing prompt such as:

```text
Review recent lifecycle behavior candidates for this persona. Summarize the
candidate IDs, evidence-source counts, confidence, and whether any need
operator approval. Do not edit prompt files directly; tell the operator to use
talonctl lifecycle promote or rollback-promotion.
```

The actual promotion/rollback path is governed by lifecycle IPC commands:

```bash
npx talonctl lifecycle candidates <persona> --limit 25
npx talonctl lifecycle promote <persona> <promotion-id> --approved-by <operator-id>
npx talonctl lifecycle rollback-promotion <persona> <activation-id> --reason operator-rejected
```

## Phase 2b: List Schedules

Run: `npx talonctl list-schedules --config talond.yaml`
Optionally filter: `--persona <name>`

## Phase 2c: Remove Schedule

1. Run `npx talonctl list-schedules` to show existing schedules.
2. Ask which schedule to remove (by ID).
3. Run: `npx talonctl remove-schedule <id> --config talond.yaml`

## Notes

- Schedules fire in system local time (CET on the VM).
- Schedule output is silent -- the agent only sends messages if it explicitly uses channel.send.
- The daemon must be running for schedules to fire (they live in the DB, not the config).
- Behavior-review schedules may summarize candidates, but they must not directly
  rewrite system prompts. Use lifecycle promotion commands for governed changes.
- After creating schedules, remind the user: schedules require a running daemon to execute.
