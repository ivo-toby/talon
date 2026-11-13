import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSignalConfig } from '../../../../../src/channels/connectors/signal/signal-config.js';
import {
  SignalDeviceRegistry,
  verifySignalDevices,
} from '../../../../../src/channels/connectors/signal/signal-device-registry.js';
import {
  evaluateSignalCandidate,
  normalizeSignalReceive,
  type SignalInboundContext,
} from '../../../../../src/channels/connectors/signal/signal-inbound-policy.js';
import { validateSignalTargetMetadata } from '../../../../../src/channels/connectors/signal/signal-target.js';
import {
  parseSignalReceiveNotification,
  parseSignalRpcFrame,
  parseSignalSendEvidence,
} from '../../../../../src/channels/connectors/signal/signal-wire.js';

/**
 * Wire conformance for the packaged fake bridge (tests/smoke/signal-channel-smoke.mjs).
 * Oracle: the pinned signal-cli v0.14.9 sources vendored in the epic research snapshot, never
 * upstream master. Each assertion names the file and line that declares the field.
 */
const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../../../../..');
const PINNED = join(REPO, '.wdd/epics/signal-channel/research/signal-cli-v0.14.9');
const ADDITIONS = join(REPO, '.wdd/epics/signal-channel/research/review-1-source-additions');

/** The ONE fixture module shared with the packaged smoke (tests/smoke/signal-channel-smoke.mjs). */
interface Fixtures {
  selfIdentifier(input: { number: string | null; aci: string }): string;
  listAccountsRows(input: { number: string | null; aci: string }): unknown;
  listDevicesRows(devices: readonly unknown[]): unknown;
  dmEnvelope(input: Record<string, unknown>): unknown;
  groupEnvelope(input: Record<string, unknown>): unknown;
  syncEnvelope(input: Record<string, unknown>): unknown;
  receiveParams(input: Record<string, unknown>): unknown;
  receiveException(message: string): unknown;
  sendSuccessResult(input: Record<string, unknown>): unknown;
  rateLimitError(input: Record<string, unknown>): { code: number; message: string; data: unknown };
}
const fixtures = (await import(
  pathToFileURL(join(REPO, '.agents/skills/run-talon-smoke/scripts/signal-wire-fixtures.mjs')).href
)) as Fixtures;

function sourceLines(relative: string): string[] {
  const path = join(PINNED, relative);
  expect(existsSync(path), `pinned source present: ${relative}`).toBe(true);
  return readFileSync(path, 'utf8').split('\n');
}

/** Asserts that the 1-based line declares the pattern. The citation is the test's evidence. */
function expectDeclared(relative: string, line: number, pattern: RegExp): void {
  const lines = sourceLines(relative);
  const text = lines[line - 1] ?? '';
  expect(text, `${relative}:${line} declares ${pattern}`).toMatch(pattern);
}

/** Same as expectDeclared for the review-1 supplemental sources (not in the main snapshot). */
function expectAdditionDeclared(relative: string, line: number, pattern: RegExp): void {
  const path = join(ADDITIONS, relative);
  expect(existsSync(path), `supplemental source present: ${relative}`).toBe(true);
  const text = readFileSync(path, 'utf8').split('\n')[line - 1] ?? '';
  expect(text, `${relative}:${line} declares ${pattern}`).toMatch(pattern);
}

/** Asserts that a 1-based inclusive window contains the pattern (for multi-line man examples). */
function expectInWindow(relative: string, from: number, to: number, pattern: RegExp): void {
  const window = sourceLines(relative)
    .slice(from - 1, to)
    .join('\n');
  expect(window, `${relative}:${from}-${to} contains ${pattern}`).toMatch(pattern);
}

const ACI = '0c6b8f8e-3d2a-4f5b-9a71-2e5f7c1d9b10';
const PEER = '5a1e2b3c-4d5e-4f60-8a71-b2c3d4e5f607';
const NUMBER = '+15550000001';
const GROUP = Buffer.alloc(32, 1).toString('base64');

describe('signal-cli v0.14.9 wire conformance for the fake bridge', () => {
  describe('framing and envelopes', () => {
    it('frames UTF-8 JSON lines (SocketHandler.java:115-116)', () => {
      expectDeclared(
        'src/main/java/org/asamk/signal/jsonrpc/SocketHandler.java',
        115,
        /getLineSupplier/,
      );
      expectDeclared(
        'src/main/java/org/asamk/signal/jsonrpc/SocketHandler.java',
        116,
        /StandardCharsets\.UTF_8/,
      );
    });

    it('omits null result/error keys on responses (JsonRpcResponse.java:23,31) with pinned error codes (:77,:79)', () => {
      expectDeclared('src/main/java/org/asamk/signal/jsonrpc/JsonRpcResponse.java', 23, /NON_NULL/);
      expectDeclared('src/main/java/org/asamk/signal/jsonrpc/JsonRpcResponse.java', 31, /NON_NULL/);
      expectDeclared(
        'src/main/java/org/asamk/signal/jsonrpc/JsonRpcResponse.java',
        77,
        /PARSE_ERROR = -32700/,
      );
      expectDeclared(
        'src/main/java/org/asamk/signal/jsonrpc/JsonRpcResponse.java',
        79,
        /METHOD_NOT_FOUND = -32601/,
      );
    });

    it('accepts the success envelope the fake writes and the failure envelope with data.response evidence', () => {
      const success = parseSignalRpcFrame(
        Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'req-1', result: { version: '0.14.9' } })),
      );
      expect(success.isOk() && success.value.kind === 'result').toBe(true);
      const failure = parseSignalRpcFrame(
        Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'req-2',
            error: {
              code: -5,
              message: 'rate limited',
              data: { response: { timestamp: 1, results: [] } },
            },
          }),
        ),
      );
      expect(failure.isOk() && failure.value.kind === 'failure').toBe(true);
    });

    it('receive notifications carry params.subscription and params.result (DispatcherHandler.java:185,189; JsonReceiveMessageHandler.java:26,28,32)', () => {
      const dispatcher =
        'src/main/java/org/asamk/signal/jsonrpc/SignalJsonRpcDispatcherHandler.java';
      expectDeclared(dispatcher, 158, /AtomicInteger\(0\)/);
      expectDeclared(dispatcher, 165, /getAndIncrement/);
      expectDeclared(dispatcher, 185, /"subscription"/);
      expectDeclared(dispatcher, 189, /forNotification\("receive"/);
      const receive = 'src/main/java/org/asamk/signal/json/JsonReceiveMessageHandler.java';
      expectDeclared(receive, 26, /"account"/);
      expectDeclared(receive, 28, /"exception"/);
      expectDeclared(receive, 32, /"envelope"/);

      const frame = parseSignalRpcFrame(
        Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'receive',
            params: fixtures.receiveParams({
              subscription: 0,
              number: NUMBER,
              aci: ACI,
              envelope: fixtures.dmEnvelope({
                author: { uuid: PEER, number: null },
                device: 1,
                message: 'hi',
                timestamp: 3000,
              }),
            }),
          }),
        ),
      );
      expect(frame.isOk() && frame.value.kind === 'notification').toBe(true);
      if (!frame.isOk() || frame.value.kind !== 'notification') return;
      const event = parseSignalReceiveNotification(frame.value.params);
      expect(event).toMatchObject({ subscription: 0, account: NUMBER, hasException: false });
    });

    it('result.account is the NUMBER when set, the ACI only for numberless accounts (JsonReceiveMessageHandler.java:26; Manager.java:97-107)', () => {
      expectDeclared(
        'src/main/java/org/asamk/signal/json/JsonReceiveMessageHandler.java',
        26,
        /object\.put\("account", m\.getSelfIdentifier\(\)\)/,
      );
      const manager = 'lib/src/main/java/org/asamk/signal/manager/Manager.java';
      expectAdditionDeclared(manager, 97, /String getSelfNumber\(\)/);
      expectAdditionDeclared(manager, 99, /String getSelfACI\(\)/);
      expectAdditionDeclared(manager, 104, /default String getSelfIdentifier\(\)/);
      expectAdditionDeclared(manager, 106, /number != null \? number : getSelfACI\(\)/);
      expect(fixtures.selfIdentifier({ number: NUMBER, aci: ACI })).toBe(NUMBER);
      expect(fixtures.selfIdentifier({ number: null, aci: ACI })).toBe(ACI);
      const receive = fixtures.receiveParams({ subscription: 0, number: NUMBER, aci: ACI }) as {
        result: { account: string };
      };
      expect(receive.result.account).toBe(NUMBER);
      const numberless = fixtures.receiveParams({ subscription: 0, number: null, aci: ACI }) as {
        result: { account: string };
      };
      expect(numberless.result.account).toBe(ACI);
    });

    it('envelope and data-message fields (JsonMessageEnvelope.java:19,21,25,28; JsonDataMessage.java:14-16,36)', () => {
      const env = 'src/main/java/org/asamk/signal/json/JsonMessageEnvelope.java';
      expectDeclared(env, 19, /String sourceUuid/);
      expectDeclared(env, 21, /Integer sourceDevice/);
      expectDeclared(env, 25, /JsonDataMessage dataMessage/);
      expectDeclared(env, 28, /JsonSyncMessage syncMessage/);
      const data = 'src/main/java/org/asamk/signal/json/JsonDataMessage.java';
      expectDeclared(data, 14, /long timestamp/);
      expectDeclared(data, 15, /String message/);
      expectDeclared(data, 16, /Integer expiresInSeconds/);
      expectDeclared(data, 36, /JsonGroupInfo groupInfo/);
    });

    it('group info is {groupId, groupName, revision, type DELIVER} (JsonGroupInfo.java:9,15)', () => {
      expectDeclared(
        'src/main/java/org/asamk/signal/json/JsonGroupInfo.java',
        9,
        /groupId, String groupName, int revision, String type/,
      );
      expectDeclared('src/main/java/org/asamk/signal/json/JsonGroupInfo.java', 15, /"DELIVER"/);
    });

    it('sync transcript keeps sentMessage with destination fields (JsonSyncMessage.java:22; JsonSyncDataMessage.java:17-18)', () => {
      expectDeclared(
        'src/main/java/org/asamk/signal/json/JsonSyncMessage.java',
        22,
        /JsonSyncDataMessage sentMessage/,
      );
      expectDeclared(
        'src/main/java/org/asamk/signal/json/JsonSyncDataMessage.java',
        17,
        /String destinationNumber/,
      );
      expectDeclared(
        'src/main/java/org/asamk/signal/json/JsonSyncDataMessage.java',
        18,
        /String destinationUuid/,
      );
    });
  });

  describe('bridge methods and results', () => {
    it('version result is {version} (VersionCommand.java:62,65)', () => {
      expectDeclared(
        'src/main/java/org/asamk/signal/commands/VersionCommand.java',
        62,
        /"unknown"/,
      );
      expectDeclared(
        'src/main/java/org/asamk/signal/commands/VersionCommand.java',
        65,
        /Map\.of\("version", version\)/,
      );
    });

    it('listAccounts rows are {number, aci}; numberless accounts have a null number (ListAccountsCommand.java:34,47)', () => {
      expectDeclared(
        'src/main/java/org/asamk/signal/commands/ListAccountsCommand.java',
        34,
        /new JsonAccount\(m\.getSelfNumber\(\), m\.getSelfACI\(\)\)/,
      );
      expect(fixtures.listAccountsRows({ number: null, aci: ACI })).toEqual([
        { number: null, aci: ACI },
      ]);
      expectDeclared(
        'src/main/java/org/asamk/signal/commands/ListAccountsCommand.java',
        47,
        /record JsonAccount\(String number, String aci\)/,
      );
    });

    it('listDevices rows are {id, name, createdTimestamp, lastSeenTimestamp} (ListDevicesCommand.java:67)', () => {
      expectDeclared(
        'src/main/java/org/asamk/signal/commands/ListDevicesCommand.java',
        67,
        /record JsonDevice\(long id, String name, long createdTimestamp, long lastSeenTimestamp\)/,
      );
      const verified = verifySignalDevices(
        parseSignalConfig({
          accountMode: 'personal',
          socketPath: '/home/ivo/.cache/talon-signal-smoke/bridge/signal.sock',
          account: NUMBER,
          accountUuid: ACI,
          deviceId: 2,
          deviceCreatedTimestamp: 2000,
          allowedDmPeers: [PEER],
          allowedSenders: [PEER],
          allowedGroups: [GROUP],
        }).unwrapOr(undefined) as never,
        [
          { id: 1, name: 'phone', createdTimestamp: 1000, lastSeenTimestamp: 1 },
          { id: 2, name: 'talon', createdTimestamp: 2000, lastSeenTimestamp: 1 },
        ],
        1,
        3000,
      );
      expect(verified.isOk()).toBe(true);
    });

    it('listContacts rows expose uuid, isBlocked, unregistered, messageExpirationTime (JsonContact.java:12,23,25,27)', () => {
      const contact = 'src/main/java/org/asamk/signal/json/JsonContact.java';
      expectDeclared(contact, 12, /String uuid/);
      expectDeclared(contact, 23, /boolean isBlocked/);
      expectDeclared(contact, 25, /int messageExpirationTime/);
      expectDeclared(contact, 27, /boolean unregistered/);
      const target = validateSignalTargetMetadata(
        { kind: 'dm', accountUuid: ACI, peerUuid: PEER },
        [
          {
            uuid: PEER,
            number: null,
            isBlocked: false,
            unregistered: false,
            messageExpirationTime: 0,
          },
        ],
      );
      expect(target.isOk()).toBe(true);
    });

    it('listGroups rows expose id, members, permissions and isTerminated (ListGroupsCommand.java:153,164,166,168)', () => {
      const groups = 'src/main/java/org/asamk/signal/commands/ListGroupsCommand.java';
      expectDeclared(groups, 152, /record JsonGroup\(/);
      expectDeclared(groups, 153, /String id,/);
      expectDeclared(groups, 164, /permissionAddMember/);
      expectDeclared(groups, 166, /permissionSendMessage/);
      expectDeclared(groups, 168, /boolean isTerminated/);
      const target = validateSignalTargetMetadata(
        { kind: 'group', accountUuid: ACI, groupId: GROUP },
        [
          {
            id: GROUP,
            name: 'smoke group',
            description: '',
            isMember: true,
            isBlocked: false,
            messageExpirationTime: 0,
            members: [{ number: null, uuid: ACI, isAdmin: false }],
            pendingMembers: [],
            requestingMembers: [],
            admins: [],
            banned: [],
            permissionAddMember: 'ONLY_ADMINS',
            permissionEditDetails: 'ONLY_ADMINS',
            permissionSendMessage: 'EVERY_MEMBER',
            isTerminated: false,
          },
        ],
      );
      expect(target.isOk()).toBe(true);
    });

    it('send requests use recipient, groupId or noteToSelf (man:156-158,162-164; SendCommand.java:52,132)', () => {
      const man = 'man/signal-cli-jsonrpc.5.adoc';
      expectInWindow(man, 156, 156, /"method":"send","params":\{"recipient":\["\+YYY"\]/);
      expectInWindow(man, 162, 162, /"method":"send","params":\{"groupId":"GROUP_ID_BASE64"/);
      // Note to Self is the camelCase form of the CLI --note-to-self flag (SendCommand.java:52,132).
      expectDeclared(
        'src/main/java/org/asamk/signal/commands/SendCommand.java',
        52,
        /"--note-to-self"/,
      );
      expectDeclared(
        'src/main/java/org/asamk/signal/commands/SendCommand.java',
        132,
        /ns\.getBoolean\("note-to-self"\)/,
      );
    });

    it('send result is {timestamp, results[{recipientAddress,groupId,type}]} (SendMessageResultUtils.java:38; JsonSendMessageResult.java:11-14; JsonRecipientAddress.java:10)', () => {
      expectDeclared(
        'src/main/java/org/asamk/signal/util/SendMessageResultUtils.java',
        38,
        /"timestamp".*"results"/,
      );
      expectDeclared(
        'src/main/java/org/asamk/signal/json/JsonSendMessageResult.java',
        11,
        /record JsonSendMessageResult\(/,
      );
      expectDeclared(
        'src/main/java/org/asamk/signal/json/JsonSendMessageResult.java',
        12,
        /JsonRecipientAddress recipientAddress/,
      );
      expectDeclared(
        'src/main/java/org/asamk/signal/json/JsonSendMessageResult.java',
        13,
        /String groupId/,
      );
      expectDeclared(
        'src/main/java/org/asamk/signal/json/JsonSendMessageResult.java',
        14,
        /Type type/,
      );
      expectDeclared(
        'src/main/java/org/asamk/signal/json/JsonRecipientAddress.java',
        10,
        /record JsonRecipientAddress\(String uuid, String number, String username\)/,
      );
      const evidence = parseSignalSendEvidence({
        timestamp: 1_700_000_000_000,
        results: [
          { recipientAddress: { uuid: PEER, number: null, username: null }, type: 'SUCCESS' },
        ],
      });
      expect(evidence).toMatchObject({ complete: true, timestampValid: true });
    });

    it('text limit is 2000 UTF-8 bytes (ServiceConfig.java:24; signal-config.ts chunk bound)', () => {
      expectDeclared(
        'lib/src/main/java/org/asamk/signal/manager/config/ServiceConfig.java',
        24,
        /MAX_MESSAGE_SIZE_BYTES = 2000/,
      );
    });

    it('application error codes match the pinned handler (SignalJsonRpcCommandHandler.java:40-44)', () => {
      const handler = 'src/main/java/org/asamk/signal/jsonrpc/SignalJsonRpcCommandHandler.java';
      expectDeclared(handler, 40, /USER_ERROR = -1/);
      expectDeclared(handler, 41, /IO_ERROR = -3/);
      expectDeclared(handler, 42, /UNTRUSTED_KEY_ERROR = -4/);
      expectDeclared(handler, 43, /RATELIMIT_ERROR = -5/);
      expectDeclared(handler, 44, /CAPTCHA_REJECTED_ERROR = -6/);
    });
  });
});

/**
 * The fixtures below are the SAME builders the packaged fake bridge serves. Each is serialized
 * as the bridge would write it, then parsed by the production wire parser, normalized and
 * evaluated by the production inbound policy, so a drifting fake fails here.
 */
describe('shared fixtures through the production parser and inbound policy', () => {
  const OTHER_DEVICE_TS = 3_000;
  const devices = [
    { id: 1, name: 'phone', createdTimestamp: 1000, lastSeenTimestamp: 1 },
    { id: 2, name: 'talon', createdTimestamp: 2000, lastSeenTimestamp: 1 },
  ];
  const me = { uuid: ACI, number: NUMBER };
  const peer = { uuid: PEER, number: null };

  function build(mode: 'personal' | 'dedicated', accountSelector: string) {
    const config = parseSignalConfig({
      accountMode: mode,
      socketPath: '/home/ivo/.cache/talon-signal-smoke/bridge/signal.sock',
      account: accountSelector,
      accountUuid: ACI,
      deviceId: mode === 'personal' ? 2 : 1,
      ...(mode === 'personal' ? { deviceCreatedTimestamp: 2000 } : {}),
      allowedDmPeers: [PEER],
      allowedSenders: [PEER],
      allowedGroups: [GROUP],
      triggerPrefix: '!talon',
    })._unsafeUnwrap();
    const registry = SignalDeviceRegistry.create(1, [config])._unsafeUnwrap();
    const rows = fixtures.listDevicesRows(
      mode === 'personal' ? devices : [{ ...devices[1], id: 1, createdTimestamp: 1000 }],
    );
    registry
      .publish(verifySignalDevices(config, rows as never, 1, 1_000)._unsafeUnwrap())
      ._unsafeUnwrap();
    return { config, registry };
  }

  /** Serialize like the bridge, parse like the connector, then run the production policy. */
  function admit(
    mode: 'personal' | 'dedicated',
    selector: string,
    aliases: readonly string[],
    number: string | null,
    envelope: unknown,
  ) {
    const { config, registry } = build(mode, selector);
    const frame = parseSignalRpcFrame(
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'receive',
          params: fixtures.receiveParams({ subscription: 5, number, aci: ACI, envelope }),
        }),
      ),
    )._unsafeUnwrap();
    if (frame.kind !== 'notification') throw new Error('expected notification');
    const event = parseSignalReceiveNotification(frame.params);
    expect(event?.account).toBe(number ?? ACI);
    const context: SignalInboundContext = {
      config,
      channelName: 'signal-smoke',
      generation: 1,
      connectionGeneration: 1,
      subscription: 5,
      aliases,
      registry: registry.snapshot(),
      now: 2_000,
    };
    return normalizeSignalReceive(frame.params, 1, context).andThen((candidate) =>
      evaluateSignalCandidate(candidate, context),
    );
  }

  const dm = (message: string, device = 1) =>
    fixtures.dmEnvelope({ author: peer, device, message, timestamp: OTHER_DEVICE_TS });
  const group = (message: string) =>
    fixtures.groupEnvelope({
      author: peer,
      device: 1,
      message,
      timestamp: OTHER_DEVICE_TS,
      groupId: GROUP,
    });
  const sync = (device: number, destination: unknown, message: string, groupId?: string) =>
    fixtures.syncEnvelope({
      author: me,
      device,
      destination,
      message,
      timestamp: OTHER_DEVICE_TS,
      groupId,
    });

  it('admits a full DM and group envelope with the number-form account', () => {
    const aliases = [ACI, NUMBER];
    const directMessage = admit(
      'dedicated',
      NUMBER,
      aliases,
      NUMBER,
      dm('!talon hello'),
    )._unsafeUnwrap();
    expect(directMessage).toMatchObject({ kind: 'admit', event: { content: 'hello' } });
    expect(directMessage.event.externalThreadId).toContain(PEER);
    const groupMessage = admit(
      'dedicated',
      NUMBER,
      aliases,
      NUMBER,
      group('!talon hi group'),
    )._unsafeUnwrap();
    expect(groupMessage).toMatchObject({ kind: 'admit', event: { content: 'hi group' } });
    expect(groupMessage.event.externalThreadId).toContain(GROUP.replace(/=+$/, ''));
  });

  it('admits an ACI-only (numberless) account that reports the ACI', () => {
    const aliases = [ACI];
    const admitted = admit('dedicated', ACI, aliases, null, dm('!talon aci'))._unsafeUnwrap();
    expect(admitted.kind).toBe('admit');
  });

  it('a number-form account that listAccounts has not reported is an unknown alias, never silently admitted', () => {
    const held = admit('dedicated', NUMBER, [ACI], NUMBER, dm('!talon hello'))._unsafeUnwrap();
    expect(held.kind).toBe('alias');
  });

  it('admits personal Note to Self, linked-device DM and group commands from the sync transcript', () => {
    const aliases = [ACI, NUMBER];
    const noteToSelf = admit(
      'personal',
      NUMBER,
      aliases,
      NUMBER,
      sync(1, me, 'plain note'),
    )._unsafeUnwrap();
    expect(noteToSelf).toMatchObject({ kind: 'admit', event: { content: 'plain note' } });
    expect(noteToSelf.event.externalThreadId).toContain(ACI);
    const linkedDm = admit(
      'personal',
      NUMBER,
      aliases,
      NUMBER,
      sync(1, peer, '!talon from phone'),
    )._unsafeUnwrap();
    expect(linkedDm).toMatchObject({ kind: 'admit', event: { content: 'from phone' } });
    const linkedGroup = admit(
      'personal',
      NUMBER,
      aliases,
      NUMBER,
      sync(1, undefined, '!talon in group', GROUP),
    )._unsafeUnwrap();
    expect(linkedGroup).toMatchObject({ kind: 'admit', event: { content: 'in group' } });
    expect(linkedGroup.event.externalThreadId).toContain(GROUP.replace(/=+$/, ''));
  });

  it('excludes the bridge device echo, dedicated own transcript, strangers and untriggered text', () => {
    const aliases = [ACI, NUMBER];
    const echo = admit('personal', NUMBER, aliases, NUMBER, sync(2, me, 'Reply to something'));
    expect(echo.isErr() && echo.error.reason).toBe('BOT_OUTPUT');
    const dedicatedEcho = admit('dedicated', NUMBER, aliases, NUMBER, sync(1, peer, '!talon echo'));
    expect(dedicatedEcho.isErr() && dedicatedEcho.error.reason).toBe('BOT_OUTPUT');
    const stranger = admit(
      'dedicated',
      NUMBER,
      aliases,
      NUMBER,
      fixtures.dmEnvelope({
        author: { uuid: '9f8e7d6c-1111-4222-8333-444455556666', number: null },
        device: 1,
        message: '!talon hi',
        timestamp: OTHER_DEVICE_TS,
      }),
    );
    expect(stranger.isErr() && stranger.error.reason).toBe('UNSELECTED');
    const untriggered = admit('dedicated', NUMBER, aliases, NUMBER, dm('no prefix'));
    expect(untriggered.isErr() && untriggered.error.reason).toBe('EMPTY_TEXT');
  });

  it('a receive-fault notification is excluded without blocking (JsonReceiveMessageHandler.java:27-29)', () => {
    const params = fixtures.receiveParams({
      subscription: 5,
      number: NUMBER,
      aci: ACI,
      exception: fixtures.receiveException('fault'),
    });
    const frame = parseSignalRpcFrame(
      Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'receive', params })),
    )._unsafeUnwrap();
    expect(
      frame.kind === 'notification' && parseSignalReceiveNotification(frame.params),
    ).toMatchObject({
      hasException: true,
    });
  });

  it('the all-rate-limited send error parses to RATE_LIMIT_FAILURE evidence with retryAfter (SendMessageResultUtils.java:61-65; SignalJsonRpcCommandHandler.java:43,261,290)', () => {
    expectDeclared(
      'src/main/java/org/asamk/signal/jsonrpc/SignalJsonRpcCommandHandler.java',
      43,
      /RATELIMIT_ERROR = -5/,
    );
    expectDeclared(
      'src/main/java/org/asamk/signal/jsonrpc/SignalJsonRpcCommandHandler.java',
      290,
      /Map\.of\("response", result\[0\]\)/,
    );
    expectDeclared(
      'src/main/java/org/asamk/signal/json/JsonSendMessageResult.java',
      16,
      /Long retryAfterSeconds/,
    );
    const error = fixtures.rateLimitError({
      timestamp: 1_700_000_000_000,
      recipientUuid: PEER,
      retryAfterSeconds: 1,
    });
    const frame = parseSignalRpcFrame(
      Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'r1', error })),
    )._unsafeUnwrap();
    expect(frame.kind).toBe('failure');
    if (frame.kind !== 'failure') return;
    expect(frame.error.remoteCode).toBe('RATE_LIMIT');
    expect(frame.error.sendEvidence).toMatchObject({
      complete: true,
      results: [{ type: 'RATE_LIMIT_FAILURE', retryAfter: { kind: 'valid', seconds: 1 } }],
    });
  });

  it('the success send result is accepted as complete evidence for DM, group and Note to Self', () => {
    for (const input of [
      { timestamp: 1_700_000_000_000, recipientUuid: PEER },
      { timestamp: 1_700_000_000_000, recipientUuid: PEER, groupId: GROUP },
      { timestamp: 1_700_000_000_000, recipientUuid: ACI },
    ]) {
      expect(parseSignalSendEvidence(fixtures.sendSuccessResult(input))).toMatchObject({
        complete: true,
        timestampValid: true,
      });
    }
  });
});
