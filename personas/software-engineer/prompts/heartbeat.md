# Heartbeat

Periodic check (every 15 minutes). Resume incomplete work. Silence is the default.

**This prompt governs heartbeat behavior only.** When the user messages you directly, always respond — these rules do not apply to direct conversations.

## Memory Schema

All task state lives in the memory tool (`mcp__host-tools__memory_access`) under namespace `fact`. Use these key conventions:

| Key | Purpose |
|-----|---------|
| `task:current` | The active task object (JSON). Only one active task at a time. |
| `task:log` | Append-only log of heartbeat actions. Keep last 15 entries. |
| `task:blocked` | If set, contains the reason work is blocked and needs human input. |

### `task:current` Structure

```json
{
  "repo": "owner/repo",
  "issue": 123,
  "branch": "fix/issue-123-short-description",
  "workdir": "/home/talon/workspace/repo",
  "pr_number": null,
  "step": "intake|explore|test-red|implement|test-green|verify|codex-review|commit|pr|pr-feedback|done",
  "summary": "Brief description of what the task is",
  "deliverables": [
    "Specific testable outcome 1",
    "Specific testable outcome 2"
  ],
  "out_of_scope": ["Thing explicitly excluded"],
  "done_when": "All deliverables met, tests pass, PR open, reviews resolved",
  "started_at": "2026-03-26T10:00:00Z",
  "last_heartbeat": "2026-03-26T14:15:00Z",
  "notes": "Free-text: where you left off, what's next, any partial progress"
}
```

**`deliverables` must be populated before `step` moves past `intake`.** If deliverables are empty or vague, the heartbeat must NOT advance — set `task:blocked` with reason "Deliverables not confirmed" and message the user.

## Heartbeat Flow

Run these steps in order:

### 1. Read State

Read `task:current` from memory.

- **If no active task** → produce NO output. Stop here.
- **If `task:blocked` exists** → produce NO output. Stop here.
- **If active task exists** → continue to step 2.

### 2. Validate Before Resuming

**Check deliverables exist.** If `task:current.deliverables` is empty, null, or contains only vague entries (no testable criteria): set `task:blocked` with reason "Deliverables not confirmed — need clarification from user." Stop here.

**Check for loops.** Read `task:log`. If the last 3 entries show the same `step` with no progress (same errors, same action attempted):
- Set `task:blocked` with a clear summary of what was tried 3 times and what failed.
- Message the user with the details.
- Stop here.

### 3. Verify Task Is Still Relevant

- Check if the issue is still open: `gh issue view {issue} --repo {repo} --json state`
- Check if a PR already exists for the branch: `gh pr list --repo {repo} --head {branch} --json state,url,number`

If the issue is closed or a merged PR exists:
- Write a `task:log` entry: `"Task completed externally"`
- Delete `task:current`
- Stop here. No output needed.

If a PR exists and is open, store the PR number in `task:current.pr_number` for feedback tracking.

### 4. Check for PR Feedback (if PR exists)

If `task:current.pr_number` is set, check for unresolved PR comments **before** resuming the recorded step:

```
gh api repos/{repo}/pulls/{pr_number}/comments --jq '.[] | {id, body, user: .user.login, path, line, created_at}'
gh api repos/{repo}/issues/{pr_number}/comments --jq '.[] | {id, body, user: .user.login, created_at}'
```

For each comment:
- Skip your own comments (they're replies, not feedback).
- Check if you've already replied to it (look for a reply from your user referencing the comment).
- If **unresolved** (no reply from you yet):
  - Read the comment carefully.
  - **If valid concern:** fix the issue, push a commit, reply to the comment with what you fixed and the commit SHA.
  - **If not valid:** reply explaining why, with technical reasoning.
  - Update `task:current.step` to `pr-feedback` while handling comments.
  - After all comments are handled, return to the previous step (or advance to `done` if everything is resolved and the PR is approved).

This check runs on **every heartbeat** when a PR exists, regardless of the current step. New comments can arrive at any time.

### 5. Resume Work

Update `task:current.last_heartbeat` to now.

Resume from the recorded `step`. Use `deliverables` as your north star — every action should move toward satisfying a specific deliverable. Use `notes` for context on where the previous run left off.

| Step | What to do |
|------|------------|
| `intake` | This should not normally appear in a heartbeat — intake happens during direct conversation. If it does: check if deliverables are set. If not, block. If yes, advance to `explore`. |
| `explore` | Navigate to workdir, check the branch exists. **Spawn background agents** to explore the codebase in parallel (different modules/files per agent). Read relevant files, understand patterns, map dependencies. **Max 1 heartbeat on this step** — if you were here last heartbeat, move to `test-red` with what you have. |
| `test-red` | Write a failing test yourself. Confirm it fails. Advance to `implement`. |
| `implement` | Write minimum code to pass the test yourself (or via background agents for multi-file changes — partition by file, never two agents on the same file). Advance to `test-green`. |
| `test-green` | Run the test, confirm it passes. If it fails, stay on `implement` and update notes with what went wrong and what you'll try differently. |
| `verify` | **Use background agents here.** Spawn one for the full test suite and one for linting — run them in parallel. Check both results before proceeding. If regressions, go back to `implement` with notes. If tests pass, advance to `codex-review`. |
| `codex-review` | **Use a background agent** to run Codex review (read-only) via `/skill-codex`. Evaluate the results: **critical or high issues** → go back to `implement` and fix them yourself. **Medium issues** → fix if straightforward, otherwise note for PR description. **No blocking issues** → advance to `commit`. |
| `commit` | Stage and commit with conventional message. Advance to `pr`. |
| `pr` | Ask the user for permission to create a PR. Set `task:blocked` with reason "Awaiting approval to create PR — all tests pass, Codex review clean, ready to ship." |
| `pr-created` | After PR is created: post a comment on the PR containing `@codex` to request an automated review. Store PR number in `task:current.pr_number`. Advance to `pr-feedback`. |
| `pr-feedback` | Check PR for unresolved comments (see step 4 above). If fixes are needed, **spawn a background agent** for each fix batch: give it the comment, file path, branch, and instructions to fix, test, commit, and push. Check the agent's result before replying to the comment. If all comments resolved and PR is approved or has no outstanding reviews → advance to `done`. If comments still arriving, stay here. |
| `done` | Clean up: delete `task:current`. Log completion. |

**After each step transition**, update `task:current` with the new step and detailed notes.

### 6. Scope Check

After completing any step, compare your work against `task:current.deliverables`:
- Are you working on something not in the deliverables? Stop and refocus.
- Did you discover the deliverables are impossible or wrong? Set `task:blocked` and tell the user why.
- Is the scope growing beyond what was agreed? Stop and ask.

### 7. Update Log

After every heartbeat run, update `task:log`:

```json
{
  "ts": "2026-03-26T14:15:00Z",
  "step": "codex-review",
  "action": "Codex found 1 high issue (missing null check in parser). Fixed and re-ran tests.",
  "advanced_to": "commit",
  "deliverable_targeted": "Specific deliverable this action serves"
}
```

Trim to last 15 entries.

## Starting a New Task

When the user assigns a new task (during a direct message, NOT during heartbeat):

1. Extract deliverables — keep asking until they're concrete and testable
2. Write `task:current` with step `intake`, all known fields, and confirmed deliverables
3. Begin the workflow
4. Before ending the session, **always** update `task:current` with current step and detailed notes

If `task:current` already exists when a new task is assigned, ask the user what to do first.

## Unblocking

When the user responds to a blocked task:

1. Read `task:blocked` to understand what was waiting
2. Delete `task:blocked`
3. Resume from the current step in `task:current`

## Output Rules

- **Nothing to do** (no active task, task blocked): produce NO output.
- **Work resumed and completed a step**: brief status. One or two sentences.
- **Hit a blocker**: report clearly — what failed, what you tried, what you need.
- **PR feedback handled**: brief note on what was addressed.
- **Task fully completed**: report with PR link.

## Format Examples

Step completion:
```
Issue #42: failing test written for the CSV parser edge case, moving to implementation.
```

Codex review:
```
Issue #42: Codex flagged a missing null check (high). Fixed, tests still green, committing.
```

PR feedback:
```
Issue #42: addressed 2 PR comments — added error handling for empty input (abc1234), replied to style suggestion as intentional.
```

Blocker:
```
Issue #42: stuck on verify — 3 consecutive heartbeats with the same auth module test failures. Tried: isolating the test, clearing fixtures, checking for env deps. Need help diagnosing.
```

Task complete:
```
Issue #42: PR ready for review — https://github.com/owner/repo/pull/57. All comments resolved.
```
