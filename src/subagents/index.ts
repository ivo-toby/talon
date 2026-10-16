/**
 * Sub-agent system barrel export.
 *
 * Re-exports the public API surface for the sub-agent subsystem so that
 * consumers can import from `@talon/subagents` (or `../subagents/index.js`)
 * without reaching into individual files.
 */

export { SubAgentLoader } from './subagent-loader.js';
export { SubAgentRunner, type SubAgentInvokeContext } from './subagent-runner.js';
export {
  ModelResolver,
  isInferenceProvider,
  isSubscriptionCliProvider,
  isSandboxedSubscriptionProvider,
  INFERENCE_PROVIDERS,
  SUBSCRIPTION_CLI_PROVIDERS,
  SANDBOXED_SUBSCRIPTION_PROVIDERS,
} from './model-resolver.js';
export {
  buildSubAgentModelChain,
  runSubAgentModelChain,
  validateVisionModelChain,
  VISION_SUBAGENT_NAME,
  type SubAgentModelChainEntry,
  type SubAgentModelChainSuccess,
} from './subagent-model-chain.js';
export { SubAgentManifestSchema } from './subagent-schema.js';
export type {
  SubAgentManifest,
  SubAgentContext,
  SubAgentInput,
  SubAgentResult,
  SubAgentRunFn,
  SubAgentServices,
  FindingPersistence,
  LoadedSubAgent,
} from './subagent-types.js';
// Image service port handed to `SubAgentServices` (TASK-001 read port; the
// TASK-011 Finding persistence port is `FindingPersistence` above).
// Re-exported so runtime wiring (TASK-014) can type the injected adapters
// without reaching into individual source files.
export type { ImageAccess, ImageAccessRequest } from '../images/image-types.js';
