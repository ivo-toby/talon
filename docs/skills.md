# Skills

Skills are reusable bundles attached to personas. A skill can contribute:

- prompt instructions
- MCP server definitions
- tool manifests
- migration files

## Supported formats

### `SKILL.md`

```text
skills/web-research/
  SKILL.md
  mcp/
  tools/
  migrations/
```

Example:

```markdown
---
name: web-research
version: 0.1.0
description: Search the web and summarize findings
requiredCapabilities:
  - net.http:egress
---

# Web Research

Use web tools carefully and include sources.
```

Supported frontmatter keys are:

- `name`
- `version`
- `description`
- `requiredCapabilities`

### `skill.yaml`

```text
skills/web-research/
  skill.yaml
  prompts/main.md
  mcp/brave.json
```

Example:

```yaml
name: web-research
version: 0.1.0
description: Search the web and summarize findings
requiredCapabilities:
  - net.http:egress
```

The loader also supports optional arrays named:

- `promptFragments`
- `toolManifests`
- `mcpServers`
- `migrations`

If those arrays are omitted, the loader auto-discovers files from the matching subdirectories.

## Creating and listing skills

```bash
npx talonctl add-skill --name my-skill --persona assistant --format skillmd
npx talonctl add-skill --name my-skill --persona assistant --format yaml

npx talonctl list-skills
npx talonctl list-skills --persona assistant
```

## Runtime loading

Foreground agent runs use lazy loading:

- the prompt contains only skill names and descriptions
- the agent calls `skill_load` when it needs the full instructions

Background agents use eager loading instead and receive merged skill contents up front.

## Required capabilities

`requiredCapabilities` must be satisfied by the persona's combined `allow` and `requireApproval` labels.

Preferred examples:

- `memory.access:thread`
- `net.http:egress`
- `schedule.manage:own`
- `db.query:own`

Scope-less labels like `net.http` are accepted but logged with a warning.

## Reserved MCP server names

Skill-defined MCP servers must not start with `__talond_`. That prefix is reserved for Talon's internal servers.
