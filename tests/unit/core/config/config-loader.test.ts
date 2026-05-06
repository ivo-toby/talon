import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadConfigFromString, validateConfig } from '../../../../src/core/config/config-loader.js';
import { ConfigError } from '../../../../src/core/errors/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpFile: string;

beforeEach(() => {
  // Create a unique temporary file path for each test
  tmpFile = join(tmpdir(), `talon-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
});

afterEach(() => {
  // Clean up the temp file if it was created
  try {
    unlinkSync(tmpFile);
  } catch {
    // File may not have been created in every test
  }
});

function writeTempConfig(content: string): string {
  writeFileSync(tmpFile, content, 'utf-8');
  return tmpFile;
}

// ---------------------------------------------------------------------------
// loadConfigFromString
// ---------------------------------------------------------------------------

describe('loadConfigFromString', () => {
  it('returns Ok with all defaults for an empty YAML document', () => {
    const result = loadConfigFromString('');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.logLevel).toBe('info');
      expect(result.value.storage.type).toBe('sqlite');
    }
  });

  it('returns Ok with all defaults for an explicit empty mapping', () => {
    const result = loadConfigFromString('{}');
    expect(result.isOk()).toBe(true);
  });

  it('parses a minimal valid YAML config', () => {
    const yaml = `
logLevel: debug
dataDir: /tmp/talon
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.logLevel).toBe('debug');
      expect(result.value.dataDir).toBe('/tmp/talon');
    }
  });

  it('parses channels array from YAML', () => {
    const yaml = `
channels:
  - type: telegram
    name: main
    tokenRef: TELEGRAM_BOT_TOKEN
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.channels).toHaveLength(1);
      expect(result.value.channels[0].type).toBe('telegram');
      expect(result.value.channels[0].tokenRef).toBe('TELEGRAM_BOT_TOKEN');
    }
  });

  it('parses personas array from YAML', () => {
    const yaml = `
personas:
  - name: helper
    model: claude-opus-4-6
    skills:
      - web-search
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.personas).toHaveLength(1);
      expect(result.value.personas[0].name).toBe('helper');
      expect(result.value.personas[0].model).toBe('claude-opus-4-6');
      expect(result.value.personas[0].skills).toContain('web-search');
    }
  });

  it('returns Err(ConfigError) for invalid YAML syntax', () => {
    const result = loadConfigFromString('key: [unclosed');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
      expect(result.error.message).toMatch(/Failed to parse YAML/);
    }
  });

  it('truncates error message and appends "and N more" when more than 5 issues are present', () => {
    // Provide more than 5 simultaneously invalid fields to trigger the
    // `issues.length > 5 ? ` (and ${issues.length - 5} more)` : ''` true branch.
    // Each channel entry missing its required 'type' produces an issue; adding
    // multiple invalid top-level fields alongside channels pushes the count above 5.
    const yaml = `
logLevel: bad-level
sandbox:
  maxConcurrent: 0
  runtime: invalid-runtime
ipc:
  pollIntervalMs: 50
queue:
  maxAttempts: 0
  concurrencyLimit: 0
`;
    const result = loadConfigFromString(yaml);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toMatch(/and \d+ more/);
    }
  });

  it('returns Err(ConfigError) with field path for schema violations', () => {
    const result = loadConfigFromString('logLevel: not-a-valid-level');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
      expect(result.error.message).toMatch(/validation failed/i);
      expect(result.error.message).toMatch(/logLevel/);
    }
  });

  it('returns Err(ConfigError) for invalid sandbox.maxConcurrent', () => {
    const result = loadConfigFromString('sandbox:\n  maxConcurrent: 0');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
      expect(result.error.message).toMatch(/sandbox\.maxConcurrent/);
    }
  });

  it('returns Err(ConfigError) for a missing required channel field', () => {
    const yaml = `
channels:
  - name: no-type-channel
`;
    const result = loadConfigFromString(yaml);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
    }
  });

  it('strips extra (unknown) fields from the config', () => {
    const result = loadConfigFromString('unknownTopLevelKey: 42');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect((result.value as Record<string, unknown>)['unknownTopLevelKey']).toBeUndefined();
    }
  });

  it('returns Err(ConfigError) for a persona with an empty name', () => {
    const yaml = `
personas:
  - name: ""
`;
    const result = loadConfigFromString(yaml);
    expect(result.isErr()).toBe(true);
  });

  it('handles a null YAML document (treated as empty config)', () => {
    const result = loadConfigFromString('null');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.personas).toEqual([]);
    }
  });

  it('maps deprecated backgroundAgent.claudePath to providers when providers are omitted', () => {
    const yaml = `
backgroundAgent:
  claudePath: /usr/local/bin/claude
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.backgroundAgent.defaultProvider).toBe('claude-code');
      expect(result.value.backgroundAgent.providers).toEqual({
        'claude-code': {
          enabled: true,
          command: '/usr/local/bin/claude',
          contextWindowTokens: 200000,
        },
      });
      expect(result.value.backgroundAgent.claudePath).toBe('/usr/local/bin/claude');
    }
  });

  it('prefers explicit backgroundAgent.providers over deprecated claudePath', () => {
    const yaml = `
backgroundAgent:
  claudePath: /usr/local/bin/claude
  providers:
    claude-code:
      enabled: true
      command: /custom/claude
      contextWindowTokens: 210000
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.backgroundAgent.providers['claude-code']).toEqual({
        enabled: true,
        command: '/custom/claude',
        contextWindowTokens: 210000,
      });
    }
  });

  it('loads provider-scoped agentRunner contextManagement settings', () => {
    const yaml = `
agentRunner:
  defaultProvider: claude-code
  providers:
    claude-code:
      enabled: true
      command: claude
      contextWindowTokens: 1000000
      contextManagement:
        enabled: true
        triggerMetric: cache_read_input_tokens
        thresholdRatio: 0.5
        recentMessageCount: 10
        summarizer: session-summarizer
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.agentRunner.providers['claude-code']).toEqual({
        enabled: true,
        command: 'claude',
        contextWindowTokens: 1000000,
        contextManagement: {
          enabled: true,
          triggerMetric: 'cache_read_input_tokens',
          thresholdRatio: 0.5,
          recentMessageCount: 10,
          summarizer: 'session-summarizer',
        },
      });
    }
  });

  it('loads the root talond.yaml.example successfully', () => {
    const example = readFileSync(join(process.cwd(), 'talond.yaml.example'), 'utf8');
    const result = loadConfigFromString(example);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.workflow.defaultRolloutMode).toBe('observe');
    }
  });

  it('loads config/talond.example.yaml successfully', () => {
    const example = readFileSync(join(process.cwd(), 'config/talond.example.yaml'), 'utf8');
    const result = loadConfigFromString(example);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.workflow.defaultRolloutMode).toBe('observe');
    }
  });

  it('loads cache_total_input_tokens as a provider-scoped trigger metric', () => {
    const yaml = `
agentRunner:
  defaultProvider: claude-code
  providers:
    claude-code:
      enabled: true
      command: claude
      contextWindowTokens: 1000000
      contextManagement:
        enabled: true
        triggerMetric: cache_total_input_tokens
        thresholdRatio: 0.5
        recentMessageCount: 10
        summarizer: session-summarizer
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.agentRunner.providers['claude-code']).toEqual({
        enabled: true,
        command: 'claude',
        contextWindowTokens: 1000000,
        contextManagement: {
          enabled: true,
          triggerMetric: 'cache_total_input_tokens',
          thresholdRatio: 0.5,
          recentMessageCount: 10,
          summarizer: 'session-summarizer',
        },
      });
    }
  });

  it('rejects legacy top-level context config in YAML input', () => {
    const yaml = `
context:
  enabled: true
  thresholdTokens: 80000
  recentMessageCount: 10
`;
    const result = loadConfigFromString(yaml);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toMatch(/context.*removed/i);
      expect(result.error.message).toMatch(/README\.md/);
    }
  });

  it('rejects legacy top-level context config in raw object validation', () => {
    const raw = {
      context: {
        enabled: true,
        thresholdTokens: 80000,
        recentMessageCount: 10,
      },
    };
    const result = validateConfig(raw);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toMatch(/context.*removed/i);
      expect(result.error.message).toMatch(/README\.md/);
    }
  });

  it('migrates legacy rotationThreshold to contextManagement for claude provider', () => {
    const yaml = `
agentRunner:
  providers:
    claude-code:
      enabled: true
      command: claude
      contextWindowTokens: 200000
      rotationThreshold: 0.4
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const cm = result.value.agentRunner.providers['claude-code']?.contextManagement;
      expect(cm?.enabled).toBe(true);
      expect(cm?.thresholdRatio).toBe(0.4);
      expect(cm?.triggerMetric).toBe('cache_read_input_tokens');
      expect(cm?.recentMessageCount).toBe(10);
      expect(cm?.summarizer).toBe('session-summarizer');
    }
  });

  it('migrates legacy rotationThreshold with input_tokens for non-claude provider', () => {
    const yaml = `
agentRunner:
  providers:
    gemini-cli:
      enabled: true
      command: gemini
      contextWindowTokens: 1000000
      rotationThreshold: 0.8
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const cm = result.value.agentRunner.providers['gemini-cli']?.contextManagement;
      expect(cm?.enabled).toBe(true);
      expect(cm?.thresholdRatio).toBe(0.8);
      expect(cm?.triggerMetric).toBe('input_tokens');
    }
  });

  it('does not migrate rotationThreshold when contextManagement is already present', () => {
    const yaml = `
agentRunner:
  providers:
    claude-code:
      enabled: true
      command: claude
      contextWindowTokens: 200000
      rotationThreshold: 0.4
      contextManagement:
        enabled: false
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const cm = result.value.agentRunner.providers['claude-code']?.contextManagement;
      expect(cm?.enabled).toBe(false);
    }
  });

  it('prefers explicit backgroundAgent.providers over claudePath (claudePath present but providers win)', () => {
    const yaml = `
backgroundAgent:
  claudePath: /old/claude
  providers:
    claude-code:
      enabled: true
      command: /new/claude
      contextWindowTokens: 100000
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.backgroundAgent.providers['claude-code']?.command).toBe('/new/claude');
      expect(result.value.backgroundAgent.providers['claude-code']?.contextWindowTokens).toBe(100000);
    }
  });

  it('applies schema defaults when backgroundAgent is an empty object', () => {
    const yaml = `
backgroundAgent: {}
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.backgroundAgent.enabled).toBe(true);
      expect(result.value.backgroundAgent.maxConcurrent).toBe(3);
      expect(result.value.backgroundAgent.defaultTimeoutMinutes).toBe(30);
      expect(result.value.backgroundAgent.defaultProvider).toBe('claude-code');
      expect(result.value.backgroundAgent.providers['claude-code']).toMatchObject({
        enabled: true,
        command: 'claude',
        contextWindowTokens: 200000,
      });
    }
  });

  it('substitutes an unset env var placeholder with an empty string', () => {
    // Exercises the `process.env[name] ?? ''` fallback on line 129.
    // Use a name that is guaranteed not to be set in the test environment.
    delete process.env['__TALON_TEST_UNSET_VAR__'];
    const yaml = `logLevel: \${__TALON_TEST_UNSET_VAR__}`;
    const result = loadConfigFromString(yaml);
    // logLevel: '' is not a valid enum value so validation fails, but the substitution
    // itself must not throw — we verify the error is a schema error, not a parse error.
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toMatch(/validation failed/i);
    }
  });
});

// ---------------------------------------------------------------------------
// loadConfig (file-based)
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  it('returns Ok for a valid YAML file', () => {
    const path = writeTempConfig('logLevel: warn\n');
    const result = loadConfig(path);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.logLevel).toBe('warn');
    }
  });

  it('returns Ok for an empty YAML file', () => {
    const path = writeTempConfig('');
    const result = loadConfig(path);
    expect(result.isOk()).toBe(true);
  });

  it('returns Err(ConfigError) when the file does not exist', () => {
    const result = loadConfig('/nonexistent/path/to/config.yaml');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
      expect(result.error.message).toMatch(/Failed to read config file/);
      expect(result.error.message).toMatch(/\/nonexistent\/path\/to\/config\.yaml/);
    }
  });

  it('returns Err(ConfigError) for invalid YAML in a file', () => {
    const path = writeTempConfig('key: [unclosed bracket');
    const result = loadConfig(path);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
      expect(result.error.message).toMatch(/Failed to parse YAML/);
    }
  });

  it('returns Err(ConfigError) for schema violations in a file', () => {
    const path = writeTempConfig('logLevel: not-a-valid-level\n');
    const result = loadConfig(path);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
      expect(result.error.message).toMatch(/logLevel/);
    }
  });

  it('includes the file path in the read error message', () => {
    const result = loadConfig('/does/not/exist.yaml');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('/does/not/exist.yaml');
    }
  });
});

// ---------------------------------------------------------------------------
// Frozen output
// ---------------------------------------------------------------------------

describe('frozen config output', () => {
  it('loadConfigFromString returns a frozen config', () => {
    const result = loadConfigFromString('{}');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  it('loadConfigFromString returns frozen nested objects', () => {
    const result = loadConfigFromString('{}');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(Object.isFrozen(result.value.storage)).toBe(true);
      expect(Object.isFrozen(result.value.sandbox)).toBe(true);
      expect(Object.isFrozen(result.value.ipc)).toBe(true);
      expect(Object.isFrozen(result.value.queue)).toBe(true);
      expect(Object.isFrozen(result.value.scheduler)).toBe(true);
    }
  });

  it('loadConfigFromString returns frozen arrays', () => {
    const result = loadConfigFromString('channels:\n  - type: telegram\n    name: main\n');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(Object.isFrozen(result.value.channels)).toBe(true);
      expect(Object.isFrozen(result.value.channels[0])).toBe(true);
    }
  });

  it('loadConfig (file) returns a frozen config', () => {
    const path = writeTempConfig('{}');
    const result = loadConfig(path);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  it('mutating a frozen config throws in strict mode', () => {
    const result = loadConfigFromString('{}');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // In strict mode (which vitest uses), assigning to a frozen object throws
      expect(() => {
        (result.value as Record<string, unknown>)['logLevel'] = 'debug';
      }).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// auth.providers
// ---------------------------------------------------------------------------

describe('auth.providers schema', () => {
  it('defaults to an empty object when not specified', () => {
    const result = loadConfigFromString('');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.auth.providers).toEqual({});
    }
  });

  it('parses provider credentials with apiKey and baseURL', () => {
    const yaml = `
auth:
  mode: api_key
  providers:
    openai:
      apiKey: sk-test-123
      baseURL: https://api.openai.com/v1
    anthropic:
      apiKey: sk-ant-456
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.auth.providers.openai.apiKey).toBe('sk-test-123');
      expect(result.value.auth.providers.openai.baseURL).toBe('https://api.openai.com/v1');
      expect(result.value.auth.providers.anthropic.apiKey).toBe('sk-ant-456');
      expect(result.value.auth.providers.anthropic.baseURL).toBeUndefined();
    }
  });

  it('allows providers with only baseURL (no apiKey)', () => {
    const yaml = `
auth:
  providers:
    local:
      baseURL: http://localhost:8080
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.auth.providers.local.baseURL).toBe('http://localhost:8080');
      expect(result.value.auth.providers.local.apiKey).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// persona.subagents
// ---------------------------------------------------------------------------

describe('persona.subagents schema', () => {
  it('defaults to an empty array when not specified', () => {
    const yaml = `
personas:
  - name: helper
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.personas[0].subagents).toEqual([]);
    }
  });

  it('parses subagent names from config', () => {
    const yaml = `
personas:
  - name: orchestrator
    subagents:
      - code-reviewer
      - test-runner
      - doc-writer
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.personas[0].subagents).toEqual([
        'code-reviewer',
        'test-runner',
        'doc-writer',
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// sprites config
// ---------------------------------------------------------------------------

describe('sprites config', () => {
  it('loads sprites config with env var substitution', () => {
    process.env.SPRITES_TOKEN = 'resolved-sprites-token';
    try {
      const yaml = `
sprites:
  enabled: true
  token: \${SPRITES_TOKEN}
  defaultBaseSnapshot: node-22-bookworm
  resourceLimits:
    cpus: 4
    memoryMb: 8192
`;
      const result = loadConfigFromString(yaml);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.sprites.enabled).toBe(true);
        expect(result.value.sprites.token).toBe('resolved-sprites-token');
        expect(result.value.sprites.defaultBaseSnapshot).toBe('node-22-bookworm');
        expect(result.value.sprites.resourceLimits).toEqual({
          cpus: 4,
          memoryMb: 8192,
          diskGb: 20,
        });
      }
    } finally {
      delete process.env.SPRITES_TOKEN;
    }
  });

  it('rejects enabled sprites config without a token', () => {
    const yaml = `
sprites:
  enabled: true
  token: ""
`;
    const result = loadConfigFromString(yaml);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toMatch(/sprites\.token/);
    }
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  it('returns Ok for a valid plain object', () => {
    const result = validateConfig({ logLevel: 'error' });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.logLevel).toBe('error');
    }
  });

  it('returns Ok with defaults for an empty object', () => {
    const result = validateConfig({});
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.logLevel).toBe('info');
    }
  });

  it('returns Err(ConfigError) for invalid data', () => {
    const result = validateConfig({ logLevel: 'not-a-level' });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
      expect(result.error.message).toMatch(/logLevel/);
    }
  });

  it('returns Err(ConfigError) for a non-object input', () => {
    const result = validateConfig('not an object');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
    }
  });

  it('returns a frozen config', () => {
    const result = validateConfig({});
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  it('includes field path in validation error message', () => {
    const result = validateConfig({ ipc: { pollIntervalMs: 50 } });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toMatch(/ipc\.pollIntervalMs/);
    }
  });

  it('truncates error message and appends "and N more" when more than 5 issues are present', () => {
    const raw = {
      logLevel: 'bad-level',
      sandbox: { maxConcurrent: 0, runtime: 'invalid-runtime' },
      ipc: { pollIntervalMs: 50 },
      queue: { maxAttempts: 0, concurrencyLimit: 0 },
    };
    const result = validateConfig(raw);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toMatch(/and \d+ more/);
    }
  });
});
