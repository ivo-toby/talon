import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  watch,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { lifecycleCommand } from '../../../src/cli/commands/lifecycle.js';
import type { DaemonCommand } from '../../../src/ipc/daemon-ipc.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'talon-lifecycle-cli-test-'));
}

function readLastCommand(inputDir: string): DaemonCommand {
  const files = readdirSync(inputDir)
    .filter((file) => file.endsWith('.json'))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  return JSON.parse(
    readFileSync(join(inputDir, files[files.length - 1]!), 'utf8'),
  ) as DaemonCommand;
}

async function respondToNextCommand(
  inputDir: string,
  outputDir: string,
  data: Record<string, unknown>,
  success = true,
): Promise<{ close(): void }> {
  mkdirSync(inputDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  const seen = new Set<string>();
  const watcher = watch(inputDir, (_event, filename) => {
    if (!filename || !filename.endsWith('.json') || seen.has(filename)) return;
    seen.add(filename);
    try {
      const command = JSON.parse(readFileSync(join(inputDir, filename), 'utf8')) as DaemonCommand;
      const response = {
        id: randomUUID(),
        commandId: command.id,
        success,
        ...(success ? { data } : { error: String(data.error ?? 'daemon failure') }),
      };
      writeFileSync(
        join(outputDir, `${Date.now()}-${randomUUID().replace(/-/g, '')}.json`),
        JSON.stringify(response),
      );
    } catch {
      // Atomic writes can briefly expose a path before content is readable.
    }
  });
  return watcher;
}

describe('lifecycleCommand()', () => {
  let tmpDir: string;
  let inputDir: string;
  let outputDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    inputDir = join(tmpDir, 'input');
    outputDir = join(tmpDir, 'output');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('requests effective lifecycle handlers with bounded status summaries', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const watcher = await respondToNextCommand(inputDir, outputDir, {
      lifecycleEnabled: true,
      dispatcher: { running: true, stopping: false, inFlight: 1, handlers: [] },
      backlog: { pending: 2, claimed: 1, failed: 0, completed: 3, dead_letter: 1 },
      handlers: [
        {
          handlerId: 'behavior-signal-projector',
          displayName: 'Behavior signal projector',
          mode: 'event',
          runtimeKind: 'native',
          personas: ['assistant'],
          subscriptions: 1,
          backlog: { pending: 2, claimed: 0, failed: 0, completed: 1, dead_letter: 0 },
          timing: {
            oldestCreatedAt: 1_700_000_000_000,
            oldestAgeMs: 90_000,
            nextRetryAt: 1_800_000_060_000,
          },
          circuit: 'closed',
        },
      ],
    });

    await lifecycleCommand({ action: 'handlers', ipcDir: tmpDir, timeoutMs: 2_000 });
    watcher.close();

    const command = readLastCommand(inputDir);
    expect(command.command).toBe('lifecycle-handlers');
    expect(command.payload).toEqual({ limit: 50 });
    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Lifecycle handlers');
    expect(output).toContain('behavior-signal-projector');
    expect(output).toContain('pending=2');
    expect(output).toContain('lag=1m');
    expect(output).toContain('oldest=2023-11-14T22:13:20.000Z');
    expect(output).toContain('nextRetry=2027-01-15T08:01:00.000Z');
  });

  it('requests exact delivery replay and renders the reopened identity', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const watcher = await respondToNextCommand(inputDir, outputDir, {
      eventId: 'event-123',
      handlerId: 'handler-one',
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
    });

    await lifecycleCommand({
      action: 'replay',
      eventId: 'event-123',
      handlerId: 'handler-one',
      ipcDir: tmpDir,
      timeoutMs: 2_000,
    });
    watcher.close();

    const command = readLastCommand(inputDir);
    expect(command.command).toBe('lifecycle-replay');
    expect(command.payload).toEqual({ eventId: 'event-123', handlerId: 'handler-one' });
    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Reopened lifecycle delivery');
    expect(output).toContain('event-123');
    expect(output).toContain('handler-one');
  });

  it('requests handler disablement and renders audit-relevant counts', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const watcher = await respondToNextCommand(inputDir, outputDir, {
      handlerId: 'handler-one',
      disabledDeliveries: 4,
    });

    await lifecycleCommand({
      action: 'disable',
      handlerId: 'handler-one',
      ipcDir: tmpDir,
      timeoutMs: 2_000,
    });
    watcher.close();

    const command = readLastCommand(inputDir);
    expect(command.command).toBe('lifecycle-disable');
    expect(command.payload).toEqual({ handlerId: 'handler-one' });
    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Disabled lifecycle handler "handler-one"');
    expect(output).toContain('Disabled deliveries: 4');
  });

  it('requests behavior-candidate provenance by persona with an explicit limit', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const watcher = await respondToNextCommand(inputDir, outputDir, {
      persona: 'assistant',
      candidates: [
        {
          candidateId: 'candidate-1',
          status: 'ready',
          kind: 'preference',
          confidence: 0.9,
          evidenceSources: 2,
          summary: 'Prefer shorter answers',
        },
      ],
    });

    await lifecycleCommand({
      action: 'candidates',
      persona: 'assistant',
      limit: 10,
      ipcDir: tmpDir,
      timeoutMs: 2_000,
    });
    watcher.close();

    const command = readLastCommand(inputDir);
    expect(command.command).toBe('lifecycle-candidates');
    expect(command.payload).toEqual({ persona: 'assistant', limit: 10 });
    const output = consoleSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('Behavior candidates for "assistant"');
    expect(output).toContain('candidate-1');
    expect(output).toContain('evidence=2');
  });

  it('exits with code 1 when required replay arguments are missing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code?: number) => undefined as never);

    await lifecycleCommand({
      action: 'replay',
      eventId: 'event-123',
      ipcDir: tmpDir,
      timeoutMs: 10,
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'handler id is required',
    );
  });
});
