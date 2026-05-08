/**
 * Process-wide registry of "this rejection is expected and non-fatal" matchers.
 *
 * Background: the daemon installs a global `unhandledRejection` handler that
 * exits the process. Some channel connectors (notably WhatsApp Baileys) wrap
 * third-party libraries that emit unhandled promise rejections from their own
 * internal async work — for example, when a WebSocket frame arrives on a
 * stream that has just been forcibly torn down. Letting one channel's flaky
 * dependency take down the entire daemon is too broad a blast radius.
 *
 * Connectors register a {@link RejectionMatcher} on `start()` and deregister
 * it on `stop()`. The {@link classifyRejection} helper used by
 * `signal-handler.ts` reports a rejection as non-fatal as soon as any
 * registered matcher claims it; otherwise the existing fatal-exit behavior
 * applies.
 *
 * The matcher set lives in module-scoped state and is shared across the
 * process. Tests must call {@link __resetMatchersForTesting} between cases to
 * keep state hermetic.
 */

export interface RejectionMatcher {
  /** Stable identifier used in log output to attribute swallowed rejections. */
  readonly name: string;
  /**
   * Returns true if this matcher recognises the rejection as a known,
   * connector-internal failure that should not crash the daemon.
   */
  matches(reason: unknown): boolean;
}

export interface RejectionClassification {
  /** True if no registered matcher claimed the rejection. */
  fatal: boolean;
  /** Name of the matcher that claimed the rejection, when fatal === false. */
  matchedBy?: string;
}

const matchers: RejectionMatcher[] = [];

/**
 * Adds a matcher to the registry. Returns a deregister function that is safe
 * to call multiple times.
 */
export function registerSafeRejectionMatcher(matcher: RejectionMatcher): () => void {
  matchers.push(matcher);
  let deregistered = false;
  return () => {
    if (deregistered) return;
    deregistered = true;
    const idx = matchers.indexOf(matcher);
    if (idx !== -1) matchers.splice(idx, 1);
  };
}

/**
 * Walks the matcher registry and reports the first matcher that claims the
 * rejection. A matcher that throws is treated as non-matching so a buggy
 * matcher cannot mask other matchers or crash the signal handler.
 */
export function classifyRejection(reason: unknown): RejectionClassification {
  for (const matcher of matchers) {
    let claimed = false;
    try {
      claimed = matcher.matches(reason);
    } catch {
      claimed = false;
    }
    if (claimed) {
      return { fatal: false, matchedBy: matcher.name };
    }
  }
  return { fatal: true };
}

/**
 * Test-only helper: drops every registered matcher so cases start from a
 * known-empty registry.
 */
export function __resetMatchersForTesting(): void {
  matchers.length = 0;
}
