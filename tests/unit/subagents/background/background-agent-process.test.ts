import { describe, expect, it } from 'vitest';
import { BackgroundAgentProcess } from '../../../../src/subagents/background/background-agent-process.js';

describe('BackgroundAgentProcess', () => {
  it('starts a process, exposes pid, and captures stdout', async () => {
    const processWrapper = new BackgroundAgentProcess({
      command: 'echo',
      args: ['hello world'],
      cwd: '/tmp',
      stdin: '',
      timeoutMs: 5_000,
    });

    const startResult = processWrapper.start();
    expect(startResult.isOk()).toBe(true);

    const { pid, completion } = startResult._unsafeUnwrap();
    expect(pid).toBeGreaterThan(0);

    const result = await completion;
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
    expect(result._unsafeUnwrap().stdout).toContain('hello world');
  });

  it('captures non-zero exit codes', async () => {
    const processWrapper = new BackgroundAgentProcess({
      command: 'bash',
      args: ['-lc', 'exit 7'],
      cwd: '/tmp',
      stdin: '',
      timeoutMs: 5_000,
    });

    const completion = processWrapper.start()._unsafeUnwrap().completion;
    const result = await completion;

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().exitCode).toBe(7);
  });

  it('times out and kills long-running processes', async () => {
    const processWrapper = new BackgroundAgentProcess({
      command: 'sleep',
      args: ['60'],
      cwd: '/tmp',
      stdin: '',
      timeoutMs: 100,
    });

    const completion = processWrapper.start()._unsafeUnwrap().completion;
    const result = await completion;

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().timedOut).toBe(true);
  });

  it('rejects a second start call', () => {
    const processWrapper = new BackgroundAgentProcess({
      command: 'sleep',
      args: ['1'],
      cwd: '/tmp',
      stdin: '',
      timeoutMs: 5_000,
    });

    expect(processWrapper.start().isOk()).toBe(true);
    expect(processWrapper.start().isErr()).toBe(true);
    processWrapper.kill();
  });

  it('passes provider-specific env overrides to the spawned process', async () => {
    const processWrapper = new BackgroundAgentProcess({
      command: 'bash',
      args: ['-lc', 'printf "%s" "$TEST_PROVIDER_ENV"'],
      cwd: '/tmp',
      stdin: '',
      timeoutMs: 5_000,
      env: {
        TEST_PROVIDER_ENV: 'gemini-env-ok',
      },
    });

    const completion = processWrapper.start()._unsafeUnwrap().completion;
    const result = await completion;

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().stdout).toBe('gemini-env-ok');
  });

  it('does not inherit process.env when inheritEnv is false', async () => {
    process.env.TALON_TEST_DAEMON_SECRET = 'leak-me';
    try {
      const processWrapper = new BackgroundAgentProcess({
        command: '/bin/sh',
        args: ['-c', 'printf "[%s][%s]" "$TALON_TEST_DAEMON_SECRET" "$ALLOWED"'],
        cwd: '/tmp',
        stdin: '',
        timeoutMs: 5_000,
        env: { ALLOWED: 'yes' },
        inheritEnv: false,
      });

      const result = await processWrapper.start()._unsafeUnwrap().completion;

      expect(result._unsafeUnwrap().stdout).toBe('[][yes]');
    } finally {
      delete process.env.TALON_TEST_DAEMON_SECRET;
    }
  });
});
