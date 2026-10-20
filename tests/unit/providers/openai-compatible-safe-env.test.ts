import { describe, expect, it } from 'vitest';
import {
  ENV_PASSTHROUGH_VAR,
  buildSandboxEnv,
  buildWrapperEnv,
  normalizeEnvPassthrough,
} from '../../../src/providers/openai-compatible/agent-cli/safe-env.js';

const daemonEnv: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/home/talon',
  LANG: 'nl_NL.UTF-8',
  HTTPS_PROXY: 'http://user:pass@proxy:3128',
  NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  OPENAI_API_KEY: 'sk-openai-secret',
  TELEGRAM_BOT_TOKEN: 'tg-secret',
  TALOND_BRIDGE_SECRET: 'bridge-secret',
  GH_TOKEN: 'gh-secret',
};

describe('normalizeEnvPassthrough', () => {
  it('returns [] for non-arrays', () => {
    expect(normalizeEnvPassthrough(undefined)).toEqual([]);
    expect(normalizeEnvPassthrough('GH_TOKEN')).toEqual([]);
  });

  it('keeps valid names, trims, dedupes and drops invalid entries', () => {
    expect(
      normalizeEnvPassthrough([' GH_TOKEN ', 'GH_TOKEN', 'BAD-NAME', '', 42, '1X', 'A_B']),
    ).toEqual(['GH_TOKEN', 'A_B']);
  });
});

describe('buildWrapperEnv', () => {
  it('passes only allowlisted variables and never daemon secrets', () => {
    const env = buildWrapperEnv(daemonEnv, []);
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/talon',
      LANG: 'nl_NL.UTF-8',
      HTTPS_PROXY: 'http://user:pass@proxy:3128',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
    });
    expect(Object.values(env).join(' ')).not.toMatch(/secret/);
  });

  it('forwards explicit passthrough names and records them for the sandbox', () => {
    const env = buildWrapperEnv(daemonEnv, ['GH_TOKEN', 'NOT_SET']);
    expect(env.GH_TOKEN).toBe('gh-secret');
    expect(env).not.toHaveProperty('NOT_SET');
    expect(env[ENV_PASSTHROUGH_VAR]).toBe('GH_TOKEN,NOT_SET');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
});

describe('buildSandboxEnv', () => {
  it('drops proxy/TLS wrapper extras and secrets', () => {
    const env = buildSandboxEnv(buildWrapperEnv(daemonEnv, []));
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/talon', LANG: 'nl_NL.UTF-8' });
  });

  it('includes passthrough names recorded by the provider', () => {
    const env = buildSandboxEnv(buildWrapperEnv(daemonEnv, ['GH_TOKEN']));
    expect(env.GH_TOKEN).toBe('gh-secret');
    expect(env).not.toHaveProperty(ENV_PASSTHROUGH_VAR);
  });

  it('ignores invalid names smuggled into the passthrough variable', () => {
    const env = buildSandboxEnv({ ...daemonEnv, [ENV_PASSTHROUGH_VAR]: 'BAD-NAME,,PATH' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/talon', LANG: 'nl_NL.UTF-8' });
  });
});
