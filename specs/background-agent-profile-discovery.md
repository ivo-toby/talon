# Background Agent Profile Discovery

> Issue: ivo-toby/talon#100
> Branch: `feat/issue-100-background-agent-profiles`
> Status: DRAFT
> Date: 2026-03-28

## Problem

The main agent has a `background_agent spawn profile="<name>"` tool but no way to
discover which profiles exist or what they do. It must guess profile names or
fail at runtime. This makes the profile feature unusable in practice.

## Solution

Two changes:

1. **Add YAML frontmatter with `description` to persona `system.md` files** --
   the persona loader parses it at load time, strips it from the prompt content,
   and stores it on `LoadedPersona`. Same pattern skills use with `SKILL.md`.

2. **Add a `profiles` action to the `background_agent` tool** -- returns
   `{name, description}[]` for all loaded personas. The tool description tells
   the agent to call `profiles` before spawning with a profile. Dynamic,
   hot-reload-safe, no env var plumbing.

## Detailed Design

### 1. Persona frontmatter in `system.md`

#### Format

```markdown
---
description: "Deep web research -- searches multiple sources, cross-references findings, synthesizes answers with citations"
---

# researcher -- System Prompt

You are Researcher, a deep web research agent...
```

#### Schema

New Zod schema in `src/personas/persona-schema.ts`:

```typescript
import { z } from 'zod';

export const PersonaFrontmatterSchema = z.object({
  description: z.string().min(1).optional(),
});
```

`description` is optional so existing personas without frontmatter keep working.

#### Parsing

Modify `PersonaLoader.readSystemPrompt()` to use `gray-matter` (already a
dependency -- used by `SkillLoader`):

```typescript
import matter from 'gray-matter';

private async readSystemPrompt(filePath: string, personaName: string) {
  const raw = await readFile(filePath, 'utf-8');
  const { data, content } = matter(raw);
  // validate data against PersonaFrontmatterSchema (warn on failure, don't block)
  // return { frontmatter: data, content: content.trim() }
}
```

Return both the parsed frontmatter and the body (frontmatter stripped). The body
goes into `LoadedPersona.systemPromptContent` as before -- the agent never sees
the YAML fence.

#### `LoadedPersona` type change

```typescript
export interface LoadedPersona {
  config: PersonaConfig;
  description?: string;           // <-- new, from frontmatter
  systemPromptContent?: string;   // body only, frontmatter stripped
  personalityContent?: string;
  taskPromptPaths?: Record<string, string>;
  resolvedCapabilities: ResolvedCapabilities;
}
```

#### PersonaLoader public API addition

```typescript
/** Returns name + description for all loaded personas. */
listProfiles(): Array<{ name: string; description?: string }> {
  return [...this.cache.entries()].map(([name, loaded]) => ({
    name,
    description: loaded.description,
  }));
}
```

### 2. `profiles` action on `background_agent` tool

#### Handler (`background-agent.ts`)

Add `'profiles'` to the action union type:

```typescript
export interface BackgroundAgentArgs {
  action: 'spawn' | 'status' | 'cancel' | 'result' | 'profiles';
  // ...
}
```

New method:

```typescript
private profiles(requestId: string): ToolCallResult {
  const profiles = this.deps.personaLoader.listProfiles();
  return {
    requestId,
    tool: BackgroundAgentHandler.manifest.name,
    status: 'success',
    result: { profiles },
  };
}
```

Add case to `execute()` switch:

```typescript
case 'profiles':
  return this.profiles(requestId);
```

#### MCP schema (`host-tools-mcp-server.ts`)

Update the `background_agent` tool definition:

- Add `'profiles'` to the `action` enum
- Update tool description:

```
Starts and manages background agent workers. Use action "profiles" to list
available profiles before spawning with a specific profile. Each profile is a
persona with its own system prompt, skills, model, and provider.
```

- Update `profile` field description:

```
Persona name to use as the background agent profile. Call with
action "profiles" first to see available options. When provided, the named
persona's system prompt, skills, model, and provider are used instead of the
spawning thread's persona.
```

### 3. `add-persona` CLI changes

#### `--description` flag

Add to Commander options:

```typescript
.option('--description <text>', 'Short description of what this persona does (written to system.md frontmatter)')
```

#### Template update

Modify `buildSystemPromptTemplate()` to accept an optional description and
generate frontmatter:

```typescript
export function buildSystemPromptTemplate(name: string, description?: string): string {
  const frontmatter = description
    ? ['---', `description: "${description}"`, '---', ''].join('\n')
    : ['---', 'description: ""', '---', ''].join('\n');

  return [
    frontmatter,
    `# ${name} -- System Prompt`,
    '',
    // ... rest of template
  ].join('\n');
}
```

Always generate the frontmatter block (even if empty) so the structure is there
for the user to fill in.

### 4. `create-profile` skill update

Update the skill instructions to:

- Always generate a `description` in the frontmatter when writing `system.md`
- Description should be 1-2 sentences summarizing the persona's purpose and
  strengths -- enough for an LLM to decide which profile to spawn
- Example: `"Senior code reviewer -- focused security and performance analysis with PR review expertise"`

### 5. Hot reload

Works automatically:

- `daemon.reload()` calls `personaLoader.loadFromConfig()` which re-reads all
  system prompt files, re-parses frontmatter, rebuilds the cache
- Next `profiles` action call returns updated data
- In-flight conversations get current profiles on next tool call
- No env vars, no MCP server restart needed

## Files to modify

| File | Change |
|------|--------|
| `src/personas/persona-schema.ts` | New file -- `PersonaFrontmatterSchema` |
| `src/personas/persona-types.ts` | Add `description?: string` to `LoadedPersona` |
| `src/personas/persona-loader.ts` | Parse frontmatter, strip from content, add `listProfiles()` |
| `src/personas/persona-runtime-context.ts` | No change (receives stripped content) |
| `src/tools/host-tools/background-agent.ts` | Add `profiles` action + handler method |
| `src/tools/host-tools-mcp-server.ts` | Add `profiles` to enum, update descriptions |
| `src/cli/commands/add-persona.ts` | Add `--description` flag, update template |
| `skills/create-profile/SKILL.md` | Add instruction to generate description |
| `templates/assistant/system.md` | Add frontmatter block (optional, for default persona) |
| `tests/unit/personas/persona-loader.test.ts` | Frontmatter parsing tests |
| `tests/unit/tools/background-agent.test.ts` | `profiles` action tests |

## Out of scope

- Filtering profiles by capability (future: `subagent.background.profile:<name>`)
- Profile-specific tags or categories in frontmatter
- Excluding the spawning persona from the profiles list (all personas returned)

## Example flow

```
Agent: background_agent action="profiles"
Tool:  { profiles: [
  { name: "james", description: "Personal butler -- formal, anticipatory, handles daily tasks" },
  { name: "researcher", description: "Deep web research -- multi-source search, cross-referencing, cited answers" },
  { name: "code-reviewer", description: "Senior code reviewer -- security, performance, and correctness focus" }
]}

Agent: background_agent action="spawn" profile="researcher" prompt="Research the latest developments in..."
Tool:  { taskId: "abc-123" }
```
