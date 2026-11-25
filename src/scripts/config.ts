import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { err, ok } from 'neverthrow';
import type { Result } from 'neverthrow';
import { SCRIPT_IMAGE_DIGEST_RE } from '../core/config/script-image.js';
import type { ScriptsConfig } from '../core/config/config-schema.js';
import {
  createDockerBackend,
  createDockerEngineClient,
  ExecutionBroker,
} from '../execution-broker/index.js';
import { ScriptError } from './types.js';

export const SCRIPT_PROFILE = 'script';
export const SCRIPT_WORKSPACE = 'scripts';

const SCRIPT_MOUNT_TARGET = '/scripts';
const WORKER_USER = '10001:10001';
const WORKER_MEMORY_BYTES = 256 * 1024 * 1024;
const WORKER_PIDS_LIMIT = 64;
const WORKER_NANO_CPUS = 1_000_000_000;
const WORKER_TMPFS_BYTES = 16 * 1024 * 1024;

function invalid(detail: string): ScriptError {
  return new ScriptError('INVALID_ARGUMENT', detail);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Builds the execution broker of the script runtime from the operator
 * configuration. Construction only: nothing connects to Docker here.
 */
export function buildScriptBroker(
  config: ScriptsConfig,
  personaIds: string[],
): Result<ExecutionBroker, ScriptError> {
  if (!config.enabled) {
    return err(invalid('scripts are not enabled'));
  }
  if (!SCRIPT_IMAGE_DIGEST_RE.test(config.image)) {
    return err(invalid('scripts image must be pinned by digest'));
  }
  if (personaIds.length === 0 || personaIds.some((id) => id === '')) {
    return err(invalid('scripts need at least one persona and no empty persona id'));
  }
  const root = resolve(config.root);
  if (!isDirectory(root)) {
    return err(invalid('scripts root is not an existing directory'));
  }

  const backend = createDockerBackend(
    createDockerEngineClient({ socketPath: config.dockerSocket }),
    {
      image: config.image,
      user: WORKER_USER,
      memoryBytes: WORKER_MEMORY_BYTES,
      pidsLimit: WORKER_PIDS_LIMIT,
      nanoCpus: WORKER_NANO_CPUS,
      tmpfsSizeBytes: WORKER_TMPFS_BYTES,
      diskQuotaEnforced: false,
    },
  );
  if (backend.isErr()) {
    return err(
      new ScriptError('SANDBOX', 'the sandbox backend could not be created', backend.error),
    );
  }

  return ok(
    new ExecutionBroker({
      allowlist: {
        profiles: [
          {
            id: SCRIPT_PROFILE,
            maxTimeoutMs: config.runTimeoutMs,
            outputCapChars: 10_000,
            maxArgvCount: 8,
            maxArgvChars: 1_000,
            maxConcurrentExecsPerLease: 1,
            maxActiveLeases: 4,
          },
        ],
        workspaces: [
          {
            id: SCRIPT_WORKSPACE,
            hostPath: root,
            mountTarget: SCRIPT_MOUNT_TARGET,
            mode: 'ro',
          },
        ],
        grants: [...new Set(personaIds)].map((id) => ({
          parentPersona: id,
          workerPersona: id,
          profile: SCRIPT_PROFILE,
          workspace: SCRIPT_WORKSPACE,
        })),
      },
      backend: backend.value,
    }),
  );
}
