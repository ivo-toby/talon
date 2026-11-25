// @ts-check
// Runs `node run.js <name>/script.ts` with the working directory set to the scripts root.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'node:util';
import { _finish, _waitForStart } from './index.js';

const MAX_ERROR_MESSAGE_CHARS = 2000;

for (const method of ['log', 'info', 'warn', 'error']) {
  console[method] = (/** @type {unknown[]} */ ...args) => {
    process.stderr.write(format(...args) + '\n');
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (error instanceof Error) return String(error.message).slice(0, MAX_ERROR_MESSAGE_CHARS);
  return 'script threw a non-error value';
}

/** @param {unknown} error */
function fail(error) {
  _finish({ ok: false, message: describeError(error) });
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

async function main() {
  const scriptPath = process.argv[2];
  if (scriptPath === undefined) {
    throw new Error('no script path given');
  }
  const { input } = await _waitForStart();
  const module = await import(pathToFileURL(resolve(process.cwd(), scriptPath)).href);
  if (typeof module.default !== 'function') {
    throw new Error('script has no default export function');
  }
  const result = await module.default(input);
  _finish({ ok: true, result });
}

main().catch(fail);
