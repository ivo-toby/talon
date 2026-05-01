/**
 * Tool types and host-tool implementations.
 *
 * Host tools are fully implemented but not yet wired as MCP servers (Step 7).
 */

export type {
  ExecutionLocation,
  ToolManifest,
  PolicyDecision,
  ToolCallRequest,
  ToolCallResult,
} from './tool-types.js';

export type {
  ChannelSendTool,
  ChannelSendArgs,
  ScheduleManageTool,
  ScheduleManageArgs,
  MemoryAccessTool,
  MemoryAccessArgs,
  HttpProxyTool,
  HttpProxyArgs,
  ExaSearchTool,
  ExaSearchArgs,
  ExaSearchType,
  ExaCategory,
  ExaSearchResultEntry,
  ExaSearchResultPayload,
  DbQueryTool,
  DbQueryArgs,
  ToolExecutionContext,
} from './host-tools/index.js';

export {
  ChannelSendHandler,
  ScheduleManageHandler,
  MemoryAccessHandler,
  HttpProxyHandler,
  ExaSearchHandler,
  DbQueryHandler,
} from './host-tools/index.js';
