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

// Shared execution context type used by all handlers
export type { ToolExecutionContext } from './channel-send.js';
