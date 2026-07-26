/**
 * Daemon IPC server — runs inside `talond`.
 *
 * Polls an input directory for DaemonCommand JSON files, dispatches them
 * to a caller-supplied handler, and writes DaemonResponse files atomically
 * to an output directory.
 *
 * Error handling policy:
 *   - Invalid JSON / schema violations → file moved to `errorsDir`, no crash
 *   - Handler rejection                → error response written to outputDir
 *   - Directory unreadable             → logged, polling continues
 */

import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import writeFileAtomic from 'write-file-atomic';
import type pino from 'pino';

import { DaemonCommandSchema } from './daemon-ipc.js';
import type { DaemonCommand, DaemonResponse } from './daemon-ipc.js';
import { ensureOwnerOnlyDir } from '../core/fs/private-paths.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Configuration for {@link DaemonIpcServer}. */
export interface DaemonIpcServerOptions {
  /** Directory to poll for incoming DaemonCommand files. */
  inputDir: string;
  /** Directory to write DaemonResponse files into. */
  outputDir: string;
  /** Directory to move invalid / unprocessable command files into. */
  errorsDir: string;
  /** Pino logger instance. */
  logger: pino.Logger;
  /** Async function that handles a command and returns a response. */
  commandHandler: (command: DaemonCommand) => Promise<DaemonResponse>;
  /** How often to poll `inputDir` in milliseconds. Default: 500. */
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// DaemonIpcServer
// ---------------------------------------------------------------------------

/**
 * Server-side daemon IPC component.
 *
 * Polls `inputDir` at a configurable interval, parses and validates each
 * `.json` file as a {@link DaemonCommand}, dispatches it to the handler,
 * and writes the {@link DaemonResponse} atomically to `outputDir`.
 *
 * Invalid files are moved to `errorsDir` with an error annotation so
 * operators can inspect what went wrong.
 *
 * @example
 * ```ts
 * const server = new DaemonIpcServer({
 *   inputDir: 'data/ipc/daemon/input',
 *   outputDir: 'data/ipc/daemon/output',
 *   errorsDir: 'data/ipc/daemon/errors',
 *   logger,
 *   commandHandler: async (cmd) => handleCommand(cmd),
 * });
 * server.start();
 * ```
 */
export class DaemonIpcServer {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private readonly pollIntervalMs: number;

  constructor(private readonly opts: DaemonIpcServerOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
  }

  /**
   * Starts the polling loop.
   *
   * The first poll fires after one `pollIntervalMs` interval. Calling `start`
   * while already running is a no-op.
   */
  start(): void {
    if (this.intervalHandle !== null) {
      return;
    }
    this.intervalHandle = setInterval(() => {
      void this.runPoll();
    }, this.pollIntervalMs);
  }

  /**
   * Stops the polling loop.
   *
   * Safe to call multiple times; subsequent calls are no-ops.
   */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Performs a single poll of the input directory.
   *
   * Useful for testing without a real timer. Returns the list of successfully
   * processed commands.
   */
  async pollOnce(): Promise<DaemonCommand[]> {
    const files = await this.listFiles();
    const processed: DaemonCommand[] = [];

    for (const file of files) {
      const cmd = await this.processFile(file);
      if (cmd !== null) {
        processed.push(cmd);
      }
    }

    return processed;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Inner poll loop body — called on every tick. */
  private async runPoll(): Promise<void> {
    await this.pollOnce();
  }

  /**
   * Returns all `.json` files in `inputDir`, sorted lexicographically for
   * FIFO processing order.
   */
  private async listFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.opts.inputDir);
    } catch {
      // Directory not yet created or temporarily unavailable — not fatal.
      return [];
    }

    return entries
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(this.opts.inputDir, name));
  }

  /**
   * Reads, validates, dispatches, and deletes a single command file.
   *
   * On success, writes the handler's response to `outputDir`.
   * On invalid file, moves it to `errorsDir`.
   * On handler error, writes an error response to `outputDir`.
   *
   * @returns The parsed command on success, or `null` on failure.
   */
  private async processFile(filepath: string): Promise<DaemonCommand | null> {
    // --- Read ---
    let raw: string;
    try {
      raw = await fs.readFile(filepath, 'utf8');
    } catch {
      // File disappeared between readdir and readFile — skip silently.
      return null;
    }

    // --- Parse JSON ---
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (cause) {
      this.opts.logger.warn(
        { filepath, cause: String(cause) },
        'daemon-ipc-server: JSON parse error, moving to errors dir',
      );
      await this.moveToErrors(filepath, raw, `JSON parse error: ${String(cause)}`);
      return null;
    }

    // --- Validate schema ---
    const validation = DaemonCommandSchema.safeParse(parsed);
    if (!validation.success) {
      this.opts.logger.warn(
        { filepath, error: validation.error.message },
        'daemon-ipc-server: schema validation failed, moving to errors dir',
      );
      await this.moveToErrors(
        filepath,
        raw,
        `Schema validation failed: ${validation.error.message}`,
      );
      return null;
    }

    const command = validation.data;

    // --- Dispatch to handler ---
    let response: DaemonResponse;
    try {
      response = await this.opts.commandHandler(command);
    } catch (cause) {
      this.opts.logger.error(
        { commandId: command.id, command: command.command, cause: String(cause) },
        'daemon-ipc-server: command handler threw, writing error response',
      );
      response = {
        id: randomUUID(),
        commandId: command.id,
        success: false,
        error: `Handler error: ${String(cause)}`,
      };
    }

    // --- Write response ---
    await this.writeResponse(response);

    // --- Delete processed input file ---
    try {
      await fs.unlink(filepath);
    } catch {
      // If deletion fails, we may re-process the command on the next poll.
      // The handler should be idempotent where possible.
    }

    this.opts.logger.debug(
      { commandId: command.id, command: command.command },
      'daemon-ipc-server: command processed',
    );

    return command;
  }

  /**
   * Writes a DaemonResponse atomically to `outputDir`.
   *
   * The filename embeds the current timestamp and response ID for FIFO
   * ordering, matching the naming convention used by IpcWriter.
   */
  private async writeResponse(response: DaemonResponse): Promise<void> {
    try {
      await ensureOwnerOnlyDir(this.opts.outputDir);

      const paddedTs = String(Date.now()).padStart(15, '0');
      const cleanId = response.id.replace(/-/g, '');
      const filename = `${paddedTs}-${cleanId}.json`;
      const filepath = path.join(this.opts.outputDir, filename);

      await writeFileAtomic(filepath, JSON.stringify(response), { encoding: 'utf8' });
    } catch (cause) {
      this.opts.logger.error(
        { commandId: response.commandId, cause: String(cause) },
        'daemon-ipc-server: failed to write response',
      );
    }
  }

  /**
   * Moves a problematic command file to `errorsDir`.
   *
   * Writes a sibling `.error.json` annotation file alongside the original
   * content so operators can inspect what went wrong.
   */
  private async moveToErrors(filepath: string, rawContent: string, reason: string): Promise<void> {
    try {
      await ensureOwnerOnlyDir(this.opts.errorsDir);

      const basename = path.basename(filepath);
      const destPath = path.join(this.opts.errorsDir, basename);

      await fs.writeFile(destPath, rawContent, 'utf8');

      const errorRecord = {
        originalFile: filepath,
        reason,
        timestamp: Date.now(),
      };
      await fs.writeFile(
        path.join(this.opts.errorsDir, basename.replace('.json', '.error.json')),
        JSON.stringify(errorRecord, null, 2),
        'utf8',
      );

      await fs.unlink(filepath);
    } catch {
      // Moving to errors dir itself failed — log and move on to avoid
      // infinite crash loops. The original file stays in the inbox so
      // the next poll will re-attempt.
    }
  }
}
