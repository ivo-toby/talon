import { z } from 'zod';
import { ChannelError } from '../../../core/errors/error-types.js';
import { err, ok, type Result } from '../../../core/types/result.js';
import { SIGNAL_MAX_CHUNK_BYTES, SignalUuidSchema } from './signal-config.js';
import { normalizeSignalGroupId, normalizeSignalUuid } from './signal-identities.js';

export const SIGNAL_RPC_MAX_BYTES = 1024 * 1024;
export const SIGNAL_RPC_MAX_PENDING = 64;

/** Opaque untrusted method data, never a policy/admission proof or diagnostic payload. */
export type SignalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly SignalJsonValue[]
  | { readonly [key: string]: SignalJsonValue };
export type SignalRpcId = string | number | null;

/** DispatcherHandler.java:158-171 allocates subscription IDs with Java AtomicInteger. */
export function isSignalSubscriptionId(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= -2147483648 &&
    value <= 2147483647
  );
}

const Account = z
  .string()
  .refine((value) => /^\+[1-9][0-9]{1,14}$/.test(value) || normalizeSignalUuid(value).isOk());
const Group = z.string().refine((value) => normalizeSignalGroupId(value).isOk());
const accountParams = z.object({ account: Account }).strict();
const message = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= SIGNAL_MAX_CHUNK_BYTES);
const recipients = z.array(SignalUuidSchema).min(1);

// Runtime subset only. Pinned v0.14.9 man/signal-cli-jsonrpc.5.adoc:83-99;
// SendCommand.java:47-67; ListContactsCommand.java:30-45; ListGroupsCommand.java:35-40.
// Reject extra send options so media/provisioning cannot enter via a typed escape hatch.
const RequestSchema = z.union([
  z.object({ method: z.enum(['version', 'listAccounts']) }).strict(),
  z.object({ method: z.enum(['listDevices', 'subscribeReceive']), params: accountParams }).strict(),
  z
    .object({
      method: z.literal('unsubscribeReceive'),
      params: accountParams
        .extend({ subscription: z.number().refine(isSignalSubscriptionId) })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal('listGroups'),
      params: accountParams.extend({ groupId: z.array(Group).optional() }).strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal('listContacts'),
      params: accountParams
        .extend({ recipient: recipients, allRecipients: z.literal(true) })
        .strict(),
    })
    .strict(),
  z
    .object({
      method: z.literal('send'),
      params: z.union([
        accountParams.extend({ message, recipient: recipients }).strict(),
        accountParams.extend({ message, groupId: Group }).strict(),
        accountParams.extend({ message, noteToSelf: z.literal(true) }).strict(),
      ]),
    })
    .strict(),
]);
export type SignalRpcRequest = z.infer<typeof RequestSchema>;

export class SignalWireError extends ChannelError {
  constructor() {
    super('Signal wire rejected: INVALID_FRAME');
  }
}

export type SignalRemoteCode =
  | 'PARSE_ERROR'
  | 'INVALID_REQUEST'
  | 'METHOD_NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'INTERNAL_ERROR'
  | 'USER_ERROR'
  | 'IO_ERROR'
  | 'UNTRUSTED_IDENTITY'
  | 'RATE_LIMIT'
  | 'CHALLENGE_REQUIRED'
  | 'UNKNOWN';

export type SignalRetryAfter = Readonly<
  { kind: 'absent' } | { kind: 'invalid' } | { kind: 'valid'; seconds: number }
>;
export type SignalSendResultType =
  | 'SUCCESS'
  | 'NETWORK_FAILURE'
  | 'UNREGISTERED_FAILURE'
  | 'IDENTITY_FAILURE'
  | 'RATE_LIMIT_FAILURE'
  | 'INVALID_PRE_KEY_FAILURE'
  | 'UNKNOWN';

/** No recipient identity or challenge value. This is evidence, not delivery policy. */
export interface SignalSendResultEvidence {
  readonly valid: boolean;
  readonly type: SignalSendResultType;
  readonly challengeRequired: boolean;
  readonly retryAfter: SignalRetryAfter;
}
export interface SignalSendEvidence {
  readonly complete: boolean;
  readonly timestampValid: boolean;
  readonly results: readonly SignalSendResultEvidence[];
}

export class SignalRpcRemoteError extends ChannelError {
  constructor(
    readonly remoteCode: SignalRemoteCode,
    readonly sendEvidence: SignalSendEvidence,
  ) {
    super(`Signal RPC rejected: ${remoteCode}`);
  }
}

export type SignalRpcFrame =
  | { readonly kind: 'result'; readonly id: SignalRpcId; readonly value: SignalJsonValue }
  | { readonly kind: 'failure'; readonly id: SignalRpcId; readonly error: SignalRpcRemoteError }
  | { readonly kind: 'notification'; readonly method: string; readonly params?: SignalJsonValue };

export interface SignalReceiveNotification {
  readonly subscription: number;
  readonly account: string;
  readonly envelope?: SignalJsonValue;
  readonly hasException: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonObject(
  value: SignalJsonValue | undefined,
): value is { readonly [key: string]: SignalJsonValue } {
  return isRecord(value);
}

/** Iterative so a bounded but deeply nested untrusted document cannot overflow the stack. */
function freezeJson(value: SignalJsonValue): SignalJsonValue {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (current !== null && typeof current === 'object') {
      for (const child of Object.values(current)) pending.push(child);
      Object.freeze(current);
    }
  }
  return value;
}

export function encodeSignalRpcRequest(
  request: SignalRpcRequest,
  id: string,
): Result<Buffer, SignalWireError> {
  const parsed = RequestSchema.safeParse(request);
  if (!parsed.success) return err(new SignalWireError());
  const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, ...parsed.data })}\n`, 'utf8');
  return bytes.length - 1 <= SIGNAL_RPC_MAX_BYTES ? ok(bytes) : err(new SignalWireError());
}

function remoteCode(code: number): SignalRemoteCode {
  // JsonRpcResponse.java:75-81; SignalJsonRpcCommandHandler.java:40-44.
  switch (code) {
    case -32700:
      return 'PARSE_ERROR';
    case -32600:
      return 'INVALID_REQUEST';
    case -32601:
      return 'METHOD_NOT_FOUND';
    case -32602:
      return 'INVALID_PARAMS';
    case -32603:
      return 'INTERNAL_ERROR';
    case -1:
      return 'USER_ERROR';
    case -3:
      return 'IO_ERROR';
    case -4:
      return 'UNTRUSTED_IDENTITY';
    case -5:
      return 'RATE_LIMIT';
    case -6:
      return 'CHALLENGE_REQUIRED';
    default:
      return 'UNKNOWN';
  }
}

function sendType(value: unknown): SignalSendResultType {
  switch (value) {
    case 'SUCCESS':
    case 'NETWORK_FAILURE':
    case 'UNREGISTERED_FAILURE':
    case 'IDENTITY_FAILURE':
    case 'RATE_LIMIT_FAILURE':
    case 'INVALID_PRE_KEY_FAILURE':
      return value;
    default:
      return 'UNKNOWN';
  }
}

function sendEntry(input: unknown): SignalSendResultEvidence {
  const record = isRecord(input) ? input : {};
  const address = record.recipientAddress;
  // JsonRecipientAddress.java:9-15: all three nullable fields are serialized.
  const addressValid =
    isRecord(address) &&
    (address.uuid === null || normalizeSignalUuid(address.uuid).isOk()) &&
    (address.number === null ||
      (typeof address.number === 'string' && /^\+[1-9][0-9]{1,14}$/.test(address.number))) &&
    (address.username === null || typeof address.username === 'string') &&
    [address.uuid, address.number, address.username].some(
      (value) => typeof value === 'string' && value.length > 0,
    );
  const type = sendType(record.type);
  const delay = record.retryAfterSeconds;
  const retryAfter: SignalRetryAfter = Object.freeze(
    delay === undefined
      ? { kind: 'absent' }
      : typeof delay === 'number' && Number.isSafeInteger(delay) && delay >= 0
        ? { kind: 'valid', seconds: delay }
        : { kind: 'invalid' },
  );
  const token = record.token;
  return Object.freeze({
    valid:
      addressValid &&
      type !== 'UNKNOWN' &&
      (record.groupId === undefined || normalizeSignalGroupId(record.groupId).isOk()) &&
      (token === undefined || typeof token === 'string') &&
      retryAfter.kind !== 'invalid',
    type,
    challengeRequired: token !== undefined && token !== null,
    retryAfter,
  });
}

/** SendMessageResultUtils.java:43-68, JsonSendMessageResult.java:10-48.
 * Retain malformed entries as unknown evidence, rather than filtering failures away.
 */
export function parseSignalSendEvidence(input: unknown): SignalSendEvidence {
  const record = isRecord(input) ? input : {};
  const timestampValid =
    typeof record.timestamp === 'number' &&
    Number.isSafeInteger(record.timestamp) &&
    record.timestamp > 0;
  const results = Object.freeze(Array.isArray(record.results) ? record.results.map(sendEntry) : []);
  return Object.freeze({
    complete: timestampValid && results.length > 0 && results.every((entry) => entry.valid),
    timestampValid,
    results,
  });
}

/** Only outer JSONRPC schema failures are protocol failures; receive payloads are not. */
export function parseSignalRpcFrame(bytes: Buffer): Result<SignalRpcFrame, SignalWireError> {
  try {
    if (bytes.length > SIGNAL_RPC_MAX_BYTES) return err(new SignalWireError());
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as SignalJsonValue;
    if (!isJsonObject(value) || value.jsonrpc !== '2.0') return err(new SignalWireError());
    if (Object.hasOwn(value, 'method')) {
      if (
        typeof value.method !== 'string' ||
        !value.method ||
        Object.hasOwn(value, 'id') ||
        Object.hasOwn(value, 'result') ||
        Object.hasOwn(value, 'error') ||
        (value.params !== undefined && !isJsonObject(value.params) && !Array.isArray(value.params))
      )
        return err(new SignalWireError());
      return ok(
        Object.freeze({
          kind: 'notification',
          method: value.method,
          params: value.params === undefined ? undefined : freezeJson(value.params),
        }),
      );
    }
    const id = value.id;
    if (
      !Object.hasOwn(value, 'id') ||
      !(
        id === null ||
        typeof id === 'string' ||
        (typeof id === 'number' && Number.isSafeInteger(id))
      ) ||
      Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error')
    )
      return err(new SignalWireError());
    if (Object.hasOwn(value, 'result'))
      return ok(Object.freeze({ kind: 'result', id, value: freezeJson(value.result) }));
    const error = value.error;
    if (
      !isJsonObject(error) ||
      typeof error.code !== 'number' ||
      !Number.isSafeInteger(error.code) ||
      typeof error.message !== 'string'
    )
      return err(new SignalWireError());
    // CommandHandler.java:286-290 puts command output in data.response. Nothing else escapes.
    const evidence = parseSignalSendEvidence(
      isJsonObject(error.data) ? error.data.response : undefined,
    );
    return ok(
      Object.freeze({
        kind: 'failure',
        id,
        error: new SignalRpcRemoteError(remoteCode(error.code), evidence),
      }),
    );
  } catch {
    return err(new SignalWireError());
  }
}

/** Manual wrapper only: DispatcherHandler.java:179-199, JsonReceiveMessageHandler.java:23-35.
 * Exception type/message are never provenance or account-state evidence.
 */
export function parseSignalReceiveNotification(
  params: SignalJsonValue | undefined,
): SignalReceiveNotification | undefined {
  if (
    !isJsonObject(params) ||
    !isSignalSubscriptionId(params.subscription) ||
    !isJsonObject(params.result) ||
    typeof params.result.account !== 'string'
  )
    return undefined;
  return Object.freeze({
    subscription: params.subscription,
    account: params.result.account,
    envelope: params.result.envelope,
    hasException: params.result.exception !== undefined && params.result.exception !== null,
  });
}
