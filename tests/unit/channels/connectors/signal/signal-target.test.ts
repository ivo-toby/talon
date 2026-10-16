import { describe, expect, it, expectTypeOf } from 'vitest';
import {
  selectSignalTarget,
  createSignalTargetRequest,
  validateSignalTargetMetadata,
} from '../../../../../src/channels/connectors/signal/signal-target.js';
import {
  SignalConfigSchema,
  type SignalConfig,
} from '../../../../../src/channels/connectors/signal/signal-config.js';
import type { SignalDestination } from '../../../../../src/channels/connectors/signal/signal-identities.js';
import { encodeSignalRpcRequest } from '../../../../../src/channels/connectors/signal/signal-wire.js';
import { SignalDeliveryError } from '../../../../../src/core/errors/error-types.js';
import type { Result } from '../../../../../src/core/types/result.js';

// Source contracts, not live evidence: signal-cli v0.14.9, commit
// 3997429779095ff3a2d64c877126e84fce9852aa. Citations use pinned upstream paths.
const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const peerUuid = 'cccccccc-1111-2222-3333-dddddddddddd';
const otherUuid = 'eeeeeeee-1111-2222-3333-ffffffffffff';
const selfId = `signal:v1:${accountUuid}:self`;
const dmId = `signal:v1:${accountUuid}:dm:${peerUuid}`;
const groupId = `signal:v1:${accountUuid}:group:-_8`;
const self: SignalDestination = { kind: 'self', accountUuid };
const dm: SignalDestination = { kind: 'dm', accountUuid, peerUuid };
const group: SignalDestination = { kind: 'group', accountUuid, groupId: '+/8=' };
function config(change: Record<string, unknown> = {}): SignalConfig {
  return SignalConfigSchema.parse({
    accountMode: 'personal',
    socketPath: '/run/signal/bridge.sock',
    account: '+12025550123', // Bootstrap hint must never become a runtime selector.
    accountUuid,
    deviceId: 3,
    deviceCreatedTimestamp: 200,
    allowedDmPeers: [peerUuid],
    allowedGroups: ['+/8='],
    ...change,
  });
}

// src/main/java/org/asamk/signal/commands/ListContactsCommand.java:117-167;
// src/main/java/org/asamk/signal/json/JsonContact.java:9-30: only these fields
// are consumed. Profile/name/number are neither required nor authorization keys.
function contact(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: peerUuid,
    isBlocked: false,
    unregistered: false,
    messageExpirationTime: 0,
    ...change,
  };
}

// src/main/java/org/asamk/signal/commands/ListGroupsCommand.java:59-74,119-142,154-179:
// UUID::toString, independently nullable number/uuid, members' explicit isAdmin,
// four address arrays, three permission .name() strings; null labels are omitted.
// Permission values below are synthetic nonempty enum-name placeholders, NOT
// claims about upstream enum members or an additional permission authorization gate.
function groupRecord(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '+/8=',
    isMember: true,
    isBlocked: false,
    isTerminated: false,
    messageExpirationTime: 0,
    members: [{ number: null, uuid: accountUuid, isAdmin: false }],
    pendingMembers: [],
    requestingMembers: [],
    admins: [],
    banned: [],
    permissionAddMember: 'SOURCE_ENUM_NAME',
    permissionEditDetails: 'SOURCE_ENUM_NAME',
    permissionSendMessage: 'SOURCE_ENUM_NAME',
    ...change,
  };
}

function expectFailure(
  result: Result<unknown, SignalDeliveryError>,
  reason: SignalDeliveryError['reason'],
): void {
  const error = result._unsafeUnwrapErr();
  expect(error).toBeInstanceOf(SignalDeliveryError);
  expect(error).toMatchObject({
    reason,
    message: `Signal delivery failed: ${reason}`,
    outcome: 'NOT_SENT',
    currentChunkAcceptance: 'unwritten',
    acceptedChunks: 0,
    successCount: 0,
    failureCount: 0,
    retryScope: 'none',
    providerRetryable: false,
  });
  expect(error.cause).toBeUndefined();
  expect(result).not.toHaveProperty('value');
}

describe('selectSignalTarget', () => {
  it('uses the actual config normalizer and returns only the existing typed private destination', () => {
    const selected = config({
      accountUuid: accountUuid.toUpperCase(),
      allowedDmPeers: [peerUuid.toUpperCase()],
      allowedSenders: [],
    });
    expectTypeOf<typeof selectSignalTarget>().parameter(1).toEqualTypeOf<SignalConfig>();
    expectTypeOf<typeof createSignalTargetRequest>()
      .parameter(0)
      .toEqualTypeOf<SignalDestination>();
    expect(selectSignalTarget(dmId, selected)._unsafeUnwrap()).toEqual(dm);
    expect(selectSignalTarget(groupId, selected)._unsafeUnwrap()).toEqual(group);
    expect(Object.isFrozen(selectSignalTarget(dmId, selected)._unsafeUnwrap())).toBe(true);
  });

  it('allows canonical personal self without an ordinary peer/sender selection', () => {
    expect(
      selectSignalTarget(
        selfId,
        config({ allowedDmPeers: [], allowedSenders: [] }),
      )._unsafeUnwrap(),
    ).toEqual(self);
  });

  it('refuses dedicated self even with an allowed own-account peer', () => {
    expectFailure(
      selectSignalTarget(
        selfId,
        config({ accountMode: 'dedicated', allowedDmPeers: [accountUuid] }),
      ),
      'TARGET_REFUSED',
    );
  });

  it.each(['personal', 'dedicated'])(
    'refuses the own-DM alias in %s mode rather than creating a second self lease key',
    (accountMode) => {
      expectFailure(
        selectSignalTarget(
          `signal:v1:${accountUuid}:dm:${accountUuid}`,
          config({ accountMode, allowedDmPeers: [accountUuid] }),
        ),
        'TARGET_REFUSED',
      );
    },
  );

  it.each([dmId, groupId])(
    'denies an unselected destination %s despite sender authorization',
    (destination) => {
      expectFailure(
        selectSignalTarget(
          destination,
          config({ allowedDmPeers: [], allowedGroups: [], allowedSenders: [peerUuid] }),
        ),
        'TARGET_REFUSED',
      );
    },
  );

  it.each([dmId, groupId])(
    'selection is re-evaluated after a configuration change for %s',
    (destination) => {
      expect(selectSignalTarget(destination, config()).isOk()).toBe(true);
      expectFailure(
        selectSignalTarget(destination, config({ allowedDmPeers: [], allowedGroups: [] })),
        'TARGET_REFUSED',
      );
    },
  );

  it.each(['self', `dm:${peerUuid}`, 'group:-_8'])(
    'refuses replaced-account destinations before any selection: %s',
    (suffix) => {
      expectFailure(
        selectSignalTarget(`signal:v1:${otherUuid}:${suffix}`, config()),
        'ACCOUNT_MISMATCH',
      );
    },
  );

  it.each([
    'private-target',
    '',
    `${selfId}:extra`,
    `signal:v1:${accountUuid.toUpperCase()}:self`,
    `signal:v1:${accountUuid}:dm:${peerUuid.toUpperCase()}`,
    `signal:v1:${accountUuid}:group:+/8=`,
    `signal:v1:${accountUuid}:group:-_8=`,
  ])('reuses canonical identity parsing for %j', (destination) => {
    expectFailure(selectSignalTarget(destination, config()), 'INVALID_DESTINATION');
  });
});

describe('createSignalTargetRequest pinned request conformance', () => {
  it.each([
    [selfId, self, accountUuid],
    [dmId, dm, peerUuid],
  ] as const)(
    'pins %s to ACI and exactly one recipient without internal or stale phone selector',
    (id, destination, recipient) => {
      // src/main/java/org/asamk/signal/commands/ListContactsCommand.java:30-45,55-65;
      // lib/src/main/java/org/asamk/signal/manager/api/RecipientIdentifier.java:24-29 accepts UUIDs.
      // src/main/java/org/asamk/signal/jsonrpc/SignalJsonRpcCommandHandler.java:102-139
      // selects account before command parsing.
      const selected = selectSignalTarget(id, config())._unsafeUnwrap();
      expect(selected).toEqual(destination);
      const request = createSignalTargetRequest(selected);
      expect(request).toEqual({
        method: 'listContacts',
        params: { account: accountUuid, recipient: [recipient], allRecipients: true },
      });
      const encoded = encodeSignalRpcRequest(request, 'target-read')
        ._unsafeUnwrap()
        .toString('utf8');
      expect(JSON.parse(encoded)).toEqual({ jsonrpc: '2.0', id: 'target-read', ...request });
      expect(encoded).not.toContain('+12025550123');
      expect(encoded).not.toContain('internal');
    },
  );

  it('uses the exact canonical standard Base64 group filter array, not a name or external Base64url', () => {
    // src/main/java/org/asamk/signal/commands/ListGroupsCommand.java:35-40,111-115:
    // groupId is a list, not send's scalar.
    const request = createSignalTargetRequest(
      selectSignalTarget(groupId, config())._unsafeUnwrap(),
    );
    expect(request).toEqual({
      method: 'listGroups',
      params: { account: accountUuid, groupId: ['+/8='] },
    });
    expect(encodeSignalRpcRequest(request, 'target-read').isOk()).toBe(true);
  });

  it('allocates independent request values without mutating or caching caller destinations', () => {
    const destination = Object.freeze({ ...dm });
    const first = createSignalTargetRequest(destination);
    const second = createSignalTargetRequest(destination);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.params).not.toBe(second.params);
    expect(destination).toEqual(dm);
  });
});

describe('validateSignalTargetMetadata contact/self', () => {
  it.each([dm, self])(
    'accepts exactly one normalized safe contact for $kind and returns no private metadata',
    (destination) => {
      const uuid = destination.kind === 'dm' ? destination.peerUuid : accountUuid;
      const metadata = [
        contact({
          uuid: uuid.toUpperCase(),
          number: null,
          name: 'private-name',
          profile: { about: 'private-profile' },
        }),
      ];
      const before = JSON.stringify(metadata);
      const result = validateSignalTargetMetadata(destination, metadata);
      expectTypeOf<typeof result>().toEqualTypeOf<Result<void, SignalDeliveryError>>();
      expect(result._unsafeUnwrap()).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('private');
      expect(JSON.stringify(metadata)).toBe(before);
    },
  );

  it.each([
    null,
    undefined,
    true,
    1,
    'private-raw',
    {},
    [],
    [null],
    [[]],
    [1],
    [contact({ uuid: otherUuid })],
    [contact(), contact()],
    [contact(), contact({ uuid: peerUuid.toUpperCase() })],
    [contact(), contact({ uuid: otherUuid })],
  ])('rejects missing, malformed, unrelated or ambiguous contact data #%#', (metadata) => {
    // Single-filter exact-cardinality is our conservative policy, not an upstream guarantee.
    expectFailure(validateSignalTargetMetadata(dm, metadata), 'TARGET_UNVERIFIABLE');
  });

  it('requires the self contact, not a selected peer record, for Note to Self', () => {
    expectFailure(validateSignalTargetMetadata(self, [contact()]), 'TARGET_UNVERIFIABLE');
    expectFailure(validateSignalTargetMetadata(self, []), 'TARGET_UNVERIFIABLE');
  });

  it.each(['uuid', 'isBlocked', 'unregistered', 'messageExpirationTime'])(
    'requires explicit contact field %s',
    (key) => {
      const { [key]: _omitted, ...metadata } = contact();
      expectFailure(validateSignalTargetMetadata(dm, [metadata]), 'TARGET_UNVERIFIABLE');
    },
  );

  it.each([
    { uuid: null },
    { uuid: '+12025550123' },
    { uuid: `PNI:${peerUuid}` },
    { isBlocked: null },
    { isBlocked: 0 },
    { unregistered: null },
    { unregistered: 'false' },
    { messageExpirationTime: null },
    { messageExpirationTime: '0' },
    { messageExpirationTime: false },
    { messageExpirationTime: 0.1 },
    { messageExpirationTime: NaN },
    { messageExpirationTime: Infinity },
    { messageExpirationTime: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects malformed contact safety fields #%#', (change) => {
    expectFailure(validateSignalTargetMetadata(dm, [contact(change)]), 'TARGET_UNVERIFIABLE');
  });

  it.each([
    { isBlocked: true },
    { unregistered: true },
    { messageExpirationTime: 1 },
    { messageExpirationTime: -1 },
    { messageExpirationTime: Number.MAX_SAFE_INTEGER },
    { messageExpirationTime: Number.MIN_SAFE_INTEGER },
  ])('refuses complete known unsafe contact state #%#', (change) => {
    for (const destination of [dm, self]) {
      const uuid = destination.kind === 'dm' ? peerUuid : accountUuid;
      expectFailure(
        validateSignalTargetMetadata(destination, [contact({ uuid, ...change })]),
        'TARGET_REFUSED',
      );
    }
  });

  it('validates completeness before interpreting unsafe flags', () => {
    expectFailure(
      validateSignalTargetMetadata(dm, [
        contact({ isBlocked: true, messageExpirationTime: undefined }),
      ]),
      'TARGET_UNVERIFIABLE',
    );
  });

  it('has no timer cache across independent chunk checks', () => {
    expect(validateSignalTargetMetadata(dm, [contact()]).isOk()).toBe(true);
    expectFailure(
      validateSignalTargetMetadata(dm, [contact({ messageExpirationTime: 60 })]),
      'TARGET_REFUSED',
    );
    expectFailure(validateSignalTargetMetadata(dm, []), 'TARGET_UNVERIFIABLE');
    expect(validateSignalTargetMetadata(dm, [contact()]).isOk()).toBe(true);
  });
});

const addressLists = ['pendingMembers', 'requestingMembers', 'admins', 'banned'];
const memberLists = ['members', ...addressLists];
const permissions = ['permissionAddMember', 'permissionEditDetails', 'permissionSendMessage'];
describe('validateSignalTargetMetadata group source conformance', () => {
  it('accepts source-shaped hidden-phone UUID members and all required provenance arrays without retaining them', () => {
    const metadata = [
      groupRecord({
        members: [
          {
            number: null,
            uuid: peerUuid.toUpperCase(),
            isAdmin: true,
            labelEmoji: 'private-emoji',
            label: 'private-label',
          },
        ],
        name: 'private-group',
        description: 'private-description',
      }),
    ];
    const before = JSON.stringify(metadata);
    expect(validateSignalTargetMetadata(group, metadata)._unsafeUnwrap()).toBeUndefined();
    expect(JSON.stringify(metadata)).toBe(before);
  });

  it('accepts source-nullable UUIDs with valid number-only addresses without granting peer authorization', () => {
    const member = { uuid: null, number: '+12025550124', isAdmin: false };
    const address = { uuid: null, number: '+12025550125' };
    const metadata = groupRecord({
      members: [member],
      pendingMembers: [address],
      requestingMembers: [address],
      admins: [address],
      banned: [address],
    });
    expect(validateSignalTargetMetadata(group, [metadata]).isOk()).toBe(true);
  });

  it('does not invent roster-self/admin/permission authorization beyond the approved group flags', () => {
    expect(
      validateSignalTargetMetadata(group, [
        groupRecord({ members: [], permissionSendMessage: 'ANOTHER_SOURCE_ENUM_NAME' }),
      ]).isOk(),
    ).toBe(true);
  });

  it.each([
    null,
    undefined,
    {},
    [],
    [null],
    [[]],
    [false],
    [groupRecord({ id: 'YWJj' })],
    [groupRecord(), groupRecord()],
    [groupRecord(), groupRecord({ id: 'YWJj' })],
  ])('rejects missing, unrelated or ambiguous groups #%#', (metadata) => {
    expectFailure(validateSignalTargetMetadata(group, metadata), 'TARGET_UNVERIFIABLE');
  });

  it.each([
    'id',
    'isMember',
    'isBlocked',
    'isTerminated',
    'messageExpirationTime',
    ...memberLists,
    ...permissions,
  ])('requires source group field %s without defaults', (key) => {
    const { [key]: _omitted, ...metadata } = groupRecord();
    expectFailure(validateSignalTargetMetadata(group, [metadata]), 'TARGET_UNVERIFIABLE');
  });

  it.each([
    { id: '-_8' },
    { id: '+/8' },
    { id: '+/9=' },
    { id: null },
    { isMember: 'true' },
    { isBlocked: null },
    { isTerminated: undefined },
    { messageExpirationTime: null },
    { messageExpirationTime: '0' },
    { messageExpirationTime: 0.5 },
    { messageExpirationTime: Infinity },
    { messageExpirationTime: NaN },
    { messageExpirationTime: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects noncanonical IDs and malformed safety fields #%#', (change) => {
    expectFailure(
      validateSignalTargetMetadata(group, [groupRecord(change)]),
      'TARGET_UNVERIFIABLE',
    );
  });

  it.each([
    { isMember: false },
    { isBlocked: true },
    { isTerminated: true },
    { messageExpirationTime: 1 },
    { messageExpirationTime: -1 },
    { messageExpirationTime: Number.MAX_SAFE_INTEGER },
    { messageExpirationTime: Number.MIN_SAFE_INTEGER },
  ])('refuses complete known unsafe group state #%#', (change) => {
    expectFailure(validateSignalTargetMetadata(group, [groupRecord(change)]), 'TARGET_REFUSED');
  });

  it.each(memberLists)('requires %s to be an array of parseable records', (key) => {
    for (const value of [undefined, null, {}, 'private-list', [null], [[]], [1]]) {
      expectFailure(
        validateSignalTargetMetadata(group, [groupRecord({ [key]: value })]),
        'TARGET_UNVERIFIABLE',
      );
    }
  });

  it.each(memberLists)(
    'validates nullable number/UUID fields and fail-closed usable provenance in %s',
    (key) => {
      for (const address of [
        {},
        { uuid: peerUuid },
        { number: null },
        { number: null, uuid: null },
        { number: null, uuid: 'private-invalid-uuid' },
        { number: '+12025550124', uuid: 'bad' },
        { number: 'private-name', uuid: peerUuid },
        { number: 1, uuid: peerUuid },
      ]) {
        expectFailure(
          validateSignalTargetMetadata(group, [
            groupRecord({ [key]: [{ ...address, isAdmin: false }] }),
          ]),
          'TARGET_UNVERIFIABLE',
        );
      }
    },
  );

  it.each([undefined, null, 'false', 0])(
    'requires explicit boolean isAdmin on full members #%#',
    (isAdmin) => {
      expectFailure(
        validateSignalTargetMetadata(group, [
          groupRecord({ members: [{ number: null, uuid: peerUuid, isAdmin }] }),
        ]),
        'TARGET_UNVERIFIABLE',
      );
    },
  );

  it.each(['labelEmoji', 'label'])(
    'accepts supplied string %s but rejects malformed supplied labels',
    (key) => {
      for (const value of [null, false, 1, {}]) {
        expectFailure(
          validateSignalTargetMetadata(group, [
            groupRecord({
              members: [{ number: null, uuid: peerUuid, isAdmin: false, [key]: value }],
            }),
          ]),
          'TARGET_UNVERIFIABLE',
        );
      }
      expect(
        validateSignalTargetMetadata(group, [
          groupRecord({ members: [{ number: null, uuid: peerUuid, isAdmin: false, [key]: '' }] }),
        ]).isOk(),
      ).toBe(true);
    },
  );

  it.each(permissions)(
    'requires explicit nonempty source enum-name string %s, not an invented default',
    (key) => {
      for (const value of [null, undefined, '', ' ', false, 1, {}]) {
        expectFailure(
          validateSignalTargetMetadata(group, [groupRecord({ [key]: value })]),
          'TARGET_UNVERIFIABLE',
        );
      }
    },
  );

  it('checks every record in each provenance array, not just the first', () => {
    for (const key of memberLists) {
      expectFailure(
        validateSignalTargetMetadata(group, [
          groupRecord({
            [key]: [
              { number: null, uuid: peerUuid, isAdmin: false },
              { number: null, uuid: null, isAdmin: false },
            ],
          }),
        ]),
        'TARGET_UNVERIFIABLE',
      );
    }
  });

  it('checks required metadata completeness before unsafe group classification', () => {
    expectFailure(
      validateSignalTargetMetadata(group, [groupRecord({ isBlocked: true, members: null })]),
      'TARGET_UNVERIFIABLE',
    );
  });

  it('rechecks group membership/timer on every call without cached safe state', () => {
    expect(validateSignalTargetMetadata(group, [groupRecord()]).isOk()).toBe(true);
    expectFailure(
      validateSignalTargetMetadata(group, [groupRecord({ isMember: false })]),
      'TARGET_REFUSED',
    );
    expectFailure(
      validateSignalTargetMetadata(group, [groupRecord({ messageExpirationTime: 60 })]),
      'TARGET_REFUSED',
    );
    expectFailure(validateSignalTargetMetadata(group, []), 'TARGET_UNVERIFIABLE');
  });
});

describe('target metadata privacy and immutability', () => {
  it('never retains raw targets, private members, names, phone numbers or dynamic parse paths in errors', () => {
    const secret = 'private-secret-parse-path';
    const input = [
      {
        ...groupRecord(),
        name: secret,
        [secret]: secret,
        members: [{ uuid: secret, number: '+12025550199', isAdmin: false }],
      },
    ];
    const error = validateSignalTargetMetadata(group, input)._unsafeUnwrapErr();
    expect(error.message).toBe('Signal delivery failed: TARGET_UNVERIFIABLE');
    const serialized = JSON.stringify(error);
    for (const value of [secret, '+12025550199', '+/8=', accountUuid, peerUuid, 'members', 'uuid'])
      expect(serialized).not.toContain(value);
    expect(error.cause).toBeUndefined();
    expect(error).not.toHaveProperty('issues');
    expect(error).not.toHaveProperty('metadata');
  });

  it('works with frozen inputs and leaves all original metadata bytes unchanged', () => {
    const member = Object.freeze({ number: null, uuid: peerUuid, isAdmin: false });
    const metadata = Object.freeze([
      Object.freeze(groupRecord({ members: Object.freeze([member]) })),
    ]);
    const before = JSON.stringify(metadata);
    expect(validateSignalTargetMetadata(Object.freeze({ ...group }), metadata).isOk()).toBe(true);
    expect(JSON.stringify(metadata)).toBe(before);
  });
});
