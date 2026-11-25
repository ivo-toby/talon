// @ts-check
// In-container Talon SDK. Imports only `node:` modules.
// Protocol: one JSON object per line. Script to host on stdout, host to script on stdin.

const MAX_ERROR_MESSAGE_CHARS = 2000;
// Same bound as the host decoder: a longer line is a protocol error there.
const MAX_LINE_BYTES = 1_048_576;

export class TalonToolError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'TalonToolError';
    /** @type {string} */
    this.code = code;
  }
}

/** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
const pending = new Map();
let nextId = 1;
let finished = false;
let reading = false;
/** @type {((message: { mode: string, input: unknown }) => void) | undefined} */
let resolveStart;
/** @type {Promise<{ mode: string, input: unknown }> | undefined} */
let startPromise;

/**
 * @param {unknown} message
 * @param {() => void} callback
 */
function writeLine(message, callback) {
  process.stdout.write(JSON.stringify(message) + '\n', callback);
}

/** @param {string} line */
function handleLine(line) {
  if (line.trim() === '') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== 'object' || message === null) return;
  if (message.t === 'start') {
    resolveStart?.({ mode: message.mode, input: message.input });
    resolveStart = undefined;
    return;
  }
  if (message.t === 'result') {
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    if (message.ok === true) {
      entry.resolve(message.value);
    } else {
      entry.reject(new TalonToolError(String(message.message), String(message.code)));
    }
  }
}

function startReading() {
  if (reading) return;
  reading = true;
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (/** @type {string} */ chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      handleLine(line);
      index = buffer.indexOf('\n');
    }
  });
  // The host dropped the stream: stop at once, or the process outlives its run.
  const onClose = () => {
    if (!finished) process.exit(1);
  };
  process.stdin.on('end', onClose);
  process.stdin.on('close', onClose);
  process.stdin.on('error', onClose);
}

/**
 * Call a host tool by its full name.
 * @param {string} name
 * @param {unknown} [input]
 * @returns {Promise<unknown>}
 */
export function call(name, input) {
  if (finished) {
    return Promise.reject(new TalonToolError('script already finished', 'SCRIPT_FAILED'));
  }
  startReading();
  const id = nextId;
  let line;
  try {
    line = JSON.stringify({ t: 'call', id, name, input: input === undefined ? null : input });
  } catch {
    return Promise.reject(
      new TalonToolError('tool input is not JSON-serializable', 'INVALID_ARGUMENT'),
    );
  }
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    return Promise.reject(new TalonToolError('tool input is too large', 'RESULT_TOO_LARGE'));
  }
  nextId += 1;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.stdout.write(line + '\n');
  });
}

/** @param {string | symbol} key */
const isPlainKey = (key) => typeof key === 'string' && key !== 'then';

/** @type {Record<string, Record<string, (input?: unknown) => Promise<unknown>>>} */
export const tools = new Proxy(
  {},
  {
    get(_target, server) {
      if (!isPlainKey(server)) return undefined;
      return new Proxy(
        {},
        {
          get(_inner, tool) {
            if (!isPlainKey(tool)) return undefined;
            return (/** @type {unknown} */ input) =>
              call(`${String(server)}.${String(tool)}`, input);
          },
        },
      );
    },
  },
);

/**
 * Internal, used by run.js only. Not part of the public API.
 * @returns {Promise<{ mode: string, input: unknown }>}
 */
export function _waitForStart() {
  startPromise ??= new Promise((resolve) => {
    resolveStart = resolve;
  });
  startReading();
  return startPromise;
}

/**
 * Internal, used by run.js only. Writes the one `done` line, then exits with code 0.
 * Later calls do nothing.
 * @param {{ ok: true, result: unknown } | { ok: false, message: string }} outcome
 */
export function _finish(outcome) {
  if (finished) return;
  finished = true;
  let message;
  if (outcome.ok) {
    let text;
    try {
      text = JSON.stringify(outcome.result === undefined ? null : outcome.result);
    } catch {
      text = undefined;
    }
    message =
      text === undefined
        ? { t: 'done', ok: false, message: 'script result is not JSON-serializable' }
        : { t: 'done', ok: true, result: JSON.parse(text) };
    if (Buffer.byteLength(JSON.stringify(message), 'utf8') > MAX_LINE_BYTES) {
      message = { t: 'done', ok: false, message: 'script result is too large' };
    }
  } else {
    message = { t: 'done', ok: false, message: outcome.message.slice(0, MAX_ERROR_MESSAGE_CHARS) };
  }
  writeLine(message, () => process.exit(0));
}
