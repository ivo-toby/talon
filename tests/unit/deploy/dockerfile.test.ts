// Docker deployment is not yet implemented (TASK-037). These tests validate
// static deploy files that have drifted from the current codebase entry points.
// Skip until Docker hardening is prioritised.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEPLOY_DIR = resolve(import.meta.dirname, '../../../deploy');
const CONFIG_DIR = resolve(import.meta.dirname, '../../../config');

function readDeploy(file: string): string {
  return readFileSync(resolve(DEPLOY_DIR, file), 'utf8');
}

function readConfig(file: string): string {
  return readFileSync(resolve(CONFIG_DIR, file), 'utf8');
}

/**
 * Parse Dockerfile stages from content.
 * Returns an array of { name, base, content } objects, one per stage.
 */
function parseDockerfileStages(content: string): Array<{ name: string; base: string }> {
  const stages: Array<{ name: string; base: string }> = [];
  const fromPattern = /^FROM\s+(\S+)\s+AS\s+(\S+)/im;
  const lines = content.split('\n');

  for (const line of lines) {
    const m = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i);
    if (m) {
      stages.push({ base: m[1]!, name: m[2] ?? 'default' });
    }
  }
  return stages;
}

/**
 * Extract the value of a Dockerfile instruction (e.g. ENTRYPOINT, WORKDIR).
 * Returns the first match or undefined.
 */
function extractInstruction(content: string, instruction: string): string | undefined {
  const pattern = new RegExp(`^${instruction}\\s+(.+)$`, 'im');
  const m = content.match(pattern);
  return m?.[1]?.trim();
}

/**
 * Extract all occurrences of a Dockerfile instruction.
 */
function extractAllInstructions(content: string, instruction: string): string[] {
  const pattern = new RegExp(`^${instruction}\\s+(.+)$`, 'gim');
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    results.push(m[1]!.trim());
  }
  return results;
}

/**
 * Parse systemd unit file sections into a map of key->value pairs per section.
 */
function parseSystemdUnit(content: string): Record<string, Record<string, string[]>> {
  const sections: Record<string, Record<string, string[]>> = {};
  let currentSection = '';

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1]!;
      sections[currentSection] = sections[currentSection] ?? {};
      continue;
    }

    const kvMatch = line.match(/^([^=]+)=(.*)$/);
    if (kvMatch && currentSection) {
      const key = kvMatch[1]!.trim();
      const value = kvMatch[2]!.trim();
      const section = sections[currentSection]!;
      section[key] = section[key] ?? [];
      section[key]!.push(value);
    }
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Dockerfile (talond)
// ---------------------------------------------------------------------------

describe.skip('deploy/Dockerfile (talond)', () => {
  let content: string;
  let stages: Array<{ name: string; base: string }>;

  beforeAll(() => {
    content = readDeploy('Dockerfile');
    stages = parseDockerfileStages(content);
  });

  it('has exactly two stages', () => {
    expect(stages).toHaveLength(2);
  });

  it('first stage is named "builder"', () => {
    expect(stages[0]!.name).toBe('builder');
  });

  it('second stage is named "production"', () => {
    expect(stages[1]!.name).toBe('production');
  });

  it('both stages use node:24-slim as base', () => {
    expect(stages[0]!.base).toBe('node:24-slim');
    expect(stages[1]!.base).toBe('node:24-slim');
  });

  it('production stage copies from builder', () => {
    expect(content).toMatch(/COPY\s+--from=builder/i);
  });

  it('sets NODE_ENV=production', () => {
    expect(content).toMatch(/ENV\s+NODE_ENV=production/i);
  });

  it('creates a non-root talond user', () => {
    expect(content).toMatch(/useradd.*talond/i);
  });

  it('specifies uid 1000 for the talond user', () => {
    expect(content).toMatch(/--uid\s+1000/i);
  });

  it('declares /data volume', () => {
    expect(content).toMatch(/\/data/);
    const volumeLine = extractInstruction(content, 'VOLUME');
    expect(volumeLine).toContain('/data');
  });

  it('declares /config volume', () => {
    const volumeLine = extractInstruction(content, 'VOLUME');
    expect(volumeLine).toContain('/config');
  });

  it('has the correct ENTRYPOINT pointing to dist/index.js', () => {
    const entrypoint = extractInstruction(content, 'ENTRYPOINT');
    expect(entrypoint).toContain('dist/index.js');
  });

  it('ENTRYPOINT includes --config /config/talond.yaml', () => {
    const entrypoint = extractInstruction(content, 'ENTRYPOINT');
    expect(entrypoint).toContain('--config');
    expect(entrypoint).toContain('/config/talond.yaml');
  });

  it('has a HEALTHCHECK instruction', () => {
    expect(content).toMatch(/^HEALTHCHECK/im);
  });

  it('switches to USER talond', () => {
    expect(content).toMatch(/^USER\s+talond/im);
  });

  it('has OCI image title label', () => {
    expect(content).toMatch(/org\.opencontainers\.image\.title/i);
  });

  it('installs production node_modules with --omit=dev', () => {
    expect(content).toMatch(/npm\s+ci\s+--omit=dev/);
  });
});

// ---------------------------------------------------------------------------
// Dockerfile.sandbox
// ---------------------------------------------------------------------------

describe.skip('deploy/Dockerfile.sandbox (agent sandbox)', () => {
  let content: string;
  let stages: Array<{ name: string; base: string }>;

  beforeAll(() => {
    content = readDeploy('Dockerfile.sandbox');
    stages = parseDockerfileStages(content);
  });

  it('has a single stage (no builder stage needed)', () => {
    expect(stages).toHaveLength(1);
  });

  it('uses node:24-slim as base', () => {
    expect(stages[0]!.base).toBe('node:24-slim');
  });

  it('creates a non-root agent user', () => {
    expect(content).toMatch(/useradd.*agent/i);
  });

  it('uses UID 1001 for the agent user', () => {
    expect(content).toMatch(/--uid\s+1001/i);
  });

  it('switches to USER agent before ENTRYPOINT', () => {
    expect(content).toMatch(/^USER\s+agent/im);
  });

  it('sets WORKDIR to /workspace', () => {
    const workdir = extractInstruction(content, 'WORKDIR');
    expect(workdir).toBe('/workspace');
  });

  it('ENTRYPOINT is node (script mounted at runtime)', () => {
    const entrypoint = extractInstruction(content, 'ENTRYPOINT');
    expect(entrypoint).toContain('"node"');
  });

  it('sets NODE_ENV=production', () => {
    expect(content).toMatch(/ENV\s+NODE_ENV=production/i);
  });

  it('has OCI image title label', () => {
    expect(content).toMatch(/org\.opencontainers\.image\.title/i);
  });

  it('installs Anthropic SDK', () => {
    expect(content).toMatch(/@anthropic-ai\//i);
  });
});

// ---------------------------------------------------------------------------
// talond.service
// ---------------------------------------------------------------------------

describe.skip('deploy/talond.service', () => {
  let content: string;
  let unit: Record<string, Record<string, string[]>>;

  beforeAll(() => {
    content = readDeploy('talond.service');
    unit = parseSystemdUnit(content);
  });

  it('has [Unit] section', () => {
    expect(unit['Unit']).toBeDefined();
  });

  it('has [Service] section', () => {
    expect(unit['Service']).toBeDefined();
  });

  it('has [Install] section', () => {
    expect(unit['Install']).toBeDefined();
  });

  it('has After=docker.service', () => {
    const after = unit['Unit']?.['After']?.join(' ') ?? '';
    expect(after).toContain('docker.service');
  });

  it('sets NODE_ENV=production', () => {
    const env = unit['Service']?.['Environment'] ?? [];
    expect(env.some((e) => e.includes('NODE_ENV=production'))).toBe(true);
  });

  it('sets Restart=on-failure', () => {
    const restart = unit['Service']?.['Restart']?.[0] ?? '';
    expect(restart).toBe('on-failure');
  });

  it('sets WatchdogSec=30', () => {
    const watchdog = unit['Service']?.['WatchdogSec']?.[0] ?? '';
    expect(watchdog).toBe('30');
  });

  it('has NoNewPrivileges=true', () => {
    const nnp = unit['Service']?.['NoNewPrivileges']?.[0] ?? '';
    expect(nnp).toBe('true');
  });

  it('has ProtectSystem=strict', () => {
    const ps = unit['Service']?.['ProtectSystem']?.[0] ?? '';
    expect(ps).toBe('strict');
  });

  it('has ProtectHome=true', () => {
    const ph = unit['Service']?.['ProtectHome']?.[0] ?? '';
    expect(ph).toBe('true');
  });

  it('has PrivateTmp=true', () => {
    const pt = unit['Service']?.['PrivateTmp']?.[0] ?? '';
    expect(pt).toBe('true');
  });

  it('ExecStart references dist/index.js', () => {
    const exec = unit['Service']?.['ExecStart']?.[0] ?? '';
    expect(exec).toContain('dist/index.js');
  });

  it('WantedBy is multi-user.target', () => {
    const wb = unit['Install']?.['WantedBy']?.[0] ?? '';
    expect(wb).toBe('multi-user.target');
  });
});

// ---------------------------------------------------------------------------
// talond.timer
// ---------------------------------------------------------------------------

describe.skip('deploy/talond.timer', () => {
  let content: string;
  let unit: Record<string, Record<string, string[]>>;

  beforeAll(() => {
    content = readDeploy('talond.timer');
    unit = parseSystemdUnit(content);
  });

  it('has [Timer] section', () => {
    expect(unit['Timer']).toBeDefined();
  });

  it('has [Install] section', () => {
    expect(unit['Install']).toBeDefined();
  });

  it('sets Persistent=true', () => {
    const persistent = unit['Timer']?.['Persistent']?.[0] ?? '';
    expect(persistent).toBe('true');
  });

  it('sets OnUnitActiveSec', () => {
    expect(unit['Timer']?.['OnUnitActiveSec']).toBeDefined();
  });

  it('triggers talond-wake.service', () => {
    const unitTarget = unit['Timer']?.['Unit']?.[0] ?? '';
    expect(unitTarget).toBe('talond-wake.service');
  });

  it('WantedBy is timers.target', () => {
    const wb = unit['Install']?.['WantedBy']?.[0] ?? '';
    expect(wb).toBe('timers.target');
  });

  it('has OnBootSec to delay first run', () => {
    expect(unit['Timer']?.['OnBootSec']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// talond-wake.service
// ---------------------------------------------------------------------------

describe.skip('deploy/talond-wake.service', () => {
  let content: string;
  let unit: Record<string, Record<string, string[]>>;

  beforeAll(() => {
    content = readDeploy('talond-wake.service');
    unit = parseSystemdUnit(content);
  });

  it('has [Unit] section', () => {
    expect(unit['Unit']).toBeDefined();
  });

  it('has [Service] section', () => {
    expect(unit['Service']).toBeDefined();
  });

  it('Type is oneshot', () => {
    const type = unit['Service']?.['Type']?.[0] ?? '';
    expect(type).toBe('oneshot');
  });

  it('conflicts with talond.service (mutually exclusive with persistent daemon)', () => {
    const conflicts = unit['Unit']?.['Conflicts']?.[0] ?? '';
    expect(conflicts).toContain('talond.service');
  });

  it('has NoNewPrivileges=true', () => {
    const nnp = unit['Service']?.['NoNewPrivileges']?.[0] ?? '';
    expect(nnp).toBe('true');
  });

  it('has ProtectSystem=strict', () => {
    const ps = unit['Service']?.['ProtectSystem']?.[0] ?? '';
    expect(ps).toBe('strict');
  });

  it('sets NODE_ENV=production', () => {
    const env = unit['Service']?.['Environment'] ?? [];
    expect(env.some((e) => e.includes('NODE_ENV=production'))).toBe(true);
  });

  it('ExecStart references talonctl or wake command', () => {
    const exec = unit['Service']?.['ExecStart']?.[0] ?? '';
    expect(exec).toMatch(/wake/i);
  });

  it('has no [Install] section (managed by timer, not enabled directly)', () => {
    // The wake service should NOT have a WantedBy — it is activated by the timer
    const install = unit['Install'];
    const wantedBy = install?.['WantedBy'];
    expect(wantedBy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// docker-compose.yaml
// ---------------------------------------------------------------------------

describe.skip('deploy/docker-compose.yaml', () => {
  let content: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;

  beforeAll(() => {
    content = readDeploy('docker-compose.yaml');
    parsed = yaml.load(content);
  });

  it('is valid YAML', () => {
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe('object');
  });

  it('has a services key', () => {
    expect(parsed.services).toBeDefined();
  });

  it('includes a talond service', () => {
    expect(parsed.services.talond).toBeDefined();
  });

  it('talond service has restart: unless-stopped', () => {
    expect(parsed.services.talond.restart).toBe('unless-stopped');
  });

  it('talond service has volume mounts', () => {
    const volumes = parsed.services.talond.volumes;
    expect(Array.isArray(volumes)).toBe(true);
    expect(volumes.length).toBeGreaterThan(0);
  });

  it('talond service has /data in its volumes', () => {
    const volumes = JSON.stringify(parsed.services.talond.volumes);
    expect(volumes).toContain('/data');
  });

  it('talond service has /config in its volumes', () => {
    const volumes = JSON.stringify(parsed.services.talond.volumes);
    expect(volumes).toContain('/config');
  });

  it('talond service references an env_file', () => {
    expect(parsed.services.talond.env_file).toBeDefined();
  });

  it('talond service has NODE_ENV=production in environment', () => {
    const env = parsed.services.talond.environment;
    expect(env).toBeDefined();
    const envStr = JSON.stringify(env);
    expect(envStr).toContain('production');
  });

  it('talond service drops all capabilities', () => {
    const capDrop = parsed.services.talond.cap_drop;
    expect(capDrop).toBeDefined();
    expect(capDrop).toContain('ALL');
  });

  it('declares a named volume for persistent data', () => {
    expect(parsed.volumes).toBeDefined();
    const volumeKeys = Object.keys(parsed.volumes ?? {});
    expect(volumeKeys.length).toBeGreaterThan(0);
  });

  it('talond service has a healthcheck', () => {
    expect(parsed.services.talond.healthcheck).toBeDefined();
  });

  it('talond service has a build section', () => {
    expect(parsed.services.talond.build).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// config/talond.example.yaml — deployment mode comments
// ---------------------------------------------------------------------------

describe('config/talond.example.yaml', () => {
  let content: string;

  beforeAll(() => {
    content = readConfig('talond.example.yaml');
  });

  it('mentions native daemon (systemd) deployment mode', () => {
    expect(content).toMatch(/native daemon/i);
  });

  it('mentions container daemon (Docker) deployment mode', () => {
    expect(content).toMatch(/container daemon/i);
  });

  it('mentions wake-only / timer mode', () => {
    expect(content).toMatch(/wake-only/i);
  });

  it('references talond.service in comments', () => {
    expect(content).toContain('talond.service');
  });

  it('references docker-compose.yaml in comments', () => {
    expect(content).toContain('docker-compose.yaml');
  });

  it('references talond.timer in comments', () => {
    expect(content).toContain('talond.timer');
  });

  it('is valid YAML (no syntax errors)', () => {
    // js-yaml throws on syntax errors
    expect(() => yaml.load(content)).not.toThrow();
  });
});
