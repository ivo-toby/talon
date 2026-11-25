# Talon scripts: code mode for routines and for agents

Status: proposed design, 2026-11-25. Not approved. Nothing in this document is built, except the execution broker on branch `feat/execution-broker-contract`.

## Intent

Ivo wants the assistant to be faster and cheaper. The measurements below show that the cost comes from the number of model steps, not from the size of tool results. A Talon script is a small TypeScript program that calls tools. Talon runs it without a model step between the tool calls.

A script has two uses.

- Static code mode. The agent writes a script one time, with tests. The user approves its behavior. A schedule then runs the stored script.
- Dynamic code mode. The agent writes a script for one request. Talon runs it one time and returns the result.

Both uses share one runtime, one SDK, and one sandbox. This document designs the shared parts and the static use. The dynamic use is a later slice.

## Measurements

Source: Langfuse and the Talon database on the live host `talon-vm`, read on 2026-11-25. The persona is `assistant` on the `openai-compatible` provider.

- 7 days: 608 runs and about 250 million input tokens. That is about 410,000 input tokens per run.
- 3 days: 274 runs and 107 million input tokens. 143 runs made 11 or more tool calls and used 77 million tokens. Almost all of these start on the hour or the half hour.
- The schedules behind these runs are `mail-intake` (every 30 minutes), `heartbeat` (every hour) and `braintoss` (every hour).
- Each run repeats the same tool calls in the same order. Example: time, memory read (4), mail accounts, mail metadata (4), Gmail search, memory write (3).
- Tool results are small. Talon cuts them at about 4,000 characters. All results of the week together are less than 1 million tokens.
- A run with no tool call costs about 74,000 input tokens. Each additional model step costs an estimated 30,000 to 50,000 tokens. This estimate comes from averages per run.

Limits of the data: Langfuse rate limits stopped the 7-day tool listing early. The token totals are complete. The cause of the 74,000-token base context is not measured. The suspected cause is the tool definitions of all MCP servers.

## Goals

1. A scheduled routine with nothing to do costs zero model tokens.
2. A scheduled routine with work to do uses one model request, or a small fixed number. That request contains only the data to judge.
3. The agent writes the script and its tests. The user does not write code.
4. The user approves behavior, not code. The approval shows what the script did on real data in dry-run mode.
5. A script has the tool rights of its persona and no more.
6. Script code that a model wrote never runs inside the Talon process.

## Non-goals

- Dynamic code mode in the first slice.
- Mastra workflows inside scripts. This can be added to the SDK later.
- A declarative workflow format. See Approaches.
- A smaller base context for normal conversations. This is a separate project.
- Support for the Claude Code, Codex and Gemini providers in the first slice. A script does not depend on the provider of the persona, but the authoring flow is tested only with `openai-compatible`.
- Read-write workspace mounts. The broker keeps these closed until a disk quota exists.

## Anti-goals

- A script that sends a message or changes data during a test.
- A changed script that runs on a schedule before the user approved the change.
- Email text that can cause a tool call. Mail is untrusted data.
- A second, weaker permission system next to persona capabilities.

## Approaches

Three ways were considered.

1. Fixed pre-step. Each schedule gets a hand-written list of tool calls that Talon runs before the model. This is small, but it is not a platform. Each routine needs a developer.
2. Declarative steps. The agent writes a YAML list of steps, and Talon turns it into a Mastra workflow. No sandbox is necessary because no foreign code runs. The mail intake was written out in this form. After ten lines it needed expressions, conditions, loops and nested steps. The calendar clash check did not fit. The result is a weak programming language that models know less well than TypeScript.
3. Code in a sandbox. The agent writes TypeScript against a Talon SDK. The script runs in a disposable container. Tools are called through a narrow channel to Talon.

Ivo chose approach 3 for both the static and the dynamic use. Reasons: one platform for both uses, full expressive power, and a language that models write well. The cost is the sandbox and the tool channel. The broker on this branch already supplies most of the sandbox.

## Design

### Parts

| Part | Purpose | State |
| ---- | ------- | ----- |
| Script SDK | Typed access to tools, memory, one model request, and notifications | New |
| Tool gateway | Runs a tool call from a script inside Talon, with persona rights and a mode | New |
| Sandbox | Runs the script in a hardened container | Broker exists, needs a tool channel |
| Script store | Keeps scripts, tests, versions and approval state | New |
| Test runner | Runs unit tests and the dry-run integration test | New |
| Approval | Shows dry-run behavior to the user and records the decision | New |
| Scheduler link | Lets a schedule run an approved script | Small change |
| Authoring skill and host tools | Teach the agent the procedure and let it do the steps | New |

### Script SDK

The script imports from `talon`. The SDK is a thin client. It holds no credentials and makes no network connection. Each call becomes a request on the tool channel.

- `tools.<server>.<tool>(input)`: one function per tool that the persona can use. This covers host tools and MCP tools. The types come from the tool input schemas.
- `memory.read`, `memory.write`: thread memory of the schedule thread.
- `model.judge({ prompt, input, output })`: one model request with no tools. `prompt` names a prompt file of the persona. `output` is a schema. Talon rejects a reply that does not match the schema.
- `notify(channel, text)`: send a message. This follows the `channel.send` capability.

`model.judge` uses the model of the persona. The manifest can name a different configured model. The daemon makes no model requests at this time, so this is a new small client in the daemon. The prompt file is part of the script directory and of its content hash.

On the Talon side, MCP tools are tool objects from the Mastra MCP client. At this time that client exists only inside the `agent-cli` child process of the `openai-compatible` provider. The daemon has no MCP client. The gateway therefore starts a helper process for each script run. The helper resolves the MCP servers of the persona in the same way as `agent-cli`, and it stops at the end of the run. A spike must measure the start time and the OAuth token handling before this choice is final.

Persona capabilities cover host tools only. An MCP server reaches a persona through its skills. The first slice uses two conditions for an MCP tool. Its server is attached to the persona, and the manifest lists the tool. A new capability vocabulary for MCP tools is not part of this design.

### Tool gateway and modes

The gateway is the only path from a script to a tool. For each call it does these checks in this order: the script run exists and is active, the manifest lists the tool, the persona can use the tool, and the mode allows the call. The manifest also lists each channel that `notify` can use. A live run is held to the manifest that the user approved.

There are three modes.

- `unit`: no tool runs. The test supplies fixed answers. A call with no fixed answer fails the test.
- `dry-run`: a read tool runs for real. A write tool does not run. The gateway records the call and its input, and returns a placeholder result that the test can set.
- `live`: all permitted tools run.

Each tool is `read` or `write`. Host tools get a fixed class in code. For an MCP tool, the gateway uses the `readOnlyHint` annotation of the tool. An operator can override the class per tool in the configuration. A tool with no information is `write`.

`model.judge` runs for real in `dry-run` and `live`. In `unit` the test supplies the answer.

### Sandbox and tool channel

The script runs in a container that the execution broker creates. The existing posture stays: digest-pinned image, non-root user, no network, read-only root file system, all capabilities dropped, and limits for memory, processes, CPU and time.

The broker currently starts a command and returns its output after the command ends. A script must exchange messages with Talon while it runs. The tool channel is the standard input and output of the exec, with one JSON message per line. The container keeps no network. This needs a streaming exec in the Docker backend, and that is new work on this branch.

Talon runs on the host on `talon-vm`, and Docker 29 is present there. Talon therefore uses the broker as a library in the same process. The separate Compose service and the HTTP API stay in the code for the Docker deployment of Talon. They are not part of the first slice.

The script directory is mounted read-only. The image contains Node.js, which runs TypeScript directly, and the SDK client.

### Script store

A script is a directory with `script.ts`, `script.test.ts`, optional fixture files and a manifest. The manifest holds the name, the persona, the tools that the script uses, and the content hash.

Each saved change is a new version. A version has one state: `draft`, `tested`, `awaiting-approval`, `approved`, `rejected` or `retired`. Approval is bound to the content hash. A schedule runs only the newest `approved` version. A new draft does not stop the approved version from running.

### Tests and approval

The agent must supply unit tests and one integration test. The flow has these steps.

1. The agent saves the script and the tests.
2. Talon runs the unit tests in the sandbox in `unit` mode. A failure returns to the agent.
3. Talon runs the script one time in `dry-run` mode on real data. The dry run must go through the work path. A script therefore accepts test input, for example a look-back window of 24 hours and an empty list of processed IDs. A dry run that did no work cannot be sent for approval.
4. Talon sends the user a summary on the channel of the persona. The summary lists what the script read and what it asked the model. It also lists each write that did not run, with the data of that write.
5. The user approves or rejects. Talon records the decision with the content hash.
6. After approval, the agent can attach the version to a schedule.

The user sees behavior. The code stays available on request.

The agent must not be able to approve its own script. Talon has no inbound approval path at this time. The `requireApproval` setting only removes tools from a persona, and no connector handles a button. The decision therefore needs a path that the model cannot call.

The approval message contains a short code that is bound to the content hash. The user replies with `/approve <code>` or `/reject <code>`. The message pipeline handles this reply before any agent sees it, and only for a sender that the channel already trusts. A code works one time and for one version. This form works on every channel. A Telegram button can be added later for less effort by the user.

### Scheduler link

A schedule payload currently names a prompt or a prompt file. A new payload form names a script. When such a schedule fires, Talon runs the approved version in `live` mode and does not start an agent run. The script decides whether a model request is necessary.

If a script fails, Talon records the failure and sends one message to the persona channel. It does not fall back to the old prompt.

### Authoring skill and host tools

A skill gives the agent the procedure to make a script. Example trigger: "check my email every hour". New host tools let the agent save a script, run its tests, request approval, and attach it to a schedule. Each tool has its own capability.

### Errors and audit

A script run has a hard time limit from the broker profile. A time-out ends the run and removes the container. Each run and each write tool call is recorded in `audit_log`. Each model request of `model.judge` is reported to Langfuse with the script name.

## First slice

The first slice is the mail intake as a stored script, from authoring to schedule. It includes the minimum of every part above. Success means these three results.

- A mail-intake run with no new mail uses zero model tokens.
- A run with new mail uses one model request that contains only the new mail and the classify prompt.
- The assistant wrote the script and its tests through the authoring skill.
- Ivo approved the script from a dry-run summary on Telegram with `/approve`.

After the first slice, measure the tokens again for one week. Then decide the order of `heartbeat`, `braintoss` and the dynamic use.

### The current mail intake

The prompt is `personas/assistant/prompts/mail-intake.md` on `talon-vm`. It is not in this repository. It does these steps in this order.

1. Get the time and read state from thread memory.
2. List new mail from IMAP and Gmail.
3. Classify each message.
4. Write ledger entries to Postgram and compare dated entries with the calendar.
5. Create follow-up tasks and send one alert to `TalonMain`.
6. Write state.

The mail and the calendar are read-only in this routine.

The tools are `memory.access` and `channel.send` (host tools), and the MCP servers `zerolib-email`, `google-workspace`, `postgram` and `home-assistant`. Only the classify step needs a model. The other steps are fixed logic.

## Decided by Ivo

- The approval decision is a `/approve <code>` reply that the model cannot send.
- Script authoring by the agent is part of the first slice. This is a platform feature, and the platform does not know the quality of the model that an operator uses. The tests and the approval of the user are the protection against a weak model. The design does not depend on a stronger model.

- Code in a sandbox, not a declarative format.
- The model writes the scripts, the unit tests and the integration tests, and runs them.
- The user approves the result of a dry run. The user does not review code.
- If the user asks for a routine, an authoring skill starts the flow.
- Mastra workflows can become part of the SDK later. The start is plain code.

## Calls made by the writer, open to correction

- TypeScript is the script language.
- The tool channel is standard input and output, so the container keeps no network.
- Talon uses the broker as a library on a host install.
- An unknown tool counts as a write tool.
- Approval is bound to a content hash, and a new draft does not stop the approved version.
- A failed script does not fall back to the old prompt.
- The mail intake is the first slice.
- `model.judge` uses the model of the persona, and its prompt is part of the approved content.
- The gateway uses a helper process for each run to reach MCP tools.
- A live run is held to the tools and channels in the approved manifest.
- A dry run must go through the work path before approval.

## Left to the builder

- The exact SDK function names and the way types are generated from tool schemas.
- The message format of the tool channel.
- The storage location and database tables of the script store.
- The test framework inside the image.
- The layout of the approval message.
- The contents and the build of the script image.

## Not verified

- The streaming exec against a real Docker daemon. The current backend is verified only for buffered output.
- The quality of scripts from the current model. `talon-main` maps to GLM-5.3-flash, and Ivo reports that it writes code well. No script from it was tested for this design.
- That the MCP servers in use set `readOnlyHint`.
- The token estimate for a run with new mail.
