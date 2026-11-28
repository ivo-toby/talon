/**
 * Host-side tool: memory.access
 *
 * Reads from or writes to the per-thread layered memory store. The host
 * mediates all memory operations to ensure isolation between threads and
 * enforce size limits.
 *
 * Thread isolation is enforced at the schema level: the primary key is
 * (thread_id, id), so all lookups are inherently scoped to the thread.
 *
 * Gated by `memory.read:thread` (read ops) and `memory.write:thread` (write ops).
 */

import type pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import type { MemoryRepository } from '../../core/database/repositories/memory-repository.js';
import { ToolError } from '../../core/errors/error-types.js';
import type { ToolExecutionContext } from './channel-send.js';

/** Manifest for the memory.access host tool. */
export interface MemoryAccessTool {
  readonly manifest: ToolManifest;
}

/** Arguments accepted by the memory.access tool. */
export interface MemoryAccessArgs {
  /** Operation to perform. */
  operation: 'read' | 'write' | 'delete' | 'list';
  /** Memory key to read, write, or delete. */
  key?: string;
  /** Value to store (required for write). */
  value?: unknown;
  /** Optional namespace/layer to scope the operation. */
  namespace?: string;
}

/** Valid operations for the memory.access tool. */
const VALID_OPERATIONS = new Set(['read', 'write', 'delete', 'list']);

/**
 * Handler class for the memory.access host tool.
 *
 * Dispatches to MemoryRepository for the underlying SQLite operations.
 * All memory items are scoped to the thread in the execution context
 * via the compound primary key (thread_id, id).
 *
 * Note: The memory.access tool uses a simplified key/value model on top
 * of the MemoryItemRow schema. The `key` maps to the row `id`, and the
 * `namespace` maps to the `type` field (defaulting to 'note').
 */
export class MemoryAccessHandler {
  /** Static manifest describing the tool. */
  static readonly manifest: ToolManifest = {
    name: 'memory.access',
    description:
      'Reads from or writes to the per-thread layered memory store. Read operations require memory.read:thread; write/delete require memory.write:thread.',
    capabilities: ['memory.read:thread', 'memory.write:thread'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      memoryRepository: MemoryRepository;
      logger: pino.Logger;
    },
  ) {}

  /**
   * Execute the memory.access tool.
   *
   * @param args    - Validated tool arguments.
   * @param context - Execution context (runId, threadId, personaId).
   * @returns ToolCallResult with status 'success' or 'error'.
   */
  execute(args: MemoryAccessArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    return Promise.resolve(this.executeSync(args, context));
  }

  /** Synchronous dispatch — wrapped by execute() to satisfy the async tool interface. */
  private executeSync(args: MemoryAccessArgs, context: ToolExecutionContext): ToolCallResult {
    const requestId = context.requestId ?? 'unknown';
    const { operation, key, namespace } = args;

    // A schedule run on a dedicated schedule thread works on the memory of the
    // conversation it serves (server-resolved, same persona only); every other
    // run works on its own thread. All handlers below read `threadId`.
    const memoryContext: ToolExecutionContext =
      context.originThreadId !== undefined
        ? { ...context, threadId: context.originThreadId }
        : context;

    this.deps.logger.info(
      {
        requestId,
        runId: context.runId,
        threadId: memoryContext.threadId,
        ...(context.originThreadId !== undefined ? { runThreadId: context.threadId } : {}),
        operation,
        key,
        namespace,
      },
      'memory.access: executing',
    );

    // Validate operation
    if (!operation || !VALID_OPERATIONS.has(operation)) {
      const error = new ToolError(
        `memory.access: invalid operation "${operation}". Must be one of: read, write, delete, list`,
      );
      this.deps.logger.warn({ requestId, operation }, error.message);
      return { requestId, tool: 'memory.access', status: 'error', error: error.message };
    }

    switch (operation) {
      case 'read':
        return this.handleRead(args, memoryContext, requestId);
      case 'write':
        return this.handleWrite(args, memoryContext, requestId);
      case 'delete':
        return this.handleDelete(args, memoryContext, requestId);
      case 'list':
        return this.handleList(args, memoryContext, requestId);
      default: {
        // TypeScript exhaustiveness — should never reach here
        const error = new ToolError(`memory.access: unknown operation "${operation as string}"`);
        return { requestId, tool: 'memory.access', status: 'error', error: error.message };
      }
    }
  }

  /** Handle the 'read' operation — look up a memory item by (threadId, key). */
  private handleRead(
    args: MemoryAccessArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): ToolCallResult {
    const { key } = args;

    if (!key || typeof key !== 'string' || key.trim() === '') {
      const error = new ToolError('memory.access: key is required for read operation');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'memory.access', status: 'error', error: error.message };
    }

    const result = this.deps.memoryRepository.findById(context.threadId, key);
    if (result.isErr()) {
      const msg = `memory.access: read failed — ${result.error.message}`;
      this.deps.logger.error({ requestId, key, err: result.error }, msg);
      return { requestId, tool: 'memory.access', status: 'error', error: msg };
    }

    const item = result.value;

    this.deps.logger.debug({ requestId, key, found: item !== null }, 'memory.access: read complete');

    return {
      requestId,
      tool: 'memory.access',
      status: 'success',
      result: item ? { key: item.id, value: item.content, namespace: item.type, metadata: item.metadata } : null,
    };
  }

  /** Handle the 'write' operation — upsert a memory item scoped to thread. */
  private handleWrite(
    args: MemoryAccessArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): ToolCallResult {
    const { key, value, namespace } = args;

    if (value === undefined || value === null) {
      const error = new ToolError('memory.access: value is required for write operation');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'memory.access', status: 'error', error: error.message };
    }

    const itemKey = key ?? uuidv4();
    const contentStr = typeof value === 'string' ? value : JSON.stringify(value);
    const memType = resolveMemoryType(namespace);

    // Check if item already exists in this thread (to decide insert vs. update)
    const existing = this.deps.memoryRepository.findById(context.threadId, itemKey);
    if (existing.isErr()) {
      const msg = `memory.access: write pre-check failed — ${existing.error.message}`;
      this.deps.logger.error({ requestId, key: itemKey, err: existing.error }, msg);
      return { requestId, tool: 'memory.access', status: 'error', error: msg };
    }

    if (existing.value) {
      // Update existing item in this thread
      const updateResult = this.deps.memoryRepository.update(context.threadId, itemKey, { content: contentStr });
      if (updateResult.isErr()) {
        const msg = `memory.access: write (update) failed — ${updateResult.error.message}`;
        this.deps.logger.error({ requestId, key: itemKey, err: updateResult.error }, msg);
        return { requestId, tool: 'memory.access', status: 'error', error: msg };
      }
    } else {
      // Insert new item scoped to this thread
      const insertResult = this.deps.memoryRepository.insert({
        id: itemKey,
        thread_id: context.threadId,
        type: memType,
        content: contentStr,
        embedding_ref: null,
        metadata: '{}',
      });
      if (insertResult.isErr()) {
        const msg = `memory.access: write (insert) failed — ${insertResult.error.message}`;
        this.deps.logger.error({ requestId, key: itemKey, err: insertResult.error }, msg);
        return { requestId, tool: 'memory.access', status: 'error', error: msg };
      }
    }

    this.deps.logger.debug({ requestId, key: itemKey }, 'memory.access: write complete');

    return {
      requestId,
      tool: 'memory.access',
      status: 'success',
      result: { key: itemKey, written: true },
    };
  }

  /** Handle the 'delete' operation — remove a memory item by (threadId, key). */
  private handleDelete(
    args: MemoryAccessArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): ToolCallResult {
    const { key } = args;

    if (!key || typeof key !== 'string' || key.trim() === '') {
      const error = new ToolError('memory.access: key is required for delete operation');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'memory.access', status: 'error', error: error.message };
    }

    const deleteResult = this.deps.memoryRepository.delete(context.threadId, key);
    if (deleteResult.isErr()) {
      const msg = `memory.access: delete failed — ${deleteResult.error.message}`;
      this.deps.logger.error({ requestId, key, err: deleteResult.error }, msg);
      return { requestId, tool: 'memory.access', status: 'error', error: msg };
    }

    this.deps.logger.debug({ requestId, key }, 'memory.access: delete complete');

    return {
      requestId,
      tool: 'memory.access',
      status: 'success',
      result: { key, deleted: true },
    };
  }

  /** Handle the 'list' operation — return all items for the thread, optionally filtered by namespace. */
  private handleList(
    args: MemoryAccessArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): ToolCallResult {
    const { namespace } = args;
    const memType = namespace ? resolveMemoryType(namespace) : undefined;

    const result = this.deps.memoryRepository.findByThread(context.threadId, memType);
    if (result.isErr()) {
      const msg = `memory.access: list failed — ${result.error.message}`;
      this.deps.logger.error({ requestId, threadId: context.threadId, err: result.error }, msg);
      return { requestId, tool: 'memory.access', status: 'error', error: msg };
    }

    const items = result.value.map((row) => ({
      key: row.id,
      value: row.content,
      namespace: row.type,
      metadata: row.metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    this.deps.logger.debug(
      { requestId, threadId: context.threadId, count: items.length },
      'memory.access: list complete',
    );

    return {
      requestId,
      tool: 'memory.access',
      status: 'success',
      result: { items, count: items.length },
    };
  }
}

/**
 * Resolve a namespace string to a valid MemoryType.
 *
 * Falls back to 'note' for unknown/unrecognised namespaces.
 *
 * @param namespace - Caller-provided namespace string.
 */
function resolveMemoryType(
  namespace: string | undefined,
): 'fact' | 'summary' | 'note' | 'embedding_ref' {
  switch (namespace) {
    case 'fact':
      return 'fact';
    case 'summary':
      return 'summary';
    case 'embedding_ref':
      return 'embedding_ref';
    default:
      return 'note';
  }
}
