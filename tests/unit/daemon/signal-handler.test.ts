/**
 * Unit tests for signal handler setup.
 *
 * Tests verify that signal listeners are registered and invoke the correct
 * daemon methods. We spy on process.on / process.exit rather than emitting
 * real OS signals to keep the test suite hermetic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from 'neverthrow';
import pino from 'pino';
import type { TalondDaemon } from '../../../src/daemon/daemon.js';
import { DaemonError } from '../../../src/core/errors/index.js';
import {
  registerSafeRejectionMatcher,
  __resetMatchersForTesting,
} from '../../../src/daemon/unhandled-rejection-shield.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

/**
 * Creates a minimal TalondDaemon stub with the methods used by the signal
 * handler. We avoid importing the real daemon to keep the test isolated.
 */
function makeDaemonStub(overrides: Partial<TalondDaemon> = {}): TalondDaemon {
  return {
    state: 'running',
    stop: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(ok(undefined)),
    start: vi.fn().mockResolvedValue(ok(undefined)),
    health: vi.fn().mockReturnValue({
      state: 'running',
      uptime: 0,
      queueStats: { pending: 0, claimed: 0, processing: 0, deadLetter: 0 },
      activeChannels: [],
      schedulerRunning: false,
    }),
    ...overrides,
  } as unknown as TalondDaemon;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setupSignalHandlers', () => {
  let registeredListeners: Map<string, ((...args: unknown[]) => void)[]>;
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetMatchersForTesting();
    registeredListeners = new Map();

    // Intercept process.on to capture registered handlers without touching
    // the actual process signal table.
    processOnSpy = vi.spyOn(process, 'on').mockImplementation((event, listener) => {
      const existing = registeredListeners.get(event as string) ?? [];
      existing.push(listener as (...args: unknown[]) => void);
      registeredListeners.set(event as string, existing);
      return process;
    });

    // Prevent process.exit from actually terminating the test process.
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      // no-op in tests
      return undefined as never;
    });
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  it('registers a SIGTERM handler', async () => {
    const { setupSignalHandlers } = await import('../../../src/daemon/signal-handler.js');
    const daemon = makeDaemonStub();
    setupSignalHandlers(daemon, createSilentLogger());

    expect(registeredListeners.has('SIGTERM')).toBe(true);
    expect(registeredListeners.get('SIGTERM')!.length).toBeGreaterThanOrEqual(1);
  });

  it('registers a SIGINT handler', async () => {
    const { setupSignalHandlers } = await import('../../../src/daemon/signal-handler.js');
    const daemon = makeDaemonStub();
    setupSignalHandlers(daemon, createSilentLogger());

    expect(registeredListeners.has('SIGINT')).toBe(true);
    expect(registeredListeners.get('SIGINT')!.length).toBeGreaterThanOrEqual(1);
  });

  it('registers a SIGHUP handler', async () => {
    const { setupSignalHandlers } = await import('../../../src/daemon/signal-handler.js');
    const daemon = makeDaemonStub();
    setupSignalHandlers(daemon, createSilentLogger());

    expect(registeredListeners.has('SIGHUP')).toBe(true);
  });

  it('registers an unhandledRejection handler', async () => {
    const { setupSignalHandlers } = await import('../../../src/daemon/signal-handler.js');
    const daemon = makeDaemonStub();
    setupSignalHandlers(daemon, createSilentLogger());

    expect(registeredListeners.has('unhandledRejection')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // SIGTERM / SIGINT shutdown
  // -------------------------------------------------------------------------

  it('calls daemon.stop() when SIGTERM handler is invoked', async () => {
    const { setupSignalHandlers } = await import('../../../src/daemon/signal-handler.js');
    const daemon = makeDaemonStub();
    setupSignalHandlers(daemon, createSilentLogger());

    const handler = registeredListeners.get('SIGTERM')![0];
    // Handlers fire async work with `void`; invoke and wait for microtasks to settle.
    (handler as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(daemon.stop).toHaveBeenCalledOnce();
  });

  it('calls daemon.stop() when SIGINT handler is invoked', async () => {
    const { setupSignalHandlers } = await import('../../../src/daemon/signal-handler.js');
    const daemon = makeDaemonStub();
    setupSignalHandlers(daemon, createSilentLogger());

    const handler = registeredListeners.get('SIGINT')![0];
    (handler as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(daemon.stop).toHaveBeenCalledOnce();
  });

  it('calls process.exit(0) after graceful shutdown', async () => {
    const { setupSignalHandlers } = await import('../../../src/daemon/signal-handler.js');
    const daemon = makeDaemonStub();
    setupSignalHandlers(daemon, createSilentLogger());

    const handler = registeredListeners.get('SIGTERM')![0];
    (handler as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(processExitSpy).toHaveBeenCalledWith(0);
  });

  it('guards against double-shutdown (second signal is ignored)', async () => {
    const { setupSignalHandlers } = await import('../../../src/daemon/signal-handler.js');
    const daemon = makeDaemonStub();
    setupSignalHandlers(daemon, createSilentLogger());

    const sigtermHandler = registeredListeners.get('SIGTERM')![0];
    const sigintHandler = registeredListeners.get('SIGINT')![0];

    // Fire both signals and allow async work to complete.
    (sigtermHandler as () => void)();
    (sigintHandler as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // daemon.stop() should have been called only once despite two signals
    expect(daemon.stop).toHaveBeenCalledOnce();
  });

  it('calls process.exit(1) if daemon.stop() throws', async () => {
    const { setupSignalHandlers } = await import('../../../src/daemon/signal-handler.js');
    const daemon = makeDaemonStub({
      stop: vi.fn().mockRejectedValue(new Error('stop failed')),
    });
    setupSignalHandlers(daemon, createSilentLogger());

    const handler = registeredListeners.get('SIGTERM')![0];
    (handler as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  // -------------------------------------------------------------------------
  // SIGHUP reload
  // -------------------------------------------------------------------------

  it('calls daemon.reload() when SIGHUP handler is invoked', async () => {
    const { setupSignalHandlers } = await import('../../../src/daemon/signal-handler.js');
    const daemon = makeDaemonStub();
    setupSignalHandlers(daemon, createSilentLogger());

    const handler = registeredListeners.get('SIGHUP')![0];
    // The SIGHUP handler fires handleReload() using void — invoke and wait a tick.
    (handler as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(daemon.reload).toHaveBeenCalledOnce();
  });

  it('does not crash if daemon.reload() returns an error Result', async () => {
    const { setupSignalHandlers } = await import('../../../src/daemon/signal-handler.js');
    const daemon = makeDaemonStub({
      reload: vi.fn().mockResolvedValue(err(new DaemonError('reload failed'))),
    });
    setupSignalHandlers(daemon, createSilentLogger());

    const handler = registeredListeners.get('SIGHUP')![0];
    // The SIGHUP handler fires async work in the background via void; we
    // call the internal handleReload indirectly by invoking the listener.
    // Wait a tick to let the async work complete.
    (handler as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should not have crashed (process.exit not called)
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('does not crash if daemon.reload() throws', async () => {
    const { setupSignalHandlers } = await import('../../../src/daemon/signal-handler.js');
    const daemon = makeDaemonStub({
      reload: vi.fn().mockRejectedValue(new Error('unexpected throw')),
    });
    setupSignalHandlers(daemon, createSilentLogger());

    const handler = registeredListeners.get('SIGHUP')![0];
    (handler as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should not have crashed (process.exit not called)
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // unhandledRejection
  // -------------------------------------------------------------------------

  it('calls process.exit(1) when unhandledRejection fires with no matcher claim', async () => {
    const { setupSignalHandlers } = await import('../../../src/daemon/signal-handler.js');
    const daemon = makeDaemonStub();
    setupSignalHandlers(daemon, createSilentLogger());

    const handler = registeredListeners.get('unhandledRejection')![0];
    (handler as (reason: unknown) => void)(new Error('unhandled'));

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('does NOT exit when a registered shield matcher claims the rejection', async () => {
    const { setupSignalHandlers } = await import('../../../src/daemon/signal-handler.js');
    const daemon = makeDaemonStub();
    setupSignalHandlers(daemon, createSilentLogger());

    registerSafeRejectionMatcher({
      name: 'test-shield',
      matches: (reason) => reason instanceof Error && reason.message === 'shielded',
    });

    const handler = registeredListeners.get('unhandledRejection')![0];
    (handler as (reason: unknown) => void)(new Error('shielded'));

    expect(processExitSpy).not.toHaveBeenCalled();
  });

  it('still exits when shield matchers exist but none claim the rejection', async () => {
    const { setupSignalHandlers } = await import('../../../src/daemon/signal-handler.js');
    const daemon = makeDaemonStub();
    setupSignalHandlers(daemon, createSilentLogger());

    registerSafeRejectionMatcher({
      name: 'narrow',
      matches: (reason) => reason instanceof Error && reason.message === 'specific',
    });

    const handler = registeredListeners.get('unhandledRejection')![0];
    (handler as (reason: unknown) => void)(new Error('something else'));

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
