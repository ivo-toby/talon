/**
 * Zod schema for the `sandbox:` block in skill SKILL.md frontmatter.
 *
 * Validates every field according to the design spec
 * (docs/superpowers/specs/2026-04-05-skill-script-execution-design.md, section 1).
 *
 * Cross-field validations (secrets vs env, bins vs shell, mount target dedup)
 * are enforced via `.superRefine()` at the profile level.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Mount targets that the sandbox runner reserves. No user mount may equal,
 * be an ancestor of, or be a descendant of any of these paths -- with one
 * narrow exception for descendants of `/skill` that are NOT descendants of
 * `/skill/bin`.
 */
export const RESERVED_MOUNT_TARGETS = [
  '/workspace',
  '/skill',
  '/skill/bin',
  '/usr',
  '/usr/lib',
  '/lib',
  '/lib64',
  '/bin',
  '/proc',
  '/dev',
  '/tmp',
  '/run',
  '/etc',
] as const;

/** Default bins when none are specified. */
const DEFAULT_BINS = ['bash', 'sh', 'ls', 'cat'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a path for prefix comparison: strip trailing slashes (except root `/`),
 * then append `/` so that `/skill` becomes `/skill/` and prefix checks work correctly.
 */
function normForPrefix(p: string): string {
  if (p === '/') return '/';
  const clean = p.replace(/\/+$/, '');
  return clean + '/';
}

/**
 * Check whether `child` is a proper descendant of `parent`.
 * Both must be absolute paths.
 */
function isDescendantOf(child: string, parent: string): boolean {
  if (child === parent) return false;
  return normForPrefix(child).startsWith(normForPrefix(parent));
}

/**
 * Check whether `candidate` is a proper ancestor of `target`.
 */
function isAncestorOf(candidate: string, target: string): boolean {
  return isDescendantOf(target, candidate);
}

/** Extract the basename of a path (e.g. `/bin/bash` -> `bash`). */
function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] ?? p;
}

/**
 * Canonicalise a path: resolve `.`, `..`, and collapse `//`.
 * Does NOT hit the filesystem -- purely textual.
 * Returns `null` if the path tries to escape above root.
 */
function canonicalisePath(p: string): string | null {
  const segments = p.split('/').filter((s) => s !== '' && s !== '.');
  const result: string[] = [];
  for (const seg of segments) {
    if (seg === '..') {
      if (result.length === 0) return null; // escapes root
      result.pop();
    } else {
      result.push(seg);
    }
  }
  return '/' + result.join('/');
}

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

const MountSourceSchema = z.string().refine(
  (s) => {
    // Disallow textual `..` in path segments
    const segments = s.split('/');
    if (segments.some((seg) => seg === '..')) return false;

    // Check for ${...} substitutions -- only ${skill.dir} is allowed
    const substitutions = s.match(/\$\{[^}]+\}/g) ?? [];
    for (const sub of substitutions) {
      if (sub !== '${skill.dir}') return false;
    }

    // If no substitution, must be absolute
    if (substitutions.length === 0 && !s.startsWith('/')) return false;

    // If has substitution, must start with ${skill.dir}
    if (substitutions.length > 0 && !s.startsWith('${skill.dir}')) return false;

    return true;
  },
  {
    message:
      'mount source must start with ${skill.dir} or be an absolute path; ' +
      '${HOME}, ${persona.dataDir}, other substitutions, and ".." segments are forbidden',
  },
);

const MountTargetSchema = z.string().refine(
  (t) => {
    if (!t.startsWith('/')) return false;

    // Canonicalise: resolve `.`, `..`, collapse `//`
    const canonical = canonicalisePath(t);
    if (canonical === null) return false; // escapes root via ..

    const target = canonical;

    for (const reserved of RESERVED_MOUNT_TARGETS) {
      // Rule 1: equals a reserved target
      if (target === reserved) return false;

      // Rule 2: ancestor of a reserved target
      if (isAncestorOf(target, reserved)) return false;

      // Rule 3: descendant of a reserved target -- with /skill exception
      if (isDescendantOf(target, reserved)) {
        // Exception: descendants of /skill that are NOT descendants of /skill/bin
        if (reserved === '/skill' && !isDescendantOf(target, '/skill/bin')) {
          continue;
        }
        // Also allow if the reserved is /skill and we already handled it
        if (reserved !== '/skill') {
          return false;
        }
        // If reserved IS /skill and it IS a descendant of /skill/bin, reject
        if (isDescendantOf(target, '/skill/bin')) {
          return false;
        }
      }
    }

    return true;
  },
  {
    message:
      'mount target must be absolute and must not equal, be an ancestor of, or be a descendant of ' +
      'a reserved target (exception: descendants of /skill that are not under /skill/bin)',
  },
);

const MountSchema = z.object({
  source: MountSourceSchema,
  target: MountTargetSchema,
  mode: z.enum(['ro', 'rw']).default('ro'),
});

const ResourceLimitsSchema = z
  .object({
    memoryMb: z.number().optional().default(1024),
    cpus: z.number().optional().default(1),
    pidsLimit: z.number().optional().default(256),
  })
  .default({ memoryMb: 1024, cpus: 1, pidsLimit: 256 });

// ---------------------------------------------------------------------------
// Main schema
// ---------------------------------------------------------------------------

export const SkillSandboxProfileSchema = z
  .object({
    workdir: z
      .string()
      .default('repo')
      .refine(
        (v) => v === 'repo' || v === 'skill-bundle' || v.startsWith('/'),
        {
          message:
            'workdir must be "repo", "skill-bundle", or an absolute path starting with /',
        },
      ),

    mounts: z.array(MountSchema).default([]),

    network: z.enum(['off', 'on']).default('off'),

    secrets: z
      .array(
        z.string().regex(SECRET_NAME_RE, {
          message: 'secret name must match [A-Z_][A-Z0-9_]*',
        }),
      )
      .default([]),

    env: z.record(z.string(), z.string()).default({}),

    bins: z.array(z.string()).default(DEFAULT_BINS),

    image: z.string().default('talon-skill-runtime:latest'),

    shell: z.string().default('/bin/bash'),

    timeoutSeconds: z.number().int().min(1).max(600).default(60),

    resourceLimits: ResourceLimitsSchema,
  })
  .strict()
  .superRefine((profile, ctx) => {
    // Cross-field: secrets must not collide with env keys
    const envKeys = new Set(Object.keys(profile.env));
    for (const secret of profile.secrets) {
      if (envKeys.has(secret)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `secret "${secret}" collides with an env key`,
          path: ['secrets'],
        });
      }
    }

    // Cross-field: bins must be non-empty
    if (profile.bins.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'bins must not be empty when sandbox block is present',
        path: ['bins'],
      });
    }

    // Cross-field: bins must include the basename of shell
    const shellBase = basename(profile.shell);
    const binBasenames = profile.bins.map((b) => basename(b));
    if (!binBasenames.includes(shellBase)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `bins must include the shell "${profile.shell}" (basename "${shellBase}")`,
        path: ['bins'],
      });
    }

    // Cross-field: mount targets must not duplicate
    const targets = new Set<string>();
    for (let i = 0; i < profile.mounts.length; i++) {
      const mount = profile.mounts[i];
      if (!mount) continue;
      const t = mount.target;
      const normalised = t === '/' ? '/' : t.replace(/\/+$/, '');
      if (targets.has(normalised)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate mount target "${t}"`,
          path: ['mounts', i, 'target'],
        });
      }
      targets.add(normalised);
    }
  });

// ---------------------------------------------------------------------------
// Inferred type
// ---------------------------------------------------------------------------

export type SkillSandboxProfile = z.output<typeof SkillSandboxProfileSchema>;
