import { describe, it, expect } from 'vitest';
import {
  SkillSandboxProfileSchema,
  RESERVED_MOUNT_TARGETS,
} from '@talon/skills/skill-sandbox-schema';

/** Helper: parse and return data or errors. */
function parse(input: Record<string, unknown>) {
  return SkillSandboxProfileSchema.safeParse(input);
}

function expectSuccess(input: Record<string, unknown>) {
  const result = parse(input);
  if (!result.success) {
    throw new Error(
      `Expected success but got errors: ${JSON.stringify(result.error.issues, null, 2)}`,
    );
  }
  return result.data;
}

function expectFailure(input: Record<string, unknown>) {
  const result = parse(input);
  expect(result.success).toBe(false);
  if (result.success) throw new Error('unreachable');
  return result.error;
}

describe('SkillSandboxProfileSchema', () => {
  // -----------------------------------------------------------------------
  // Defaults
  // -----------------------------------------------------------------------
  describe('defaults (empty block)', () => {
    it('produces correct defaults for an empty object', () => {
      const data = expectSuccess({});
      expect(data.workdir).toBe('repo');
      expect(data.network).toBe('off');
      expect(data.secrets).toEqual([]);
      expect(data.env).toEqual({});
      expect(data.bins).toEqual(['bash', 'sh', 'ls', 'cat']);
      expect(data.mounts).toEqual([]);
      expect(data.image).toBe('talon-skill-runtime:latest');
      expect(data.shell).toBe('/bin/bash');
      expect(data.timeoutSeconds).toBe(60);
      expect(data.resourceLimits).toEqual({
        memoryMb: 1024,
        cpus: 1,
        pidsLimit: 256,
      });
    });
  });

  // -----------------------------------------------------------------------
  // workdir
  // -----------------------------------------------------------------------
  describe('workdir', () => {
    it('accepts "repo"', () => {
      const data = expectSuccess({ workdir: 'repo' });
      expect(data.workdir).toBe('repo');
    });

    it('accepts "skill-bundle"', () => {
      const data = expectSuccess({ workdir: 'skill-bundle' });
      expect(data.workdir).toBe('skill-bundle');
    });

    it('accepts an absolute path', () => {
      const data = expectSuccess({ workdir: '/var/data' });
      expect(data.workdir).toBe('/var/data');
    });

    it('rejects a relative path', () => {
      expectFailure({ workdir: 'relative/path' });
    });
  });

  // -----------------------------------------------------------------------
  // mounts[].source
  // -----------------------------------------------------------------------
  describe('mount source', () => {
    it('accepts ${skill.dir}/foo', () => {
      expectSuccess({
        mounts: [
          { source: '${skill.dir}/foo', target: '/skill/fixtures' },
        ],
      });
    });

    it('accepts absolute path /usr/share/dict', () => {
      expectSuccess({
        mounts: [
          { source: '/usr/share/dict', target: '/skill/data' },
        ],
      });
    });

    it('rejects ${HOME}/foo', () => {
      expectFailure({
        mounts: [{ source: '${HOME}/foo', target: '/skill/data' }],
      });
    });

    it('rejects ${persona.dataDir}/foo', () => {
      expectFailure({
        mounts: [{ source: '${persona.dataDir}/foo', target: '/skill/data' }],
      });
    });

    it('rejects ../escape', () => {
      expectFailure({
        mounts: [{ source: '../escape', target: '/skill/data' }],
      });
    });

    it('rejects relative path without substitution', () => {
      expectFailure({
        mounts: [{ source: 'relative/path', target: '/skill/data' }],
      });
    });

    it('rejects path with .. segment in the middle', () => {
      expectFailure({
        mounts: [{ source: '/foo/../bar', target: '/skill/data' }],
      });
    });
  });

  // -----------------------------------------------------------------------
  // mounts[].target — reserved targets
  // -----------------------------------------------------------------------
  describe('mount target', () => {
    it('rejects /workspace (exact reserved)', () => {
      expectFailure({
        mounts: [{ source: '/data', target: '/workspace' }],
      });
    });

    it('rejects /skill (exact reserved)', () => {
      expectFailure({
        mounts: [{ source: '/data', target: '/skill' }],
      });
    });

    it('rejects /skill/bin (exact reserved)', () => {
      expectFailure({
        mounts: [{ source: '/data', target: '/skill/bin' }],
      });
    });

    it('rejects /usr (exact reserved)', () => {
      expectFailure({
        mounts: [{ source: '/data', target: '/usr' }],
      });
    });

    it('rejects /etc (exact reserved)', () => {
      expectFailure({
        mounts: [{ source: '/data', target: '/etc' }],
      });
    });

    it('rejects descendant of /skill/bin (e.g. /skill/bin/curl)', () => {
      expectFailure({
        mounts: [{ source: '/data', target: '/skill/bin/curl' }],
      });
    });

    it('rejects descendant of /usr (e.g. /usr/lib/foo)', () => {
      expectFailure({
        mounts: [{ source: '/data', target: '/usr/lib/foo' }],
      });
    });

    it('rejects descendant of /etc (e.g. /etc/hosts)', () => {
      expectFailure({
        mounts: [{ source: '/data', target: '/etc/hosts' }],
      });
    });

    it('allows descendant of /skill that is NOT under /skill/bin', () => {
      expectSuccess({
        mounts: [
          { source: '/data', target: '/skill/fixtures' },
        ],
      });
    });

    it('allows /skill/data/seed', () => {
      expectSuccess({
        mounts: [{ source: '/data', target: '/skill/data/seed' }],
      });
    });

    it('rejects ancestor of reserved target (e.g. /)', () => {
      expectFailure({
        mounts: [{ source: '/data', target: '/' }],
      });
    });

    it('rejects non-absolute target', () => {
      expectFailure({
        mounts: [{ source: '/data', target: 'relative' }],
      });
    });

    it('rejects /skill/../etc (path traversal bypass)', () => {
      expectFailure({
        mounts: [{ source: '/data', target: '/skill/../etc' }],
      });
    });

    it('rejects /.//skill/bin/curl (double-slash bypass)', () => {
      expectFailure({
        mounts: [{ source: '/data', target: '/.//skill/bin/curl' }],
      });
    });

    it('rejects /skill//bin/curl (double-slash in path)', () => {
      expectFailure({
        mounts: [{ source: '/data', target: '/skill//bin/curl' }],
      });
    });

    it('rejects /skill/../usr/lib (traversal to reserved)', () => {
      expectFailure({
        mounts: [{ source: '/data', target: '/skill/../usr/lib' }],
      });
    });
  });

  // -----------------------------------------------------------------------
  // mounts[].target dedup
  // -----------------------------------------------------------------------
  describe('mount target dedup', () => {
    it('rejects two mounts with the same target', () => {
      expectFailure({
        mounts: [
          { source: '/a', target: '/skill/fixtures' },
          { source: '/b', target: '/skill/fixtures' },
        ],
      });
    });
  });

  // -----------------------------------------------------------------------
  // mounts[].mode
  // -----------------------------------------------------------------------
  describe('mount mode', () => {
    it('defaults to ro', () => {
      const data = expectSuccess({
        mounts: [{ source: '/data', target: '/skill/fixtures' }],
      });
      expect(data.mounts[0]!.mode).toBe('ro');
    });

    it('accepts rw', () => {
      const data = expectSuccess({
        mounts: [{ source: '/data', target: '/skill/fixtures', mode: 'rw' }],
      });
      expect(data.mounts[0]!.mode).toBe('rw');
    });
  });

  // -----------------------------------------------------------------------
  // network
  // -----------------------------------------------------------------------
  describe('network', () => {
    it('accepts "off"', () => {
      const data = expectSuccess({ network: 'off' });
      expect(data.network).toBe('off');
    });

    it('accepts "on"', () => {
      const data = expectSuccess({ network: 'on' });
      expect(data.network).toBe('on');
    });

    it('rejects "allowlist"', () => {
      expectFailure({ network: 'allowlist' });
    });

    it('rejects random string', () => {
      expectFailure({ network: 'maybe' });
    });
  });

  // -----------------------------------------------------------------------
  // secrets
  // -----------------------------------------------------------------------
  describe('secrets', () => {
    it('accepts valid secret name', () => {
      expectSuccess({ secrets: ['MY_SECRET_123'] });
    });

    it('accepts name starting with underscore', () => {
      expectSuccess({ secrets: ['_TOKEN'] });
    });

    it('rejects lowercase secret name', () => {
      expectFailure({ secrets: ['my_secret'] });
    });

    it('rejects secret starting with digit', () => {
      expectFailure({ secrets: ['1BAD'] });
    });

    it('rejects collision with env key', () => {
      expectFailure({
        secrets: ['API_KEY'],
        env: { API_KEY: 'value' },
      });
    });
  });

  // -----------------------------------------------------------------------
  // bins
  // -----------------------------------------------------------------------
  describe('bins', () => {
    it('accepts non-empty bins', () => {
      const data = expectSuccess({ bins: ['bash', 'node'], shell: '/bin/bash' });
      expect(data.bins).toEqual(['bash', 'node']);
    });

    it('rejects empty bins', () => {
      expectFailure({ bins: [] });
    });

    it('rejects bins that do not include shell', () => {
      expectFailure({ bins: ['node', 'npm'], shell: '/bin/bash' });
    });
  });

  // -----------------------------------------------------------------------
  // shell + bins cross-check
  // -----------------------------------------------------------------------
  describe('shell + bins cross-check', () => {
    it('accepts shell /bin/bash with bins including bash', () => {
      expectSuccess({ shell: '/bin/bash', bins: ['bash', 'node'] });
    });

    it('accepts shell /bin/bash with bins including /bin/bash', () => {
      expectSuccess({ shell: '/bin/bash', bins: ['/bin/bash', 'node'] });
    });

    it('rejects shell /bin/zsh without zsh in bins', () => {
      expectFailure({ shell: '/bin/zsh', bins: ['bash', 'node'] });
    });

    it('accepts shell /bin/zsh with zsh in bins', () => {
      expectSuccess({ shell: '/bin/zsh', bins: ['bash', 'zsh'] });
    });
  });

  // -----------------------------------------------------------------------
  // timeoutSeconds
  // -----------------------------------------------------------------------
  describe('timeoutSeconds', () => {
    it('accepts 60', () => {
      const data = expectSuccess({ timeoutSeconds: 60 });
      expect(data.timeoutSeconds).toBe(60);
    });

    it('accepts 1 (minimum)', () => {
      const data = expectSuccess({ timeoutSeconds: 1 });
      expect(data.timeoutSeconds).toBe(1);
    });

    it('accepts 600 (maximum)', () => {
      const data = expectSuccess({ timeoutSeconds: 600 });
      expect(data.timeoutSeconds).toBe(600);
    });

    it('rejects 0', () => {
      expectFailure({ timeoutSeconds: 0 });
    });

    it('rejects 601', () => {
      expectFailure({ timeoutSeconds: 601 });
    });
  });

  // -----------------------------------------------------------------------
  // strict mode
  // -----------------------------------------------------------------------
  describe('strict mode', () => {
    it('rejects unknown key', () => {
      expectFailure({ foo: 'bar' } as Record<string, unknown>);
    });
  });

  // -----------------------------------------------------------------------
  // resourceLimits
  // -----------------------------------------------------------------------
  describe('resourceLimits', () => {
    it('accepts partial resourceLimits', () => {
      const data = expectSuccess({ resourceLimits: { memoryMb: 512 } });
      expect(data.resourceLimits.memoryMb).toBe(512);
      expect(data.resourceLimits.cpus).toBe(1);
      expect(data.resourceLimits.pidsLimit).toBe(256);
    });
  });

  // -----------------------------------------------------------------------
  // RESERVED_MOUNT_TARGETS export
  // -----------------------------------------------------------------------
  describe('RESERVED_MOUNT_TARGETS', () => {
    it('is exported and contains expected entries', () => {
      expect(RESERVED_MOUNT_TARGETS).toContain('/workspace');
      expect(RESERVED_MOUNT_TARGETS).toContain('/skill');
      expect(RESERVED_MOUNT_TARGETS).toContain('/skill/bin');
      expect(RESERVED_MOUNT_TARGETS).toContain('/usr');
      expect(RESERVED_MOUNT_TARGETS).toContain('/etc');
      expect(RESERVED_MOUNT_TARGETS.length).toBe(13);
    });
  });
});
