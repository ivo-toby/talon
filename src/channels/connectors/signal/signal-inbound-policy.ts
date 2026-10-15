import { createHash } from 'node:crypto';
import { ChannelError } from '../../../core/errors/error-types.js';
import { err, ok, type Result } from '../../../core/types/result.js';
import type { SignalConfig } from './signal-config.js';
import {
  formatSignalExternalId,
  normalizeSignalGroupId,
  normalizeSignalUuid,
  type SignalDestination,
} from './signal-identities.js';
import type { SignalAccountProofRegistry, SignalInboundEvent } from './signal-types.js';

export type SignalIgnoreReason =
  | 'INVALID_EVENT'
  | 'RECEIVE_EXCEPTION'
  | 'CONTROL'
  | 'EPHEMERAL'
  | 'EMPTY_TEXT'
  | 'STALE_SUBSCRIPTION'
  | 'UNSELECTED'
  | 'UNAUTHORIZED'
  | 'BOT_OUTPUT'
  | 'UNKNOWN_DEVICE'
  | 'UNVERIFIED_DEVICE'
  | 'DEVICE_REPLAY'
  | 'UNKNOWN_ALIAS';

export class SignalInboundError extends ChannelError {
  constructor(readonly reason: SignalIgnoreReason) {
    super(`Signal input excluded: ${reason}`);
  }
}

export interface SignalInboundContext {
  readonly config: SignalConfig;
  readonly channelName: string;
  readonly generation: number;
  /** Socket epoch, separate from the generation-wide provenance registry. */
  readonly connectionGeneration: number;
  readonly subscription: number;
  readonly aliases: readonly string[];
  readonly registry: SignalAccountProofRegistry;
  readonly now: number;
}

export interface SignalTextCandidate {
  readonly accountAlias: string;
  readonly authorUuid: string;
  readonly sourceDevice: number | null;
  readonly dataTimestamp: number;
  readonly receivedAt: number;
  readonly destination: SignalDestination;
  readonly text: string;
}

export type SignalAdmission = Readonly<{
  kind: 'admit' | 'alias' | 'proof';
  candidate: SignalTextCandidate;
  event: SignalInboundEvent;
}>;

function excluded(reason: SignalIgnoreReason): Result<never, SignalInboundError> {
  return err(new SignalInboundError(reason));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

const envelopeControls = [
  'editMessage',
  'storyMessage',
  'callMessage',
  'receiptMessage',
  'typingMessage',
];
const dataControls = [
  'groupCallUpdate',
  'reaction',
  'remoteDelete',
  'sticker',
  'storyContext',
  'pollCreate',
  'pollVote',
  'pollTerminate',
  'pinMessage',
  'unpinMessage',
  'adminDelete',
  'editMessage',
];

/** Input is manual subscription params, not automatic receive or HTTP/SSE output.
 * Pinned JsonReceiveMessageHandler.java:23-35; JsonMessageEnvelope.java:15-31;
 * JsonSyncDataMessage.java:14-30 uses @JsonUnwrapped. Never retain the envelope. */
export function normalizeSignalReceive(
  params: unknown,
  connectionGeneration: number,
  context: SignalInboundContext,
): Result<SignalTextCandidate, SignalInboundError> {
  if (
    connectionGeneration !== context.connectionGeneration ||
    !record(params) ||
    params.subscription !== context.subscription
  )
    return excluded('STALE_SUBSCRIPTION');
  const result = params.result;
  if (!record(result)) return excluded('INVALID_EVENT');
  if (present(result.exception)) return excluded('RECEIVE_EXCEPTION');
  if (typeof result.account !== 'string' || result.account.length === 0)
    return excluded('INVALID_EVENT');
  const envelope = result.envelope;
  if (!record(envelope)) return excluded('INVALID_EVENT');
  if (envelopeControls.some((key) => present(envelope[key]))) return excluded('CONTROL');
  const author = normalizeSignalUuid(envelope.sourceUuid);
  if (author.isErr()) return excluded('UNAUTHORIZED');
  const wireDevice = envelope.sourceDevice;
  const device =
    typeof wireDevice === 'number' && Number.isSafeInteger(wireDevice) && wireDevice > 0
      ? wireDevice
      : null;
  const sync = envelope.syncMessage;
  let data: Record<string, unknown>;
  let destinationUuid: unknown = author.value;
  if (present(sync)) {
    if (!record(sync) || present(envelope.dataMessage) || !record(sync.sentMessage))
      return excluded('CONTROL');
    if (author.value !== context.config.accountUuid) return excluded('UNAUTHORIZED');
    data = sync.sentMessage;
    destinationUuid = data.destinationUuid;
    if (Object.entries(sync).some(([key, value]) => key !== 'sentMessage' && present(value)))
      return excluded('CONTROL');
  } else {
    if (!record(envelope.dataMessage)) return excluded('CONTROL');
    data = envelope.dataMessage;
  }
  if (dataControls.some((key) => present(data[key]))) return excluded('CONTROL');
  for (const key of ['isExpirationUpdate', 'isEndSession', 'isProfileKeyUpdate']) {
    if (present(data[key]) && data[key] !== false) return excluded('CONTROL');
  }
  if (data.expiresInSeconds !== 0 || (present(data.viewOnce) && data.viewOnce !== false))
    return excluded('EPHEMERAL');
  if (typeof data.message !== 'string' || data.message.trim().length === 0)
    return excluded('EMPTY_TEXT');
  if (
    typeof data.timestamp !== 'number' ||
    !Number.isSafeInteger(data.timestamp) ||
    data.timestamp <= 0
  )
    return excluded('INVALID_EVENT');
  let destination: SignalDestination;
  if (present(data.groupInfo)) {
    const group = data.groupInfo;
    if (!record(group) || group.type !== 'DELIVER') return excluded('CONTROL');
    const id = normalizeSignalGroupId(group.groupId);
    if (id.isErr()) return excluded('INVALID_EVENT');
    destination = { kind: 'group', accountUuid: context.config.accountUuid, groupId: id.value };
  } else {
    const peer = normalizeSignalUuid(destinationUuid);
    if (peer.isErr()) return excluded('INVALID_EVENT');
    destination =
      peer.value === context.config.accountUuid
        ? { kind: 'self', accountUuid: context.config.accountUuid }
        : { kind: 'dm', accountUuid: context.config.accountUuid, peerUuid: peer.value };
  }
  const aliasUuid = normalizeSignalUuid(result.account);
  return ok(
    Object.freeze({
      accountAlias: aliasUuid.isOk() ? aliasUuid.value : result.account,
      authorUuid: author.value,
      sourceDevice: device,
      dataTimestamp: data.timestamp,
      receivedAt: context.now,
      destination: Object.freeze(destination),
      text: data.message,
    }),
  );
}

/** Re-run this policy before every quarantine release and receipt attempt. */
export function evaluateSignalCandidate(
  candidate: SignalTextCandidate,
  context: SignalInboundContext,
): Result<SignalAdmission, SignalInboundError> {
  const { config } = context;
  if (candidate.destination.accountUuid !== config.accountUuid) return excluded('UNAUTHORIZED');
  const own = candidate.authorUuid === config.accountUuid;
  const destination = candidate.destination;
  if (destination.kind === 'self' && (!own || config.accountMode !== 'personal'))
    return excluded('BOT_OUTPUT');
  if (destination.kind === 'dm' && !config.allowedDmPeers.includes(destination.peerUuid))
    return excluded('UNSELECTED');
  if (destination.kind === 'group' && !config.allowedGroups.includes(destination.groupId))
    return excluded('UNSELECTED');
  if (!own && !config.allowedSenders.includes(candidate.authorUuid))
    return excluded('UNAUTHORIZED');
  let text = candidate.text;
  if (destination.kind !== 'self') {
    const start = text.trimStart();
    if (!start.startsWith(config.triggerPrefix)) return excluded('EMPTY_TEXT');
    const tail = start.slice(config.triggerPrefix.length);
    if (tail.length > 0 && !/^\s/u.test(tail)) return excluded('EMPTY_TEXT');
    text = tail.trimStart();
  }
  if (text.trim().length === 0) return excluded('EMPTY_TEXT');
  const local = context.registry.find((entry) => entry.accountUuid === candidate.authorUuid);
  if (candidate.sourceDevice === null) return excluded('UNKNOWN_DEVICE');
  if ((own && config.accountMode === 'dedicated') || local?.accountMode === 'dedicated')
    return excluded('BOT_OUTPUT');
  let staleProof = false;
  if (own || local) {
    if (!local || local.status !== 'verified' || local.generation !== context.generation)
      return excluded('UNVERIFIED_DEVICE');
    if (candidate.sourceDevice === local.bridgeDeviceId) return excluded('BOT_OUTPUT');
    const human = local.humanDevices.find((device) => device.deviceId === candidate.sourceDevice);
    if (!human) return excluded('UNKNOWN_DEVICE');
    if (candidate.dataTimestamp < human.createdTimestamp) return excluded('DEVICE_REPLAY');
    staleProof = context.now >= local.expiresAt;
  }
  const external = formatSignalExternalId(destination);
  if (external.isErr()) return excluded('INVALID_EVENT');
  const identity = JSON.stringify([
    'signal',
    1,
    config.accountUuid,
    external.value,
    candidate.authorUuid,
    candidate.sourceDevice,
    candidate.dataTimestamp,
  ]);
  const event: SignalInboundEvent = Object.freeze({
    channelType: 'signal',
    channelName: context.channelName,
    externalThreadId: external.value,
    senderId: candidate.authorUuid,
    content: text,
    idempotencyKey: `signal:v1:${createHash('sha256').update(identity).digest('hex')}`,
    timestamp: candidate.receivedAt,
  });
  const knownAlias = context.aliases.some((alias) => {
    const uuid = normalizeSignalUuid(alias);
    return (uuid.isOk() ? uuid.value : alias) === candidate.accountAlias;
  });
  return ok(
    Object.freeze({
      kind: !knownAlias ? 'alias' : staleProof ? 'proof' : 'admit',
      candidate,
      event,
    }),
  );
}
