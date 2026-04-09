import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import { ExecutionEnvError } from '../core/errors/error-types.js';
import { isPathWithinBase } from '../core/fs/path-containment.js';

function canonicalizePath(path: string): string {
  const resolvedPath = resolve(path);
  const missingSegments: string[] = [];
  let current = resolvedPath;

  while (true) {
    try {
      const real = realpathSync(current);
      return missingSegments.length === 0
        ? real
        : resolve(real, ...missingSegments.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return resolvedPath;
      }
      missingSegments.push(basename(current));
      current = parent;
    }
  }
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

  const resolvedCandidate = isAbsolute(candidatePath)
    ? canonicalizePath(candidatePath)
    : resolveRelativeHostPath(candidatePath, normalizedRoots);

  if (!normalizedRoots.some((root) => isPathWithinBase(resolvedCandidate, root))) {
    return err(
      new ExecutionEnvError(
        `execution_env: [HOST_PATH_NOT_ALLOWED] path "${candidatePath}" is outside allowed roots`,
      ),
    );
  }

  return ok(resolvedCandidate);
}

function resolveRelativeHostPath(candidatePath: string, normalizedRoots: string[]): string {
  const fallback = canonicalizePath(resolve(normalizedRoots[0]!, candidatePath));

  for (const root of normalizedRoots) {
    const candidate = canonicalizePath(resolve(root, candidatePath));
    if (!isPathWithinBase(candidate, root)) {
      continue;
    }
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return fallback;
}
