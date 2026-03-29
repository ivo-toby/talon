# spark-coder subagent

## Summary

A lightweight subagent that uses OpenAI's `gpt-5.4-spark` for fast code generation. Receives a task description and context files, returns structured file operations via `generateObject`. The parent agent handles all filesystem I/O and orchestration.

## Motivation

Talon's execution environment (Sprites) provides sandboxed code execution. Pairing it with a fast code generator enables a tight generate-test-fix loop where the parent agent orchestrates between spark-coder (generation) and execution_env (validation) without needing a full agentic loop on the fast model.

## Design

### Schema change: `requiresEnv`

Add an optional `requiresEnv` field to `SubAgentManifestSchema` — an array of environment variable names that must be set for the subagent to load. The loader checks these at load time and skips the subagent with an info-level log if any are missing.

This is generic infrastructure: any future subagent that depends on provider-specific env vars gets gating for free.

```yaml
# In subagent.yaml
requiresEnv:
  - OPENAI_API_KEY
```

**Schema addition** (`subagent-schema.ts`):
```typescript
requiresEnv: z.array(z.string().min(1)).default([])
```

**Type addition** (`subagent-types.ts`):
```typescript
requiresEnv: string[];  // on SubAgentManifest
```

**Loader change** (`subagent-loader.ts`):
After manifest validation, before importing the entry point, check each `requiresEnv` var against `process.env`. If any are missing, log at info level and skip (not warn — absence is expected when the provider isn't configured).

### Subagent: `spark-coder`

**Directory**: `src/subagents/default/spark-coder/`

**Manifest** (`subagent.yaml`):
```yaml
name: spark-coder
version: "0.1.0"
description: "Fast code generation using gpt-5.4-spark — accepts context files and instructions, returns file operations"

model:
  provider: openai
  name: gpt-5.4-spark
  maxTokens: 16384

requiredCapabilities: []
requiresEnv:
  - OPENAI_API_KEY

rootPaths: []

timeoutMs: 60000
```

**System prompt** (`prompts/01-system.md`):
Instructs the model to act as a fast, precise code generator. Input is a task + context files + optional constraints. Output is structured file operations.

**Run function** (`index.ts`):
Uses `generateObject` with a Zod schema:

```typescript
const FileOperationSchema = z.object({
  path: z.string().describe('Relative file path'),
  content: z.string().describe('Complete file content'),
  action: z.enum(['create', 'replace']),
});

const SparkCoderOutputSchema = z.object({
  files: z.array(FileOperationSchema),
  explanation: z.string().describe('Brief explanation of what was done (1-2 sentences)'),
});
```

### Input contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `task` | string | yes | What code to generate |
| `contextFiles` | `{path, content}[]` | no | Existing files for context |
| `constraints` | string | no | Style, framework, language constraints |

### Output

`SubAgentResult.data` contains `{ files, explanation }` matching `SparkCoderOutputSchema`.

### What it does NOT do

- No filesystem access — no `rootPaths`, no `requiredCapabilities`
- No multi-turn iteration — single shot; parent agent orchestrates retries
- No code execution — that's what `execution_env` is for
- No tool use — pure generation, no agentic loop

## Testing

- **Loader tests**: verify `requiresEnv` gating — subagent skipped when env var missing, loaded when present
- **spark-coder tests**: verify input validation (empty task), verify `generateObject` called with correct schema, verify output structure
