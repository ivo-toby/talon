import { describe, expect, it, vi } from 'vitest';
import { err, ok } from 'neverthrow';
import pino from 'pino';
import { createDaemonProviderFactory } from '../../../src/scripts/daemon-provider.js';
import type { DaemonProviderDeps } from '../../../src/scripts/daemon-provider.js';
import { ScriptError } from '../../../src/scripts/types.js';
import type { AuthoredManifest, RunContext, RunProvider } from '../../../src/scripts/types.js';

const context: RunContext = {
  personaId: 'p1',
  threadId: 't1',
  scriptRunId: 'r1',
  scriptName: 'mail-intake',
  channels: [],
  versionDir: '/x',
};

function manifest(tools: string[]): AuthoredManifest {
  return { name: 'mail-intake', description: 'd', tools, channels: [], dryRunInput: null };
}

function setup(
  over: {
    provider?: string;
    providers?: Record<string, unknown>;
    auth?: Record<string, unknown>;
    servers?: Array<{ name: string; config: Record<string, unknown> }>;
    persona?: boolean;
    model?: string;
  } = {},
) {
  const mcpProvider: RunProvider = {
    describe: (name) => (name.startsWith('mail.') ? { toolClass: 'read' } : undefined),
    call: () => Promise.resolve(ok('mcp')),
    close: vi.fn(() => Promise.resolve()),
  };
  const createMcp = vi.fn(() => Promise.resolve(ok(mcpProvider)));
  const createJudgeModel = vi.fn(() => ({ generate: () => Promise.resolve(ok({})) }));
  const materializeBearer = vi.fn(() => Promise.resolve('secret-token'));
  const servers = over.servers ?? [
    { name: 'mail', config: { transport: 'stdio', command: 'mail-server', args: [] } },
    { name: 'calendar', config: { transport: 'stdio', command: 'cal-server', args: [] } },
  ];
  const deps = {
    hostTools: { executeInProcess: vi.fn() },
    personaLoader: {
      getById: () =>
        ok(
          over.persona === false
            ? undefined
            : {
                config: {
                  name: 'p1',
                  skills: ['s1'],
                  model: over.model ?? 'big-model',
                  ...(over.provider ? { provider: over.provider } : {}),
                },
                resolvedCapabilities: { allow: [], requireApproval: [] },
              },
        ),
    },
    skillResolver: {
      collectMcpServers: () => servers,
      mergePromptFragments: () => '',
    },
    loadedSkills: () => [
      { manifest: { name: 's1', description: 'x' }, promptContents: [], resolvedMcpServers: [] },
      { manifest: { name: 'other', description: 'x' }, promptContents: [], resolvedMcpServers: [] },
    ],
    config: () => ({
      agentRunner: {
        defaultProvider: 'claude-code',
        providers: over.providers ?? {
          'claude-code': { enabled: true, command: 'claude' },
          local: {
            enabled: true,
            type: 'openai-compatible',
            command: 'x',
            options: { baseUrl: 'http://llm.test/v1', headers: { 'x-a': '1', bad: 2 } },
          },
        },
      },
      auth: { providers: over.auth ?? { 'openai-compatible': { apiKey: 'k1' } } },
      scripts: { judgeTimeoutMs: 5000, toolClasses: { 'mail.send': 'write' } },
    }),
    tokenStore: { materializeBearer },
    logger: pino({ level: 'silent' }),
    createMcp,
    createJudgeModel,
  } as unknown as DaemonProviderDeps;
  return {
    factory: createDaemonProviderFactory(deps),
    createMcp,
    createJudgeModel,
    materializeBearer,
    mcpProvider,
  };
}

describe('createDaemonProviderFactory', () => {
  it('fails with a fixed message when the persona is not loaded', async () => {
    const { factory } = setup({ persona: false });
    const result = await factory(context, manifest(['talon.memory_read']));
    expect(result._unsafeUnwrapErr().scriptCode).toBe('TOOL_FAILED');
  });

  it('connects no MCP server and makes no judge model for a manifest of host tools', async () => {
    const { factory, createMcp, createJudgeModel } = setup({ provider: 'local' });
    const provider = (await factory(context, manifest(['talon.memory_read'])))._unsafeUnwrap();
    expect(createMcp).not.toHaveBeenCalled();
    expect(createJudgeModel).not.toHaveBeenCalled();
    expect(provider.describe('talon.memory_read')).toEqual({ toolClass: 'read' });
    expect(provider.describe('talon.memory_write')).toEqual({ toolClass: 'write' });
    expect(provider.describe('mail.list')).toBeUndefined();
    expect(provider.describe('model.judge')).toBeUndefined();
  });

  it('connects only the servers that the manifest names', async () => {
    const { factory, createMcp } = setup();
    const provider = (
      await factory(context, manifest(['mail.list', 'talon.memory_read']))
    )._unsafeUnwrap();
    expect(createMcp).toHaveBeenCalledTimes(1);
    const options = createMcp.mock.calls[0][0] as {
      servers: Record<string, unknown>;
      toolClasses: unknown;
    };
    expect(Object.keys(options.servers)).toEqual(['mail']);
    expect(options.toolClasses).toEqual({ 'mail.send': 'write' });
    expect(provider.describe('mail.list')).toEqual({ toolClass: 'read' });
  });

  it('does not call the MCP factory when the persona has none of the named servers', async () => {
    const { factory, createMcp } = setup();
    const provider = (await factory(context, manifest(['crm.find'])))._unsafeUnwrap();
    expect(createMcp).not.toHaveBeenCalled();
    expect(provider.describe('crm.find')).toBeUndefined();
  });

  it('returns the error of the MCP factory', async () => {
    const { factory, createMcp } = setup();
    createMcp.mockResolvedValueOnce(err(new ScriptError('TOOL_FAILED', 'no connection')) as never);
    const result = await factory(context, manifest(['mail.list']));
    expect(result._unsafeUnwrapErr().scriptCode).toBe('TOOL_FAILED');
  });

  it('gets a login token only for a server that the manifest names', async () => {
    const servers = [
      {
        name: 'mail',
        config: {
          transport: 'http',
          url: 'https://mail.test/mcp',
          auth: { kind: 'oauth2', tokenStore: 'mail' },
        },
      },
      {
        name: 'calendar',
        config: {
          transport: 'http',
          url: 'https://cal.test/mcp',
          auth: { kind: 'oauth2', tokenStore: 'cal' },
        },
      },
    ];
    const { factory, createMcp, materializeBearer } = setup({ servers });
    (await factory(context, manifest(['mail.list'])))._unsafeUnwrap();
    expect(materializeBearer).toHaveBeenCalledTimes(1);
    expect(materializeBearer.mock.calls[0][0]).toBe('mail');
    const options = createMcp.mock.calls[0][0] as {
      servers: Record<string, { headers?: Record<string, string>; auth?: unknown }>;
    };
    expect(options.servers.mail.headers?.Authorization).toBe('Bearer secret-token');
    expect(options.servers.mail.auth).toBeUndefined();
  });

  it('turns a login failure into TOOL_FAILED without the server detail in the message', async () => {
    const servers = [
      {
        name: 'mail',
        config: {
          transport: 'http',
          url: 'https://mail.test/mcp',
          auth: { kind: 'oauth2', tokenStore: 'mail' },
        },
      },
    ];
    const { factory, materializeBearer } = setup({ servers });
    materializeBearer.mockRejectedValueOnce(new Error('no tokens for mail at https://mail.test'));
    const error = (await factory(context, manifest(['mail.list'])))._unsafeUnwrapErr();
    expect(error.scriptCode).toBe('TOOL_FAILED');
    expect(error.message).not.toContain('mail.test');
  });

  it('builds the judge from the openai-compatible provider of the persona', async () => {
    const { factory, createJudgeModel } = setup({ provider: 'local' });
    const provider = (await factory(context, manifest(['model.judge'])))._unsafeUnwrap();
    expect(createJudgeModel).toHaveBeenCalledWith({
      baseUrl: 'http://llm.test/v1',
      modelId: 'big-model',
      apiKey: 'k1',
      headers: { 'x-a': '1' },
      telemetry: { scriptName: 'mail-intake' },
    });
    expect(provider.describe('model.judge')).toEqual({ toolClass: 'model' });
  });

  it('prefers the credential slot of options.providerId and its base URL', async () => {
    const { factory, createJudgeModel } = setup({
      provider: 'local',
      providers: {
        local: {
          enabled: true,
          type: 'openai-compatible',
          command: 'x',
          options: { providerId: 'groq' },
        },
      },
      auth: {
        groq: { apiKey: 'g1', baseURL: 'https://groq.test/v1' },
        'openai-compatible': { apiKey: 'k1' },
      },
    });
    (await factory(context, manifest(['model.judge'])))._unsafeUnwrap();
    expect(createJudgeModel).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://groq.test/v1', apiKey: 'g1' }),
    );
  });

  it('gives no judge to a persona on another provider type', async () => {
    const { factory, createJudgeModel } = setup();
    const provider = (await factory(context, manifest(['model.judge'])))._unsafeUnwrap();
    expect(createJudgeModel).not.toHaveBeenCalled();
    expect(provider.describe('model.judge')).toBeUndefined();
  });

  it('gives no judge when the provider is disabled or has no base URL', async () => {
    for (const local of [
      { enabled: false, type: 'openai-compatible', command: 'x', options: { baseUrl: 'http://a' } },
      { enabled: true, type: 'openai-compatible', command: 'x' },
    ]) {
      const { factory, createJudgeModel } = setup({
        provider: 'local',
        providers: { local },
        auth: {},
      });
      const provider = (await factory(context, manifest(['model.judge'])))._unsafeUnwrap();
      expect(createJudgeModel).not.toHaveBeenCalled();
      expect(provider.describe('model.judge')).toBeUndefined();
    }
  });

  it('closes the MCP part when the provider closes', async () => {
    const { factory, mcpProvider } = setup();
    const provider = (await factory(context, manifest(['mail.list'])))._unsafeUnwrap();
    await provider.close();
    expect(mcpProvider.close).toHaveBeenCalledTimes(1);
  });
});

describe('createDaemonProviderFactory with allServers', () => {
  const noTools = manifest([]);

  it('connects every MCP server of the persona although the manifest names none', async () => {
    const { factory, createMcp } = setup();
    await factory(context, noTools, { allServers: true });
    expect(createMcp).toHaveBeenCalledTimes(1);
    const options = createMcp.mock.calls[0][0] as { servers: Record<string, unknown> };
    expect(Object.keys(options.servers).sort()).toEqual(['calendar', 'mail']);
  });

  it('still connects nothing without the option', async () => {
    const { factory, createMcp } = setup();
    await factory(context, noTools);
    await factory(context, noTools, {});
    await factory(context, noTools, { allServers: false });
    expect(createMcp).not.toHaveBeenCalled();
  });

  it('offers the judge when the persona can have one, whatever the manifest says', async () => {
    const { factory, createJudgeModel } = setup({ provider: 'local' });
    const provider = (await factory(context, noTools, { allServers: true }))._unsafeUnwrap();
    expect(createJudgeModel).toHaveBeenCalledTimes(1);
    expect(provider.list().map((t) => t.name)).toContain('model.judge');
  });

  it('has no judge for a persona on a provider that cannot judge', async () => {
    const { factory } = setup();
    const provider = (await factory(context, noTools, { allServers: true }))._unsafeUnwrap();
    expect(provider.list().map((t) => t.name)).not.toContain('model.judge');
  });

  it('lists only the host tools that the capabilities of the persona grant', async () => {
    const { factory } = setup();
    const provider = (await factory(context, noTools, { allServers: true }))._unsafeUnwrap();
    expect(provider.list().some((t) => t.name.startsWith('talon.'))).toBe(false);
  });

  it('passes the error of the MCP factory on', async () => {
    const { factory, createMcp } = setup();
    createMcp.mockResolvedValueOnce(
      err(new ScriptError('TOOL_FAILED', 'the MCP servers could not be reached')),
    );
    const result = await factory(context, noTools, { allServers: true });
    expect(result._unsafeUnwrapErr().scriptCode).toBe('TOOL_FAILED');
  });
});
