import { err, ok, type Result } from 'neverthrow';
import { ScriptError, type ScriptErrorCode, type ScriptMode } from './types.js';

/** One JSON object per line, UTF-8. Upper bound for a single line, in bytes. */
export const MAX_LINE_BYTES = 1_048_576;

const MAX_CALL_NAME_CHARS = 200;
const CALL_NAME = /^[A-Za-z0-9._-]+$/;

export type HostMessage =
  | { t: 'start'; mode: ScriptMode; input: unknown }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; code: ScriptErrorCode; message: string };

export type ScriptMessage =
  | { t: 'call'; id: number; name: string; input: unknown }
  | { t: 'done'; ok: true; result: unknown }
  | { t: 'done'; ok: false; message: string };

/** Encode a host message as one line with a final newline. */
export function encodeMessage(message: HostMessage): string {
  // JSON.stringify escapes newlines inside strings, so the only newline is the last character.
  return JSON.stringify(message) + '\n';
}

function protocolError(detail: string): ScriptError {
  return new ScriptError('PROTOCOL', detail);
}

function parseLine(line: string): Result<ScriptMessage, string> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return err('line is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err('message is not a JSON object');
  }
  const obj = value as Record<string, unknown>;

  if (obj.t === 'call') {
    const { id, name } = obj;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
      return err('call id is not a non-negative integer');
    }
    if (typeof name !== 'string' || name.length > MAX_CALL_NAME_CHARS || !CALL_NAME.test(name)) {
      return err('call name is not a valid tool name');
    }
    return ok({ t: 'call', id, name, input: obj.input });
  }

  if (obj.t === 'done') {
    if (typeof obj.ok !== 'boolean') {
      return err('done ok is not a boolean');
    }
    if (obj.ok) {
      return ok({ t: 'done', ok: true, result: obj.result });
    }
    if (typeof obj.message !== 'string') {
      return err('failed done has no message string');
    }
    return ok({ t: 'done', ok: false, message: obj.message });
  }

  return err('unknown message type');
}

export interface LineDecoder {
  push(text: string): Result<ScriptMessage[], ScriptError>;
}

/**
 * Decode decoded-text chunks into validated script messages.
 * After the first error the decoder stays failed.
 */
export function createLineDecoder(maxLineBytes: number = MAX_LINE_BYTES): LineDecoder {
  // The pending line is kept as parts with a running byte count, so a push costs
  // only the size of the new text, whatever the pending line already holds.
  let parts: string[] = [];
  let pendingBytes = 0;
  let failed = false;

  const fail = (detail: string): Result<ScriptMessage[], ScriptError> => {
    failed = true;
    parts = [];
    pendingBytes = 0;
    return err(protocolError(detail));
  };

  return {
    push(text: string): Result<ScriptMessage[], ScriptError> {
      if (failed) {
        return err(protocolError('decoder already failed'));
      }
      const messages: ScriptMessage[] = [];
      let from = 0;
      let newline = text.indexOf('\n', from);

      while (newline !== -1) {
        const segment = text.slice(from, newline);
        const raw = parts.length === 0 ? segment : parts.join('') + segment;
        parts = [];
        pendingBytes = 0;
        from = newline + 1;
        newline = text.indexOf('\n', from);

        if (Buffer.byteLength(raw, 'utf8') > maxLineBytes) {
          return fail('line exceeds the size limit');
        }
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line.trim() === '') {
          continue;
        }
        const parsed = parseLine(line);
        if (parsed.isErr()) {
          return fail(parsed.error);
        }
        messages.push(parsed.value);
      }

      if (from < text.length) {
        const rest = from === 0 ? text : text.slice(from);
        parts.push(rest);
        pendingBytes += Buffer.byteLength(rest, 'utf8');
        if (pendingBytes > maxLineBytes) {
          return fail('line exceeds the size limit');
        }
      }
      return ok(messages);
    },
  };
}
