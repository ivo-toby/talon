/**
 * Skill sandbox staging: resolves bins, creates curated .bin/ directory,
 * and canonicalises mount sources before any agent run.
 *
 * Runs once per skill per daemon startup.
 */

import { access, constants, mkdir, readdir, readlink, realpath, symlink, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { err, ok, type Result } from 'neverthrow';

import { isContained } from '@talon/core/fs/path-containment.js';

import type { SkillSandboxProfile } from './skill-sandbox-schema.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StagedSkillSandbox {
  /** Absolute path to the per-skill curated bin directory containing symlinks */
  binDir: string;
  /** Map from declared bin name → resolved absolute host path */
  resolvedBins: Record<string, string>;
  /** Mount declarations with sources resolved to canonical absolute paths */
  canonicalMounts: Array<{ source: string; target: string; mode: 'ro' | 'rw' }>;
}

export class StagingError extends Error {
  constructor(
    public readonly skillName: string,
    public readonly reason: string,
    public readonly details?: unknown,
  ) {
    super(`Staging failed for skill "${skillName}": ${reason}`);
    this.name = 'StagingError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SKILL_DIR_TEMPLATE = '${skill.dir}';

/**
 * Look up a binary name on the system PATH.
 * Returns the first match that is executable, or null.
 */
async function findOnPath(name: string): Promise<string | null> {
  const pathEnv = process.env['PATH'] ?? '';
  const dirs = pathEnv.split(':').filter(Boolean);

  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return resolve(candidate);
    } catch {
      // not found or not executable in this dir — continue
    }
  }

  return null;
}

/**
 * Remove all symlinks in `dir`, ignoring non-symlink entries.
 * Does NOT follow symlinks (uses readlink to verify, then unlink).
 */
async function clearSymlinks(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // directory doesn't exist yet — nothing to clear
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      // readlink throws if not a symlink — use that as our check
      await readlink(fullPath);
      await unlink(fullPath);
    } catch {
      // not a symlink — leave it alone
    }
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Prepare a skill's sandbox environment:
 * 1. Resolve each bin name → absolute path via PATH lookup
 * 2. Create {dataDir}/skills/{skillName}/.bin/ with symlinks
 * 3. Canonicalize mount sources, checking containment for ${skill.dir} paths
 */
export async function stageSkillSandbox(
  profile: SkillSandboxProfile,
  skillDir: string,
  dataDir: string,
  skillName: string,
): Promise<Result<StagedSkillSandbox, StagingError>> {
  // -----------------------------------------------------------------------
  // 1. Resolve bins
  // -----------------------------------------------------------------------
  const resolvedBins: Record<string, string> = {};
  const missingBins: string[] = [];

  const binResults = await Promise.all(
    profile.bins.map(async (name) => {
      const resolved = await findOnPath(name);
      return { name, resolved };
    }),
  );

  for (const { name, resolved } of binResults) {
    if (resolved === null) {
      missingBins.push(name);
    } else {
      resolvedBins[name] = resolved;
    }
  }

  if (missingBins.length > 0) {
    return err(
      new StagingError(
        skillName,
        `binaries not found on PATH: ${missingBins.join(', ')}`,
        { missingBins },
      ),
    );
  }

  // -----------------------------------------------------------------------
  // 2. Create .bin/ directory with symlinks
  // -----------------------------------------------------------------------
  const binDir = join(dataDir, 'skills', skillName, '.bin');

  await mkdir(binDir, { recursive: true });
  await clearSymlinks(binDir);

  for (const [name, target] of Object.entries(resolvedBins)) {
    await symlink(target, join(binDir, name));
  }

  // -----------------------------------------------------------------------
  // 3. Canonicalize mount sources
  // -----------------------------------------------------------------------
  const canonicalMounts: Array<{ source: string; target: string; mode: 'ro' | 'rw' }> = [];

  for (const mount of profile.mounts) {
    const isSkillDirPath = mount.source.startsWith(SKILL_DIR_TEMPLATE);

    // Substitute ${skill.dir} template
    const rawSource = isSkillDirPath
      ? mount.source.replace(SKILL_DIR_TEMPLATE, skillDir)
      : mount.source;

    // Resolve to canonical path
    let canonicalSource: string;
    try {
      canonicalSource = await realpath(rawSource);
    } catch {
      return err(
        new StagingError(
          skillName,
          `mount source does not exist: ${mount.source} (resolved to "${rawSource}")`,
          { source: mount.source, rawSource },
        ),
      );
    }

    // Containment check for ${skill.dir} paths
    if (isSkillDirPath) {
      const containmentResult = await isContained(canonicalSource, skillDir);
      if (containmentResult.isErr()) {
        return err(
          new StagingError(
            skillName,
            `mount source escapes skill directory: ${mount.source} (resolved to "${canonicalSource}")`,
            { source: mount.source, canonicalSource, skillDir },
          ),
        );
      }
    }

    canonicalMounts.push({
      source: canonicalSource,
      target: mount.target,
      mode: mount.mode,
    });
  }

  return ok({ binDir, resolvedBins, canonicalMounts });
}
