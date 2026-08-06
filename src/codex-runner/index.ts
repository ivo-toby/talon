import { createCodexRunnerHttpServer } from './http-server.js';
import { CodexRunnerService } from './runner-service.js';
import { isUnsafeCodexSandboxToken } from '../subagents/codex-sandbox-protocol.js';

const token = process.env.TALON_CODEX_RUNNER_TOKEN;
if (token === undefined || token.length < 32 || isUnsafeCodexSandboxToken(token)) {
  throw new Error(
    'TALON_CODEX_RUNNER_TOKEN must be set to a unique random value of at least 32 characters',
  );
}

const port = parsePort(process.env.TALON_CODEX_RUNNER_PORT);
const service = new CodexRunnerService({
  authDir: process.env.TALON_CODEX_RUNNER_AUTH_DIR ?? '/auth',
  command: process.env.TALON_CODEX_COMMAND ?? 'codex',
  appServerUid: parseOptionalId(process.env.TALON_CODEX_APP_SERVER_UID) ?? 10001,
  appServerGid: parseOptionalId(process.env.TALON_CODEX_APP_SERVER_GID) ?? 10001,
});
const server = createCodexRunnerHttpServer(token, service);

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`Talon Codex sandbox runner listening on port ${port}\n`);
});

function stop(signal: NodeJS.Signals): void {
  process.stdout.write(`Talon Codex sandbox runner received ${signal}; stopping\n`);
  server.close(() => process.exit(0));
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

function parsePort(value: string | undefined): number {
  if (value === undefined) return 9700;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('TALON_CODEX_RUNNER_PORT must be a valid TCP port');
  }
  return port;
}

function parseOptionalId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const id = Number(value);
  if (!Number.isInteger(id) || id < 0) {
    throw new Error('TALON_CODEX_APP_SERVER_UID and TALON_CODEX_APP_SERVER_GID must be non-negative integers');
  }
  return id;
}
