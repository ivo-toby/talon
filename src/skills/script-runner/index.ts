import type pino from 'pino';
import type { SkillScriptRunner } from './runner-types.js';
import { detectRunnerBackend } from './availability.js';
import { BubblewrapRunner } from './bubblewrap-runner.js';
import { AppleContainerRunner } from './apple-container-runner.js';

export * from './runner-types.js';
export * from './output-capture.js';
export { BubblewrapRunner } from './bubblewrap-runner.js';
export { AppleContainerRunner } from './apple-container-runner.js';

let cachedRunner: SkillScriptRunner | null | undefined;

/**
 * Detect the available sandbox backend and return a runner instance.
 * Returns null if neither bwrap (Linux) nor container (macOS) is available.
 * Caches the detection result — subsequent calls return the same instance.
 */
export async function createSkillScriptRunner(deps: {
  logger: pino.Logger;
  dataDir: string;
}): Promise<SkillScriptRunner | null> {
  if (cachedRunner !== undefined) {
    return cachedRunner;
  }

  const detected = await detectRunnerBackend(deps.logger);

  if (!detected) {
    cachedRunner = null;
    return null;
  }

  if (detected.backend === 'bubblewrap') {
    cachedRunner = new BubblewrapRunner(deps.dataDir, deps.logger);
  } else {
    cachedRunner = new AppleContainerRunner(deps.dataDir, deps.logger);
  }

  return cachedRunner;
}

/**
 * Reset the cached runner instance. Only for testing.
 * @internal
 */
export function _resetCachedRunner(): void {
  cachedRunner = undefined;
}
