import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRunnerService } from '../../../src/codex-runner/runner-service.js';
import { CodexSandboxPolicyViolationError } from '../../../src/codex-runner/app-server.js';

describe('CodexRunnerService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses a fresh restricted App Server home without inheriting Talon secrets', async () => {
    const authDir = await mkdtemp(join(tmpdir(), 'talon-codex-auth-test-'));
    await writeFile(join(authDir, 'auth.json'), '{"tokens":"subscription-state"}');
    vi.stubEnv('OPENAI_API_KEY', 'must-not-reach-codex');
    vi.stubEnv('CODEX_API_KEY', 'must-not-reach-codex');
    vi.stubEnv('TALON_CHANNEL_SECRET', 'must-not-reach-codex');
    const runTurn = vi.fn().mockResolvedValue({ text: 'contained result' });
    const service = new CodexRunnerService({ authDir }, { runTurn });

    try {
      const result = await service.generate({
        model: 'gpt-5.6-terra',
        systemPrompt: 'Trusted instruction',
        userPrompt: 'Bounded task',
      });

      expect(result).toEqual({ ok: true, text: 'contained result' });
      expect(runTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-5.6-terra',
          systemPrompt: 'Trusted instruction',
          userPrompt: 'Bounded task',
          env: expect.objectContaining({ CODEX_HOME: expect.any(String) }),
        }),
      );
      const invocation = runTurn.mock.calls[0][0];
      expect(invocation.env.OPENAI_API_KEY).toBeUndefined();
      expect(invocation.env.CODEX_API_KEY).toBeUndefined();
      expect(invocation.env.TALON_CHANNEL_SECRET).toBeUndefined();
      expect(invocation.env.CODEX_HOME).not.toBe(authDir);
    } finally {
      await rm(authDir, { recursive: true, force: true });
    }
  });

  it('reports forbidden App Server tool use as a policy violation', async () => {
    const authDir = await mkdtemp(join(tmpdir(), 'talon-codex-auth-test-'));
    await writeFile(join(authDir, 'auth.json'), '{}');
    const service = new CodexRunnerService(
      { authDir },
      {
        runTurn: vi
          .fn()
          .mockRejectedValue(new CodexSandboxPolicyViolationError('commandExecution attempted')),
      },
    );

    try {
      await expect(
        service.generate({ model: 'gpt-5.6-terra', systemPrompt: 'x', userPrompt: 'y' }),
      ).resolves.toEqual({
        ok: false,
        code: 'POLICY_VIOLATION',
        error: 'commandExecution attempted',
      });
    } finally {
      await rm(authDir, { recursive: true, force: true });
    }
  });
});
