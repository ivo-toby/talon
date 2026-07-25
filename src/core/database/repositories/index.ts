/**
 * Data repositories.
 *
 * Repository pattern over raw SQLite — each repository handles one aggregate
 * (e.g., threads, messages, queue items) with typed read/write methods.
 * The interface is kept abstract to allow a future Postgres swap.
 */

export { BaseRepository } from './base-repository.js';

export type { ChannelRow, InsertChannelInput, UpdateChannelInput } from './channel-repository.js';
export { ChannelRepository } from './channel-repository.js';

export type { PersonaRow, InsertPersonaInput, UpdatePersonaInput } from './persona-repository.js';
export { PersonaRepository } from './persona-repository.js';

export type { BindingRow, InsertBindingInput } from './binding-repository.js';
export { BindingRepository } from './binding-repository.js';

export type { ThreadRow, InsertThreadInput, UpdateThreadInput } from './thread-repository.js';
export { ThreadRepository } from './thread-repository.js';

export type { MessageRow, InsertMessageInput, InsertMessageOutcome } from './message-repository.js';
export { MessageRepository } from './message-repository.js';

export type { QueueItemRow, QueueStatus, QueueType, EnqueueInput } from './queue-repository.js';
export { QueueRepository } from './queue-repository.js';

export type {
  RunRow,
  RunStatus,
  InsertRunInput,
  UpdateTokensInput,
  TokenAggregateRow,
} from './run-repository.js';
export { RunRepository } from './run-repository.js';

export type {
  ScheduleRow,
  ScheduleType,
  InsertScheduleInput,
  UpdateScheduleInput,
} from './schedule-repository.js';
export { ScheduleRepository } from './schedule-repository.js';

export type {
  MemoryItemRow,
  MemoryType,
  InsertMemoryItemInput,
  UpdateMemoryItemInput,
} from './memory-repository.js';
export { MemoryRepository } from './memory-repository.js';

export type { ArtifactRow, InsertArtifactInput } from './artifact-repository.js';
export { ArtifactRepository } from './artifact-repository.js';

export type { AuditLogRow, InsertAuditLogInput } from './audit-repository.js';
export { AuditRepository } from './audit-repository.js';

export type {
  ToolResultRow,
  ToolResultStatus,
  InsertToolResultInput,
} from './tool-result-repository.js';
export { ToolResultRepository } from './tool-result-repository.js';

export { BackgroundTaskRepository } from './background-task-repository.js';
export type { InsertA2ATaskInput } from './a2a-task-repository.js';
export { A2ATaskRepository } from './a2a-task-repository.js';
export { ExecutionEnvRepository } from './execution-env-repository.js';
export { ExecutionEnvCheckpointRepository } from './execution-env-checkpoint-repository.js';

export type {
  LifecycleEventRow,
  LifecycleEventFanoutResult,
} from './lifecycle-event-repository.js';
export { LifecycleEventRepository } from './lifecycle-event-repository.js';

export type {
  LifecycleDeliveryStatus,
  LifecycleDeliveryFanoutInput,
  LifecycleDeliveryRow,
  ClaimedLifecycleDelivery,
  ClaimLifecycleDeliveryOptions,
  LifecycleDeliveryClock,
  LifecycleFailureDiagnostic,
} from './lifecycle-delivery-repository.js';
export { LifecycleDeliveryRepository } from './lifecycle-delivery-repository.js';

export type {
  LifecycleSignalHandoffInput,
  LifecycleSignalRow,
} from './lifecycle-signal-repository.js';
export { LifecycleSignalRepository } from './lifecycle-signal-repository.js';

export type {
  BehaviorCandidateInput,
  BehaviorCandidateRow,
  BehaviorEvidenceInput,
  BehaviorEvidenceRow,
  BehaviorMetadata,
  BehaviorPromotionActivationInput,
  BehaviorPromotionInput,
  BehaviorPromotionRollbackInput,
  BehaviorPromotionRow,
} from './behavior-signal-repository.js';
export { BehaviorSignalRepository } from './behavior-signal-repository.js';
