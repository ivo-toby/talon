import type {
  AgentOutput,
  ChannelConnector,
  InboundEvent,
  TrustedDeliveryContext,
} from '../../channel-types.js';
import type { SignalDeliveryError } from '../../../core/errors/error-types.js';
import type { Result } from '../../../core/types/result.js';
import type { SignalDestination } from './signal-identities.js';
import type { SignalConfig } from './signal-config.js';

/** Normalized text/provenance only; never a raw signal-cli envelope. */
export interface SignalInboundEvent extends InboundEvent {
  readonly channelType: 'signal';
  readonly raw?: never;
  readonly attachments?: never;
}

export interface SignalPreparedText {
  readonly destination: SignalDestination;
  readonly chunks: readonly string[];
}

/** Acceptance by the bridge, not proof of recipient delivery or read status. */
export interface SignalChunkReceipt {
  readonly acceptance: 'complete';
  readonly successCount: number;
  readonly failureCount: 0;
}

export interface SignalPreparedDelivery {
  prepare(
    destination: string,
    output: AgentOutput,
  ): Result<SignalPreparedText, SignalDeliveryError>;
  sendPreparedChunk(
    destination: string,
    chunk: string,
    trustedContext: TrustedDeliveryContext,
  ): Promise<Result<SignalChunkReceipt, SignalDeliveryError>>;
}

export interface SignalChannelConnector extends ChannelConnector, SignalPreparedDelivery {
  readonly type: 'signal';
}

/** Local proof, not RPC JSON. listDevices has no current-device marker. */
export interface SignalDeviceProof {
  readonly deviceId: number;
  readonly createdTimestamp: number;
}

export type SignalAccountProofSnapshot = Readonly<
  {
    accountUuid: string;
    accountMode: SignalConfig['accountMode'];
    bridgeDeviceId: number;
    generation: number;
  } & (
    | { status: 'unverified' }
    | {
        status: 'verified';
        verifiedAt: number;
        expiresAt: number;
        humanDevices: readonly SignalDeviceProof[];
      }
  )
>;

export type SignalAccountProofRegistry = readonly SignalAccountProofSnapshot[];
