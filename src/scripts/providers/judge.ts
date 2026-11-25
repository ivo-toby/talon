import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';
import { ScriptError } from '../types.js';
import type { RunContext, ToolClass, ToolProvider } from '../types.js';

export interface JudgeModel {
  /** One request with no tools. Returns the raw JSON value of the reply. */
  generate(request: {
    system: string;
    user: string;
    schema: object;
    signal: AbortSignal;
  }): Promise<Result<unknown, ScriptError>>;
}

const TOOL_NAME = 'model.judge';
const MAX_SCHEMA_CHARS = 16_384;
const MAX_INPUT_CHARS = 200_000;
const MAX_PROMPT_BYTES = 65_536;
const FORMAT_INSTRUCTION =
  'Reply with one JSON value that matches this JSON Schema, and with nothing else:';

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

const callSchema = z
  .object({
    prompt: z.string().regex(/^[a-z0-9-]{1,64}$/),
    input: z.unknown(),
    schema: z
      .record(z.string(), z.unknown())
      .refine((s) => s.type === 'object' && jsonLength(s) <= MAX_SCHEMA_CHARS),
  })
  .strict()
  .refine((v) => 'input' in v);

const invalid = (detail: string): ScriptError => new ScriptError('INVALID_ARGUMENT', detail);

async function readPrompt(versionDir: string, prompt: string): Promise<string | undefined> {
  const file = join(versionDir, 'prompts', `${prompt}.md`);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > MAX_PROMPT_BYTES) return undefined;
    const bytes = await readFile(file);
    if (bytes.length > MAX_PROMPT_BYTES) return undefined;
    return bytes.toString('utf8');
  } catch {
    return undefined;
  }
}

/** Calls `model.judge`: one model request with no tools, reply checked against the schema. */
export function createJudgeProvider(options: {
  model: JudgeModel;
  context: RunContext;
  timeoutMs: number;
}): ToolProvider {
  const failed = (cause?: unknown): ScriptError =>
    new ScriptError(
      'TOOL_FAILED',
      'the judge request failed',
      cause instanceof Error ? cause : undefined,
    );

  return {
    describe(name): { toolClass: ToolClass } | undefined {
      return name === TOOL_NAME ? { toolClass: 'model' } : undefined;
    },

    async call(name, input, signal): Promise<Result<unknown, ScriptError>> {
      if (name !== TOOL_NAME) return err(new ScriptError('UNKNOWN_TOOL', 'tool is not available'));
      const parsed = callSchema.safeParse(input);
      if (!parsed.success) return err(invalid('judge input does not match the schema'));
      const { prompt, schema } = parsed.data;
      const judgeInput = parsed.data.input;

      const user = ((): string | undefined => {
        try {
          const text = JSON.stringify(judgeInput);
          return text !== undefined && text.length <= MAX_INPUT_CHARS ? text : undefined;
        } catch {
          return undefined;
        }
      })();
      if (user === undefined) return err(invalid('judge input value is not usable'));

      const system = await readPrompt(options.context.versionDir, prompt);
      if (system === undefined) return err(invalid('judge prompt file is not usable'));

      let replySchema: z.ZodType;
      try {
        replySchema = z.fromJSONSchema(schema);
      } catch {
        return err(invalid('judge schema cannot be used'));
      }

      if (signal.aborted) return err(failed());

      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      const stopped = new Promise<'stopped'>((resolve) => {
        const stop = (): void => {
          controller.abort();
          resolve('stopped');
        };
        timer = setTimeout(stop, options.timeoutMs);
        onAbort = stop;
        signal.addEventListener('abort', stop, { once: true });
      });

      try {
        const running = Promise.resolve()
          .then(() => options.model.generate({ system, user, schema, signal: controller.signal }))
          .catch((cause: unknown) => err<unknown, ScriptError>(failed(cause)));
        const outcome = await Promise.race([running, stopped]);
        if (outcome === 'stopped') return err(failed());
        if (outcome.isErr()) return err(outcome.error);
        const checked = replySchema.safeParse(outcome.value);
        if (!checked.success) {
          return err(new ScriptError('TOOL_FAILED', 'the judge reply does not match the schema'));
        }
        return ok(checked.data);
      } finally {
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** Trims, strips one surrounding Markdown code fence, parses JSON. */
function extractJson(text: string): { value: unknown } | undefined {
  let body = text.trim();
  const fence = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(body);
  if (fence) body = fence[1].trim();
  try {
    return { value: JSON.parse(body) as unknown };
  } catch {
    return undefined;
  }
}

export function createOpenAiCompatibleJudgeModel(options: {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  modelId: string;
  telemetry?: { scriptName: string };
}): JudgeModel {
  const provider = createOpenAICompatible({
    name: 'talon-script-judge',
    baseURL: options.baseUrl,
    apiKey: options.apiKey,
    headers: options.headers,
  });
  return {
    async generate(request): Promise<Result<unknown, ScriptError>> {
      try {
        const { text } = await generateText({
          model: provider(options.modelId),
          system: `${request.system}\n\n${FORMAT_INSTRUCTION}\n${JSON.stringify(request.schema)}`,
          messages: [{ role: 'user', content: request.user }],
          temperature: 0,
          maxRetries: 1,
          abortSignal: request.signal,
          ...(options.telemetry
            ? {
                experimental_telemetry: {
                  isEnabled: true,
                  functionId: 'script.judge',
                  metadata: { scriptName: options.telemetry.scriptName },
                },
              }
            : {}),
        });
        const extracted = extractJson(text);
        if (!extracted) {
          return err(new ScriptError('TOOL_FAILED', 'the judge reply is not JSON'));
        }
        return ok(extracted.value);
      } catch (cause) {
        return err(
          new ScriptError(
            'TOOL_FAILED',
            'the judge model request failed',
            cause instanceof Error ? cause : undefined,
          ),
        );
      }
    },
  };
}
