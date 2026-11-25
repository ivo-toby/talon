export const tools: Record<string, Record<string, (input?: unknown) => Promise<unknown>>>;
export function call(name: string, input?: unknown): Promise<unknown>;
export class TalonToolError extends Error {
  readonly code: string;
}
