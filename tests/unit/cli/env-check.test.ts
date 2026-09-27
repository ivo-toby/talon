import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envCheck } from '../../../src/cli/commands/env-check.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-env-check-test-'));
  mkdirSync(join(tmpDir, 'skills'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function writeYaml(content: string): string {
  const p = join(tmpDir, 'talond.yaml');
  writeFileSync(p, content);
  return p;
}

function check(p: string) {
  return envCheck({ configPath: p, skillsDir: join(tmpDir, 'skills') });
}

describe('envCheck()', () => {
  it('returns empty array when no env vars referenced', async () => {
    const p = writeYaml('logLevel: info\n');
    const result = await check(p);
    expect(result).toEqual([]);
  });

  it('finds env var placeholders', async () => {
    const p = writeYaml('channels:\n  - token: ${TELEGRAM_TOKEN}\n    key: ${API_KEY}\n');
    const result = await check(p);

    expect(result).toHaveLength(2);
    expect(result.map((v) => v.name)).toEqual(['API_KEY', 'TELEGRAM_TOKEN']);
  });

  it('reports set/unset status', async () => {
    process.env.TEST_ENV_CHECK_VAR = 'hello';
    const p = writeYaml('token: ${TEST_ENV_CHECK_VAR}\nother: ${MISSING_VAR_12345}\n');
    const result = await check(p);

    const testVar = result.find((v) => v.name === 'TEST_ENV_CHECK_VAR');
    const missingVar = result.find((v) => v.name === 'MISSING_VAR_12345');

    expect(testVar?.isSet).toBe(true);
    expect(missingVar?.isSet).toBe(false);

    delete process.env.TEST_ENV_CHECK_VAR;
  });

  it('deduplicates env var references', async () => {
    const p = writeYaml('a: ${MY_VAR}\nb: ${MY_VAR}\nc: ${MY_VAR}\n');
    const result = await check(p);
    expect(result).toHaveLength(1);
  });

  it('throws for non-existent config', async () => {
    await expect(envCheck({ configPath: join(tmpDir, 'nope.yaml') }))
      .rejects.toThrow(/not found/);
  });

  it('finds secret placeholders and OAuth client references in MCP definitions', async () => {
    vi.stubEnv('MCP_STATIC_TOKEN', 'present');
    const mcpDir = join(tmpDir, 'skills', 'work-search', 'mcp');
    mkdirSync(mcpDir, { recursive: true });
    writeFileSync(join(mcpDir, 'server.json'), JSON.stringify({
      name: 'server',
      config: {
        transport: 'http',
        url: 'https://search.example.com/mcp',
        headers: { Authorization: 'Bearer ${MCP_STATIC_TOKEN}' },
        env: { MCP_API_KEY: '${MCP_API_KEY}' },
        auth: {
          kind: 'oauth2',
          clientIdEnv: 'MCP_OAUTH_CLIENT_ID',
          clientSecretEnv: 'MCP_OAUTH_CLIENT_SECRET',
          authorizationServerIssuer: 'https://identity.example.com',
        },
      },
    }));
    const p = writeYaml('logLevel: info\n');

    const result = await check(p);
    expect(result).toEqual([
      { name: 'MCP_API_KEY', isSet: false },
      { name: 'MCP_OAUTH_CLIENT_ID', isSet: false },
      { name: 'MCP_OAUTH_CLIENT_SECRET', isSet: false },
      { name: 'MCP_STATIC_TOKEN', isSet: true },
    ]);
  });

  it('treats empty environment variables as missing', async () => {
    vi.stubEnv('EMPTY_MCP_TOKEN', '');
    const p = writeYaml('token: ${EMPTY_MCP_TOKEN}\n');
    const result = await check(p);
    expect(result).toEqual([{ name: 'EMPTY_MCP_TOKEN', isSet: false }]);
  });
});
