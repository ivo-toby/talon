import { ChannelError } from '../../../core/errors/error-types.js';
import { err, ok, type Result } from '../../../core/types/result.js';

export type SignalIdentityReason =
  | 'INVALID_UUID'
  | 'INVALID_GROUP_ID'
  | 'INVALID_DESTINATION'
  | 'ACCOUNT_MISMATCH';

export class SignalIdentityError extends ChannelError {
  constructor(readonly reason: SignalIdentityReason) {
    super(`Signal identity rejected: ${reason}`);
  }
}

export type SignalDestination =
  | { readonly kind: 'self'; readonly accountUuid: string }
  | { readonly kind: 'dm'; readonly accountUuid: string; readonly peerUuid: string }
  | { readonly kind: 'group'; readonly accountUuid: string; readonly groupId: string };

export function normalizeSignalUuid(value: unknown): Result<string, SignalIdentityError> {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? ok(value.toLowerCase())
    : err(new SignalIdentityError('INVALID_UUID'));
}

/** Buffer decoding alone is permissive; the round trip rejects padding bits and aliases. */
export function normalizeSignalGroupId(value: unknown): Result<string, SignalIdentityError> {
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return err(new SignalIdentityError('INVALID_GROUP_ID'));
  }
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.toString('base64') === value
    ? ok(value)
    : err(new SignalIdentityError('INVALID_GROUP_ID'));
}

export function signalGroupIdToBase64url(value: unknown): Result<string, SignalIdentityError> {
  return normalizeSignalGroupId(value).map((groupId) =>
    Buffer.from(groupId, 'base64').toString('base64url'),
  );
}

export function signalGroupIdFromBase64url(value: unknown): Result<string, SignalIdentityError> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return err(new SignalIdentityError('INVALID_GROUP_ID'));
  }
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length > 0 && bytes.toString('base64url') === value
    ? ok(bytes.toString('base64'))
    : err(new SignalIdentityError('INVALID_GROUP_ID'));
}

export function formatSignalExternalId(
  destination: SignalDestination,
): Result<string, SignalIdentityError> {
  return normalizeSignalUuid(destination.accountUuid).andThen((accountUuid) => {
    const prefix = `signal:v1:${accountUuid}`;
    switch (destination.kind) {
      case 'self':
        return ok(`${prefix}:self`);
      case 'dm':
        return normalizeSignalUuid(destination.peerUuid).map((peer) => `${prefix}:dm:${peer}`);
      case 'group':
        return signalGroupIdToBase64url(destination.groupId).map(
          (group) => `${prefix}:group:${group}`,
        );
    }
  });
}

/** External IDs must already be canonical; wire/config UUID normalization is separate. */
export function parseSignalExternalId(
  value: unknown,
  expectedAccountUuid?: string,
): Result<SignalDestination, SignalIdentityError> {
  const invalid = (): Result<never, SignalIdentityError> =>
    err(new SignalIdentityError('INVALID_DESTINATION'));
  if (typeof value !== 'string') return invalid();
  const parts = value.split(':');
  if (parts[0] !== 'signal' || parts[1] !== 'v1') return invalid();
  const account = normalizeSignalUuid(parts[2]);
  if (account.isErr() || parts[2] !== account.value) return invalid();
  if (expectedAccountUuid !== undefined) {
    const expected = normalizeSignalUuid(expectedAccountUuid);
    if (expected.isErr() || expected.value !== account.value)
      return err(new SignalIdentityError('ACCOUNT_MISMATCH'));
  }
  if (parts.length === 4 && parts[3] === 'self')
    return ok({ kind: 'self', accountUuid: account.value });
  if (parts.length !== 5) return invalid();
  if (parts[3] === 'dm') {
    const peer = normalizeSignalUuid(parts[4]);
    return peer.isOk() && peer.value === parts[4]
      ? ok({ kind: 'dm', accountUuid: account.value, peerUuid: peer.value })
      : invalid();
  }
  if (parts[3] === 'group') {
    const group = signalGroupIdFromBase64url(parts[4]);
    return group.isOk()
      ? ok({ kind: 'group', accountUuid: account.value, groupId: group.value })
      : invalid();
  }
  return invalid();
}
