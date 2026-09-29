import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOAuthFlow } from '../../../src/auth/oauth-flow.js';
import { readTokens } from '../../../src/auth/oauth-token-store.js';
import { authMcp } from '../../../src/cli/commands/auth-mcp.js';

vi.mock('../../../src/auth/oauth-flow.js', () => ({
  runOAuthFlow: vi.fn(),
}));

describe('authMcp()', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'talon-auth-mcp-test-'));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await rm(rootDir, { recursive: true, force: true });
  });

  async function writeServerDefinition(
    fileName = 'search',
    definitionName = 'search',
  ): Promise<string> {
    const skillsDir = join(rootDir, 'skills');
    const mcpDir = join(skillsDir, 'work-search', 'mcp');
    await mkdir(mcpDir, { recursive: true });
    await writeFile(join(mcpDir, `${fileName}.json`), JSON.stringify({
      name: definitionName,
      config: {
        transport: 'http',
        url: 'https://search.example.com/mcp',
        auth: {
          kind: 'oauth2',
          clientIdEnv: 'WORK_SEARCH_CLIENT_ID',
          clientSecretEnv: 'WORK_SEARCH_CLIENT_SECRET',
          authorizationServerIssuer: 'https://identity.example.com',
          scopes: ['search:read'],
        },
      },
    }));
    return skillsDir;
  }

  it('uses pre-registered credentials but persists only environment references', async () => {
    const skillsDir = await writeServerDefinition();
    const dataDir = join(rootDir, 'data');
    const clientSecret = 'secret-not-for-disk';
    vi.mocked(runOAuthFlow).mockResolvedValue({
      authorizationServer: {
        issuer: 'https://identity.example.com',
        authorization_endpoint: 'https://identity.example.com/authorize',
        token_endpoint: 'https://identity.example.com/token',
      },
      tokens: {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 60_000,
        tokenEndpoint: 'https://identity.example.com/token',
        clientId: 'client-id-not-for-disk',
        clientSecret,
        tokenEndpointAuthMethod: 'client_secret_basic',
      },
    });

    const result = await authMcp({
      selector: 'work-search:search',
      dataDir,
      skillsDir,
      environment: {
        WORK_SEARCH_CLIENT_ID: 'client-id-not-for-disk',
        WORK_SEARCH_CLIENT_SECRET: clientSecret,
      },
      printLine: vi.fn(),
    });

    expect(runOAuthFlow).toHaveBeenCalledWith(expect.objectContaining({
      expectedAuthorizationServerIssuer: 'https://identity.example.com',
      scopes: ['search:read'],
      registeredClient: {
        clientId: 'client-id-not-for-disk',
        clientSecret,
        tokenEndpointAuthMethod: 'client_secret_basic',
      },
    }));
    const stored = await readTokens(dataDir, result.tokenStoreId);
    expect(stored).toMatchObject({
      clientIdEnv: 'WORK_SEARCH_CLIENT_ID',
      clientSecretEnv: 'WORK_SEARCH_CLIENT_SECRET',
      tokenEndpointAuthMethod: 'client_secret_basic',
      authorizationServerIssuer: 'https://identity.example.com',
    });
    expect(stored?.clientId).toBeUndefined();
    expect(stored?.clientSecret).toBeUndefined();
    const raw = await readFile(result.tokenFilePath, 'utf-8');
    expect(raw).not.toContain(clientSecret);
    expect(raw).not.toContain('client-id-not-for-disk');
  });

  it('uses the declared MCP name for the default token store when the file name differs', async () => {
    const skillsDir = await writeServerDefinition('remote', 'glean');
    const dataDir = join(rootDir, 'data');
    vi.mocked(runOAuthFlow).mockResolvedValue({
      authorizationServer: {
        issuer: 'https://identity.example.com',
        authorization_endpoint: 'https://identity.example.com/authorize',
        token_endpoint: 'https://identity.example.com/token',
      },
      tokens: {
        accessToken: 'access-token',
        expiresAt: Date.now() + 60_000,
        tokenEndpoint: 'https://identity.example.com/token',
      },
    });

    const result = await authMcp({
      selector: 'work-search:remote',
      dataDir,
      skillsDir,
      environment: {
        WORK_SEARCH_CLIENT_ID: 'client-id',
        WORK_SEARCH_CLIENT_SECRET: 'client-secret',
      },
      printLine: vi.fn(),
    });

    expect(result.tokenStoreId).toBe('work-search/glean');
    expect(result.tokenFilePath).toBe(join(dataDir, 'mcp-auth', 'work-search', 'glean.json'));
  });

  it('fails before starting OAuth when a referenced client secret is unset', async () => {
    const skillsDir = await writeServerDefinition();
    await expect(authMcp({
      selector: 'work-search:search',
      dataDir: join(rootDir, 'data'),
      skillsDir,
      environment: { WORK_SEARCH_CLIENT_ID: 'client-id' },
      printLine: vi.fn(),
    })).rejects.toThrow(/requires environment variable "WORK_SEARCH_CLIENT_SECRET" to be set/i);
    expect(runOAuthFlow).not.toHaveBeenCalled();
  });

  it('does not persist access tokens that providers could re-expand', async () => {
    const skillsDir = await writeServerDefinition();
    const dataDir = join(rootDir, 'data');
    vi.mocked(runOAuthFlow).mockResolvedValue({
      authorizationServer: {
        issuer: 'https://identity.example.com',
        authorization_endpoint: 'https://identity.example.com/authorize',
        token_endpoint: 'https://identity.example.com/token',
      },
      tokens: {
        accessToken: '${DAEMON_SECRET}',
        expiresAt: Date.now() + 60_000,
        tokenEndpoint: 'https://identity.example.com/token',
      },
    });

    await expect(authMcp({
      selector: 'work-search:search',
      dataDir,
      skillsDir,
      environment: {
        WORK_SEARCH_CLIENT_ID: 'client-id',
        WORK_SEARCH_CLIENT_SECRET: 'client-secret',
      },
      printLine: vi.fn(),
    })).rejects.toThrow(/refusing to persist it/i);

    await expect(readTokens(dataDir, 'work-search/search')).resolves.toBeUndefined();
  });
});
