import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

import { DaemonIpcClient } from '../../../src/ipc/daemon-ipc-client.js';
import type { DaemonResponse } from '../../../src/ipc/daemon-ipc.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(commandId: string, overrides: Partial<DaemonResponse> = {}): DaemonResponse {
  return {
    id: randomUUID(),
    commandId,
    success: true,
    data: { state: 'running' },
    ...overrides,
  };
}

/**
 * Writes a response file to the output directory after `delayMs` milliseconds,
 * simulating a daemon responding to a command.
 */
async function writeResponseAfter(
  outputDir: string,
  response: DaemonResponse,
  delayMs = 0,
): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  await fs.mkdir(outputDir, { recursive: true });
  const paddedTs = String(Date.now()).padStart(15, '0');
  const cleanId = response.id.replace(/-/g, '');
  const filename = `${paddedTs}-${cleanId}.json`;
  await fs.writeFile(path.join(outputDir, filename), JSON.stringify(response), 'utf8');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('DaemonIpcClient', () => {
  let tmpDir: string;
  let inputDir: string;
  let outputDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daemon-ipc-client-test-'));
    inputDir = path.join(tmpDir, 'input');
    outputDir = path.join(tmpDir, 'output');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // sendCommand() — basic happy path
  // -------------------------------------------------------------------------

  describe('sendCommand()', () => {
    it('writes a command file to inputDir', async () => {
      const client = new DaemonIpcClient({
        inputDir,
        outputDir,
        timeoutMs: 500,
        pollIntervalMs: 50,
      });

      // Start the response in parallel so we don't block on timeout.
      const sendPromise = client.sendCommand('status');

      // Wait briefly, then check the command file was written.
      await new Promise((r) => setTimeout(r, 50));
      const inputFiles = await fs.readdir(inputDir);
      expect(inputFiles.filter((f) => f.endsWith('.json'))).toHaveLength(1);

      // Write a response so the promise resolves.
      const inputFile = inputFiles.find((f) => f.endsWith('.json'))!;
      const raw = await fs.readFile(path.join(inputDir, inputFile), 'utf8');
      const cmd = JSON.parse(raw) as { id: string };
      void writeResponseAfter(outputDir, makeResponse(cmd.id), 0);

      await sendPromise;
    });

    it('returns the matching DaemonResponse', async () => {
      const client = new DaemonIpcClient({
        inputDir,
        outputDir,
        timeoutMs: 2000,
        pollIntervalMs: 50,
      });

      // Intercept the written command so we can match the commandId.
      let commandId: string | null = null;

      const sendPromise = client.sendCommand('status');

      // Small delay, then read back what was written.
      await new Promise((r) => setTimeout(r, 60));
      const inputFiles = await fs.readdir(inputDir);
      if (inputFiles.length > 0) {
        const raw = await fs.readFile(path.join(inputDir, inputFiles[0]!), 'utf8');
        commandId = (JSON.parse(raw) as { id: string }).id;
      }

      expect(commandId).not.toBeNull();
      const response = makeResponse(commandId!);
      void writeResponseAfter(outputDir, response, 0);

      const result = await sendPromise;
      expect(result).not.toBeNull();
      expect(result!.commandId).toBe(commandId);
      expect(result!.success).toBe(true);
    });

    it('deletes the response file after reading it', async () => {
      const client = new DaemonIpcClient({
        inputDir,
        outputDir,
        timeoutMs: 2000,
        pollIntervalMs: 50,
      });

      const sendPromise = client.sendCommand('reload');

      await new Promise((r) => setTimeout(r, 60));
      const inputFiles = await fs.readdir(inputDir);
      const raw = await fs.readFile(path.join(inputDir, inputFiles[0]!), 'utf8');
      const commandId = (JSON.parse(raw) as { id: string }).id;

      void writeResponseAfter(outputDir, makeResponse(commandId), 0);

      await sendPromise;

      // Response file should have been cleaned up.
      const remaining = await fs.readdir(outputDir);
      expect(remaining.filter((f) => f.endsWith('.json'))).toHaveLength(0);
    });

    it('returns null on timeout when no daemon responds', async () => {
      const client = new DaemonIpcClient({
        inputDir,
        outputDir,
        timeoutMs: 150,
        pollIntervalMs: 50,
      });

      const result = await client.sendCommand('status');
      expect(result).toBeNull();
    }, 10_000);

    it('returns null when outputDir does not exist and no response appears', async () => {
      const client = new DaemonIpcClient({
        inputDir,
        outputDir: path.join(tmpDir, 'nonexistent-output'),
        timeoutMs: 150,
        pollIntervalMs: 50,
      });

      const result = await client.sendCommand('status');
      expect(result).toBeNull();
    }, 10_000);

    it('creates inputDir if it does not exist', async () => {
      const newInputDir = path.join(tmpDir, 'new-input');

      const client = new DaemonIpcClient({
        inputDir: newInputDir,
        outputDir,
        timeoutMs: 150,
        pollIntervalMs: 50,
      });

      // Send command — it will timeout but should not throw.
      await client.sendCommand('status');

      const stat = await fs.stat(newInputDir);
      expect(stat.isDirectory()).toBe(true);
    }, 10_000);

    it('creates inputDir with owner-only permissions on POSIX', async () => {
      const newInputDir = path.join(tmpDir, 'restricted-input');

      const client = new DaemonIpcClient({
        inputDir: newInputDir,
        outputDir,
        timeoutMs: 150,
        pollIntervalMs: 50,
      });

      await client.sendCommand('status');

      const stat = await fs.stat(newInputDir);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o700);
    }, 10_000);

    it('handles failure response from daemon', async () => {
      const client = new DaemonIpcClient({
        inputDir,
        outputDir,
        timeoutMs: 2000,
        pollIntervalMs: 50,
      });

      const sendPromise = client.sendCommand('shutdown');

      await new Promise((r) => setTimeout(r, 60));
      const inputFiles = await fs.readdir(inputDir);
      const raw = await fs.readFile(path.join(inputDir, inputFiles[0]!), 'utf8');
      const commandId = (JSON.parse(raw) as { id: string }).id;

      const errorResponse = makeResponse(commandId, {
        success: false,
        error: 'Daemon is stopping',
        data: undefined,
      });
      void writeResponseAfter(outputDir, errorResponse, 0);

      const result = await sendPromise;
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      expect(result!.error).toBe('Daemon is stopping');
    });
  });

  // -------------------------------------------------------------------------
  // send() — lower-level method
  // -------------------------------------------------------------------------

  describe('send()', () => {
    it('accepts a pre-built DaemonCommand', async () => {
      const client = new DaemonIpcClient({
        inputDir,
        outputDir,
        timeoutMs: 2000,
        pollIntervalMs: 50,
      });

      const commandId = randomUUID();
      const sendPromise = client.send({ id: commandId, command: 'status' });

      await new Promise((r) => setTimeout(r, 60));
      void writeResponseAfter(outputDir, makeResponse(commandId), 0);

      const result = await sendPromise;
      expect(result).not.toBeNull();
      expect(result!.commandId).toBe(commandId);
    });

    it('does not match a response with a different commandId', async () => {
      const client = new DaemonIpcClient({
        inputDir,
        outputDir,
        timeoutMs: 150,
        pollIntervalMs: 50,
      });

      const commandId = randomUUID();
      const wrongCommandId = randomUUID();

      // Write a response for a different command — should not match.
      void writeResponseAfter(outputDir, makeResponse(wrongCommandId), 10);

      const result = await client.send({ id: commandId, command: 'status' });
      expect(result).toBeNull();
    }, 10_000);

    it('ignores non-.json files in outputDir when polling', async () => {
      const client = new DaemonIpcClient({
        inputDir,
        outputDir,
        timeoutMs: 2000,
        pollIntervalMs: 50,
      });

      const commandId = randomUUID();

      // Write some noise into the output dir.
      await fs.writeFile(path.join(outputDir, 'somefile.txt'), 'noise', 'utf8');

      const sendPromise = client.send({ id: commandId, command: 'reload' });

      await new Promise((r) => setTimeout(r, 60));
      void writeResponseAfter(outputDir, makeResponse(commandId), 0);

      const result = await sendPromise;
      expect(result!.commandId).toBe(commandId);
    });
  });
});
