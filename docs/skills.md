# Skills

Skills are reusable capability bundles that attach to personas. Each skill provides prompt instructions and optionally MCP servers, tool manifests, and database migrations.

## Skill Formats

Talon supports two on-disk formats.

### SKILL.md (recommended)

A single file with YAML frontmatter and a markdown body:

```
skills/web-research/
  SKILL.md              # frontmatter + instructions
  mcp/                  # optional MCP server definitions
  tools/                # optional tool manifests
  migrations/           # optional SQL migrations
```

Example `SKILL.md`:

```markdown
---
name: web-research
version: 0.1.0
description: "Search the web and fetch pages for research tasks"
requiredCapabilities:
  - net.http:external
---

# Web Research

When the user asks you to research something, use the web search tool...
```

### skill.yaml + prompts/ (legacy)

A YAML manifest with separate prompt fragment files:

```
skills/codex/
  skill.yaml            # manifest
  prompts/main.md       # prompt instructions
  mcp/codex.json        # optional MCP server definitions
```

Both formats produce identical runtime behavior.

## Creating a Skill

```bash
# SKILL.md format (recommended)
npx talonctl add-skill --name my-skill --persona assistant --format skillmd

# Legacy YAML format
npx talonctl add-skill --name my-skill --persona assistant
```

## Listing Skills

```bash
npx talonctl list-skills
npx talonctl list-skills --persona assistant
```

Output shows persona, skill name, and format (yaml/skillmd).

## Lazy Loading

Skills use lazy loading by default. Only the skill name and description are included in the agent's system prompt. When the agent needs a skill's full instructions, it calls the `skill_load` tool.

This reduces token usage significantly:

| Scenario | Eager (old) | Lazy (current) |
|---|---|---|
| 7 skills, using 1 | ~21k tokens | ~3.7k tokens |
| 20 skills, using 0 | ~60k tokens | ~2k tokens |

Background agents (spawned via the `background_agent` tool) use eager loading to ensure they have access to all skill instructions without needing to call `skill_load`.

## MCP Servers in Skills

Skills can declare MCP servers in the `mcp/` subdirectory. These are JSON files:

```json
{
  "name": "my-server",
  "config": {
    "transport": "stdio",
    "command": "npx",
    "args": ["my-mcp-server"],
    "env": {
      "API_KEY": "${MY_API_KEY}"
    }
  }
}
```

MCP servers from skills are connected eagerly at startup (the tools are available immediately), even though skill prompt instructions load lazily.

## Required Capabilities

Skills can declare `requiredCapabilities` in their manifest. These are capability labels that the persona must have in its `capabilities.allow` or `requireApproval` set for the skill to be usable.

```yaml
requiredCapabilities:
  - net.http:external
  - memory.access:thread
```

Format: `<domain>.<action>:<scope>` or `<domain>.<action>`.

## Reserved Names

MCP server names starting with `__talond_` are reserved for internal use. Skill-defined MCP servers using this prefix will be rejected at startup.
