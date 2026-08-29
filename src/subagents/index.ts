/**
 * Sub-agent system barrel export.
 *
 * Re-exports the public API surface for the sub-agent subsystem so that
 * consumers can import from `@talon/subagents` (or `../subagents/index.js`)
 * without reaching into individual files.
 */

export { SubAgentLoader } from './subagent-loader.js';
export { SubAgentRunner, type SubAgentInvokeContext } from './subagent-runner.js';
export { ModelResolver } from './model-resolver.js';
export { SubAgentManifestSchema } from './subagent-schema.js';
export type {
  SubAgentManifest,
  SubAgentContext,
  SubAgentInput,
  SubAgentResult,
  SubAgentRunFn,
  LifecycleSubAgentRunFn,
  SubAgentServices,
  LoadedSubAgent,
} from './subagent-types.js';
