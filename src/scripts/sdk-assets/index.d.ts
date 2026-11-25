export const tools: Record<string, Record<string, (input?: unknown) => Promise<unknown>>>;
export function call(name: string, input?: unknown): Promise<unknown>;
export class TalonToolError extends Error {
  readonly code: string;
}
export const memory: {
  /** Reads one memory value. Returns the stored value. */
  read(key: string, namespace?: string): Promise<unknown>;
  /** Lists the memory entries of a namespace. */
  list(namespace?: string): Promise<unknown>;
  /** Writes one memory value. Does not run in a test or a dry run. */
  write(key: string, value: unknown, namespace?: string): Promise<unknown>;
  /** Deletes one memory value. Does not run in a test or a dry run. */
  delete(key: string, namespace?: string): Promise<unknown>;
};
/** Sends a message to a channel. Does not run in a test or a dry run. */
export function notify(
  channelId: string,
  content: string,
  externalChatId?: string,
): Promise<unknown>;
export const model: {
  /** Asks a model to judge the input against the prompt and returns an answer that fits the schema. */
  judge(request: { prompt: string; input: unknown; schema: object }): Promise<unknown>;
};
