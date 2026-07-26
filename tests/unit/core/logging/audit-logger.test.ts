import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { AuditLogger } from '../../../../src/core/logging/audit-logger.js';
import type { AuditEntry, AuditStore } from '../../../../src/core/logging/audit-logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a pino logger that writes JSON to an in-memory array.
 */
function createCapturingLogger(): {
  logger: pino.Logger;
  records: () => Record<string, unknown>[];
} {
  const raw: string[] = [];
  const writable = {
    write(chunk: string) {
      raw.push(chunk.trimEnd());
      return true;
    },
  };
  const logger = pino(
    { level: 'trace', base: { service: 'talond' } },
    writable as unknown as pino.DestinationStream,
  );
  return {
    logger,
    records: () => raw.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** Creates a minimal AuditEntry for use in tests. */
function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    action: 'test.action',
    details: { key: 'value' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('AuditLogger construction', () => {
  it('constructs without a store', () => {
    const { logger } = createCapturingLogger();
    expect(() => new AuditLogger(logger)).not.toThrow();
  });

  it('constructs with a store', () => {
    const { logger } = createCapturingLogger();
    const store: AuditStore = { append: vi.fn() };
    expect(() => new AuditLogger(logger, store)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Shared behaviour: pino output for every method
// ---------------------------------------------------------------------------

describe.each([
  ['logToolExecution', 'tool.execution'],
  ['logApprovalDecision', 'approval.decision'],
  ['logChannelSend', 'channel.send'],
  ['logScheduleTrigger', 'schedule.trigger'],
  ['logConfigReload', 'config.reload'],
  ['logLifecycleInterceptor', 'lifecycle.interceptor'],
  ['logLifecycleDecision', 'lifecycle.decision'],
  ['logLifecycleReplay', 'lifecycle.replay'],
  ['logLifecycleDisablement', 'lifecycle.disablement'],
  ['logLifecycleProjection', 'lifecycle.projection'],
  ['logLifecyclePromotion', 'lifecycle.promotion'],
] as const)('%s()', (method, expectedMsg) => {
  it(`writes a pino record with msg "${expectedMsg}"`, () => {
    const { logger, records } = createCapturingLogger();
    const audit = new AuditLogger(logger);
    audit[method](makeEntry());
    const r = records();
    expect(r).toHaveLength(1);
    expect(r[0].msg).toBe(expectedMsg);
  });

  it('sets audit: true on the record', () => {
    const { logger, records } = createCapturingLogger();
    const audit = new AuditLogger(logger);
    audit[method](makeEntry());
    expect(records()[0].audit).toBe(true);
  });

  it('includes details in the record', () => {
    const { logger, records } = createCapturingLogger();
    const audit = new AuditLogger(logger);
    audit[method](makeEntry({ details: { query: 'hello', count: 3 } }));
    const r = records()[0];
    expect(r.details).toEqual({ query: 'hello', count: 3 });
  });

  it('includes optional correlation fields when provided', () => {
    const { logger, records } = createCapturingLogger();
    const audit = new AuditLogger(logger);
    const entry = makeEntry({
      runId: 'run-001',
      threadId: 'thread-002',
      personaId: 'assistant',
      tool: 'web_search',
      requestId: 'req-abc',
    });
    audit[method](entry);
    const r = records()[0];
    expect(r.runId).toBe('run-001');
    expect(r.threadId).toBe('thread-002');
    expect(r.personaId).toBe('assistant');
    expect(r.tool).toBe('web_search');
    expect(r.requestId).toBe('req-abc');
  });

  it('omits undefined correlation fields', () => {
    const { logger, records } = createCapturingLogger();
    const audit = new AuditLogger(logger);
    audit[method](makeEntry({ runId: undefined, threadId: undefined }));
    const keys = Object.keys(records()[0]);
    expect(keys).not.toContain('runId');
    expect(keys).not.toContain('threadId');
  });

  it('calls store.append when a store is provided', () => {
    const { logger } = createCapturingLogger();
    const store: AuditStore = { append: vi.fn() };
    const audit = new AuditLogger(logger, store);
    const entry = makeEntry({ runId: 'r1' });
    audit[method](entry);
    expect(store.append).toHaveBeenCalledOnce();
    expect(store.append).toHaveBeenCalledWith(entry);
  });

  it('does not call store.append when no store is provided', () => {
    const { logger } = createCapturingLogger();
    // No store — should not throw
    const audit = new AuditLogger(logger);
    expect(() => audit[method](makeEntry())).not.toThrow();
  });

  it('logs at info level', () => {
    const { logger, records } = createCapturingLogger();
    const audit = new AuditLogger(logger);
    audit[method](makeEntry());
    // pino level 30 === info
    expect(records()[0].level).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// AuditStore callback contract
// ---------------------------------------------------------------------------

describe('AuditStore callback', () => {
  it('passes the exact entry object to store.append', () => {
    const { logger } = createCapturingLogger();
    const appended: AuditEntry[] = [];
    const store: AuditStore = {
      append(entry) {
        appended.push(entry);
      },
    };
    const audit = new AuditLogger(logger, store);
    const entry = makeEntry({ runId: 'r-x', details: { foo: 'bar' } });
    audit.logToolExecution(entry);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toBe(entry); // same reference
  });

  it('store.append is called for every method', () => {
    const { logger } = createCapturingLogger();
    const store: AuditStore = { append: vi.fn() };
    const audit = new AuditLogger(logger, store);

    audit.logToolExecution(makeEntry());
    audit.logApprovalDecision(makeEntry());
    audit.logChannelSend(makeEntry());
    audit.logScheduleTrigger(makeEntry());
    audit.logConfigReload(makeEntry());
    audit.logLifecycleDecision(makeEntry());
    audit.logLifecycleReplay(makeEntry());
    audit.logLifecycleDisablement(makeEntry());
    audit.logLifecycleProjection(makeEntry());
    audit.logLifecyclePromotion(makeEntry());

    expect(store.append).toHaveBeenCalledTimes(10);
  });

  it('works correctly without a store (pino-only mode)', () => {
    const { logger, records } = createCapturingLogger();
    const audit = new AuditLogger(logger);

    audit.logToolExecution(makeEntry({ runId: 'r-pino-only' }));

    const r = records();
    expect(r).toHaveLength(1);
    expect(r[0].runId).toBe('r-pino-only');
  });

  it('multiple calls emit multiple pino records', () => {
    const { logger, records } = createCapturingLogger();
    const audit = new AuditLogger(logger);

    audit.logToolExecution(makeEntry({ details: { n: 1 } }));
    audit.logToolExecution(makeEntry({ details: { n: 2 } }));
    audit.logToolExecution(makeEntry({ details: { n: 3 } }));

    expect(records()).toHaveLength(3);
  });
});

describe('lifecycle audit redaction', () => {
  it('redacts secret-shaped detail keys before pino and store writes', () => {
    const { logger, records } = createCapturingLogger();
    const appended: AuditEntry[] = [];
    const audit = new AuditLogger(logger, { append: (entry) => appended.push(entry) });

    audit.logLifecycleDecision(
      makeEntry({
        details: {
          handlerId: 'handler-1',
          apiKey: 'sk-secret',
          nested: { authorization: 'Bearer token', safe: 'ok' },
        },
      }),
    );

    expect(records()[0].details).toEqual({
      handlerId: 'handler-1',
      apiKey: '[redacted]',
      nested: { authorization: '[redacted]', safe: 'ok' },
    });
    expect(appended[0]?.details).toEqual(records()[0].details);
  });

  it('bounds lifecycle audit strings and nested structures', () => {
    const { logger, records } = createCapturingLogger();
    const audit = new AuditLogger(logger);

    audit.logLifecycleProjection(
      makeEntry({
        details: {
          value: 'x'.repeat(600),
          nested: { a: { b: { c: { d: { e: { f: 'too deep' } } } } } },
        },
      }),
    );

    const details = records()[0].details as Record<string, unknown>;
    expect((details.value as string).length).toBeLessThan(520);
    expect(details.nested).toEqual({ a: { b: { c: { d: '[truncated]' } } } });
  });

  it('does not evaluate accessors while redacting lifecycle audit details', () => {
    const { logger, records } = createCapturingLogger();
    const audit = new AuditLogger(logger);
    const details = { safe: 'ok' } as Record<string, unknown>;
    Object.defineProperty(details, 'computed', {
      enumerable: true,
      get: () => {
        throw new Error('audit redaction must not invoke accessors');
      },
    });

    audit.logLifecycleDecision(makeEntry({ details }));

    expect(records()[0].details).toEqual({ safe: 'ok', computed: '[redacted]' });
  });
});

// ---------------------------------------------------------------------------
// Details payload round-trip
// ---------------------------------------------------------------------------

describe('details payload', () => {
  it('preserves nested objects', () => {
    const { logger, records } = createCapturingLogger();
    const audit = new AuditLogger(logger);
    audit.logToolExecution(makeEntry({ details: { nested: { a: 1, b: [2, 3] }, flag: true } }));
    expect(records()[0].details).toEqual({ nested: { a: 1, b: [2, 3] }, flag: true });
  });

  it('preserves empty details object', () => {
    const { logger, records } = createCapturingLogger();
    const audit = new AuditLogger(logger);
    audit.logToolExecution(makeEntry({ details: {} }));
    expect(records()[0].details).toEqual({});
  });
});
