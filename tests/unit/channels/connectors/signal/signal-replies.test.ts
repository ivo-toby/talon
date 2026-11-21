import { describe, expect, it } from 'vitest';
import {
  SignalMessageTargetError,
  buildSignalQuoteParams,
  buildSignalReactionParams,
  parseSignalMessageId,
  resolveSignalMessageAddress,
  signalMessageIdFromTimestamp,
  signalSendReceipt,
} from '../../../../../src/channels/connectors/signal/signal-replies.js';

// Source citations are pinned to signal-cli v0.14.9, commit
// 3997429779095ff3a2d64c877126e84fce9852aa, not live-device evidence.
// R/ = .wdd/epics/signal-channel/research/signal-cli-v0.14.9/
const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const peerUuid = 'cccccccc-1111-2222-3333-dddddddddddd';
const sentAt = 1_700_000_000_123;

describe('Signal message identity', () => {
  // R/src/main/java/org/asamk/signal/util/SendMessageResultUtils.java:38,55 —
  // a send result reports `timestamp`; JsonDataMessage.java:14 — an inbound
  // data message carries `long timestamp`.
  it('uses the sent timestamp, in decimal, as the external message id', () => {
    expect(signalMessageIdFromTimestamp(sentAt)._unsafeUnwrap()).toBe('1700000000123');
    expect(signalSendReceipt(sentAt)._unsafeUnwrap()).toEqual({
      externalMessageId: '1700000000123',
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '1700000000123', null])(
    'rejects %j as a timestamp',
    (value) => {
      const result = signalMessageIdFromTimestamp(value);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SignalMessageTargetError);
      expect(result._unsafeUnwrapErr().reason).toBe('INVALID_TIMESTAMP');
      expect(signalSendReceipt(value).isErr()).toBe(true);
    },
  );

  it('round-trips an external message id back to its timestamp', () => {
    expect(parseSignalMessageId('1700000000123')._unsafeUnwrap()).toBe(sentAt);
  });

  it.each(['', '0', '01700000000123', '-5', '1.5', '17e11', ' 1700000000123', 'wamid.X', 4521])(
    'rejects the non-canonical id %j',
    (value) => {
      expect(parseSignalMessageId(value)._unsafeUnwrapErr().reason).toBe('INVALID_TIMESTAMP');
    },
  );

  it('rejects an id beyond the safe integer range', () => {
    expect(parseSignalMessageId('99999999999999999999').isErr()).toBe(true);
  });
});

describe('resolveSignalMessageAddress', () => {
  it('addresses a message Talon sent by the bridge account', () => {
    expect(
      resolveSignalMessageAddress(
        { externalMessageId: '1700000000123', fromSelf: true, author: peerUuid },
        accountUuid,
      )._unsafeUnwrap(),
    ).toEqual({ authorUuid: accountUuid, timestamp: sentAt });
  });

  it("addresses someone else's message by the author from the ledger, lower-cased", () => {
    expect(
      resolveSignalMessageAddress(
        { externalMessageId: '1700000000123', fromSelf: false, author: peerUuid.toUpperCase() },
        accountUuid,
      )._unsafeUnwrap(),
    ).toEqual({ authorUuid: peerUuid, timestamp: sentAt });
  });

  it('treats an absent fromSelf as not Talon', () => {
    expect(
      resolveSignalMessageAddress(
        { externalMessageId: '1700000000123' },
        accountUuid,
      )._unsafeUnwrapErr().reason,
    ).toBe('MISSING_AUTHOR');
  });

  it('rejects a missing, empty or non-UUID author', () => {
    const base = { externalMessageId: '1700000000123', fromSelf: false };
    expect(resolveSignalMessageAddress(base, accountUuid)._unsafeUnwrapErr().reason).toBe(
      'MISSING_AUTHOR',
    );
    expect(
      resolveSignalMessageAddress({ ...base, author: '' }, accountUuid)._unsafeUnwrapErr().reason,
    ).toBe('MISSING_AUTHOR');
    expect(
      resolveSignalMessageAddress(
        { ...base, author: '+31612345678' },
        accountUuid,
      )._unsafeUnwrapErr().reason,
    ).toBe('INVALID_AUTHOR');
  });

  it('rejects an invalid bridge account for a self target', () => {
    expect(
      resolveSignalMessageAddress(
        { externalMessageId: '1700000000123', fromSelf: true },
        'not-a-uuid',
      )._unsafeUnwrapErr().reason,
    ).toBe('INVALID_AUTHOR');
  });

  it('rejects a target id from another channel before looking at the author', () => {
    expect(
      resolveSignalMessageAddress(
        { externalMessageId: 'wamid.X', author: peerUuid },
        accountUuid,
      )._unsafeUnwrapErr().reason,
    ).toBe('INVALID_TIMESTAMP');
  });
});

describe('buildSignalQuoteParams', () => {
  // R/man/signal-cli-jsonrpc.5.adoc:95 — parameter names are the camelCase
  // form of the CLI flags. R/src/main/java/org/asamk/signal/commands/
  // SendCommand.java:82-86 declares --quote-timestamp, --quote-author and
  // --quote-message.
  it('maps a reply target to quoteTimestamp, quoteAuthor and quoteMessage', () => {
    expect(
      buildSignalQuoteParams(
        {
          externalMessageId: '1700000000123',
          fromSelf: false,
          author: peerUuid,
          text: 'can you check this?',
        },
        accountUuid,
      )._unsafeUnwrap(),
    ).toEqual({
      quoteTimestamp: sentAt,
      quoteAuthor: peerUuid,
      quoteMessage: 'can you check this?',
    });
  });

  // SendCommand.java:225 — `quoteMessage == null ? "" : quoteMessage`.
  it('sends an empty quoteMessage when the ledger has no text', () => {
    expect(
      buildSignalQuoteParams(
        { externalMessageId: '1700000000123', fromSelf: true },
        accountUuid,
      )._unsafeUnwrap(),
    ).toEqual({ quoteTimestamp: sentAt, quoteAuthor: accountUuid, quoteMessage: '' });
  });

  // SendCommand.java:205-208 — a quote timestamp without an author is an
  // error, so a target without one must never produce quote parameters.
  it('refuses to quote without an author', () => {
    expect(
      buildSignalQuoteParams({ externalMessageId: '1700000000123' }, accountUuid).isErr(),
    ).toBe(true);
  });
});

describe('buildSignalReactionParams', () => {
  // R/man/signal-cli.1.adoc:615-644 — sendReaction takes --emoji,
  // --target-author, --target-timestamp and --remove.
  it('maps a target and emoji to the sendReaction parameters', () => {
    expect(
      buildSignalReactionParams(
        { externalMessageId: '1700000000123', fromSelf: false, author: peerUuid },
        '👍',
        accountUuid,
      )._unsafeUnwrap(),
    ).toEqual({
      emoji: '👍',
      targetAuthor: peerUuid,
      targetTimestamp: sentAt,
      remove: false,
    });
  });

  it('reacts to a message Talon sent with the bridge account as target author', () => {
    expect(
      buildSignalReactionParams(
        { externalMessageId: '1700000000123', fromSelf: true },
        '🎉',
        accountUuid,
      )._unsafeUnwrap().targetAuthor,
    ).toBe(accountUuid);
  });

  // signal-cli.1.adoc:634-635 — "should be a single unicode grapheme cluster".
  it.each(['❤️', '👍🏽', '👨‍💻', '🤷‍♂️'])('accepts the single grapheme %s', (emoji) => {
    expect(
      buildSignalReactionParams(
        { externalMessageId: '1700000000123', fromSelf: true },
        emoji,
        accountUuid,
      )._unsafeUnwrap().emoji,
    ).toBe(emoji);
  });

  it.each(['👍👍', 'ok', '👍 ', 'thumbs up'])('rejects %j as not a single grapheme', (emoji) => {
    expect(
      buildSignalReactionParams(
        { externalMessageId: '1700000000123', fromSelf: true },
        emoji,
        accountUuid,
      )._unsafeUnwrapErr().reason,
    ).toBe('INVALID_EMOJI');
  });

  // SendReactionCommand.java is not in the pinned snapshot, so the --remove
  // requirements cannot be cited; removal stays refused until it is pinned.
  it('refuses removal (empty emoji) until the removal contract is pinned', () => {
    expect(
      buildSignalReactionParams(
        { externalMessageId: '1700000000123', fromSelf: true },
        '',
        accountUuid,
      )._unsafeUnwrapErr().reason,
    ).toBe('REMOVE_UNSUPPORTED');
  });

  it('propagates an unresolvable target', () => {
    expect(
      buildSignalReactionParams(
        { externalMessageId: 'abc', fromSelf: true },
        '👍',
        accountUuid,
      )._unsafeUnwrapErr().reason,
    ).toBe('INVALID_TIMESTAMP');
  });
});
