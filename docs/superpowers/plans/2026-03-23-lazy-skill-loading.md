# Lazy Skill Loading Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only inject skill metadata into system prompts; load full skill content on demand via a `skill_load` tool, saving ~80% of skill-related tokens per agent run.

**Architecture:** Extend `SkillLoader` to support SKILL.md format alongside skill.yaml. Replace eager prompt injection with a metadata index. For Claude SDK: use `createSdkMcpServer()` to create an in-process MCP server with `skill_load` tool (zero subprocess overhead, no provider API changes needed). For CLI providers (Gemini): use an external stdio MCP server via Unix socket. Background agents use eager loading mode.

**Tech Stack:** TypeScript, Zod, vitest, @modelcontextprotocol/sdk, @anthropic-ai/claude-agent-sdk, gray-matter (YAML frontmatter parsing)

**Spec:** `docs/superpowers/specs/2026-03-23-lazy-skill-loading-design.md`

---

## Chunk 1: Dual Skill Format Support

### Task 1: Add `format` field to `LoadedSkill` type

**Files:**
- Modify: `src/skills/skill-types.ts:89-106`

- [ ] **Step 1: Add `format` field to `LoadedSkill` interface**

```typescript
// In LoadedSkill interface, add after migrationPaths:
/** Which on-disk format this skill was loaded from. */
format: 'yaml' | 'skillmd';
```

- [ ] **Step 2: Update `SkillDirectory` interface to be format-neutral**

Update the JSDoc on `manifestPath` to say "manifest file" instead of "`<rootDir>/skill.yaml`".

- [ ] **Step 3: Run existing tests to verify nothing breaks**

Run: `npx vitest run tests/unit/skills/`
Expected: All tests fail because `format` is now required on `LoadedSkill` but not provided.

- [ ] **Step 4: Fix existing `SkillLoader` to set `format: 'yaml'`**

In `src/skills/skill-loader.ts:184-190`, add `format: 'yaml'` to the `LoadedSkill` object literal:

```typescript
const loaded: LoadedSkill = {
  manifest,
  promptContents,
  resolvedToolManifests,
  resolvedMcpServers,
  migrationPaths,
  format: 'yaml',
};
```

- [ ] **Step 5: Run tests again**

Run: `npx vitest run tests/unit/skills/`
Expected: PASS — all existing tests pass with `format: 'yaml'`.

- [ ] **Step 6: Commit**

```bash
git add src/skills/skill-types.ts src/skills/skill-loader.ts
git commit -m "feat(skills): add format field to LoadedSkill type"
```

### Task 2: Add SKILL.md frontmatter schema

**Files:**
- Modify: `src/skills/skill-schema.ts`

- [ ] **Step 1: Install gray-matter for YAML frontmatter parsing**

Run: `npm install gray-matter`
Run: `npm install --save-dev @types/gray-matter` (if types exist, otherwise skip — gray-matter has built-in types)

- [ ] **Step 2: Export `CapabilityLabelSchema` and add frontmatter schema variant**

In `src/skills/skill-schema.ts`, change `CapabilityLabelSchema` from `const` to `export const` (line 22):

```typescript
export const CapabilityLabelSchema = z.string().min(1);
```

Then add after the existing `SkillManifestSchema`:

```typescript
/**
 * Schema for SKILL.md frontmatter. Same as SkillManifestSchema but version
 * defaults to '0.1.0' and promptFragments is ignored (body IS the prompt).
 */
export const SkillMdFrontmatterSchema = z.object({
  name: z.string().min(1, 'skill name must be non-empty'),
  version: z.string().min(1).default('0.1.0'),
  description: z.string().min(1, 'skill description must be non-empty'),
  requiredCapabilities: z.array(CapabilityLabelSchema).default([]),
  // promptFragments, toolManifests, mcpServers, migrations are auto-discovered
  // and NOT declared in SKILL.md frontmatter.
});

export type SkillMdFrontmatterInput = z.input<typeof SkillMdFrontmatterSchema>;
export type SkillMdFrontmatterOutput = z.output<typeof SkillMdFrontmatterSchema>;
```

- [ ] **Step 3: Commit**

```bash
git add src/skills/skill-schema.ts package.json package-lock.json
git commit -m "feat(skills): add SKILL.md frontmatter schema and gray-matter dep"
```

### Task 3: Implement SKILL.md loading in `SkillLoader`

**Files:**
- Modify: `src/skills/skill-loader.ts`
- Test: `tests/unit/skills/skill-loader.test.ts`

- [ ] **Step 1: Write failing tests for SKILL.md loading**

Add to `tests/unit/skills/skill-loader.test.ts`:

```typescript
describe('SKILL.md format', () => {
  it('loads skill from SKILL.md with frontmatter', async () => {
    const dir = await makeTmpDir(cleanupFns);
    const skillDir = join(dir, 'my-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: my-skill',
        'description: A test skill',
        '---',
        '',
        '# My Skill',
        '',
        'These are the instructions.',
      ].join('\n'),
    );

    const loader = new SkillLoader(makeLogger());
    const result = await loader.loadFromDirectory(skillDir);

    expect(result.isOk()).toBe(true);
    const skill = result._unsafeUnwrap();
    expect(skill.manifest.name).toBe('my-skill');
    expect(skill.manifest.version).toBe('0.1.0'); // default
    expect(skill.manifest.description).toBe('A test skill');
    expect(skill.format).toBe('skillmd');
    expect(skill.promptContents).toHaveLength(1);
    expect(skill.promptContents[0]).toContain('# My Skill');
    expect(skill.promptContents[0]).toContain('These are the instructions.');
  });

  it('errors when both skill.yaml and SKILL.md exist', async () => {
    const dir = await makeTmpDir(cleanupFns);
    const skillDir = join(dir, 'ambiguous');
    await mkdir(join(skillDir, 'prompts'), { recursive: true });
    await writeFile(
      join(skillDir, 'skill.yaml'),
      'name: ambiguous\nversion: "1.0.0"\ndescription: test\n',
    );
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: ambiguous\ndescription: test\n---\nBody',
    );

    const loader = new SkillLoader(makeLogger());
    const result = await loader.loadFromDirectory(skillDir);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('ambiguous');
  });

  it('loads MCP servers from mcp/ alongside SKILL.md', async () => {
    const dir = await makeTmpDir(cleanupFns);
    const skillDir = join(dir, 'with-mcp');
    await mkdir(join(skillDir, 'mcp'), { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: with-mcp\ndescription: has mcp\n---\nInstructions',
    );
    await writeFile(
      join(skillDir, 'mcp', 'server.json'),
      JSON.stringify({
        name: 'test-server',
        config: { transport: 'stdio', command: 'echo', name: 'test-server' },
      }),
    );

    const loader = new SkillLoader(makeLogger());
    const result = await loader.loadFromDirectory(skillDir);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().resolvedMcpServers).toHaveLength(1);
  });

  it('defaults version to 0.1.0 when omitted in frontmatter', async () => {
    const dir = await makeTmpDir(cleanupFns);
    const skillDir = join(dir, 'no-version');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: no-version\ndescription: test\n---\nBody',
    );

    const loader = new SkillLoader(makeLogger());
    const result = await loader.loadFromDirectory(skillDir);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().manifest.version).toBe('0.1.0');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/skills/skill-loader.test.ts`
Expected: FAIL — SKILL.md tests fail because loader doesn't handle the format yet.

- [ ] **Step 3: Implement SKILL.md detection and loading**

In `src/skills/skill-loader.ts`, modify `loadFromDirectory`:

```typescript
import matter from 'gray-matter';
import { SkillMdFrontmatterSchema } from './skill-schema.js';

// At the start of loadFromDirectory, before reading manifest:
async loadFromDirectory(skillDir: string): Promise<Result<LoadedSkill, SkillError>> {
  this.logger.debug({ skillDir }, 'loading skill from directory');

  // Detect format
  const hasSkillYaml = await this.fileExists(join(skillDir, 'skill.yaml'));
  const hasSkillMd = await this.fileExists(join(skillDir, 'SKILL.md'));

  if (hasSkillYaml && hasSkillMd) {
    return err(
      new SkillError(
        `Skill directory "${skillDir}" contains both skill.yaml and SKILL.md — ambiguous format. Remove one.`,
      ),
    );
  }

  if (hasSkillMd) {
    return this.loadFromSkillMd(skillDir);
  }

  // Existing skill.yaml path (unchanged)
  // ... rest of existing code ...
}
```

Add the `loadFromSkillMd` and `fileExists` private methods:

```typescript
private async fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

private async loadFromSkillMd(skillDir: string): Promise<Result<LoadedSkill, SkillError>> {
  const skillMdPath = join(skillDir, 'SKILL.md');

  let rawContent: string;
  try {
    rawContent = await readFile(skillMdPath, 'utf-8');
  } catch (cause) {
    return err(
      new SkillError(
        `Failed to read SKILL.md at "${skillMdPath}": ${String(cause)}`,
        cause instanceof Error ? cause : undefined,
      ),
    );
  }

  const { data: frontmatter, content: body } = matter(rawContent);

  const parseResult = SkillMdFrontmatterSchema.safeParse(frontmatter);
  if (!parseResult.success) {
    const issues = parseResult.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return err(
      new SkillError(
        `SKILL.md frontmatter validation failed for "${skillMdPath}": ${issues}`,
      ),
    );
  }

  const fm = parseResult.data;

  // Validate capability labels
  for (const label of fm.requiredCapabilities) {
    const { valid, warning, error } = validateCapabilityLabel(label);
    if (warning) {
      this.logger.warn({ skill: fm.name, label }, warning);
    }
    if (!valid) {
      return err(
        new SkillError(
          `Skill "${fm.name}" has malformed requiredCapability: ${error ?? label}`,
        ),
      );
    }
  }

  // Build manifest compatible with SkillManifest interface
  const manifest: LoadedSkill['manifest'] = {
    name: fm.name,
    version: fm.version,
    description: fm.description,
    requiredCapabilities: fm.requiredCapabilities,
    promptFragments: [],
    toolManifests: [],
    mcpServers: [],
    migrations: [],
  };

  const promptContents = body.trim() ? [body.trim()] : [];

  // Load tool manifests, MCP defs, migrations (same as yaml format)
  const toolResult = await this.loadToolManifests(skillDir, fm.name);
  if (toolResult.isErr()) return err(toolResult.error);

  const mcpResult = await this.loadMcpServerDefs(skillDir, fm.name);
  if (mcpResult.isErr()) return err(mcpResult.error);

  const migrationsResult = await this.collectMigrationPaths(skillDir, fm.name);
  if (migrationsResult.isErr()) return err(migrationsResult.error);

  const loaded: LoadedSkill = {
    manifest,
    promptContents,
    resolvedToolManifests: toolResult.value,
    resolvedMcpServers: mcpResult.value,
    migrationPaths: migrationsResult.value,
    format: 'skillmd',
  };

  this.logger.info({ skill: fm.name, skillDir, format: 'skillmd' }, 'skill loaded');
  return ok(loaded);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/skills/skill-loader.test.ts`
Expected: PASS — all tests including new SKILL.md tests.

- [ ] **Step 5: Commit**

```bash
git add src/skills/skill-loader.ts tests/unit/skills/skill-loader.test.ts
git commit -m "feat(skills): implement SKILL.md format loading with frontmatter parsing"
```

---

## Chunk 2: Lazy Loading in System Prompt

### Task 4: Add `buildSkillIndex` and `skillLoadingMode` to `persona-runtime-context.ts`

**Files:**
- Modify: `src/personas/persona-runtime-context.ts:11-54`
- Test: `tests/unit/personas/persona-runtime-context.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/unit/personas/persona-runtime-context.test.ts`:

```typescript
describe('buildSkillIndex', () => {
  it('generates metadata-only skill index', () => {
    const skills: LoadedSkill[] = [
      {
        manifest: { name: 'codex', version: '1.0.0', description: 'Run Codex CLI', requiredCapabilities: [], promptFragments: [], toolManifests: [], mcpServers: [], migrations: [] },
        promptContents: ['Full codex instructions here...'],
        resolvedToolManifests: [],
        resolvedMcpServers: [],
        migrationPaths: [],
        format: 'yaml' as const,
      },
      {
        manifest: { name: 'web-research', version: '1.0.0', description: 'Search the web', requiredCapabilities: [], promptFragments: [], toolManifests: [], mcpServers: [], migrations: [] },
        promptContents: ['Full web research instructions...'],
        resolvedToolManifests: [],
        resolvedMcpServers: [],
        migrationPaths: [],
        format: 'skillmd' as const,
      },
    ];

    const index = buildSkillIndex(skills);

    expect(index).toContain('## Available Skills');
    expect(index).toContain('**codex**: Run Codex CLI');
    expect(index).toContain('**web-research**: Search the web');
    expect(index).toContain('skill_load');
    // Must NOT contain full prompt content
    expect(index).not.toContain('Full codex instructions');
    expect(index).not.toContain('Full web research instructions');
  });

  it('returns empty string when no skills', () => {
    expect(buildSkillIndex([])).toBe('');
  });
});

describe('skillLoadingMode', () => {
  it('uses lazy mode by default (metadata index only)', () => {
    // Build context with skills that have prompt content
    const result = buildPersonaRuntimeContext({
      loadedPersona: /* ... minimal mock ... */,
      resolvedSkills: [/* skill with promptContents */],
      skillResolver: /* ... mock ... */,
    });

    expect(result.personaPrompt).toContain('## Available Skills');
    expect(result.personaPrompt).not.toContain('Full prompt content');
  });

  it('uses eager mode when specified (full prompts)', () => {
    const result = buildPersonaRuntimeContext({
      loadedPersona: /* ... minimal mock ... */,
      resolvedSkills: [/* skill with promptContents */],
      skillResolver: /* ... mock ... */,
      skillLoadingMode: 'eager',
    });

    expect(result.personaPrompt).toContain('Full prompt content');
    expect(result.personaPrompt).not.toContain('## Available Skills');
  });
});
```

Note: Use the existing test file's mock patterns for `loadedPersona` and `skillResolver`. Read the existing test file to match patterns.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/personas/persona-runtime-context.test.ts`
Expected: FAIL — `buildSkillIndex` not exported, `skillLoadingMode` not accepted.

- [ ] **Step 3: Implement `buildSkillIndex` and `skillLoadingMode`**

In `src/personas/persona-runtime-context.ts`:

```typescript
// Add to exports
export function buildSkillIndex(resolvedSkills: LoadedSkill[]): string {
  if (resolvedSkills.length === 0) return '';

  const lines = ['## Available Skills'];
  for (const skill of resolvedSkills) {
    lines.push(`- **${skill.manifest.name}**: ${skill.manifest.description}`);
  }
  lines.push('');
  lines.push(
    'To use a skill, call the `skill_load` tool with the skill name. The tool returns the full instructions for that skill.',
  );
  return lines.join('\n');
}

// Update BuildPersonaRuntimeContextOptions interface
interface BuildPersonaRuntimeContextOptions {
  loadedPersona: LoadedPersona;
  resolvedSkills: LoadedSkill[];
  skillResolver: SkillResolver;
  excludeServerNames?: string[];
  skillLoadingMode?: 'lazy' | 'eager';
  logger?: {
    warn: (payload: Record<string, unknown>, message: string) => void;
  };
}

// Update buildPersonaRuntimeContext function
export function buildPersonaRuntimeContext(
  options: BuildPersonaRuntimeContextOptions,
): PersonaRuntimeContext {
  const mode = options.skillLoadingMode ?? 'lazy';
  const skillPrompt = mode === 'eager'
    ? options.skillResolver.mergePromptFragments(options.resolvedSkills)
    : buildSkillIndex(options.resolvedSkills);

  // ... rest unchanged ...
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/personas/persona-runtime-context.test.ts`
Expected: PASS

- [ ] **Step 5: Run full skills + personas test suite for regression**

Run: `npx vitest run tests/unit/skills/ tests/unit/personas/`
Expected: PASS — no regressions

- [ ] **Step 6: Commit**

```bash
git add src/personas/persona-runtime-context.ts tests/unit/personas/persona-runtime-context.test.ts
git commit -m "feat(personas): add buildSkillIndex and skillLoadingMode for lazy loading"
```

### Task 5: Add `__talond_` prefix validation for MCP server names

**Files:**
- Modify: `src/personas/persona-runtime-context.ts:63-119`
- Test: `tests/unit/personas/persona-runtime-context.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it('rejects user-defined MCP servers with __talond_ prefix', () => {
  const skill = makeSkillWithMcpServer('__talond_evil', 'stdio', 'echo');
  expect(() =>
    buildPersonaRuntimeContext({
      loadedPersona: minimalPersona,
      resolvedSkills: [skill],
      skillResolver: mockResolver,
    }),
  ).toThrow('__talond_');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/personas/persona-runtime-context.test.ts`
Expected: FAIL

- [ ] **Step 3: Add validation in MCP server loop**

In `buildPersonaRuntimeContext`, at the start of the `for (const server of serverDefs)` loop:

```typescript
if (server.name.startsWith('__talond_')) {
  throw new Error(
    `MCP server name "${server.name}" uses reserved prefix "__talond_". Skill-defined MCP servers must not use this prefix.`,
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/personas/persona-runtime-context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/personas/persona-runtime-context.ts tests/unit/personas/persona-runtime-context.test.ts
git commit -m "feat(personas): reject user MCP servers with reserved __talond_ prefix"
```

---

## Chunk 3: Native `skill_load` Tool (Claude SDK via In-Process MCP Server)

The Claude Agent SDK provides `createSdkMcpServer()` and `tool()` helpers that create an in-process MCP server — no subprocess, no socket, runs in the same Node.js process. The server is passed as an entry in the `mcpServers` option alongside regular MCP servers.

However, the codebase currently types `mcpServers` as `Record<string, CanonicalMcpServer>` (only transport-based servers). The SDK's `query()` accepts `Record<string, McpServerConfig>` which is a union including `McpSdkServerConfigWithInstance`. We need to widen the type at the provider boundary and update `toClaudeMcpServers()` to pass SDK server instances through untouched.

### Task 6a: Widen `CanonicalMcpServer` type for SDK in-process servers

**Files:**
- Modify: `src/providers/provider-types.ts:29-42`
- Modify: `src/providers/claude-code-provider.ts:264-288` (`toClaudeMcpServers`)

- [ ] **Step 1: Add SDK server type to `CanonicalMcpServer` union**

In `src/providers/provider-types.ts`, add:

```typescript
/**
 * An in-process MCP server created via the Claude Agent SDK's
 * createSdkMcpServer(). Contains a live McpServer instance — not
 * serializable, only usable with SDK providers.
 */
export interface CanonicalMcpSdkServer {
  transport: 'sdk';
  instance: unknown; // McpServer from @modelcontextprotocol/sdk
}

export type CanonicalMcpServer =
  | CanonicalMcpStdioServer
  | CanonicalMcpHttpServer
  | CanonicalMcpSdkServer;
```

- [ ] **Step 2: Update `toClaudeMcpServers` to pass SDK instances through**

In `src/providers/claude-code-provider.ts`, update the `toClaudeMcpServers` method:

```typescript
private toClaudeMcpServers(
  mcpServers: Record<string, CanonicalMcpServer>,
): Record<string, unknown> {
  const nativeServers: Record<string, unknown> = {};

  for (const [name, server] of Object.entries(mcpServers)) {
    // SDK in-process servers pass through as-is (they already have the
    // shape the Agent SDK expects: McpSdkServerConfigWithInstance).
    if (server.transport === 'sdk') {
      nativeServers[name] = server.instance;
      continue;
    }

    if (server.transport === 'stdio') {
      nativeServers[name] = {
        type: 'stdio',
        command: server.command,
        args: server.args,
        ...(server.env ? { env: server.env } : {}),
      };
      continue;
    }

    nativeServers[name] = {
      type: server.transport,
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
    };
  }

  return nativeServers;
}
```

- [ ] **Step 3: Update `GeminiCliProvider.toGeminiMcpServers` to skip SDK servers**

In the Gemini provider's MCP conversion, add a guard:

```typescript
if (server.transport === 'sdk') {
  // SDK in-process servers are not supported by CLI providers — skip.
  continue;
}
```

- [ ] **Step 4: Run existing tests**

Run: `npx vitest run tests/unit/providers/ tests/unit/daemon/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/providers/provider-types.ts src/providers/claude-code-provider.ts src/providers/gemini-cli-provider.ts
git commit -m "feat(providers): widen CanonicalMcpServer to support SDK in-process servers"
```

### Task 6b: Wire `skill_load` in-process MCP server in `AgentRunner`

**Files:**
- Modify: `src/daemon/agent-runner.ts:177-185` (skill filtering) and `381-397` (mcpServers construction)

- [ ] **Step 1: Build skill content map**

In `agent-runner.ts`, after `personaSkills` is computed (line ~177), add:

```typescript
// Build skill content map for lazy loading
const skillContentMap = new Map<string, string>();
for (const skill of personaSkills) {
  const content = skill.promptContents.join('\n');
  if (content) {
    skillContentMap.set(skill.manifest.name, content);
  }
}
```

- [ ] **Step 2: Create in-process MCP server for SDK strategy**

In the `executeAgentQuery` function, before `mcpServers` is used (line ~381):

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { CanonicalMcpSdkServer } from '../providers/provider-types.js';

// For SDK providers, create in-process MCP server for skill_load
const sdkSkillServer: Record<string, CanonicalMcpSdkServer> = {};
if (strategy.type === 'sdk' && skillContentMap.size > 0) {
  const server = createSdkMcpServer({
    name: '__talond_skill_loader',
    tools: [
      tool(
        'skill_load',
        'Load the full instructions for a skill. Pass the skill name exactly as shown in Available Skills.',
        { name: z.string().describe('Skill name') },
        async (args) => {
          const content = skillContentMap.get(args.name);
          if (!content) {
            return {
              content: [{
                type: 'text' as const,
                text: `Error: skill "${args.name}" not found. Available: ${[...skillContentMap.keys()].join(', ')}`,
              }],
              isError: true,
            };
          }
          this.ctx.logger.info({ runId, skill: args.name }, 'skill.loaded');
          return {
            content: [{ type: 'text' as const, text: content }],
          };
        },
      ),
    ],
  });
  sdkSkillServer['__talond_skill_loader'] = {
    transport: 'sdk',
    instance: server,
  };
}
```

- [ ] **Step 3: Inject into mcpServers map and rename host-tools**

Update the `mcpServers` construction (line ~381):

```typescript
const mcpServers: Record<string, CanonicalMcpServer> = {
  ...baseMcpServers,
  ...sdkSkillServer,
  '__talond_host_tools': {
    transport: 'stdio',
    command: 'node',
    args: [join(import.meta.dirname, '../../dist/tools/host-tools-mcp-server.js')],
    env: {
      ...process.env,
      TALOND_SOCKET: this.ctx.hostToolsBridge.path,
      TALOND_RUN_ID: runId,
      TALOND_THREAD_ID: item.threadId,
      TALOND_PERSONA_ID: personaId,
      TALOND_ALLOWED_TOOLS: allowedMcpTools.join(','),
      TALOND_TRACEPARENT: generationObservation.getTraceparent() ?? '',
    },
  },
};
```

- [ ] **Step 4: Rename server identity in `host-tools-mcp-server.ts`**

In `src/tools/host-tools-mcp-server.ts`, find the MCP server name declaration (where it reports `name: 'host-tools'`) and rename to `name: '__talond_host_tools'` for consistency with the registration key.

- [ ] **Step 5: Update `shouldSkipProviderToolObservation` for renamed server**

At line ~864, update:

```typescript
private shouldSkipProviderToolObservation(event: {
  messageType: string;
  serverName?: string;
}): boolean {
  return event.messageType === 'mcp_tool_use' && (
    event.serverName === '__talond_host_tools' ||
    event.serverName === '__talond_skill_loader'
  );
}
```

- [ ] **Step 6: Write test for SDK skill_load server creation**

Add to `tests/unit/daemon/agent-runner.test.ts` (or create):

```typescript
describe('skill_load in-process MCP server', () => {
  it('creates SDK MCP server entry when skills have content', () => {
    // Verify that when personaSkills have prompt content and strategy
    // is SDK, the mcpServers map includes __talond_skill_loader with
    // transport: 'sdk'.
  });

  it('does not create SDK server when no skills have content', () => {
    // Verify empty skills don't produce the server entry.
  });

  it('does not create SDK server for CLI strategy', () => {
    // Verify CLI providers don't get the in-process server.
  });
});
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/unit/daemon/ tests/unit/providers/`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/daemon/agent-runner.ts src/tools/host-tools-mcp-server.ts tests/unit/daemon/
git commit -m "feat(agent-runner): add in-process skill_load MCP server and rename host-tools to __talond_host_tools"
```

---

## Chunk 4: MCP Fallback for CLI Providers

### Task 9: Create `skill-loader-mcp-server.ts`

**Files:**
- Create: `src/tools/skill-loader-mcp-server.ts`
- Test: `tests/unit/tools/skill-loader-mcp-server.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// Test the skill content lookup logic (extracted as a pure function)
// rather than the full MCP server, since the MCP protocol is hard to unit test.
import { describe, it, expect } from 'vitest';
import { lookupSkillContent } from '../../../src/tools/skill-loader-mcp-server.js';

describe('lookupSkillContent', () => {
  it('returns content for known skill', () => {
    const map = new Map([['codex', 'codex instructions']]);
    expect(lookupSkillContent(map, 'codex')).toBe('codex instructions');
  });

  it('returns null for unknown skill', () => {
    const map = new Map([['codex', 'codex instructions']]);
    expect(lookupSkillContent(map, 'unknown')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/tools/skill-loader-mcp-server.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the MCP server**

Create `src/tools/skill-loader-mcp-server.ts`:

```typescript
#!/usr/bin/env node

/**
 * Skill Loader MCP Server
 *
 * A standalone Node.js script that implements the MCP protocol over stdio.
 * Exposes a single `skill_load` tool that returns skill prompt content
 * by requesting it from the HostToolsBridge via Unix socket.
 *
 * Environment variables:
 *   TALOND_SOCKET - Path to the Unix socket (required)
 */

import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/** Exported for testing — pure lookup logic. */
export function lookupSkillContent(
  map: Map<string, string>,
  name: string,
): string | null {
  return map.get(name) ?? null;
}

// ... Socket client class (same pattern as host-tools-mcp-server.ts) ...
// ... MCP server setup with ListTools returning skill_load tool ...
// ... CallTool handler sends skill.load request over socket ...

// Only run the server when executed directly (not imported for testing)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  // Initialize and start MCP server
}
```

The full implementation follows the `host-tools-mcp-server.ts` pattern:
1. SocketClient class connects to `TALOND_SOCKET`
2. MCP Server lists one tool: `skill_load`
3. On `CallTool` for `skill_load`, sends `{ id, tool: 'skill.load', args: { name }, context }` over socket
4. Returns content from bridge response

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/tools/skill-loader-mcp-server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/skill-loader-mcp-server.ts tests/unit/tools/skill-loader-mcp-server.test.ts
git commit -m "feat(tools): add skill-loader MCP server for CLI provider fallback"
```

### Task 10: Add `skill.load` handler to `HostToolsBridge`

**Files:**
- Modify: `src/tools/host-tools-bridge.ts:359+` (dispatch method)

- [ ] **Step 1: Add per-persona skill content resolution to bridge**

The bridge needs to serve skill content scoped to the requesting persona (matching which skills the persona has attached). Instead of caching a global map in the constructor (which goes stale after daemon reload), resolve content per-request using `ctx.loadedSkills` and the persona's skill list:

```typescript
// Add a method to HostToolsBridge:
private resolveSkillContent(personaId: string, skillName: string): string | null {
  // Look up persona to get its skill list
  const personaRow = this.ctx.repos.persona.findById(personaId);
  if (personaRow.isErr() || !personaRow.value) return null;

  const loadedPersona = this.ctx.personaLoader.getByName(personaRow.value.name);
  if (loadedPersona.isErr() || !loadedPersona.value) return null;

  const personaSkillNames = loadedPersona.value.config.skills;
  if (!personaSkillNames.includes(skillName)) return null;

  const skill = this.ctx.loadedSkills.find(
    (s) => s.manifest.name === skillName,
  );
  if (!skill) return null;

  const content = skill.promptContents.join('\n');
  return content || null;
}

private listAvailableSkills(personaId: string): string[] {
  const personaRow = this.ctx.repos.persona.findById(personaId);
  if (personaRow.isErr() || !personaRow.value) return [];

  const loadedPersona = this.ctx.personaLoader.getByName(personaRow.value.name);
  if (loadedPersona.isErr() || !loadedPersona.value) return [];

  return loadedPersona.value.config.skills;
}
```

- [ ] **Step 2: Add `skill.load` case to dispatch method**

In the `dispatch` method, add a case for `skill.load`:

```typescript
if (tool === 'skill.load') {
  const name = typeof args.name === 'string' ? args.name : '';
  const content = this.resolveSkillContent(context.personaId, name);
  if (!content) {
    const available = this.listAvailableSkills(context.personaId);
    return {
      requestId: context.requestId ?? 'unknown',
      tool,
      status: 'error',
      error: `Skill "${name}" not found. Available: ${available.join(', ')}`,
    };
  }
  this.ctx.logger.info({ skill: name, runId: context.runId }, 'skill.loaded via bridge');
  return {
    requestId: context.requestId ?? 'unknown',
    tool,
    status: 'success',
    result: content,
  };
}
```

- [ ] **Step 3: Bypass capability check for `skill.load`**

In `handleRequest`, before the `isToolAllowed` check, add early return:

```typescript
// skill.load bypasses capability checks — always allowed
if (normalizedTool === 'skill.load') {
  const result = await this.dispatch(normalizedTool, args, context);
  this.sendResponse(socket, { id, result });
  return;
}
```

- [ ] **Step 4: Write test for skill.load bridge handler**

```typescript
describe('skill.load bridge handler', () => {
  it('returns skill content for persona-attached skill', () => {
    // Mock persona with skill 'codex', verify content returned
  });

  it('rejects skill not attached to persona', () => {
    // Mock persona without the requested skill, verify error
  });

  it('bypasses capability check for skill.load', () => {
    // Verify skill.load works even with empty capabilities
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/unit/tools/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/host-tools-bridge.ts
git commit -m "feat(bridge): handle skill.load requests for MCP fallback"
```

### Task 11: Inject `__talond_skill_loader` MCP server for CLI providers

**Files:**
- Modify: `src/daemon/agent-runner.ts`

- [ ] **Step 1: Add MCP server injection for CLI strategy**

In the `executeAgentQuery` function, after the `mcpServers` object is built (line ~397), add:

```typescript
// For CLI providers, inject skill-loader MCP server with full bridge context
if (strategy.type === 'cli' && skillContentMap.size > 0) {
  mcpServers['__talond_skill_loader'] = {
    transport: 'stdio',
    command: 'node',
    args: [join(import.meta.dirname, '../../dist/tools/skill-loader-mcp-server.js')],
    env: {
      ...process.env,
      TALOND_SOCKET: this.ctx.hostToolsBridge.path,
      TALOND_RUN_ID: runId,
      TALOND_THREAD_ID: item.threadId,
      TALOND_PERSONA_ID: personaId,
      TALOND_TRACEPARENT: generationObservation.getTraceparent() ?? '',
    },
  };
}
```

Note: The bridge requires `context` fields (`runId`, `threadId`, `personaId`) on every request. The skill-loader MCP server must read these env vars and include them in the bridge request, same as `host-tools-mcp-server.ts` does.

- [ ] **Step 2: Commit**

```bash
git add src/daemon/agent-runner.ts
git commit -m "feat(agent-runner): inject skill-loader MCP server for CLI providers"
```

---

## Chunk 5: Background Agent Eager Loading

### Task 12: Set `skillLoadingMode: 'eager'` for background agents

**Files:**
- Modify: `src/tools/host-tools/background-agent.ts:132-138`

- [ ] **Step 1: Add `skillLoadingMode: 'eager'` to `buildPersonaRuntimeContext` call**

At line 132 in `background-agent.ts`:

```typescript
const runtimeContext = buildPersonaRuntimeContext({
  loadedPersona,
  resolvedSkills: personaSkills,
  skillResolver: this.deps.skillResolver,
  excludeServerNames: ['__talond_host_tools'],  // updated from 'host-tools'
  skillLoadingMode: 'eager',
  logger: this.deps.logger,
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/unit/tools/`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tools/host-tools/background-agent.ts
git commit -m "feat(background-agent): use eager skill loading mode"
```

---

## Chunk 6: CLI Changes

### Task 13: Add `--format` flag to `add-skill` command

**Files:**
- Modify: `src/cli/commands/add-skill.ts`
- Test: `tests/unit/cli/add-skill.test.ts` (create if doesn't exist)

- [ ] **Step 1: Write failing test for SKILL.md scaffolding**

```typescript
describe('addSkill with skillmd format', () => {
  it('creates SKILL.md stub instead of skill.yaml', async () => {
    // Set up temp dir with minimal talond.yaml and persona
    const result = await addSkill({
      name: 'test-skill',
      personaName: 'assistant',
      configPath: tempConfigPath,
      skillsDir: tempSkillsDir,
      format: 'skillmd',
    });

    expect(existsSync(join(result.skillDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(result.skillDir, 'skill.yaml'))).toBe(false);

    const content = await readFile(join(result.skillDir, 'SKILL.md'), 'utf-8');
    expect(content).toContain('name: test-skill');
    expect(content).toContain('version: 0.1.0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `format` not accepted.

- [ ] **Step 3: Add `format` option to `AddSkillOptions` and implement**

```typescript
export interface AddSkillOptions {
  name: string;
  personaName: string;
  configPath?: string;
  skillsDir?: string;
  format?: 'yaml' | 'skillmd';
}
```

In `addSkill()`, replace the skill.yaml scaffolding section (lines 113-145) with format-aware logic:

```typescript
const format = options.format ?? 'yaml';

if (format === 'skillmd') {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  await fs.mkdir(skillDir, { recursive: true });

  if (!existsSync(skillMdPath)) {
    const stub = [
      '---',
      `name: ${options.name}`,
      'version: 0.1.0',
      `description: "${options.name} — replace with a meaningful description."`,
      '---',
      '',
      `# ${options.name}`,
      '',
      'Replace this with skill instructions.',
      '',
    ].join('\n');

    await fs.writeFile(skillMdPath, stub, 'utf-8');
  }
} else {
  // Existing yaml scaffolding (current code)
  const promptsDir = path.join(skillDir, 'prompts');
  await fs.mkdir(promptsDir, { recursive: true });
  // ... rest of existing yaml scaffolding ...
}
```

Update the CLI command registration in `src/cli/index.ts` to accept `--format`:

```typescript
.option('--format <format>', 'Skill format: yaml or skillmd', 'yaml')
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/cli/add-skill.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/add-skill.ts src/cli/index.ts tests/unit/cli/add-skill.test.ts
git commit -m "feat(cli): add --format flag to add-skill for SKILL.md scaffolding"
```

### Task 14: Add FORMAT column to `list-skills`

**Files:**
- Modify: `src/cli/commands/list-skills.ts`

- [ ] **Step 1: Add `format` field to `SkillInfo`**

```typescript
export interface SkillInfo {
  personaName: string;
  skillName: string;
  format: 'yaml' | 'skillmd' | 'unknown';
}
```

- [ ] **Step 2: Detect format in `listSkills`**

```typescript
import { existsSync } from 'node:fs';
import path from 'node:path';

// In the loop where skills are collected:
for (const skillName of skills) {
  let format: 'yaml' | 'skillmd' | 'unknown' = 'unknown';
  const skillDir = path.join('skills', skillName);
  if (existsSync(path.join(skillDir, 'SKILL.md'))) {
    format = 'skillmd';
  } else if (existsSync(path.join(skillDir, 'skill.yaml'))) {
    format = 'yaml';
  }
  result.push({ personaName: p.name, skillName, format });
}
```

- [ ] **Step 3: Update CLI output to show FORMAT column**

```typescript
console.log(`${'PERSONA'.padEnd(25)} ${'SKILL'.padEnd(25)} FORMAT`);
console.log(`${'─'.repeat(25)} ${'─'.repeat(25)} ${'─'.repeat(10)}`);

for (const s of skills) {
  console.log(`${s.personaName.padEnd(25)} ${s.skillName.padEnd(25)} ${s.format}`);
}
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/list-skills.ts
git commit -m "feat(cli): add FORMAT column to list-skills"
```

---

## Chunk 7: Setup Skill Update & Final Integration

### Task 15: Update `talon-setup` skill

**Files:**
- Modify: `.claude/skills/talon-setup/SKILL.md`

- [ ] **Step 1: Update skill creation guidance**

Find the section about adding skills and update to mention both formats. Add guidance like:

```markdown
### Skill formats

Talon supports two skill formats:

- **SKILL.md** (recommended for new skills): Single file with YAML frontmatter + markdown body
  - `npx talonctl add-skill --name my-skill --persona assistant --format skillmd`
- **skill.yaml** (legacy): Separate manifest + prompts directory
  - `npx talonctl add-skill --name my-skill --persona assistant`
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/talon-setup/SKILL.md
git commit -m "docs(talon-setup): update skill creation guidance for dual format support"
```

### Task 16: Run full test suite and verify

- [ ] **Step 1: Run all unit tests related to this feature**

```bash
npx vitest run tests/unit/skills/ tests/unit/personas/ tests/unit/tools/ tests/unit/cli/
```

Expected: PASS — all tests pass.

- [ ] **Step 2: Build the project**

```bash
npm run build
```

Expected: Clean build, no TypeScript errors.

- [ ] **Step 3: Run lint**

```bash
npm run lint
```

Expected: No new lint errors.

- [ ] **Step 4: Commit any fixes**

If any issues found, fix and commit.

---

## Task Dependencies

```
Task 1 (LoadedSkill type)
  → Task 2 (frontmatter schema)
    → Task 3 (SKILL.md loading)
  → Task 4 (buildSkillIndex + skillLoadingMode)
    → Task 5 (__talond_ prefix validation)
    → Task 6 (in-process SDK MCP server + agent-runner wiring)
      → Task 9 (CLI provider MCP injection)
    → Task 7 (skill-loader MCP server for CLI providers)
      → Task 8 (bridge handler)
        → Task 9 (CLI provider MCP injection)
    → Task 10 (background agent eager mode)
  → Task 11 (add-skill --format)
  → Task 12 (list-skills FORMAT column)

Task 13 (setup skill) — independent
Task 14 (final verification) — after all others
```

Note: Task numbers shifted after merging old Tasks 6-8 into single Task 6. Subsequent tasks renumbered.

## Parallelization Opportunities

These tasks can be worked on concurrently by different agents:
- **Group A** (Chunk 1): Tasks 1-3 (dual format support)
- **Group B** (Chunk 2): Tasks 4-5 (lazy loading + prefix validation) — depends on Task 1
- **Group C** (Chunk 3): Task 6 (in-process SDK MCP server) — depends on Task 4
- **Group D** (Chunk 4): Tasks 7-9 (MCP fallback for CLI providers) — depends on Task 4
- **Group E** (Chunk 5-6): Tasks 10-12 (background agent + CLI) — depends on Task 4
- **Group F** (Chunk 7): Tasks 13-14 (setup skill + verification) — after all others
