import { describe, expect, it, vi } from 'vitest';
import {
  findMcpServersWithIgnoredAllowedTools,
  warnIfMcpAllowedToolsIgnored,
} from '../../../src/providers/mcp-allowed-tools-support.js';
import type { CanonicalMcpServer } from '../../../src/providers/provider-types.js';
import type { ProviderConfig } from '../../../src/core/config/config-types.js';
import { ClaudeCodeProvider } from '../../../src/providers/claude-code-provider.js';
import { CodexCliProvider } from '../../../src/providers/codex-cli-provider.js';
import { GeminiCliProvider } from '../../../src/providers/gemini-cli-provider.js';
import { OpenAiCompatibleProvider } from '../../../src/providers/openai-compatible-provider.js';

const WARNING = 'provider does not enforce MCP allowedTools; these servers expose all their tools';

const servers: Record<string, CanonicalMcpServer> = {
  postgram: { transport: 'http', url: 'http://mcp-server:3100/mcp', allowedTools: ['search'] },
  locked: { transport: 'stdio', command: 'locked-mcp', args: [], allowedTools: [] },
  open: { transport: 'sse', url: 'http://open/sse' },
  inproc: { transport: 'sdk', instance: {} },
};

describe('enforcesMcpAllowedTools per provider', () => {
  const config = {} as ProviderConfig;

  it('is true only for openai-compatible', () => {
    expect(new OpenAiCompatibleProvider(config).enforcesMcpAllowedTools).toBe(true);
    expect(new ClaudeCodeProvider(config).enforcesMcpAllowedTools).toBe(false);
    expect(new GeminiCliProvider(config).enforcesMcpAllowedTools).toBe(false);
    expect(new CodexCliProvider(config, {} as never).enforcesMcpAllowedTools).toBe(false);
  });
});

describe('findMcpServersWithIgnoredAllowedTools', () => {
  it('returns nothing for a provider that enforces allowedTools', () => {
    expect(
      findMcpServersWithIgnoredAllowedTools({ enforcesMcpAllowedTools: true }, servers),
    ).toEqual([]);
  });

  it('returns the servers that declare allowedTools, an empty list included', () => {
    expect(
      findMcpServersWithIgnoredAllowedTools({ enforcesMcpAllowedTools: false }, servers),
    ).toEqual(['postgram', 'locked']);
  });
});

describe('warnIfMcpAllowedToolsIgnored', () => {
  it('logs one warning with provider, servers and the given fields', () => {
    const logger = { warn: vi.fn() };
    const ignored = warnIfMcpAllowedToolsIgnored(
      { name: 'gemini-cli', enforcesMcpAllowedTools: false },
      servers,
      logger,
      { taskId: 'task-1' },
    );
    expect(ignored).toEqual(['postgram', 'locked']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { taskId: 'task-1', provider: 'gemini-cli', mcpServers: ['postgram', 'locked'] },
      WARNING,
    );
  });

  it('stays silent when nothing would be ignored', () => {
    const logger = { warn: vi.fn() };
    warnIfMcpAllowedToolsIgnored(
      { name: 'openai-compatible', enforcesMcpAllowedTools: true },
      servers,
      logger,
    );
    warnIfMcpAllowedToolsIgnored(
      { name: 'claude-code', enforcesMcpAllowedTools: false },
      { open: servers.open },
      logger,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
