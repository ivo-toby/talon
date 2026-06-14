/**
 * Heuristic matcher that decides whether an `unhandledRejection` originated
 * inside the @whiskeysockets/baileys WebSocket pipeline.
 *
 * Baileys occasionally leaks rejections from its noise-handler / WebSocket
 * decode path when WhatsApp tears down the stream (e.g. a "conflict /
 * replaced" disconnect when another Web client logs in with the same
 * account). Those rejections are not actionable from our code — Baileys
 * itself emits a `connection.update` with `connection: 'close'` and the
 * connector's reconnect logic already handles it.
 *
 * Without this matcher those rejections hit the daemon's global
 * `unhandledRejection` handler and crash the entire process. The matcher
 * lets the signal handler treat them as warnings instead.
 *
 * The matcher demands strong Baileys provenance before claiming a rejection:
 * either a Baileys frame in the stack trace, or a Boom error whose message
 * matches the exact prefix Baileys uses for stream-level errors. Generic
 * patterns like "Stream Errored" or a `noise-handler` frame on their own are
 * rejected so a real bug elsewhere in the codebase that happens to produce a
 * similar shape is not swallowed.
 */

const BAILEYS_PACKAGE_FRAGMENT = '@whiskeysockets/baileys';
const BAILEYS_STREAM_ERROR_PREFIX = 'Stream Errored (';

function safeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value;
}

function readProp(reason: unknown, key: string): unknown {
  if (reason === null || (typeof reason !== 'object' && typeof reason !== 'function')) {
    return undefined;
  }
  try {
    return (reason as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Returns true if the rejection reason looks like an internal failure of
 * @whiskeysockets/baileys.
 */
export function isBaileysInternalRejection(reason: unknown): boolean {
  if (reason === null || reason === undefined) return false;

  // Strong provenance: stack trace mentions the Baileys package path. The
  // string `@whiskeysockets/baileys` is unique enough that a stack frame
  // containing it can only come from Baileys' own modules.
  const stack = safeString(readProp(reason, 'stack'));
  if (stack !== undefined && stack.includes(BAILEYS_PACKAGE_FRAGMENT)) {
    return true;
  }

  // Boom error shape with the Baileys "Stream Errored (...)" prefix. Baileys
  // wraps stream-level XMPP errors in `new Boom('Stream Errored (' + tag + ')')`
  // which is a recognisable fingerprint. We require BOTH the Boom shape AND
  // the prefix so that an unrelated Boom or a plain Error that happens to
  // mention "Stream Errored" is not swallowed.
  const isBoom = readProp(reason, 'isBoom') === true;
  if (isBoom) {
    const message = safeString(readProp(reason, 'message'));
    if (message !== undefined && message.startsWith(BAILEYS_STREAM_ERROR_PREFIX)) {
      return true;
    }
  }

  return false;
}
