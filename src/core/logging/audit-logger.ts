/**
 * Dual-write audit logger.
 *
 * Every side-effecting operation in the daemon (tool execution, approval
 * decisions, channel sends, schedule triggers, config reloads) is recorded
 * here. The AuditLogger writes structured entries to pino and, when an
 * AuditStore is provided, to a durable store (e.g. SQLite append-only table).
 *
 * The AuditStore interface is intentionally minimal so it can be backed by
 * better-sqlite3 (TASK-005), an in-memory list (tests), or any other
 * synchronous store without changing the logger's API.
 */

import type pino from 'pino';
import { types } from 'node:util';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single audit log entry.
 *
 * `action` is the only required field beyond `details`; all correlation
 * identifiers are optional because some audit events occur before a full
 * request context is established (e.g. config reload at startup).
 */
export interface AuditEntry {
  /** Durable run identifier. */
  runId?: string;
  /** Per-thread conversation identifier. */
  threadId?: string;
  /** Persona that initiated the action. */
  personaId?: string;
  /**
   * Machine-readable action label. Use dot-separated namespacing,
   * e.g. `tool.execution`, `approval.granted`, `channel.send`.
   */
  action: string;
  /** Tool name, when the event relates to a specific tool call. */
  tool?: string;
  /** Outbound API request ID for correlation with provider logs. */
  requestId?: string;
  /** Structured payload specific to the action type. */
  details: Record<string, unknown>;
}

/**
 * Persistence interface for audit entries.
 *
 * Implementations must be synchronous so that audit writes happen
 * atomically with the pino log write and do not require error-recovery
 * logic in the logger itself. The concrete implementation (SQLite) will
 * be injected in TASK-005.
 */
export interface AuditStore {
  /**
   * Persist a single audit entry to the durable store.
   *
   * Implementations should be idempotent where possible (e.g. by using an
   * auto-incrementing primary key rather than a caller-supplied ID).
   */
  append(entry: AuditEntry): void;
}

const MAX_LIFECYCLE_AUDIT_DEPTH = 5;
const MAX_LIFECYCLE_AUDIT_KEYS = 32;
const MAX_LIFECYCLE_AUDIT_ITEMS = 32;
const MAX_LIFECYCLE_AUDIT_STRING = 512;
const SECRET_DETAIL_KEY_PATTERN =
  /(^|[_\-.])(api[_\-.]?key|authorization|bearer|credential|password|secret|token)([_\-.]|$)/i;

function redactLifecycleAuditValue(value: unknown, depth = 0): unknown {
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === undefined
  ) {
    return value;
  }
  if (typeof value === 'string') {
    return value.length > MAX_LIFECYCLE_AUDIT_STRING
      ? `${value.slice(0, MAX_LIFECYCLE_AUDIT_STRING)}...`
      : value;
  }
  if (depth >= MAX_LIFECYCLE_AUDIT_DEPTH) {
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_LIFECYCLE_AUDIT_ITEMS)
      .map((item) => redactLifecycleAuditValue(item, depth + 1));
  }
  if (typeof value !== 'object' || types.isProxy(value)) {
    return '[redacted]';
  }

  const result: Record<string, unknown> = {};
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors).slice(0, MAX_LIFECYCLE_AUDIT_KEYS)) {
    if (SECRET_DETAIL_KEY_PATTERN.test(key)) {
      result[key] = '[redacted]';
      continue;
    }
    const descriptor = descriptors[key];
    result[key] =
      descriptor && 'value' in descriptor
        ? redactLifecycleAuditValue(descriptor.value, depth + 1)
        : '[redacted]';
  }
  return result;
}

function redactLifecycleAuditEntry(entry: AuditEntry): AuditEntry {
  return {
    ...entry,
    details: redactLifecycleAuditValue(entry.details) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// AuditLogger
// ---------------------------------------------------------------------------

/**
 * Records audit events to pino and (optionally) a durable AuditStore.
 *
 * Construct one instance per daemon process and share it via dependency
 * injection. The optional `store` parameter lets callers defer the DB
 * connection until the data layer is available, while still preserving
 * every event in the structured log.
 *
 * @example
 * ```ts
 * const audit = new AuditLogger(logger);
 * audit.logToolExecution({ action: 'tool.execution', tool: 'web_search', details: { query: '...' } });
 * ```
 */
export class AuditLogger {
  /**
   * @param logger - A pino logger (typically a child with `component: 'audit'`).
   * @param store  - Optional durable store; when absent events are pino-only.
   */
  constructor(
    private readonly logger: pino.Logger,
    private readonly store?: AuditStore,
  ) {}

  // ---------------------------------------------------------------------------
  // Public audit methods
  // ---------------------------------------------------------------------------

  /**
   * Record a tool invocation.
   *
   * Call this immediately before — or immediately after — executing a tool
   * call inside a sandbox so the audit trail is ordered with the surrounding
   * log lines.
   */
  logToolExecution(entry: AuditEntry): void {
    this.write('tool.execution', entry);
  }

  /**
   * Record an approval decision (granted or denied) for a pending action.
   *
   * Include the decision outcome in `entry.details`, e.g.
   * `{ decision: 'granted', approver: 'auto-policy' }`.
   */
  logApprovalDecision(entry: AuditEntry): void {
    this.write('approval.decision', entry);
  }

  /**
   * Record a message dispatched to an outbound channel (e.g. Discord, Slack).
   *
   * Include the channel type and message preview in `entry.details`.
   */
  logChannelSend(entry: AuditEntry): void {
    this.write('channel.send', entry);
  }

  /**
   * Record a scheduled task being triggered by the cron runner.
   *
   * Include the schedule expression and next-run timestamp in `entry.details`.
   */
  logScheduleTrigger(entry: AuditEntry): void {
    this.write('schedule.trigger', entry);
  }

  /**
   * Record a configuration file reload.
   *
   * Include the config file path and a diff summary in `entry.details` where
   * possible, omitting secrets.
   */
  logConfigReload(entry: AuditEntry): void {
    this.write('config.reload', entry);
  }

  /**
   * Record a bounded lifecycle interceptor decision. Callers must provide
   * metadata only: never include intercepted content, tool arguments, model
   * prompts, or raw handler errors in this durable audit record.
   */
  logLifecycleInterceptor(entry: AuditEntry): void {
    this.write('lifecycle.interceptor', redactLifecycleAuditEntry(entry));
  }

  /** Record bounded lifecycle runtime decisions across publish, dispatch, and interceptor paths. */
  logLifecycleDecision(entry: AuditEntry): void {
    this.write('lifecycle.decision', redactLifecycleAuditEntry(entry));
  }

  /** Record an operator- or runtime-initiated lifecycle replay request. */
  logLifecycleReplay(entry: AuditEntry): void {
    this.write('lifecycle.replay', redactLifecycleAuditEntry(entry));
  }

  /** Record lifecycle disablement, including circuit-open state. */
  logLifecycleDisablement(entry: AuditEntry): void {
    this.write('lifecycle.disablement', redactLifecycleAuditEntry(entry));
  }

  /** Record bounded lifecycle projection side effects. */
  logLifecycleProjection(entry: AuditEntry): void {
    this.write('lifecycle.projection', redactLifecycleAuditEntry(entry));
  }

  /** Record governed lifecycle promotion decisions. */
  logLifecyclePromotion(entry: AuditEntry): void {
    this.write('lifecycle.promotion', redactLifecycleAuditEntry(entry));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Write the audit entry to pino at `info` level and to the optional store.
   *
   * The `auditAction` parameter is the canonical event label used as the
   * `msg` field so log aggregators can filter by event type with a plain
   * text query. The full entry is spread into the log record so all
   * correlation fields appear as top-level JSON keys.
   *
   * @param auditAction - The canonical log message / event label.
   * @param entry       - The full audit entry to record.
   */
  private write(auditAction: string, entry: AuditEntry): void {
    // Build a flat object for pino so correlation fields are top-level.
    const logObject: Record<string, unknown> = {
      audit: true,
    };

    if (entry.runId !== undefined) logObject.runId = entry.runId;
    if (entry.threadId !== undefined) logObject.threadId = entry.threadId;
    if (entry.personaId !== undefined) logObject.personaId = entry.personaId;
    if (entry.tool !== undefined) logObject.tool = entry.tool;
    if (entry.requestId !== undefined) logObject.requestId = entry.requestId;
    logObject.details = entry.details;

    this.logger.info(logObject, auditAction);

    this.store?.append(entry);
  }
}
