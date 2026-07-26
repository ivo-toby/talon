# Talon messaging refresh proposal

**Status:** proposal for review
**Scope:** the repository README and the `talond-website` marketing homepage, followed by the highest-traffic docs pages.

## Decision in one sentence

Position Talon as an **open-source, self-hosted runtime for useful AI workflows**: agents that can work across the channels and tools an operator chooses, with durable execution and explicit control over deployment, model endpoints, and tool access.

The useful shorthand is _"Home Assistant for AI agents."_ Keep it as a
secondary mental model (for talks, social posts, and a supporting line), not
as the hero. The hero should stand on its own for someone who does not already
know Home Assistant.

> **Self-hosted AI agents that work where you do.**
> Run useful, long-lived AI workflows across the messages, tools, and model
> endpoints you choose.

## Why change the current message

The current README and homepage accurately show that Talon is technical and
capable, but they lead with implementation language: _"autonomous agent
daemon,"_ a long provider list, and a feature grid. That makes a newcomer
ask "what is this codebase?" instead of "what could this take off my plate?"

The product story discussed in the recap is stronger:

- Talon is not another chat window or a general-purpose SaaS copilot.
- It is the always-on layer that can connect a chosen assistant to the places
  an operator already uses.
- Its value is **control and continuity**: deploy it yourself, choose or
  change the inference endpoint, choose the integrations, and keep useful
  work running over time.
- The near-term public product is open source for technically capable
  operators and small teams—not a managed SMB offering, healthcare product,
  or enterprise compliance platform.

This gives Talon a clear present-tense story without committing the project to
the future commercial model.

## Positioning guardrails

### Audience

Primary audience: technically confident individuals and small technical teams
who want an AI assistant to run continuously on infrastructure they control.
They may be developers, homelab operators, automation enthusiasts, or the
technical person in a small organisation.

Secondary audience: people evaluating self-hosted, provider-portable agent
infrastructure. The website should let them recognise Talon quickly, but it
must not pretend that the current setup is a consumer one-click product.

### What Talon is and is not

| Say                                                               | Do not imply                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| An open-source, self-hosted agent runtime                         | A hosted AI service or agent marketplace                                      |
| Workflows across channels, schedules, skills, and connected tools | A replacement for ChatGPT, Microsoft Copilot, or Google Workspace             |
| Provider flexibility and portable configuration                   | That every model/provider has identical behavior or support                   |
| Capability-scoped host tools and auditability                     | That a model itself is sandboxed or that every action receives human approval |
| A foundation for personal, household, and small-team workflows    | Medical advice, compliance certification, or a ready-made vertical product    |

### Claims that need correction before the refresh

These are accuracy fixes, not merely tone changes:

1. Do not say that _data stays on your infrastructure_ without qualification.
   Talon can be self-hosted, but an operator may deliberately send prompts to
   an external model or MCP server. Say: **"You choose where Talon runs, which
   providers it calls, and which integrations it can use."**
2. Do not market _approval gates_ as enforced. In the current `main` code,
   tools listed in `requireApproval` are exposed with allowed tools; the
   filtering code explicitly says bridge-level approval enforcement is future
   work (`src/tools/tool-filter.ts`). Use **"capability-scoped tool access and
   audit logging"** until the enforcement path is shipped and verified.
3. Do not lead with "four execution providers". It over-indexes on the
   current implementation (and on headless coding CLIs) instead of the durable
   promise: provider choice. Keep the exact provider matrix in the reference
   docs.
4. Do not describe an integration recipe as an out-of-the-box automation.
   For example, the smart-home page currently promises automatic grocery
   reordering and confirmation for destructive actions. Label these as
   **patterns to configure and validate**, with a clear integration and policy
   prerequisite.

## Message architecture

### Core narrative

1. **Outcome first:** Turn an assistant into a useful, always-available
   workflow in the channels and tools you already use.
2. **Control second:** Run Talon where you choose; select the provider,
   integrations, and capabilities for each persona.
3. **Trust third:** Durable queueing, scoped host tools, and audit records make
   long-running workflows more inspectable than a collection of ad-hoc scripts.
4. **How it works last:** Personas, channels, schedules, memory, MCP, and the
   provider layer are the implementation vocabulary for people who need it.

### Voice

Use plain, operator-oriented language: _run, connect, choose, review,
schedule, route, keep working._ Prefer a concrete workflow over "agentic",
"autonomy," "orchestration," or a provider name. Be confident about what is
implemented and specific about what the operator must configure.

Avoid adversarial positioning such as "escape US providers" or "replace
Copilot." The durable value is portability and operator control, not a
geopolitical claim or a model-quality contest.

## Proposed copy

### Website homepage

**SEO title**

`Talon — Self-hosted AI agents that work where you do`

**Meta description**

`Talon is an open-source, self-hosted runtime for long-lived AI workflows across your chat channels, schedules, tools, and chosen model provider.`

**Hero**

```text
Self-hosted AI agents that work where you do.

Talon is an open-source runtime for useful, long-lived AI workflows. Connect
the channels and tools you already use, choose the model endpoint, and keep
control of what each persona can do.

[Run Talon]  [Explore workflows]
```

Use the GitHub link as a quiet tertiary action rather than the main competing
CTA. "Run Talon" should lead to the installation path; "Explore workflows"
should land on the use-case overview.

**Three workflow examples immediately after the hero**

```text
Your day, prepared
Get a morning brief, meeting context, reminders, and follow-ups in the channel
you actually check. Connect the calendar and work tools you choose.

Household coordination, in one thread
Capture shopping, delivery, and home requests as they arise. Add trusted MCP
integrations and set the boundaries before anything can act.

Small-team operations without another dashboard
Route requests, prepare summaries, and run scheduled check-ins across the
tools your team already uses. Give each persona only the access it needs.
```

These are illustrative patterns, not packaged vertical products. Link each
card to a configuration-led use-case page that states its required MCPs,
permissions, and operator review points.

**Why Talon: three pillars**

```text
Runs where you choose
Deploy on infrastructure you control. You decide which data leaves it by
choosing the model providers and integrations it connects to.

Keeps work moving
Durable queueing, threads, schedules, and background work let an assistant
continue a workflow beyond one chat response.

Makes boundaries explicit
Personas receive only the configured host-tool capabilities. Talon records
side-effecting operations so you can inspect what happened.
```

**How it works: one compact explanation**

```text
1. Connect a channel people already use.
2. Create a persona with a purpose, model provider, skills, and allowed tools.
3. Add schedules and trusted integrations; Talon routes, persists, and runs
   the work on your infrastructure.
```

**Closing CTA**

```text
Run your first useful workflow

Start with one persona and one channel. Talon is open source under AGPL-3.0;
you bring the infrastructure and model provider that fit your needs.

[Installation guide]  [View on GitHub]
```

### README opening

Keep the technical README, but make its first screen answer the same outcome
question as the website.

```markdown
# Talon

**Self-hosted AI agents that work where you do.**

Talon is an open-source runtime for long-lived AI workflows. Connect a persona
to the channels and tools you already use, choose its model provider and tool
boundaries, and run it on infrastructure you control.

Talon is for operators who want more than another chat window: a personal or
small-team assistant that can remember context, run scheduled work, and use
explicitly configured integrations. It is self-hosted software—not a hosted
AI service—and external model providers or MCP servers receive only the data
you choose to send to them.
```

Replace the current "Why Talon?" list with:

```markdown
### Why Talon?

- **Useful across your existing tools** — connect chat channels, schedules,
  skills, and MCP integrations around one assistant.
- **Runs where you choose** — deploy Talon yourself and select the model
  endpoint and integrations that fit your needs.
- **Built to keep working** — a durable queue, persistent threads, and
  background execution support work that outlives a single message.
- **Explicit boundaries** — personas receive only configured capabilities;
  host-side effects are audit logged.
- **Composable by design** — use one persona for one job or route work among
  specialised personas when the workflow warrants it.
```

Add a short **"Is Talon a fit?"** note between the quick start and the deep
feature reference:

```markdown
Talon is a good fit if you are comfortable operating self-hosted software and
want to connect AI to your own channels and services. It is not a consumer
assistant, a hosted SaaS, or a guarantee that an external model provider,
integration, or automation is safe without your configuration and review.
```

### Provider copy

At the README's provider section and the homepage, use this high-level line:

> Choose the model runtime that fits your deployment. Talon keeps personas,
> channels, scheduling, and host-tool policy in its own layer while provider
> adapters execute the model call.

Then retain the exact, versioned provider details and experimental status in
the existing technical reference. This keeps the promise stable if the
provider strategy changes.

## Homepage information architecture

The current homepage reads as a changelog and a feature inventory before it
shows the operator what they could actually accomplish. Reorder it as follows:

1. Hero: the positioning and two actions.
2. Three concrete workflow patterns.
3. Three product pillars: control, continuity, explicit boundaries.
4. Compact "how it works" sequence.
5. Connectors and provider compatibility, linking to the technical reference.
6. Starter Stack / install path.
7. Latest activity as a small lower-page "Project updates" module, or move it
   to the blog entirely.

Move A2A, `spark-coder`, observability, and the detailed provider list out of
the primary feature grid. They are valuable proof for technically interested
visitors, but they are not the reason a first-time visitor decides to try
Talon. The current "Talon + Postgram Starter Stack" banner should support the
installation section rather than compete with the hero.

## File-level change plan

| Surface                                              | Change                                                                                               | Notes                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `README.md` on `main`                                | Replace tagline, opening, and "Why Talon?"; add fit note; correct approval and data-residency claims | Preserve the quick start, deep architecture, CLI reference, and provider details.     |
| `talond-website/src/pages/index.astro`               | Rebuild the copy hierarchy around hero → workflows → pillars → how it works → install                | This is the largest change, but can remain a single page.                             |
| `talond-website/astro.config.mjs`                    | Update the global Starlight description                                                              | It currently repeats the implementation-first daemon tagline.                         |
| `talond-website/src/content/docs/use-cases/index.md` | Reframe use cases as configurable workflow patterns                                                  | Remove "standard Talon install" language where an external MCP or setup is essential. |
| `.../proactive-chief-of-staff.md`                    | Keep as the lead use case and add permissions/integration prerequisites                              | Best match for the personal-assistant story.                                          |
| `.../smart-home-orchestrator.md`                     | Recast as a careful LifeOps pattern; remove the approval guarantee                                   | Useful proof of breadth, but should not market unreviewed physical-world automation.  |
| README + website security copy                       | Replace "approval gates" statements until `requireApproval` is enforced end-to-end                   | Treat this as a prerequisite to publishing the refresh.                               |

## Delivery sequence

### Phase 1 — message and accuracy (recommended next change)

Update the README opening, website homepage, global site description, and the
two unsafe claim patterns. This is the smallest change that makes the public
story coherent.

### Phase 2 — proof pages

Refresh the use-case overview and four to six workflow pages around inputs,
configured integrations, boundaries, and expected outcome. Add one or two
real, anonymised operator stories when they are ready; do not invent customer
testimonials.

### Phase 3 — product proof

Ship and verify approval enforcement before reintroducing approval language.
Only then make stronger promises around action review. Keep managed hosting,
EU-only deployment, pricing, healthcare, and SMB packages out of the OSS
marketing surface until there is a real, supportable offer.

## Acceptance criteria

- A first-time reader can explain Talon in one sentence without using the word
  "daemon."
- The hero makes one outcome, one audience, and one primary action clear.
- Every marketing claim maps to a current, documented capability.
- No page suggests self-hosting prevents data from reaching a selected external
  provider or that approval is already enforced.
- Provider names and multi-agent details support the story rather than define
  it.
- The page remains clearly open source and self-hosted, without implying a
  paid offering or regulated vertical product.
