import { z } from 'zod';

export const CODEX_SANDBOX_EXAMPLE_TOKEN =
  'replace_with_a_random_32_character_minimum_value';

/** Reject a copied documentation placeholder before it can become a credential. */
export function isUnsafeCodexSandboxToken(token: string): boolean {
  return token === CODEX_SANDBOX_EXAMPLE_TOKEN;
}

/**
 * Narrow RPC contract between Talon and the externally contained Codex runner.
 * The runner deliberately accepts text/JSON generations only; it never receives
 * Talon's host-tool bridge, filesystem paths, MCP configuration, or environment.
 */
export const CodexSandboxGenerateRequestSchema = z.object({
  model: z.string().min(1),
  systemPrompt: z.string(),
  userPrompt: z.string().min(1),
  outputSchema: z.unknown().optional(),
});

export type CodexSandboxGenerateRequest = z.infer<typeof CodexSandboxGenerateRequestSchema>;

const CodexSandboxUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});

export const CodexSandboxGenerateResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    text: z.string().min(1),
    usage: CodexSandboxUsageSchema.optional(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.string().min(1),
    error: z.string().min(1),
  }),
]);

export type CodexSandboxGenerateResponse = z.infer<typeof CodexSandboxGenerateResponseSchema>;
