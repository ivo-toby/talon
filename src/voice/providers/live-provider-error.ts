import { TalonError } from '../../core/errors/error-types.js';

/**
 * Expected failures at the GPT-Live boundary.
 *
 * Provider responses are deliberately reduced to a stable reason and status;
 * response bodies may contain prompts, credentials, or other sensitive data.
 */
export type LiveProviderErrorReason =
  | 'configuration'
  | 'invalid_request'
  | 'unsupported_transport'
  | 'network'
  | 'timeout'
  | 'http'
  | 'invalid_response'
  | 'not_connected'
  | 'session_expired'
  | 'transport_closed'
  | 'invalid_provider_event'
  | 'unknown_acknowledgement'
  | 'non_monotonic_usage'
  | 'finalization_incomplete'
  | 'closed';

export class LiveProviderError extends TalonError {
  readonly code = 'VOICE_PROVIDER_ERROR' as const;

  constructor(
    readonly reason: LiveProviderErrorReason,
    message: string,
    readonly status?: number,
    cause?: Error,
  ) {
    super(message, cause);
  }
}
