// Single source of the pinned signal-cli v0.14.9 wire fixtures.
//
// Both the packaged fake bridge (tests/smoke/signal-channel-smoke.mjs) and the conformance test
// (tests/unit/channels/connectors/signal/signal-deliverable-conformance.test.ts) import these
// builders, so the fake cannot drift from the shapes the production parser is checked against.
// Oracle: the pinned v0.14.9 sources in the epic research snapshot (never moving upstream).
// Paths below are relative to .wdd/epics/signal-channel/research/signal-cli-v0.14.9/src/main/java/
// org/asamk/signal/ unless they start with lib/ or review-1-source-additions/.
// The conformance test asserts every cited line against the vendored source.

/** VersionCommand.java:65 `Map.of("version", version)`. */
export const BRIDGE_VERSION = '0.14.9';

/**
 * The `account` string of a receive notification.
 * JsonReceiveMessageHandler.java:26 `object.put("account", m.getSelfIdentifier())`;
 * review-1-source-additions/lib/.../manager/Manager.java:104-107 getSelfIdentifier() returns the
 * number when set and the ACI only for numberless accounts.
 */
export function selfIdentifier({ number, aci }) {
  return number !== null && number !== undefined ? number : aci;
}

/** ListAccountsCommand.java:34 `new JsonAccount(m.getSelfNumber(), m.getSelfACI())`, :47 record. */
export function listAccountsRows({ number, aci }) {
  return [{ number: number ?? null, aci }];
}

/** ListDevicesCommand.java:60 maps id/name/created/lastSeen, :67 record JsonDevice. */
export function listDevicesRows(devices) {
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    createdTimestamp: d.createdTimestamp,
    lastSeenTimestamp: d.lastSeenTimestamp,
  }));
}

/** JsonContact.java:10-29 (consumed subset: uuid, isBlocked, unregistered, messageExpirationTime). */
export function listContactsRow({ uuid }) {
  return {
    uuid,
    number: null,
    isBlocked: false,
    unregistered: false,
    messageExpirationTime: 0,
  };
}

/** ListGroupsCommand.java:152-168 record JsonGroup (consumed subset). */
export function listGroupsRow({ groupId, memberAci }) {
  return {
    id: groupId,
    name: 'smoke group',
    description: '',
    isMember: true,
    isBlocked: false,
    messageExpirationTime: 0,
    members: [{ number: null, uuid: memberAci, isAdmin: false }],
    pendingMembers: [],
    requestingMembers: [],
    admins: [],
    banned: [],
    permissionAddMember: 'ONLY_ADMINS',
    permissionEditDetails: 'ONLY_ADMINS',
    permissionSendMessage: 'EVERY_MEMBER',
    isTerminated: false,
  };
}

/** JsonDataMessage.java:13-40 record, :43-118 from(). Real output carries the primitive booleans. */
function dataMessage({ timestamp, message, groupId }) {
  return {
    timestamp,
    message,
    expiresInSeconds: 0,
    isExpirationUpdate: false,
    viewOnce: false,
    isEndSession: false,
    isProfileKeyUpdate: false,
    hasProfileKey: false,
    // JsonGroupInfo.java:9 record, :12-15 groupId base64, groupName, revision, "DELIVER".
    ...(groupId === undefined
      ? {}
      : { groupInfo: { groupId, groupName: 'smoke group', revision: 1, type: 'DELIVER' } }),
  };
}

/**
 * JsonMessageEnvelope.java:16-31 record, :34-90 from(). `source` is the deprecated legacy
 * identifier (:17); production ignores it, so the number-or-uuid choice is cosmetic.
 */
function envelope({ author, device, timestamp, dataMessage: data, syncMessage }) {
  return {
    source: author.number ?? author.uuid,
    sourceNumber: author.number ?? null,
    sourceUuid: author.uuid,
    sourceName: null,
    sourceDevice: device,
    timestamp,
    serverReceivedTimestamp: timestamp + 1,
    serverDeliveredTimestamp: timestamp + 2,
    ...(data === undefined ? {} : { dataMessage: data }),
    ...(syncMessage === undefined ? {} : { syncMessage }),
  };
}

/** Human DM: dataMessage only (JsonMessageEnvelope.java:25). */
export function dmEnvelope({ author, device, message, timestamp }) {
  return envelope({
    author,
    device,
    timestamp,
    dataMessage: dataMessage({ timestamp, message }),
  });
}

/** Group message: dataMessage.groupInfo (JsonDataMessage.java:36). */
export function groupEnvelope({ author, device, message, timestamp, groupId }) {
  return envelope({
    author,
    device,
    timestamp,
    dataMessage: dataMessage({ timestamp, message, groupId }),
  });
}

/**
 * Sync transcript of a message sent from another device: syncMessage.sentMessage
 * (JsonSyncMessage.java:22, :30-35). JsonSyncDataMessage.java:15-20 unwraps the data message and
 * adds destination fields; :24-28 fill them only when the transcript has a destination address
 * (a group transcript has none). Note to Self is a transcript whose destination is the account
 * itself.
 */
export function syncEnvelope({ author, device, destination, message, timestamp, groupId }) {
  const sent = {
    destination: destination ? (destination.number ?? destination.uuid) : null,
    destinationNumber: destination ? (destination.number ?? null) : null,
    destinationUuid: destination ? destination.uuid : null,
    ...dataMessage({ timestamp, message, groupId }),
  };
  return envelope({ author, device, timestamp, syncMessage: { sentMessage: sent } });
}

/**
 * Manual-mode receive notification params. SignalJsonRpcDispatcherHandler.java:185 sets
 * `subscription`, :189 `forNotification("receive", ...)`; JsonReceiveMessageHandler.java:25-35
 * builds `result` as {account, exception?, envelope?}. JsonError.java:6,9 is {message, type}.
 */
export function receiveParams({ subscription, number, aci, envelope: env, exception }) {
  const result = { account: selfIdentifier({ number, aci }) };
  if (exception !== undefined) result.exception = exception;
  if (env !== undefined) result.envelope = env;
  return { subscription, result };
}

/** Receive-fault result: JsonReceiveMessageHandler.java:27-29 with JsonError.java:6,9. */
export function receiveException(message) {
  return { message, type: 'SmokeFault' };
}

function recipientAddress({ uuid, number }) {
  // JsonRecipientAddress.java:10 record (uuid, number, username); all three serialized.
  return { uuid: uuid ?? null, number: number ?? null, username: null };
}

/**
 * Success result: SendMessageResultUtils.java:38 `Map.of("timestamp", ..., "results", results)`,
 * JsonSendMessageResult.java:11-17 record, :27-28 SUCCESS (groupId NON_NULL at :13).
 */
export function sendSuccessResult({ timestamp, recipientUuid, groupId }) {
  return {
    timestamp,
    results: [
      {
        recipientAddress: recipientAddress({ uuid: recipientUuid }),
        ...(groupId ? { groupId } : {}),
        type: 'SUCCESS',
      },
    ],
  };
}

/**
 * All-rate-limited send: SendMessageResultUtils.java:61-65 throws RateLimitErrorException,
 * SignalJsonRpcCommandHandler.java:43 RATELIMIT_ERROR = -5, :261-263 error, :286-291
 * `data: {response: <send result>}`. JsonSendMessageResult.java:16 retryAfterSeconds and :29-30
 * RATE_LIMIT_FAILURE; :39 ceilDiv(ms, 1000).
 */
export function rateLimitError({ timestamp, recipientUuid, groupId, retryAfterSeconds }) {
  return {
    code: -5,
    message: 'Failed to send message due to rate limiting',
    data: {
      response: {
        timestamp,
        results: [
          {
            recipientAddress: recipientAddress({ uuid: recipientUuid }),
            ...(groupId ? { groupId } : {}),
            type: 'RATE_LIMIT_FAILURE',
            retryAfterSeconds,
          },
        ],
      },
    },
  };
}

/** SignalJsonRpcCommandHandler.java:41 IO_ERROR = -3 (a failed metadata read). */
export function ioError(message) {
  return { code: -3, message };
}

/** SignalJsonRpcCommandHandler.java:40 USER_ERROR = -1 (unknown account). */
export function userError(message) {
  return { code: -1, message };
}

/** JsonRpcResponse.java:79 METHOD_NOT_FOUND = -32601. */
export function methodNotFoundError() {
  return { code: -32601, message: 'Method not found' };
}
