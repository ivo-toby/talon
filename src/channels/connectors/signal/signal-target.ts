import {
  SignalDeliveryError,
  type SignalDeliveryReason,
} from '../../../core/errors/error-types.js';
import { err, ok, type Result } from '../../../core/types/result.js';
import type { SignalConfig } from './signal-config.js';
import {
  normalizeSignalGroupId,
  normalizeSignalUuid,
  parseSignalExternalId,
  type SignalDestination,
} from './signal-identities.js';
import type { SignalRpcRequest } from './signal-wire.js';

function refused(reason: SignalDeliveryReason): Result<never, SignalDeliveryError> {
  return err(
    new SignalDeliveryError({
      reason,
      outcome: 'NOT_SENT',
      currentChunkAcceptance: 'unwritten',
      acceptedChunks: 0,
      successCount: 0,
      failureCount: 0,
      retryScope: 'none',
    }),
  );
}

/** Selection is not account/device proof. Re-run with current config before each chunk. */
export function selectSignalTarget(
  destination: string,
  config: SignalConfig,
): Result<SignalDestination, SignalDeliveryError> {
  const parsed = parseSignalExternalId(destination, config.accountUuid);
  if (parsed.isErr())
    return refused(
      parsed.error.reason === 'ACCOUNT_MISMATCH' ? 'ACCOUNT_MISMATCH' : 'INVALID_DESTINATION',
    );
  const target = parsed.value;
  if (
    (target.kind === 'self' && config.accountMode !== 'personal') ||
    (target.kind === 'dm' &&
      (target.peerUuid === config.accountUuid ||
        !config.allowedDmPeers.includes(target.peerUuid))) ||
    (target.kind === 'group' && !config.allowedGroups.includes(target.groupId))
  )
    return refused('TARGET_REFUSED');
  // Own-DM aliases must not bypass self-mode policy or create another self destination lease.
  return ok(Object.freeze(target));
}

/** Use only a selected destination and matching fresh proof. Never use the bootstrap phone hint.
 * Caller performs a NEW RPC for every chunk; this function performs no IO or caching. */
export function createSignalTargetRequest(
  destination: SignalDestination,
): Extract<SignalRpcRequest, { method: 'listContacts' | 'listGroups' }> {
  return destination.kind === 'group'
    ? {
        method: 'listGroups',
        params: { account: destination.accountUuid, groupId: [destination.groupId] },
      }
    : {
        method: 'listContacts',
        params: {
          account: destination.accountUuid,
          recipient: [destination.kind === 'dm' ? destination.peerUuid : destination.accountUuid],
          allRecipients: true,
        },
      };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTimer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function validAddress(address: Record<string, unknown>): boolean {
  const number = address.number;
  const uuid = address.uuid;
  const validNumber = typeof number === 'string' && /^\+[1-9][0-9]{1,14}$/.test(number);
  const validUuid = normalizeSignalUuid(uuid).isOk();
  // Source fields are independently nullable; a usable identifier is our fail-closed policy,
  // not a new peer authorization rule or an upstream constructor guarantee.
  return (
    (number === null || validNumber) && (uuid === null || validUuid) && (validNumber || validUuid)
  );
}

function validMembers(value: unknown, fullMembers: boolean): boolean {
  if (!Array.isArray(value)) return false;
  for (const member of value) {
    if (!isRecord(member) || !validAddress(member)) return false;
    if (
      fullMembers &&
      (typeof member.isAdmin !== 'boolean' ||
        (member.labelEmoji !== undefined && typeof member.labelEmoji !== 'string') ||
        (member.label !== undefined && typeof member.label !== 'string'))
    )
      return false;
  }
  return true;
}

function validGroupFields(group: Record<string, unknown>): boolean {
  return (
    typeof group.isMember === 'boolean' &&
    typeof group.isBlocked === 'boolean' &&
    typeof group.isTerminated === 'boolean' &&
    isTimer(group.messageExpirationTime) &&
    validMembers(group.members, true) &&
    ['pendingMembers', 'requestingMembers', 'admins', 'banned'].every((key) =>
      validMembers(group[key], false),
    ) &&
    ['permissionAddMember', 'permissionEditDetails', 'permissionSendMessage'].every(
      (key) => typeof group[key] === 'string' && group[key].trim().length > 0,
    )
  );
}

/** Validate ONLY a fresh successful lookup's method value against the selected destination.
 * Pinned ListContactsCommand.java:55-65,117-167 / JsonContact.java:9-30 and
 * ListGroupsCommand.java:59-74,111-142,154-179. Exactly one record is conservative
 * policy for our single-filter requests, not a claimed upstream cardinality guarantee.
 * No metadata/proof is returned or retained. Caller owns proof age and RPC error policy. */
export function validateSignalTargetMetadata(
  destination: SignalDestination,
  metadata: unknown,
): Result<void, SignalDeliveryError> {
  if (!Array.isArray(metadata) || metadata.length !== 1 || !isRecord(metadata[0]))
    return refused('TARGET_UNVERIFIABLE');
  const target = metadata[0];
  if (destination.kind === 'group') {
    const id = normalizeSignalGroupId(target.id);
    if (id.isErr() || id.value !== destination.groupId || !validGroupFields(target))
      return refused('TARGET_UNVERIFIABLE');
    if (
      target.isMember !== true ||
      target.isBlocked !== false ||
      target.isTerminated !== false ||
      target.messageExpirationTime !== 0
    )
      return refused('TARGET_REFUSED');
  } else {
    const uuid = normalizeSignalUuid(target.uuid);
    const expected = destination.kind === 'dm' ? destination.peerUuid : destination.accountUuid;
    if (
      uuid.isErr() ||
      uuid.value !== expected ||
      typeof target.isBlocked !== 'boolean' ||
      typeof target.unregistered !== 'boolean' ||
      !isTimer(target.messageExpirationTime)
    )
      return refused('TARGET_UNVERIFIABLE');
    if (
      target.isBlocked !== false ||
      target.unregistered !== false ||
      target.messageExpirationTime !== 0
    )
      return refused('TARGET_REFUSED');
  }
  return ok(undefined);
}
