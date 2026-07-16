import type { LifecycleInterceptorHandler } from './interceptor-engine.js';

/** A deterministic native baseline suitable for an explicitly registered allow policy. */
export const nativeAllowInterceptor: LifecycleInterceptorHandler = () => ({
  outcome: 'success',
  outputContract: 'talon.lifecycle.enforcing.interceptor.output.v1',
  result: { outcome: 'allow', signals: [] },
});

/**
 * Creates a deterministic native tool-name deny policy. This is deliberately
 * data-only and synchronous; it is an example of an enforcing handler that
 * does not delegate a security decision to a model.
 */
export function createNativeToolNameDenyInterceptor(
  deniedToolNames: readonly string[],
): LifecycleInterceptorHandler {
  const denied = new Set(deniedToolNames);
  return (input) => ({
    outcome: 'success',
    outputContract: 'talon.lifecycle.enforcing.interceptor.output.v1',
    result:
      input.hook === 'tool.before_execute' && denied.has(input.input.toolName)
        ? { outcome: 'deny', reason: 'tool_denied_by_native_policy', signals: [] }
        : { outcome: 'allow', signals: [] },
  });
}
