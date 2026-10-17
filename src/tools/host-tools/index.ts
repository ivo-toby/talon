/**
 * Host-side tool implementations.
 *
 * These tools run on the host (outside the sandbox) and have controlled
 * access to host resources. Each tool is gated by the persona capability
 * policy and emits an audit log entry for every invocation.
 */

export type { ChannelSendTool, ChannelSendArgs } from './channel-send.js';
export { ChannelSendHandler } from './channel-send.js';

export type { PersonaSendTool, PersonaSendArgs } from './persona-send.js';
export { PersonaSendHandler } from './persona-send.js';

export type { PersonaTaskStatusTool, PersonaTaskStatusArgs } from './persona-task-status.js';
export { PersonaTaskStatusHandler } from './persona-task-status.js';

export type { PersonaListTool, PersonaListArgs, PersonaCard } from './persona-list.js';
export { PersonaListHandler } from './persona-list.js';

export type { ScheduleManageTool, ScheduleManageArgs } from './schedule-manage.js';
export { ScheduleManageHandler } from './schedule-manage.js';

export type { MemoryAccessTool, MemoryAccessArgs } from './memory-access.js';
export { MemoryAccessHandler } from './memory-access.js';

export type { HttpProxyTool, HttpProxyArgs } from './http-proxy.js';
export { HttpProxyHandler } from './http-proxy.js';

export type { DbQueryTool, DbQueryArgs } from './db-query.js';
export { DbQueryHandler } from './db-query.js';

export type { ExecutionEnvArgs } from './execution-env.js';
export { ExecutionEnvHandler } from './execution-env.js';

export type {
  ImageLookupArgs,
  ImageLookupAccess,
  ImageLookupFindings,
  ImageLookupHandlerDeps,
  ImageLookupOperation,
  ImageLookupResult,
} from './image-lookup.js';
export {
  ImageLookupHandler,
  IMAGE_LOOKUP_TOOL_NAME,
  IMAGE_LOOKUP_CAPABILITY,
  IMAGE_LOOKUP_OPERATIONS,
  IMAGE_LOOKUP_DEFAULT_LIMIT,
  IMAGE_LOOKUP_MIN_LIMIT,
  IMAGE_LOOKUP_MAX_LIMIT,
} from './image-lookup.js';

// Shared execution context type used by all handlers
export type { ToolExecutionContext } from './channel-send.js';
