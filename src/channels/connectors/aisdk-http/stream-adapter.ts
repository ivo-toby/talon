/**
 * AI SDK v5 UI Message Stream encoding utilities.
 *
 * V5 uses standard SSE format: `data: JSON\n\n`
 * Each chunk is a JSON object with a `type` field.
 *
 * Protocol reference: https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
 */

/**
 * Encode a single SSE data frame in AI SDK v5 format.
 */
export function encodeSSE(value: Record<string, unknown>): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

/**
 * Build the stream start chunk.
 */
export function buildStart(messageId: string): string {
  return encodeSSE({ type: 'start', messageId });
}

/**
 * Build the start-step chunk.
 */
export function buildStartStep(): string {
  return encodeSSE({ type: 'start-step' });
}

/**
 * Split agent body text into v5 text-start / text-delta / text-end chunks.
 * Each chunk is one SSE data frame.
 *
 * When textChunkType is null, uses standard text-delta type.
 * When textChunkType is set, emits a custom data chunk instead (e.g. "data-human-readable").
 */
export function buildTextChunks(body: string, textChunkType: string | null, messageId: string): string[] {
  if (textChunkType) {
    // Custom chunk type — emit as single data frame
    return [encodeSSE({ type: textChunkType, data: body })];
  }

  // Standard v5 text streaming: start → deltas → end
  const chunks: string[] = [];
  chunks.push(encodeSSE({ type: 'text-start', id: messageId }));

  const tokens = body.match(/\S+\s*/g) ?? [body];
  for (const token of tokens) {
    chunks.push(encodeSSE({ type: 'text-delta', id: messageId, delta: token }));
  }

  chunks.push(encodeSSE({ type: 'text-end', id: messageId }));
  return chunks;
}

/**
 * Build the finish chunks that close an AI SDK v5 stream:
 * 1. finish-step
 * 2. finish (message-level)
 */
export function buildFinishChunks(): string[] {
  return [
    encodeSSE({ type: 'finish-step' }),
    encodeSSE({ type: 'finish' }),
  ];
}

/**
 * The stream terminator required by AI SDK v5.
 */
export function buildDone(): string {
  return 'data: [DONE]\n\n';
}

/**
 * SSE comment line used as a keep-alive tick.
 * Browsers and proxies treat SSE comment lines as no-ops but they reset
 * connection timeout timers.
 */
export function buildKeepAlive(): string {
  return ': keep-alive\n\n';
}
