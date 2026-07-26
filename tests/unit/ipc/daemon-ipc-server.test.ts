import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import pino from 'pino';

import { DaemonIpcServer } from '../../../src/ipc/daemon-ipc-server.js';
import type { DaemonCommand, DaemonResponse } from '../../../src/ipc/daemon-ipc.js';
import { DaemonResponseSchema } from '../../../src/ipc/daemon-ipc.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function makeCommand(overrides: Partial<DaemonCommand> = {}): DaemonCommand {
  return {
    id: randomUUID(),
    command: 'status',
    ...overrides,
  };
}

async function writeCommandFile(dir: string, command: DaemonCommand): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const paddedTs = String(Date.now()).padStart(15, '0');
  const cleanId = command.id.replace(/-/g, '');
  const filename = `${paddedTs}-${cleanId}.json`;
  await fs.writeFile(path.join(dir, filename), JSON.stringify(command), 'utf8');
  return filename;
}

const DEFAULT_RESPONSE: DaemonResponse = {
  id: randomUUID(),
  commandId: '',
  success: true,
  data: { state: 'running' },
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('DaemonIpcServer', () => {
  let tmpDir: string;
  let inputDir: string;
  let outputDir: string;
  let errorsDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'daemon-ipc-server-test-'));
    inputDir = path.join(tmpDir, 'input');
    outputDir = path.join(tmpDir, 'output');
    errorsDir = path.join(tmpDir, 'errors');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // pollOnce() — basic happy path
  // -------------------------------------------------------------------------

  describe('pollOnce()', () => {
    it('returns empty array when inputDir is empty', async () => {
      const server = new DaemonIpcServer({
        inputDir,
        outputDir,
        errorsDir,
        logger: makeLogger(),
        commandHandler: async (cmd) => ({ ...DEFAULT_RESPONSE, commandId: cmd.id }),
      });

      const processed = await server.pollOnce();
      expect(processed).toHaveLength(0);
    });

    it('returns empty array when inputDir does not exist', async () => {
      const server = new DaemonIpcServer({
        inputDir: path.join(tmpDir, 'nonexistent'),
        outputDir,
        errorsDir,
        logger: makeLogger(),
        commandHandler: async (cmd) => ({ ...DEFAULT_RESPONSE, commandId: cmd.id }),
      });

      const processed = await server.pollOnce();
      expect(processed).toHaveLength(0);
    });

    it('processes a valid command and invokes handler', async () => {
      const command = makeCommand();
      await writeCommandFile(inputDir, command);

      const handledIds: string[] = [];
      const server = new DaemonIpcServer({
        inputDir,
        outputDir,
        errorsDir,
        logger: makeLogger(),
        commandHandler: async (cmd) => {
          handledIds.push(cmd.id);
          return { ...DEFAULT_RESPONSE, commandId: cmd.id };
        },
      });

      const processed = await server.pollOnce();
      expect(processed).toHaveLength(1);
      expect(handledIds).toContain(command.id);
    });

    it('deletes the input file after processing', async () => {
      const command = makeCommand();
      const filename = await writeCommandFile(inputDir, command);

      const server = new DaemonIpcServer({
        inputDir,
        outputDir,
        errorsDir,
        logger: makeLogger(),
        commandHandler: async (cmd) => ({ ...DEFAULT_RESPONSE, commandId: cmd.id }),
      });

      await server.pollOnce();

      await expect(fs.access(path.join(inputDir, filename))).rejects.toThrow();
    });

    it('writes response file to outputDir', async () => {
      const command = makeCommand();
      await writeCommandFile(inputDir, command);

      const server = new DaemonIpcServer({
        inputDir,
        outputDir,
        errorsDir,
        logger: makeLogger(),
        commandHandler: async (cmd) => ({
          id: randomUUID(),
          commandId: cmd.id,
          success: true,
          data: { state: 'running' },
        }),
      });

      await server.pollOnce();

      const responseFiles = await fs.readdir(outputDir);
      expect(responseFiles.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    });

    it('response file contains valid DaemonResponse JSON matching commandId', async () => {
      const command = makeCommand();
      await writeCommandFile(inputDir, command);

      const server = new DaemonIpcServer({
        inputDir,
        outputDir,
        errorsDir,
        logger: makeLogger(),
        commandHandler: async (cmd) => ({
          id: randomUUID(),
          commandId: cmd.id,
          success: true,
          data: { uptime: 1234 },
        }),
      });

      await server.pollOnce();

      const responseFiles = (await fs.readdir(outputDir)).filter((f) => f.endsWith('.json'));
      expect(responseFiles).toHaveLength(1);

      const raw = await fs.readFile(path.join(outputDir, responseFiles[0]!), 'utf8');
      const parsed = DaemonResponseSchema.parse(JSON.parse(raw));
      expect(parsed.commandId).toBe(command.id);
      expect(parsed.success).toBe(true);
    });

    it('processes commands in lexicographic (FIFO) order', async () => {
      const cmd1 = makeCommand({ id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', command: 'status' });
      const cmd2 = makeCommand({ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', command: 'reload' });

      // Write cmd2 first but with a lower timestamp in the filename.
      await fs.writeFile(
        path.join(inputDir, `000000000001000-${cmd1.id.replace(/-/g, '')}.json`),
        JSON.stringify(cmd1),
        'utf8',
      );
      await fs.writeFile(
        path.join(inputDir, `000000000002000-${cmd2.id.replace(/-/g, '')}.json`),
        JSON.stringify(cmd2),
        'utf8',
      );

      const order: string[] = [];
      const server = new DaemonIpcServer({
        inputDir,
        outputDir,
        errorsDir,
        logger: makeLogger(),
        commandHandler: async (cmd) => {
          order.push(cmd.id);
          return { ...DEFAULT_RESPONSE, commandId: cmd.id };
        },
      });

      await server.pollOnce();

      expect(order[0]).toBe(cmd1.id);
      expect(order[1]).toBe(cmd2.id);
    });

    it('ignores non-.json files', async () => {
      await fs.writeFile(path.join(inputDir, 'somefile.txt'), 'hello');
      await fs.writeFile(path.join(inputDir, 'another.log'), 'world');

      const handlerCalls: number[] = [];
      const server = new DaemonIpcServer({
        inputDir,
        outputDir,
        errorsDir,
        logger: makeLogger(),
        commandHandler: async (cmd) => {
          handlerCalls.push(1);
          return { ...DEFAULT_RESPONSE, commandId: cmd.id };
        },
      });

      await server.pollOnce();
      expect(handlerCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('moves invalid JSON to errorsDir', async () => {
      await fs.writeFile(
        path.join(inputDir, '000000000001000-badfile.json'),
        'not valid json {{{',
        'utf8',
      );

      const server = new DaemonIpcServer({
        inputDir,
        outputDir,
        errorsDir,
        logger: makeLogger(),
        commandHandler: async (cmd) => ({ ...DEFAULT_RESPONSE, commandId: cmd.id }),
      });

      const processed = await server.pollOnce();
      expect(processed).toHaveLength(0);

      // Original file should be gone from input
      await expect(
        fs.access(path.join(inputDir, '000000000001000-badfile.json')),
      ).rejects.toThrow();

      // Error files should exist in errorsDir
      const errorFiles = await fs.readdir(errorsDir);
      expect(errorFiles.some((f) => f.endsWith('.json'))).toBe(true);
    });

    it('moves schema-invalid command to errorsDir', async () => {
      const badCommand = { id: 'not-a-uuid', command: 'unknown-command' };
      await fs.writeFile(
        path.join(inputDir, '000000000001000-badcmd.json'),
        JSON.stringify(badCommand),
        'utf8',
      );

      const server = new DaemonIpcServer({
        inputDir,
        outputDir,
        errorsDir,
        logger: makeLogger(),
        commandHandler: async (cmd) => ({ ...DEFAULT_RESPONSE, commandId: cmd.id }),
      });

      const processed = await server.pollOnce();
      expect(processed).toHaveLength(0);

      const errorFiles = await fs.readdir(errorsDir);
      expect(errorFiles.length).toBeGreaterThan(0);
    });

    it('rejects malformed lifecycle payloads before invoking the handler', async () => {
      const badCommand = {
        id: randomUUID(),
        command: 'lifecycle-disable',
        payload: {},
      };
      await fs.writeFile(
        path.join(inputDir, '000000000001000-bad-lifecycle.json'),
        JSON.stringify(badCommand),
        'utf8',
      );
      const commandHandler = vi.fn(async (cmd: DaemonCommand) => ({
        ...DEFAULT_RESPONSE,
        commandId: cmd.id,
      }));
      const server = new DaemonIpcServer({
        inputDir,
        outputDir,
        errorsDir,
        logger: makeLogger(),
        commandHandler,
      });

      const processed = await server.pollOnce();

      expect(processed).toHaveLength(0);
      expect(commandHandler).not.toHaveBeenCalled();
      expect(await fs.readdir(outputDir)).toHaveLength(0);
    });

    it('creates a .error.json companion file for invalid commands', async () => {
      await fs.writeFile(path.join(inputDir, '000000000001000-bad.json'), 'not json', 'utf8');

      const server = new DaemonIpcServer({
        inputDir,
        outputDir,
        errorsDir,
        logger: makeLogger(),
        commandHandler: async (cmd) => ({ ...DEFAULT_RESPONSE, commandId: cmd.id }),
      });

      await server.pollOnce();

      const errorFiles = await fs.readdir(errorsDir);
      const errorAnnotation = errorFiles.find((f) => f.endsWith('.error.json'));
      expect(errorAnnotation).toBeTruthy();

      const annotation = JSON.parse(
        await fs.readFile(path.join(errorsDir, errorAnnotation!), 'utf8'),
      ) as { reason: string };
      expect(annotation.reason).toContain('JSON parse error');
    });

    it('writes an error response when the handler throws', async () => {
      const command = makeCommand();
      await writeCommandFile(inputDir, command);

      const server = new DaemonIpcServer({
        inputDir,
        outputDir,
        errorsDir,
        logger: makeLogger(),
        commandHandler: async (_cmd) => {
          throw new Error('handler boom');
        },
      });

      // Handler errors result in an error response being written — the
      // command is still "processed" (input file deleted, response written).
      const processed = await server.pollOnce();
      // The command is returned even when the handler throws, since the
      // file was successfully removed and an error response was written.
      expect(processed).toHaveLength(1);

      const responseFiles = (await fs.readdir(outputDir)).filter((f) => f.endsWith('.json'));
      expect(responseFiles).toHaveLength(1);

      const raw = await fs.readFile(path.join(outputDir, responseFiles[0]!), 'utf8');
      const parsed = DaemonResponseSchema.parse(JSON.parse(raw));
      expect(parsed.commandId).toBe(command.id);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('handler boom');
    });

    it('continues processing subsequent files after an invalid file', async () => {
      // Bad file with lower sort key (processed first)
      await fs.writeFile(path.join(inputDir, '000000000000001-bad.json'), 'oops', 'utf8');

      // Good command file with higher sort key
      const command = makeCommand();
      await fs.writeFile(
        path.join(inputDir, `000000000002000-${command.id.replace(/-/g, '')}.json`),
        JSON.stringify(command),
        'utf8',
      );

      const processed: string[] = [];
      const server = new DaemonIpcServer({
        inputDir,
        outputDir,
        errorsDir,
        logger: makeLogger(),
        commandHandler: async (cmd) => {
          processed.push(cmd.id);
          return { ...DEFAULT_RESPONSE, commandId: cmd.id };
        },
      });

      await server.pollOnce();

      // Valid command should still be processed
      expect(processed).toContain(command.id);
    });
  });

  // -------------------------------------------------------------------------
  // start() / stop()
  // -------------------------------------------------------------------------

  describe('start() / stop()', () => {
    it('start() begins polling and stop() halts it', async () => {
      const handled: DaemonCommand[] = [];

      const server = new DaemonIpcServer({
        inputDir,
        outputDir,
        errorsDir,
        logger: makeLogger(),
        pollIntervalMs: 50,
        commandHandler: async (cmd) => {
          handled.push(cmd);
          return { ...DEFAULT_RESPONSE, commandId: cmd.id };
        },
      });

      server.start();

      const command = makeCommand();
      await writeCommandFile(inputDir, command);

      await new Promise((r) => setTimeout(r, 200));
      server.stop();

      expect(handled.length).toBeGreaterThan(0);
      expect(handled[0]!.id).toBe(command.id);
    });

    it('stop() is idempotent', () => {
      const server = new DaemonIpcServer({
        inputDir,
        outputDir,
        errorsDir,
        logger: makeLogger(),
        commandHandler: async (cmd) => ({ ...DEFAULT_RESPONSE, commandId: cmd.id }),
      });

      server.start();
      server.stop();
      expect(() => server.stop()).not.toThrow();
    });

    it('calling start() while already running is a no-op', () => {
      const server = new DaemonIpcServer({
        inputDir,
        outputDir,
        errorsDir,
        logger: makeLogger(),
        pollIntervalMs: 500,
        commandHandler: async (cmd) => ({ ...DEFAULT_RESPONSE, commandId: cmd.id }),
      });

      vi.useFakeTimers();
      server.start();
      server.start(); // second call — no-op
      vi.useRealTimers();
      server.stop();
    });
  });
});
