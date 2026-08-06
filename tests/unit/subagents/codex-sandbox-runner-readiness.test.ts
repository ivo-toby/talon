import { describe, expect, it, vi } from 'vitest';
import { waitForCodexSandboxRunner } from '../../../src/subagents/codex-sandbox-runner-readiness.js';

const TOKEN = 't'.repeat(32);

describe('waitForCodexSandboxRunner', () => {
  it('accepts a token-authenticated ready runner', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await waitForCodexSandboxRunner(
      {
        endpoint: 'http://codex-runner:9700',
        token: TOKEN,
        startupTimeoutMs: 1_000,
      },
      { fetch: fetchImpl as unknown as typeof fetch },
    );

    expect(result.isOk()).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://codex-runner:9700/readyz',
      expect.objectContaining({ headers: { authorization: `Bearer ${TOKEN}` } }),
    );
  });

  it('waits until the configured deadline and returns a useful readiness error', async () => {
    let time = 0;
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 503 }));

    const result = await waitForCodexSandboxRunner(
      {
        endpoint: 'http://codex-runner:9700',
        token: TOKEN,
        startupTimeoutMs: 1_000,
      },
      {
        fetch: fetchImpl as unknown as typeof fetch,
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      },
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('was not ready within 1000ms');
    expect(result._unsafeUnwrapErr().message).toContain('HTTP 503');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
