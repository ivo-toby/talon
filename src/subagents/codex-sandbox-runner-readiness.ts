import { err, ok, type Result } from 'neverthrow';

export interface CodexSandboxRunnerReadinessConfig {
  endpoint: string;
  token: string;
  startupTimeoutMs: number;
}

export interface CodexSandboxRunnerReadinessDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class CodexSandboxRunnerReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexSandboxRunnerReadinessError';
  }
}

const REQUEST_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 500;

/**
 * Waits for the externally supervised Codex runner to become ready before
 * Talon begins accepting work. The daemon deliberately never starts Docker or
 * Podman itself: container-runtime authority would defeat the runner's
 * containment boundary.
 */
export async function waitForCodexSandboxRunner(
  config: CodexSandboxRunnerReadinessConfig,
  deps: CodexSandboxRunnerReadinessDeps = {},
): Promise<Result<void, CodexSandboxRunnerReadinessError>> {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = now() + config.startupTimeoutMs;
  const readinessUrl = new URL('/readyz', config.endpoint).toString();
  const runnerLabel = runnerLabelForLog(config.endpoint);
  let lastFailure = 'runner did not respond';

  while (now() < deadline) {
    try {
      const response = await fetchImpl(readinessUrl, {
        headers: { authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, config.startupTimeoutMs)),
      });
      if (response.ok) return ok(undefined);

      lastFailure = `runner returned HTTP ${response.status}`;
    } catch (cause) {
      lastFailure = cause instanceof Error ? cause.message : String(cause);
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(RETRY_INTERVAL_MS, remaining));
  }

  return err(
    new CodexSandboxRunnerReadinessError(
      `Codex sandbox runner at ${runnerLabel} was not ready within ${config.startupTimeoutMs}ms: ${lastFailure}. ` +
        'Ensure the supervised codex-runner service is running and its dedicated Codex login is complete.',
    ),
  );
}

function runnerLabelForLog(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return url.origin;
  } catch {
    return 'the configured endpoint';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
