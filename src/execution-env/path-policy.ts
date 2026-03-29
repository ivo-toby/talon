import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import { ExecutionEnvError } from '../core/errors/error-types.js';

function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function resolveAllowedHostPath(
  candidatePath: string,
  allowedRoots: string[],
): Result<string, ExecutionEnvError> {
  const normalizedRoots = allowedRoots
    .map((root) => canonicalizePath(root))
    .filter((root, index, all) => root.length > 0 && all.indexOf(root) === index);

  if (normalizedRoots.length === 0) {
    return err(
      new ExecutionEnvError(
        'execution_env: [HOST_PATH_NOT_ALLOWED] no allowed host roots configured',
      ),
    );
  }

  const resolvedCandidate = canonicalizePath(
    isAbsolute(candidatePath)
      ? candidatePath
      : resolve(normalizedRoots[0], candidatePath),
  );

  if (!normalizedRoots.some((root) => isWithinRoot(resolvedCandidate, root))) {
    return err(
      new ExecutionEnvError(
        `execution_env: [HOST_PATH_NOT_ALLOWED] path "${candidatePath}" is outside allowed roots`,
      ),
    );
  }

  return ok(resolvedCandidate);
}
