# Import Claude Code Plugins into Talon

**Date:** 2026-03-27
**Issue:** #103
**Branch:** `feat/issue-103-import-plugin`

## Problem

Claude Code has a plugin ecosystem with skills, agents, MCP servers, hooks, and more. Talon supports skills and MCP servers natively but has no way to reuse CC plugins. Users currently have to manually copy and adapt files.

## Solution

Add `talonctl import-plugin` that reads already-installed CC plugins from `~/.claude/plugins/` and copies the compatible components (skills) into Talon's global `skills/` directory. MCP servers are detected and reported so the user can wire them up via existing commands.

This is a task run from Claude Code. The talon-setup skill will be updated to guide users through importing plugins and attaching imported skills to personas.

## CLI Interface

### List importable plugins

```sh
talonctl import-plugin --list
```

Reads `~/.claude/plugins/installed_plugins.json`, filters to plugins that have importable components (a `skills/` directory or a `package.json` with MCP dependencies), and prints them.

### Import a plugin

```sh
talonctl import-plugin --name backend-development
```

1. Read `~/.claude/plugins/installed_plugins.json` to resolve the plugin's install path.
2. If plugin has multiple entries (versions/scopes), use the most recently updated one.
3. Check that no skill from this plugin already exists in Talon's `skills/` directory. If any do, error: "Plugin skills already exist in skills/. Remove them first to re-import."
4. Scan the plugin directory for `skills/*/SKILL.md`.
5. Copy each skill directory (SKILL.md + assets/ + references/ + any other subdirectories) into Talon's `skills/` directory.
6. If the plugin contains `hooks/`, `commands/`, or `agents/`, print a warning that these are CC-specific and were skipped.
7. If the plugin contains an MCP server (`package.json` with `@modelcontextprotocol/sdk` dependency), print a notice telling the user to configure it via `talonctl` MCP commands.
8. Print summary of what was imported.

### Options

| Flag | Description | Default |
|---|---|---|
| `--name <name>` | Plugin name as it appears in `installed_plugins.json` (e.g. `backend-development`) | required |
| `--list` | List importable CC plugins | - |
| `--config <path>` | Path to talond.yaml | `talond.yaml` |
| `--skills-dir <path>` | Talon skills directory | `skills` |
| `--cc-plugins-dir <path>` | CC plugins directory | `~/.claude/plugins` |

## Plugin Discovery

CC plugins are indexed in `~/.claude/plugins/installed_plugins.json`:

```json
{
  "version": 2,
  "plugins": {
    "backend-development@claude-code-workflows": [
      {
        "scope": "user",
        "installPath": "/home/user/.claude/plugins/cache/claude-code-workflows/backend-development/1.2.3",
        "version": "1.2.3",
        "installedAt": "2025-12-13T19:00:40.302Z",
        "lastUpdated": "2025-12-13T19:00:40.302Z"
      }
    ]
  }
}
```

The key format is `<plugin-name>@<marketplace>`. We extract the plugin name (before `@`) for matching against `--name`.

When multiple entries exist for the same plugin name (different marketplaces or scopes), we pick the one with the most recent `lastUpdated` timestamp.

## What Gets Imported

| CC Plugin Component | Action |
|---|---|
| `skills/*/SKILL.md` (+ assets/, references/) | Copy to `skills/<skill-name>/` |
| `package.json` + MCP server | Detect and report, user wires up manually |
| `hooks/` | Skip with warning |
| `commands/` | Skip with warning |
| `agents/` | Skip with warning |

## Idempotency

Not idempotent. If any skill directory from the plugin already exists in `skills/`, the command errors out with a message telling the user to remove the existing skills first. This prevents accidental overwrites.

## File Structure

New files:

```
src/cli/commands/import-plugin.ts    # Command implementation
tests/unit/cli/import-plugin.test.ts # Tests
```

Modified files:

```
src/cli/index.ts                     # Register the command
README.md                            # Document the feature
```

The talon-setup skill (CC plugin, not in this repo) will also need updating to guide users through `import-plugin`.

## Implementation Notes

- Follow existing CLI patterns: core logic in an exported async function, thin CLI wrapper with console output, types/interfaces at the top.
- Use `config-utils.ts` utilities where applicable (`validateName` for plugin name validation).
- Copy files with `fs.cp` (recursive, available in Node 22).
- No config file mutations needed. Skills are just copied to `skills/`; the user attaches them to personas later via `add-skill` or the setup skill.

## Edge Cases

- `~/.claude/plugins/installed_plugins.json` missing: error "No Claude Code plugins found. Install plugins in Claude Code first."
- Plugin name not found: error "Plugin '<name>' not found. Run `talonctl import-plugin --list` to see available plugins."
- Plugin has no importable components: "Plugin '<name>' has no importable skills or MCP servers."
- Skill name collision: error "Skills from plugin '<name>' already exist in skills/. Remove them first to re-import."
- Plugin install path doesn't exist on disk: error "Plugin '<name>' install path not found. It may have been uninstalled from Claude Code."
