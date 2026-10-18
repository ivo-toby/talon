import { expect, it, vi } from 'vitest';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Server } from 'node:net';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { ViteNodeServer } from 'vite-node/server';
import type { AgentRunInput, AgentStreamEvent } from '../../../src/providers/provider.js';

const root = resolve(import.meta.dirname, '../../..');
const fixture = resolve(root, 'tests/fixtures/claude-agent-sdk-denied.ts');
const importer = resolve(root, 'src/providers/claude-code-provider.ts');
const sdkEntry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
const denial = 'Claude Agent SDK is disabled in unit tests; provide an explicit mock.';

async function withResolver(
  check: (loader: ViteNodeServer, server: ViteDevServer) => Promise<void>,
): Promise<void> {
  const listen = vi.spyOn(Server.prototype, 'listen').mockImplementation(() => {
    throw new Error('Resolver metadata must not open a listener');
  });
  let server: ViteDevServer | undefined;
  try {
    // Resource-only overrides: SDK routes and plugins come from the actual default config.
    server = await createServer({
      root,
      configFile: resolve(root, 'vitest.config.ts'),
      mode: 'test',
      envFile: false,
      publicDir: false,
      server: {
        middlewareMode: true,
        ws: false,
        hmr: false,
        watch: null,
        preTransformRequests: false,
      },
      optimizeDeps: { noDiscovery: true, include: [] },
      ssr: { optimizeDeps: { noDiscovery: true, include: [] } },
    });
    expect(server.httpServer).toBeNull();
    expect(server.config.server.ws).toBe(false);
    expect(server.config.optimizeDeps.noDiscovery).toBe(true);
    expect(server.config.optimizeDeps.include).toEqual([]);
    const options = server.config.test?.server;
    const loader = new ViteNodeServer(server, { ...options, deps: { ...options?.deps } });
    await check(loader, server);
    expect(listen).not.toHaveBeenCalled();
  } finally {
    try {
      if (server) {
        await server.close();
        console.info('Resolver resources closed (awaited)');
      }
    } finally {
      listen.mockRestore();
    }
  }
}

it('default SDK resolver metadata routes to the inert fixture without SDK evaluation', async () => {
  await withResolver(async (loader, server) => {
    const resolved = await loader.resolveId('@anthropic-ai/claude-agent-sdk', importer, 'ssr');
    const externalize = await loader.shouldExternalize(sdkEntry);
    console.info('Default SDK resolver metadata', { resolved, externalize, sdkEntry });
    expect(server.moduleGraph.getModuleById(sdkEntry)).toBeUndefined();
    expect(resolved).toMatchObject({ id: fixture, external: false });
    expect(externalize).toBe(false);
    expect(
      await loader.resolveId('@talon/providers/claude-code-provider', importer, 'ssr'),
    ).toMatchObject({ id: importer });
  });
});

it('rejects real SDK resolver paths and prevents repeated native externalization', async () => {
  await withResolver(async (loader) => {
    for (const id of [
      '@anthropic-ai/claude-agent-sdk/embed',
      sdkEntry,
      realpathSync(sdkEntry),
      pathToFileURL(sdkEntry).href,
      `/@fs/${sdkEntry}`,
    ]) {
      await expect(loader.resolveId(id, importer, 'ssr')).rejects.toThrow(
        'Real Claude Agent SDK loading is forbidden in unit tests',
      );
    }
    for (const id of [sdkEntry, pathToFileURL(sdkEntry).href]) {
      expect(await loader.shouldExternalize(id)).toBe(false);
      expect(await loader.shouldExternalize(id)).toBe(false);
    }
  });
});

it('rejects existing absolute SDK files at the public fetch boundary', async () => {
  await withResolver(async (loader) => {
    // Existing absolute files can bypass resolveId in vite-node's client.
    for (const id of [sdkEntry, resolve(dirname(sdkEntry), 'embed.js')]) {
      await expect(loader.fetchModule(id, 'ssr')).rejects.toThrow(
        'Real Claude Agent SDK loading is forbidden in unit tests',
      );
    }
  });
});

it('refuses unmocked SDK query and MCP helpers with the inert fallback', async () => {
  vi.doUnmock('@anthropic-ai/claude-agent-sdk');
  const sdk = await vi.importActual<typeof import('@anthropic-ai/claude-agent-sdk')>(
    '@anthropic-ai/claude-agent-sdk',
  );
  expect(() => sdk.query({ prompt: 'synthetic' })).toThrow(denial);
  expect(() => sdk.createSdkMcpServer({ name: 'synthetic', tools: [] })).toThrow(denial);
  expect(() =>
    sdk.tool('synthetic', 'synthetic', {}, () => Promise.resolve({ content: [] })),
  ).toThrow(denial);
});

const input: AgentRunInput = {
  threadId: 'synthetic-thread',
  prompt: 'synthetic',
  systemPrompt: 'synthetic',
  mcpServers: {},
  cwd: root,
  model: 'synthetic-model',
  maxTurns: 1,
  timeoutMs: 30_000,
};

it('refuses actual public provider execution after unmock instead of reaching the SDK', async () => {
  vi.doUnmock('@anthropic-ai/claude-agent-sdk');
  const { ClaudeCodeProvider } = await import('../../../src/providers/claude-code-provider.js');
  const provider = new ClaudeCodeProvider({
    enabled: true,
    command: 'claude',
    contextWindowTokens: 1024,
  });
  const iterator = provider.createExecutionStrategy().run(input)[Symbol.asyncIterator]();
  try {
    await expect(iterator.next()).rejects.toThrow(denial);
  } finally {
    await iterator.return?.();
  }
});

it('preserves synthetic manual mocks through independent actual public provider calls', async () => {
  vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
    query: () =>
      (async function* () {
        yield await Promise.resolve({
          type: 'result',
          result: 'synthetic result',
          session_id: 'synthetic-session',
          usage: { input_tokens: 7, output_tokens: 3 },
          is_error: false,
        });
      })(),
  }));
  try {
    const { ClaudeCodeProvider } = await import('../../../src/providers/claude-code-provider.js');
    const provider = new ClaudeCodeProvider({
      enabled: true,
      command: 'claude',
      contextWindowTokens: 1024,
    });
    // This is compatibility, not a promise to change Vitest's concurrent manual-mock semantics.
    for (let call = 0; call < 2; call += 1) {
      const events: AgentStreamEvent[] = [];
      for await (const event of provider.createExecutionStrategy().run(input)) events.push(event);
      expect(events).toEqual([
        {
          type: 'result',
          result: {
            output: 'synthetic result',
            sessionId: 'synthetic-session',
            usage: {
              inputTokens: 7,
              outputTokens: 3,
              cacheReadTokens: undefined,
              cacheWriteTokens: undefined,
              totalCostUsd: undefined,
            },
            isError: false,
          },
        },
      ]);
    }
  } finally {
    vi.doUnmock('@anthropic-ai/claude-agent-sdk');
    vi.resetModules();
  }
});

import { statSync } from 'node:fs';
import { normalizeRequestId, toFilePath } from 'vite-node/utils';

const f1SdkPaths = ['//', '///', '/./', '/.//./', '/sdk/../'].map((separator) =>
  sdkEntry.replace('/@anthropic-ai/claude-agent-sdk/', `/@anthropic-ai${separator}claude-agent-sdk/`),
);

it.each(f1SdkPaths)('F1 metadata prevents SDK native externalization for %s', async (sdkPath) => {
  const request = `/@fs/${sdkPath}`;
  const normalized = normalizeRequestId(request);
  const file = toFilePath(normalized, root);
  const canonicalStat = statSync(sdkEntry);
  const actualStat = statSync(file.path);
  expect(sdkPath).not.toBe(sdkEntry);
  expect(file.exists).toBe(true);
  expect(file.path).toBe(sdkPath);
  expect(actualStat.dev).toBe(canonicalStat.dev);
  expect(actualStat.ino).toBe(canonicalStat.ino);
  expect(realpathSync(file.path)).toBe(realpathSync(sdkEntry));
  expect(normalizeRequestId(`file://${sdkPath}`)).toBe(sdkPath);

  await withResolver(async (loader, server) => {
    expect(await loader.shouldExternalize(sdkEntry)).toBe(false);
    for (const id of [file.path, request, `file://${sdkPath}`]) {
      expect(server.moduleGraph.getModuleById(id)).toBeUndefined();
      const externalize = await loader.shouldExternalize(id);
      console.info('F1 default SDK metadata', { request, normalized, file, id, externalize });
      expect(externalize).toBe(false);
      expect(await loader.shouldExternalize(id)).toBe(false);
      await expect(loader.resolveId(id, importer, 'ssr')).rejects.toThrow(
        'Real Claude Agent SDK loading is forbidden in unit tests',
      );
      expect(server.moduleGraph.getModuleById(id)).toBeUndefined();
    }
    expect(server.moduleGraph.getModuleById(sdkEntry)).toBeUndefined();
  });
});

it('F1 metadata leaves unrelated scope and SDK-name boundary paths externalizable', async () => {
  await withResolver(async (loader) => {
    // Synthetic spelling controls are metadata only; no filesystem existence is claimed.
    for (const id of [
      createRequire(import.meta.url).resolve('@anthropic-ai/sdk'),
      sdkEntry.replace('/@anthropic-ai/', '/@other-scope/'),
      sdkEntry.replace('/@anthropic-ai/', '/@anthropic-ai-other/'),
      sdkEntry.replace('/claude-agent-sdk/', '/claude-agent-sdk-other/'),
    ]) {
      const externalize = await loader.shouldExternalize(id);
      console.info('F1 unrelated-path metadata', { id, externalize });
      expect(externalize).toBe(id);
    }
  });
});

it('F1 fetch boundary rejects filesystem-equivalent SDK paths before evaluation', async () => {
  await withResolver(async (loader) => {
    for (const sdkPath of f1SdkPaths) {
      await expect(loader.fetchModule(`/@fs/${sdkPath}`, 'ssr')).rejects.toThrow(
        'Real Claude Agent SDK loading is forbidden in unit tests',
      );
    }
  });
});
