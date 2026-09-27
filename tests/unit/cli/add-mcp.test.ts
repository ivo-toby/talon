import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addMcp } from '../../../src/cli/commands/add-mcp.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-add-mcp-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function createSkillDir(skillName: string): string {
  const skillsDir = join(tmpDir, 'skills');
  mkdirSync(join(skillsDir, skillName, 'prompts'), { recursive: true });
  return skillsDir;
}

describe('addMcp()', () => {
  it('creates MCP server JSON in skills/{name}/mcp/', async () => {
    const skillsDir = createSkillDir('web-search');
    const result = await addMcp({
      skillName: 'web-search',
      name: 'brave-search',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      skillsDir,
    });

    expect(result.name).toBe('brave-search');
    expect(existsSync(result.mcpConfigPath)).toBe(true);

    const content = JSON.parse(readFileSync(result.mcpConfigPath, 'utf-8'));
    expect(content.name).toBe('brave-search');
    expect(content.config.transport).toBe('stdio');
    expect(content.config.command).toBe('npx');
    expect(content.config.args).toEqual(['-y', '@modelcontextprotocol/server-brave-search']);
  });

  it('includes env vars in config', async () => {
    const skillsDir = createSkillDir('web-search');
    await addMcp({
      skillName: 'web-search',
      name: 'brave-search',
      transport: 'stdio',
      command: 'npx',
      env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' },
      skillsDir,
    });

    const mcpPath = join(skillsDir, 'web-search', 'mcp', 'brave-search.json');
    const content = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(content.config.env.BRAVE_API_KEY).toBe('${BRAVE_API_KEY}');
  });

  it('supports sse transport with url', async () => {
    const skillsDir = createSkillDir('remote-skill');
    const result = await addMcp({
      skillName: 'remote-skill',
      name: 'remote-server',
      transport: 'sse',
      url: 'http://localhost:3000/sse',
      skillsDir,
    });

    const content = JSON.parse(readFileSync(result.mcpConfigPath, 'utf-8'));
    expect(content.config.transport).toBe('sse');
    expect(content.config.url).toBe('http://localhost:3000/sse');
  });

  it('writes OAuth settings and secret placeholders for an HTTP MCP server', async () => {
    const skillsDir = createSkillDir('work-search');
    const result = await addMcp({
      skillName: 'work-search',
      name: 'glean',
      transport: 'http',
      url: 'https://search.example.com/mcp',
      headers: { Authorization: 'Bearer ${GLEAN_STATIC_TOKEN}' },
      auth: {
        kind: 'oauth2',
        clientIdEnv: 'GLEAN_CLIENT_ID',
        clientSecretEnv: 'GLEAN_CLIENT_SECRET',
        authorizationServerIssuer: 'https://identity.example.com',
        scopes: ['search:read'],
        tokenEndpointAuthMethod: 'client_secret_basic',
      },
      skillsDir,
    });

    const content = JSON.parse(readFileSync(result.mcpConfigPath, 'utf-8'));
    expect(content.config.headers.Authorization).toBe('Bearer ${GLEAN_STATIC_TOKEN}');
    expect(content.config.auth).toEqual({
      kind: 'oauth2',
      clientIdEnv: 'GLEAN_CLIENT_ID',
      clientSecretEnv: 'GLEAN_CLIENT_SECRET',
      authorizationServerIssuer: 'https://identity.example.com',
      scopes: ['search:read'],
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
  });

  it('requires a pinned issuer when a pre-registered client is configured', async () => {
    const skillsDir = createSkillDir('work-search');
    await expect(addMcp({
      skillName: 'work-search',
      name: 'glean',
      transport: 'http',
      url: 'https://search.example.com/mcp',
      auth: { kind: 'oauth2', clientIdEnv: 'GLEAN_CLIENT_ID' },
      skillsDir,
    })).rejects.toThrow(/--client-id-env requires --authorization-server-issuer/);
  });

  it('requires HTTPS for OAuth MCP resource URLs', async () => {
    const skillsDir = createSkillDir('work-search');
    await expect(addMcp({
      skillName: 'work-search',
      name: 'glean',
      transport: 'http',
      url: 'http://search.example.com/mcp',
      auth: { kind: 'oauth2' },
      skillsDir,
    })).rejects.toThrow(/OAuth MCP server URLs must use HTTPS/);
  });

  it('requires a client id reference when a client secret reference is supplied', async () => {
    const skillsDir = createSkillDir('work-search');
    await expect(addMcp({
      skillName: 'work-search',
      name: 'glean',
      transport: 'http',
      url: 'https://search.example.com/mcp',
      auth: { kind: 'oauth2', clientSecretEnv: 'GLEAN_CLIENT_SECRET' },
      skillsDir,
    })).rejects.toThrow(/--client-secret-env requires --client-id-env/);
  });

  it('throws when skill directory does not exist', async () => {
    const skillsDir = join(tmpDir, 'skills');
    await expect(addMcp({
      skillName: 'nonexistent',
      name: 'server',
      transport: 'stdio',
      command: 'cmd',
      skillsDir,
    })).rejects.toThrow(/not found/);
  });

  it('throws when MCP config already exists', async () => {
    const skillsDir = createSkillDir('web-search');
    await addMcp({
      skillName: 'web-search',
      name: 'brave-search',
      transport: 'stdio',
      command: 'npx',
      skillsDir,
    });

    await expect(addMcp({
      skillName: 'web-search',
      name: 'brave-search',
      transport: 'stdio',
      command: 'npx',
      skillsDir,
    })).rejects.toThrow(/already exists/);
  });

  it('throws when stdio transport missing command', async () => {
    const skillsDir = createSkillDir('web-search');
    await expect(addMcp({
      skillName: 'web-search',
      name: 'server',
      transport: 'stdio',
      skillsDir,
    })).rejects.toThrow(/--command is required/);
  });

  it('throws when sse transport missing url', async () => {
    const skillsDir = createSkillDir('web-search');
    await expect(addMcp({
      skillName: 'web-search',
      name: 'server',
      transport: 'sse',
      skillsDir,
    })).rejects.toThrow(/--url is required/);
  });

  it('rejects invalid transport value', async () => {
    const skillsDir = createSkillDir('web-search');
    await expect(addMcp({
      skillName: 'web-search',
      name: 'server',
      transport: 'websocket' as 'stdio',
      command: 'cmd',
      skillsDir,
    })).rejects.toThrow(/Invalid transport/);
  });

  it('rejects invalid MCP server name', async () => {
    const skillsDir = createSkillDir('web-search');
    await expect(addMcp({
      skillName: 'web-search',
      name: 'bad name',
      transport: 'stdio',
      command: 'cmd',
      skillsDir,
    })).rejects.toThrow(/invalid/);
  });
});
