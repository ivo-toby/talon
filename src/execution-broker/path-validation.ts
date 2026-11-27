import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import { ExecutionBrokerError } from './errors.js';
import type { WorkspaceConfig } from './types.js';

/**
 * Resolves a workspace-relative `cwd` to an absolute container-side POSIX path.
 *
 * Two-step containment: a lexical check rejects traversal and absolute cwd,
 * then a realpath-based check catches symlinks whose target leaves the
 * workspace. Error details name the rule, never the host paths involved.
 */
export function resolveWorkspaceCwd(
  cwd: string,
  workspace: WorkspaceConfig,
): Result<string, ExecutionBrokerError> {
  if (isAbsolute(cwd)) {
    return err(
      new ExecutionBrokerError('CWD_OUTSIDE_WORKSPACE', 'cwd must be workspace-relative')
    );
  }

  const lexicalRoot = resolve(workspace.hostPath);
  const lexical = resolve(lexicalRoot, cwd);
  if (!isWithin(lexical, lexicalRoot)) {
    return err(new ExecutionBrokerError('CWD_OUTSIDE_WORKSPACE', 'cwd escapes the workspace'));
  }

  const realRoot = canonicalizePath(lexicalRoot);
  const real = canonicalizePath(lexical);
  if (!isWithin(real, realRoot)) {
    return err(new ExecutionBrokerError('SYMLINK_ESCAPE', 'cwd resolves outside the workspace'));
  }

  const rel = relative(realRoot, real);
  if (rel === '') {
    return ok(workspace.mountTarget);
  }
  return ok(posix.join(workspace.mountTarget, ...rel.split(sep)));
}

/** Realpath of the deepest existing ancestor, missing tail re-appended. */
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

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}
