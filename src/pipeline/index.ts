/**
 * Message ingestion pipeline.
 *
 * Provides the end-to-end pipeline from inbound channel events through
 * normalization, deduplication, persona routing, and queue submission.
 */

export type {
  InboundCommandHandler,
  InboundReplySender,
  NormalizedMessage,
  PipelineResult,
  PipelineStats,
} from './pipeline-types.js';
export { MessageNormalizer } from './message-normalizer.js';
export { MessagePipeline } from './message-pipeline.js';
