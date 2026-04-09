import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { err, ok, type Result } from 'neverthrow';

/**
 * Pure predicate: returns true when `candidate` equals `base` or is a
 * direct descendant (separated by the platform path separator).
 * Both paths must already be resolved/canonicalized by the caller.
 */
export function isPathWithinBase(candidate: string, base: string): boolean {
  if (candidate === base) return true;
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  return candidate.startsWith(prefix);
}

export class ContainmentError extends Error {
  constructor(
    public readonly candidatePath: string,
    public readonly basePath: string,
    public readonly resolvedCandidate: string,
    public readonly resolvedBase: string,
    message?: string,
  ) {
    super(
      message ??
        `Path "${candidatePath}" (resolved: "${resolvedCandidate}") escapes base "${basePath}" (resolved: "${resolvedBase}")`,
    );
    this.name = 'ContainmentError';
  }
}

/**
 * Checks whether `candidate` is contained within `base` after resolving
 * both to their canonical (realpath) forms. Returns the resolved candidate
 * path on success, or a ContainmentError on failure.
 *
 * A path is "contained" if its resolved form equals the resolved base
 * or starts with the resolved base followed by a path separator.
 */
export async function isContained(
  candidate: string,
  base: string,
): Promise<Result<string, ContainmentError>> {
  let resolvedCandidate: string;
  let resolvedBase: string;

  try {
    resolvedBase = await realpath(base);
  } catch {
    return err(
      new ContainmentError(candidate, base, candidate, base, `Base path "${base}" does not exist`),
    );
  }

  try {
    resolvedCandidate = await realpath(candidate);
  } catch {
    return err(
      new ContainmentError(
        candidate,
        base,
        candidate,
        resolvedBase,
        `Candidate path "${candidate}" does not exist or cannot be resolved`,
      ),
    );
  }

  if (isPathWithinBase(resolvedCandidate, resolvedBase)) {
    return ok(resolvedCandidate);
  }

  return err(new ContainmentError(candidate, base, resolvedCandidate, resolvedBase));
}
