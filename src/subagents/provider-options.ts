/**
 * Shared helper for validating and wrapping per-model `providerOptions` from
 * sub-agent override config.
 *
 * The AI SDK's `providerOptions` argument is keyed by provider name and gets
 * merged into the request body. Typed providers (`anthropic`, `openai`,
 * `google`) silently drop unknown fields, so arbitrary passthrough is only
 * meaningful on the `ollama` slot — which Talon routes through
 * `createOpenAICompatible`, the AI SDK's explicit passthrough entry point.
 *
 * Forwarding `providerOptions` on a typed provider is either a no-op or a
 * source of subtle foot-guns (e.g., `temperature` / `max_tokens` silently
 * overriding runner-controlled values). This helper gates the wrap to the
 * known-compatible provider allowlist and logs a warning when misconfigured
 * entries are encountered so operators notice the drop.
 */

import type { JSONObject } from '@ai-sdk/provider';
import type pino from 'pino';

/**
 * Providers that route through the OpenAI-compatible passthrough and therefore
 * accept arbitrary request body fields via `providerOptions`. Extend this set
 * as new compatible slots are added to `ModelResolver`.
 */
const OPENAI_COMPATIBLE_PROVIDERS: ReadonlySet<string> = new Set(['ollama']);

/**
 * Wrap a raw `providerOptions` record from a sub-agent model override under
 * the active entry's provider name, or return `undefined` if the provider does
 * not support arbitrary body passthrough.
 *
 * - `raw` undefined → returns undefined (no passthrough)
 * - `raw` set on a non-compatible provider → returns undefined + warn log
 * - `raw` set on a compatible provider → returns `{ [provider]: raw }`
 *
 * The shape returned is what the AI SDK's `generateText` / `generateObject`
 * `providerOptions` argument expects.
 */
export function wrapProviderOptions(
  provider: string,
  raw: Record<string, unknown> | undefined,
  logger: Pick<pino.Logger, 'warn'>,
  context: { subagent?: string; source?: string },
): Record<string, JSONObject> | undefined {
  if (!raw) return undefined;
  if (!OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
    logger.warn(
      { provider, ...context },
      `providerOptions ignored: provider "${provider}" is not OpenAI-compatible and would silently drop unknown fields. Only ${[...OPENAI_COMPATIBLE_PROVIDERS].join(', ')} currently supports providerOptions passthrough.`,
    );
    return undefined;
  }
  return { [provider]: raw as JSONObject };
}
