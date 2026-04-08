/**
 * AI SDK v5 data-stream SSE encoding utilities.
 *
 * Each function produces one or more encoded SSE lines in the format:
 * `TYPE_CODE:JSON_VALUE\n`
 */

/**
 * Serialise one AI SDK v5 data-stream protocol part.
 * Format: `TYPE_CODE:JSON_VALUE\n`
 */
export function encodeStreamPart(type: string, value: unknown): string {
  return `${type}:${JSON.stringify(value)}\n`;
}

/**
 * Split agent body text into word-level text-delta chunks.
 *
 * When textChunkType is null, uses standard "0:" prefix.
 * When textChunkType is set, uses that string as the prefix instead.
 */
export function buildTextChunks(body: string, textChunkType: string | null): string[] {
  const tokens = body.match(/\S+\s*/g) ?? [body];
  return tokens.map((token) =>
    textChunkType
      ? `${textChunkType}:${JSON.stringify(token)}\n`
      : encodeStreamPart('0', token),
  );
}

/**
 * Build the two finish chunks that close an AI SDK stream:
 * 1. finish-step (`e`) — marks the end of a reasoning step
 * 2. finish-message (`d`) — marks the end of the assistant message
 */
export function buildFinishChunks(): string[] {
  const finishStep = encodeStreamPart('e', {
    finishReason: 'stop',
    usage: { promptTokens: 0, completionTokens: 0 },
    isContinued: false,
  });
  const finishMessage = encodeStreamPart('d', {
    finishReason: 'stop',
    usage: { promptTokens: 0, completionTokens: 0 },
  });
  return [finishStep, finishMessage];
}

/**
 * SSE comment line used as a keep-alive tick.
 * Browsers and proxies treat comment lines as no-ops but they reset
 * connection timeout timers.
 */
export function buildKeepAlive(): string {
  return ': keep-alive\n\n';
}

/**
 * Build the start-step chunk (`f`) that opens the stream.
 */
export function buildStartStep(messageId: string): string {
  return encodeStreamPart('f', { messageId });
}
