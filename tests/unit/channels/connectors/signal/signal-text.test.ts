import { describe, expect, it, expectTypeOf } from 'vitest';
import type { AgentOutput } from '../../../../../src/channels/channel-types.js';
import { stripMarkdown } from '../../../../../src/channels/format/markdown-converter.js';
import { SIGNAL_MAX_CHUNK_BYTES } from '../../../../../src/channels/connectors/signal/signal-config.js';
import type { SignalPreparedText } from '../../../../../src/channels/connectors/signal/signal-types.js';
import { prepareSignalText } from '../../../../../src/channels/connectors/signal/signal-text.js';
import { SignalDeliveryError } from '../../../../../src/core/errors/error-types.js';
import { SIGNAL_CHECKPOINT_TEXT_MAX_BYTES } from '../../../../../src/queue/signal-delivery-checkpoint.js';

const accountUuid = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const peerUuid = 'cccccccc-1111-2222-3333-dddddddddddd';
const self = `signal:v1:${accountUuid}:self`;
const dm = `signal:v1:${accountUuid}:dm:${peerUuid}`;
const group = `signal:v1:${accountUuid}:group:-_8`;

function prepare(body: string): SignalPreparedText {
  return prepareSignalText(self, { body }, accountUuid)._unsafeUnwrap();
}

function expectRefusal(
  result: ReturnType<typeof prepareSignalText>,
  reason: SignalDeliveryError['reason'],
): void {
  const error = result._unsafeUnwrapErr();
  expect(error).toBeInstanceOf(SignalDeliveryError);
  expect(error).toMatchObject({
    reason,
    outcome: 'NOT_SENT',
    currentChunkAcceptance: 'unwritten',
    acceptedChunks: 0,
    successCount: 0,
    failureCount: 0,
    retryScope: 'none',
    providerRetryable: false,
    message: `Signal delivery failed: ${reason}`,
  });
  expect(error.cause).toBeUndefined();
  expect(result).not.toHaveProperty('value');
}

describe('prepareSignalText destination contract', () => {
  it('consumes the existing AgentOutput and SignalPreparedText types', () => {
    expectTypeOf<typeof prepareSignalText>().parameter(1).toEqualTypeOf<AgentOutput>();
    expectTypeOf<ReturnType<typeof prepare>>().toEqualTypeOf<SignalPreparedText>();
  });

  it.each([
    [self, { kind: 'self', accountUuid }],
    [dm, { kind: 'dm', accountUuid, peerUuid }],
    [group, { kind: 'group', accountUuid, groupId: '+/8=' }],
  ])(
    'prepares canonical account-scoped destination %s without selecting/authorizing it',
    (id, destination) => {
      const prepared = prepareSignalText(id, { body: 'hello' }, accountUuid)._unsafeUnwrap();
      expect(prepared).toEqual({ destination, chunks: ['hello'] });
    },
  );

  it.each([
    '',
    'private-destination',
    ` signal:v1:${accountUuid}:self`,
    `${self}\n`,
    `signal:v2:${accountUuid}:self`,
    `signal:v1:${accountUuid.toUpperCase()}:self`,
    `${self}:extra`,
    `signal:v1:${accountUuid}:dm:${peerUuid.toUpperCase()}`,
    `signal:v1:${accountUuid}:dm:+12025550123`,
    `signal:v1:${accountUuid}:group:+/8=`,
    `signal:v1:${accountUuid}:group:-_8=`,
    `signal:v1:${accountUuid}:group:-_9`,
    `signal:v1:${accountUuid}:group:`,
  ])('refuses malformed or noncanonical destination %j with no private cause', (id) => {
    expectRefusal(
      prepareSignalText(id, { body: 'private body' }, accountUuid),
      'INVALID_DESTINATION',
    );
  });

  it.each([
    `signal:v1:${peerUuid}:self`,
    `signal:v1:${peerUuid}:dm:${accountUuid}`,
    `signal:v1:${peerUuid}:group:-_8`,
  ])('refuses a destination saved for a replaced account: %s', (id) => {
    expectRefusal(prepareSignalText(id, { body: 'private body' }, accountUuid), 'ACCOUNT_MISMATCH');
  });

  it('uses the existing expected-account normalization without relaxing external ID canonicality', () => {
    expect(prepareSignalText(self, { body: 'hello' }, accountUuid.toUpperCase()).isOk()).toBe(true);
    expectRefusal(
      prepareSignalText(self, { body: 'hello' }, 'invalid-account'),
      'ACCOUNT_MISMATCH',
    );
  });
});

describe('prepareSignalText attachment-first refusal', () => {
  it('rejects the whole mixed payload before inspecting the body or destination', () => {
    const output: AgentOutput = {
      get body(): string {
        throw new Error('Body must not be read for an unsupported attachment payload');
      },
      attachments: [{ filename: 'private.txt', mimeType: 'text/plain', data: 'private', size: 7 }],
    };
    expectRefusal(
      prepareSignalText('invalid-destination', output, accountUuid),
      'UNSUPPORTED_ATTACHMENT',
    );
  });

  it.each(['', 'a'.repeat(4_001), '\ud800', 'a'.repeat(SIGNAL_CHECKPOINT_TEXT_MAX_BYTES + 1)])(
    'returns no partial text preparation for attachments (case %#)',
    (body) => {
      expectRefusal(
        prepareSignalText(
          self,
          {
            body,
            attachments: [
              {
                filename: 'empty.bin',
                mimeType: 'application/octet-stream',
                data: Buffer.alloc(0),
                size: 0,
              },
            ],
          },
          accountUuid,
        ),
        'UNSUPPORTED_ATTACHMENT',
      );
    },
  );

  it('accepts an empty attachment list and leaves the caller-owned payload unchanged', () => {
    const output: AgentOutput = { body: '**hello**', attachments: [] };
    Object.freeze(output.attachments);
    Object.freeze(output);
    expect(prepareSignalText(self, output, accountUuid)._unsafeUnwrap().chunks).toEqual(['hello']);
    expect(output).toEqual({ body: '**hello**', attachments: [] });
  });
});

// Source conformance, NOT live Signal evidence: signal-cli v0.14.9,
// commit 3997429779095ff3a2d64c877126e84fce9852aa.
// lib/src/main/java/org/asamk/signal/manager/config/ServiceConfig.java:24 sets 2000 bytes.
// lib/src/main/java/org/asamk/signal/manager/internal/ManagerImpl.java:942-975,
// especially 947-959: >2000 UTF8 bytes trims text and uploads a long-text attachment.
describe('prepareSignalText source-pinned UTF8 byte boundaries', () => {
  it('keeps exactly 2000 bytes intact, splitting only above the bridge ceiling', () => {
    expect(SIGNAL_MAX_CHUNK_BYTES).toBe(2_000);
    expect(prepare('a'.repeat(2_000)).chunks).toEqual(['a'.repeat(2_000)]);
    expect(prepare('a'.repeat(2_001)).chunks).toEqual(['a'.repeat(2_000), 'a']);
    expect(prepare('😀'.repeat(500)).chunks).toEqual(['😀'.repeat(500)]);
    expect(prepare('😀'.repeat(501)).chunks).toEqual(['😀'.repeat(500), '😀']);
  });

  it.each([
    ['é', 1_998],
    ['é', 1_999],
    ['漢', 1_997],
    ['漢', 1_998],
    ['漢', 1_999],
    ['😀', 1_996],
    ['😀', 1_997],
    ['😀', 1_998],
    ['😀', 1_999],
  ])('keeps a %s codepoint whole after %i ASCII bytes', (point, prefixBytes) => {
    const prefix = 'a'.repeat(prefixBytes);
    const chunks = prepare(`${prefix}${point}z`).chunks;
    const pointFits = prefixBytes + Buffer.byteLength(point, 'utf8') <= 2_000;
    expect(chunks[0]).toBe(pointFits ? `${prefix}${point}` : prefix);
    expect(chunks.join('')).toBe(`${prefix}${point}z`);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(2_000);
      expect(Buffer.from(chunk, 'utf8').toString('utf8')).toBe(chunk);
    }
  });

  it('preserves text order and every codepoint across many mixed-width chunks', () => {
    const body = 'Aé漢😀e\u0301👩‍👩‍👧‍👦\n'.repeat(800) + 'end';
    const chunks = prepare(body).chunks;
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.join('')).toBe(body);
    expect(chunks.flatMap((chunk) => [...chunk])).toEqual([...body]);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeGreaterThan(0);
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(2_000);
      expect(Buffer.from(chunk, 'utf8').toString('utf8')).toBe(chunk);
    }
  });

  it('formats once before chunking and never formats or trims individual saved chunks', () => {
    const body = `${'a'.repeat(1_999)}\n# # heading\n\n**bold** [label](https://example.invalid)\n\n\nend`;
    const prepared = prepare(body);
    expect(prepared.chunks[0]).toBe(`${'a'.repeat(1_999)}\n`);
    expect(prepared.chunks[1]).toBe('# heading\n\nbold label\n\nend');
    expect(prepared.chunks.join('')).toBe(stripMarkdown(body));
    expect(stripMarkdown(prepared.chunks[1])).not.toBe(prepared.chunks[1]);
    expect(prepare(`${'a'.repeat(2_000)} \n tail`).chunks).toEqual(['a'.repeat(2_000), ' \n tail']);
  });

  it('returns fixed immutable preparation without attaching model actions or trusted send metadata', () => {
    const output: AgentOutput = {
      body: '# # hello',
      actions: [{ type: 'button', label: 'private label', value: 'private value' }],
      trustedDelivery: { queueItemId: 'queue', deliveryId: 'delivery', purpose: 'explicit' },
    };
    const prepared = prepareSignalText(self, output, accountUuid)._unsafeUnwrap();
    expect(prepared).toEqual({ destination: { kind: 'self', accountUuid }, chunks: ['# hello'] });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.destination)).toBe(true);
    expect(Object.isFrozen(prepared.chunks)).toBe(true);
  });
});

describe('prepareSignalText checkpoint-compatible text admission', () => {
  it.each(['', ' \t\n ', '---', '#   ', '![   ](https://example.invalid)'])(
    'refuses empty formatted text %j without synthesizing a chunk',
    (body) => {
      expectRefusal(prepareSignalText(self, { body }, accountUuid), 'INVALID_RESPONSE');
    },
  );

  it.each([
    '\ud800',
    '\udfff',
    'valid\ud800tail',
    '\ud800\ud800',
    '\udfff\ud800',
    '[label](https://example.invalid/\ud800)',
  ])('refuses ill-formed original UTF16 even when formatting would remove it (case %#)', (body) => {
    expectRefusal(prepareSignalText(self, { body }, accountUuid), 'INVALID_RESPONSE');
  });

  it.each([
    'a'.repeat(SIGNAL_CHECKPOINT_TEXT_MAX_BYTES),
    '😀'.repeat(SIGNAL_CHECKPOINT_TEXT_MAX_BYTES / 4),
  ])('accepts the existing inclusive 1MiB original/formatted ceiling (case %#)', (body) => {
    expect(SIGNAL_CHECKPOINT_TEXT_MAX_BYTES).toBe(1_048_576);
    const chunks = prepare(body).chunks;
    expect(chunks.join('')).toBe(body);
    expect(chunks.reduce((bytes, chunk) => bytes + Buffer.byteLength(chunk, 'utf8'), 0)).toBe(
      SIGNAL_CHECKPOINT_TEXT_MAX_BYTES,
    );
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 2_000)).toBe(true);
  });

  it.each([
    'a'.repeat(SIGNAL_CHECKPOINT_TEXT_MAX_BYTES + 1),
    '😀'.repeat(SIGNAL_CHECKPOINT_TEXT_MAX_BYTES / 4) + 'a',
    `[small](https://example.invalid/${'a'.repeat(SIGNAL_CHECKPOINT_TEXT_MAX_BYTES)})`,
  ])(
    'refuses oversize original text instead of truncating or admitting a shortened formatter result (case %#)',
    (body) => {
      expectRefusal(prepareSignalText(self, { body }, accountUuid), 'OUTPUT_TOO_LARGE');
    },
  );
});
