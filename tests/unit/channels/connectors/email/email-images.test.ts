/**
 * Unit tests for Email image attachment ingestion (TASK-009).
 *
 * The parsed-shape fixtures below are produced by the ACTUAL installed
 * MailParser (3.9.37, pinned by package-lock) via `simpleParser`, matching
 * contract inventory E5: `parsed.attachments[]` carries `filename?`,
 * `contentType`, `contentDisposition?`, `size`, `content: Buffer`,
 * `contentId`/`cid?`, `related?`. The inline/related classification tests are
 * driven by REAL parser output, not invented shapes:
 *
 * - `multipart/related` CID part  → contentDisposition 'inline' + related=true
 * - Content-ID with `attachment` disposition OUTSIDE multipart/related →
 *   contentId/cid present but NO related flag → ordinary, eligible.
 *
 * Guarantees exercised here:
 * 1. Authorization BEFORE staging: a denied sender or failed DMARC produces
 *    ZERO events and ZERO attachment payloads, even for image-only mail.
 * 2. Inline/related parts and absent/non-image MIME are excluded BEFORE
 *    slots (no Image, no event `attachments` field).
 * 3. Shared selection caps (maxPerMessage, maxInputBytes measured on the
 *    ACTUAL Buffer length) govern what is staged; slots never backfill.
 * 4. Body text is preserved; an authorized attachments-only message emits an
 *    event when slots are consumed.
 * 5. Raw hygiene: attachment Buffers (staged, rejected, and excluded alike)
 *    are stripped from `event.raw`; payloads travel ONLY in the explicit
 *    `attachments` field.
 * 6. Webhook boundary: `null`/non-object/non-Buffer entries and non-string
 *    dispositions are skipped or treated as absent — never thrown on.
 */

import { describe, beforeEach, it, expect, vi } from 'vitest';
import { simpleParser } from 'mailparser';
import pino from 'pino';
import { EmailConnector } from '../../../../../src/channels/connectors/email/email-connector.js';
import type {
  EmailConnectorOptions,
} from '../../../../../src/channels/connectors/email/email-connector.js';
import type {
  EmailAttachment,
  EmailConfig,
  ParsedEmail,
} from '../../../../../src/channels/connectors/email/email-types.js';
import { mapParsedMail } from '../../../../../src/channels/connectors/email/email-imap-client.js';
import {
  DEFAULT_EMAIL_IMAGE_SETTINGS,
  isInlineOrRelatedEmailAttachment,
  planEmailMedia,
  planHasImageSlots,
  stageEmailMedia,
} from '../../../../../src/channels/connectors/email/email-media.js';
import type { ImageSelectionSettings } from '../../../../../src/images/image-selection.js';
import type { InboundEvent } from '../../../../../src/channels/channel-types.js';

// The media pipeline is spied (delegating to the REAL implementations) so the
// authorization tests can assert ZERO planning/staging CALLS for denied mail —
// not merely zero events. Without the call-level assertion, moving
// `planEmailMedia`/`stageEmailMedia` above the sender/DMARC gates would still
// pass every event-level check.
vi.mock('../../../../../src/channels/connectors/email/email-media.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../../../src/channels/connectors/email/email-media.js')
  >();
  return {
    ...actual,
    planEmailMedia: vi.fn(actual.planEmailMedia),
    stageEmailMedia: vi.fn(actual.stageEmailMedia),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function defaultConfig(overrides?: Partial<EmailConfig>): EmailConfig {
  return {
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpUser: 'user@example.com',
    smtpPass: 'secret',
    smtpSecure: false,
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapUser: 'user@example.com',
    imapPass: 'secret',
    imapSecure: true,
    fromAddress: 'bot@example.com',
    pollingIntervalMs: 50,
    ...overrides,
  };
}

function makeConnector(
  configOverrides?: Partial<EmailConfig>,
  options?: EmailConnectorOptions,
): EmailConnector {
  return new EmailConnector(defaultConfig(configOverrides), 'test-email', silentLogger(), options);
}

/** Build a minimal ParsedEmail. */
function makeEmail(overrides?: Partial<ParsedEmail>): ParsedEmail {
  return {
    messageId: '<msg-001@example.com>',
    from: 'alice@example.com',
    to: 'bot@example.com',
    subject: 'Hello',
    text: 'Hi bot!',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

/** Build a forwarded EmailAttachment (post-mapParsedMail shape). */
function attachment(overrides?: Partial<EmailAttachment>): EmailAttachment {
  return {
    contentType: 'image/jpeg',
    contentDisposition: 'attachment',
    filename: 'photo.jpg',
    size: 8,
    content: Buffer.from('JPEGDATA'),
    ...overrides,
  };
}

function settings(overrides?: Partial<ImageSelectionSettings>): ImageSelectionSettings {
  return { maxInputBytes: 1_048_576, maxPerMessage: 5, ...overrides };
}

/** Capture events dispatched by the connector. */
function captureHandler(): { events: InboundEvent[]; handler: (e: InboundEvent) => void } {
  const events: InboundEvent[] = [];
  return { events, handler: (e) => events.push(e) };
}

/** A passing, trusted DMARC result set for sender alice@example.com. */
const TRUSTED_AR = ['mx.example.com; dmarc=pass (p=none; adkim=r) header.from=example.com'];

// ---------------------------------------------------------------------------
// E5 fixtures parsed by the ACTUAL MailParser 3.9.37 (oracle)
// ---------------------------------------------------------------------------

/** Ordinary attached JPEG + text body (multipart/mixed). */
const MIME_ORDINARY = [
  'From: alice@example.com',
  'To: bot@example.com',
  'Subject: attached',
  'Message-ID: <e5-a@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BB"',
  '',
  '--BB',
  'Content-Type: text/plain',
  '',
  'body text here',
  '--BB',
  'Content-Type: image/jpeg; name="photo.jpg"',
  'Content-Disposition: attachment; filename="photo.jpg"',
  'Content-Transfer-Encoding: base64',
  '',
  b64('JPGDATA-A'),
  '--BB--',
  '',
].join('\r\n');

/** Inline CID image referenced from HTML inside multipart/related. */
const MIME_INLINE_RELATED = [
  'From: alice@example.com',
  'To: bot@example.com',
  'Subject: related',
  'Message-ID: <e5-b@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/related; boundary="RB"',
  '',
  '--RB',
  'Content-Type: text/html',
  '',
  '<p>hi</p><img src="cid:img1@x"/>',
  '--RB',
  'Content-Type: image/png; name="img1.png"',
  'Content-Disposition: inline; filename="img1.png"',
  'Content-ID: <img1@x>',
  'Content-Transfer-Encoding: base64',
  '',
  b64('PNGDATA-B'),
  '--RB--',
  '',
].join('\r\n');

/** Ordinary attachment that ALSO carries a Content-ID (disposition attachment,
 *  inside multipart/mixed — NOT multipart/related): content ID alone. */
const MIME_CID_BUT_ORDINARY = [
  'From: alice@example.com',
  'To: bot@example.com',
  'Subject: cid but ordinary',
  'Message-ID: <e5-c@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="CB"',
  '',
  '--CB',
  'Content-Type: text/plain',
  '',
  'body',
  '--CB',
  'Content-Type: image/webp; name="pic.webp"',
  'Content-Disposition: attachment; filename="pic.webp"',
  'Content-ID: <cid@y>',
  'Content-Transfer-Encoding: base64',
  '',
  b64('WEBPDATA-C'),
  '--CB--',
  '',
].join('\r\n');

/** PDF attachment + inline HTML part + image part with NO Content-Disposition. */
const MIME_MIXED_EXCLUSIONS = [
  'From: alice@example.com',
  'To: bot@example.com',
  'Subject: mixed',
  'Message-ID: <e5-d@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="DB"',
  '',
  '--DB',
  'Content-Type: text/plain',
  '',
  'body',
  '--DB',
  'Content-Type: application/pdf; name="doc.pdf"',
  'Content-Disposition: attachment; filename="doc.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  b64('PDFDATA'),
  '--DB',
  'Content-Type: text/html',
  'Content-Disposition: inline',
  'Content-Transfer-Encoding: base64',
  '',
  b64('<b>inline html</b>'),
  '--DB',
  'Content-Type: image/jpeg; name="no-disposition.jpg"',
  'Content-Transfer-Encoding: base64',
  '',
  b64('JPGDATA-D'),
  '--DB--',
  '',
].join('\r\n');

// ---------------------------------------------------------------------------
// Parsed-shape pinning against the ACTUAL installed MailParser (E5)
// ---------------------------------------------------------------------------

describe('MailParser 3.9.37 attachment shape pinning (E5 oracle)', () => {
  it('ordinary attachment exposes contentType, contentDisposition, filename, size and a Buffer content', async () => {
    const parsed = await simpleParser(MIME_ORDINARY);
    expect(parsed.attachments).toHaveLength(1);
    const at = parsed.attachments[0] as unknown as Record<string, unknown>;
    expect(at.contentType).toBe('image/jpeg');
    expect(at.contentDisposition).toBe('attachment');
    expect(at.filename).toBe('photo.jpg');
    expect(Buffer.isBuffer(at.content)).toBe(true);
    expect(at.size).toBe((at.content as Buffer).byteLength);
    expect(typeof at.checksum).toBe('string');
    // No content-id header on this part: contentId/cid/related stay absent.
    expect(at).not.toHaveProperty('contentId');
    expect(at).not.toHaveProperty('cid');
    expect(at).not.toHaveProperty('related');
  });

  it('multipart/related CID part is flagged inline AND related by the parser', async () => {
    const parsed = await simpleParser(MIME_INLINE_RELATED);
    expect(parsed.attachments).toHaveLength(1);
    const at = parsed.attachments[0] as unknown as Record<string, unknown>;
    expect(at.contentDisposition).toBe('inline');
    expect(at.related).toBe(true);
    expect(at.contentId).toBe('<img1@x>');
    expect(at.cid).toBe('img1@x');
  });

  it('Content-ID with attachment disposition OUTSIDE multipart/related sets NO related flag', async () => {
    const parsed = await simpleParser(MIME_CID_BUT_ORDINARY);
    expect(parsed.attachments).toHaveLength(1);
    const at = parsed.attachments[0] as unknown as Record<string, unknown>;
    expect(at.contentDisposition).toBe('attachment');
    expect(at.contentId).toBe('<cid@y>');
    expect(at.cid).toBe('cid@y');
    // THE pinned classification fact: presence of a content ID alone does not
    // set `related`, so the part follows ordinary document classification.
    expect(at).not.toHaveProperty('related');
  });

  it('non-image parts stay attachments; an inline text/html part is not an attachment at all', async () => {
    const parsed = await simpleParser(MIME_MIXED_EXCLUSIONS);
    const kinds = parsed.attachments.map((at) => at.contentType);
    expect(kinds).toEqual(['application/pdf', 'image/jpeg']);
    const [pdf, jpg] = parsed.attachments as unknown as Record<string, unknown>[];
    expect(pdf.contentDisposition).toBe('attachment');
    // No Content-Disposition header on the jpg part → the field is ABSENT,
    // which the connector classifies as ordinary (not inline).
    expect(jpg).not.toHaveProperty('contentDisposition');
  });
});

// ---------------------------------------------------------------------------
// Forwarding: mapParsedMail carries ONLY the needed attachment fields
// ---------------------------------------------------------------------------

describe('mapParsedMail attachment forwarding (minimal E5 fields)', () => {
  it('forwards filename/contentType/contentDisposition/size/content (+related) only', async () => {
    const parsed = await simpleParser(MIME_ORDINARY);
    const email = mapParsedMail(parsed, 42);
    expect(email.attachments).toHaveLength(1);
    const forwarded = email.attachments?.[0] as unknown as Record<string, unknown>;
    expect(Object.keys(forwarded).sort()).toEqual([
      'content',
      'contentDisposition',
      'contentType',
      'filename',
      'size',
    ]);
    expect(forwarded.contentType).toBe('image/jpeg');
    expect(Buffer.isBuffer(forwarded.content)).toBe(true);
    expect(forwarded.size).toBe(9);
  });

  it('carries the related flag for inline CID parts and never leaks contentId/cid/checksum/headers', async () => {
    const parsed = await simpleParser(MIME_INLINE_RELATED);
    const email = mapParsedMail(parsed, 43);
    const forwarded = email.attachments?.[0] as unknown as Record<string, unknown>;
    expect(forwarded.related).toBe(true);
    expect(forwarded.contentDisposition).toBe('inline');
    // Parser internals and content IDs are NOT forwarded: inline/related
    // exclusion provably cannot depend on a content ID downstream.
    expect(forwarded).not.toHaveProperty('contentId');
    expect(forwarded).not.toHaveProperty('cid');
    expect(forwarded).not.toHaveProperty('checksum');
    expect(forwarded).not.toHaveProperty('headers');
    expect(forwarded).not.toHaveProperty('partId');
    expect(forwarded).not.toHaveProperty('release');
  });

  it('omits the attachments field entirely when the message carried none', async () => {
    const parsed = await simpleParser(
      ['From: a@b.c', 'Subject: plain', '', 'no attachments here'].join('\r\n'),
    );
    const email = mapParsedMail(parsed, 44);
    expect(email).not.toHaveProperty('attachments');
  });
});

// ---------------------------------------------------------------------------
// Classification: inline / related / content-ID-alone
// ---------------------------------------------------------------------------

describe('isInlineOrRelatedEmailAttachment', () => {
  it('excludes disposition=inline (case/whitespace tolerant)', () => {
    expect(isInlineOrRelatedEmailAttachment(attachment({ contentDisposition: 'inline' }))).toBe(true);
    expect(isInlineOrRelatedEmailAttachment(attachment({ contentDisposition: ' Inline ' }))).toBe(true);
  });

  it('excludes related=true even when the disposition says attachment', () => {
    expect(isInlineOrRelatedEmailAttachment(attachment({ related: true }))).toBe(true);
  });

  it('keeps an ordinary attachment eligible; absence of disposition is NOT inline', () => {
    expect(isInlineOrRelatedEmailAttachment(attachment())).toBe(false);
    const noDisposition = attachment();
    delete noDisposition.contentDisposition;
    expect(isInlineOrRelatedEmailAttachment(noDisposition)).toBe(false);
  });

  it('classifies the REAL parser outputs: inline+related excluded, content-ID-alone ordinary', async () => {
    const inline = mapParsedMail(await simpleParser(MIME_INLINE_RELATED), 1);
    const cidOnly = mapParsedMail(await simpleParser(MIME_CID_BUT_ORDINARY), 2);
    expect(isInlineOrRelatedEmailAttachment(inline.attachments?.[0] as EmailAttachment)).toBe(true);
    expect(isInlineOrRelatedEmailAttachment(cidOnly.attachments?.[0] as EmailAttachment)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Planning + staging: exclusions, caps, source order
// ---------------------------------------------------------------------------

describe('planEmailMedia / stageEmailMedia', () => {
  it('stages an ordinary image attachment with the ACTUAL byte length', () => {
    const content = Buffer.from('REALBYTES0123456789');
    const plan = planEmailMedia(
      [attachment({ content, size: 999 })], // declared size is a LIE
      settings(),
    );
    expect(planHasImageSlots(plan)).toBe(true);
    const staged = stageEmailMedia(plan);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: content.byteLength,
    });
    expect((staged[0] as { data: Buffer }).data).toBe(content);
  });

  it('excludes inline, related, non-image and absent-MIME parts BEFORE slots', () => {
    const plan = planEmailMedia(
      [
        attachment({ contentDisposition: 'inline', filename: 'inline.png', contentType: 'image/png' }),
        attachment({ related: true, filename: 'related.png', contentType: 'image/png' }),
        attachment({ contentType: 'application/pdf', filename: 'doc.pdf' }),
        (() => {
          const a = attachment({ filename: 'mystery.bin' });
          delete a.contentType;
          return a;
        })(),
      ],
      settings(),
    );
    // Zero slots consumed → an attachments-only message would carry no
    // attachments field at all.
    expect(planHasImageSlots(plan)).toBe(false);
    expect(stageEmailMedia(plan)).toEqual([]);
    expect(plan.selection.excluded.length).toBe(4);
    expect(plan.selection.excluded.map((e) => e.exclusionReason)).toEqual([
      'inline_related',
      'inline_related',
      'non_image_mime',
      'non_image_mime',
    ]);
    expect(plan.selection.excluded.map((e) => e.sourcePosition)).toEqual([0, 1, 2, 3]);
  });

  it('stages a content-ID-only ordinary attachment (forwarded shape has no content ID at all)', async () => {
    const parsed = await simpleParser(MIME_CID_BUT_ORDINARY);
    const email = mapParsedMail(parsed, 7);
    const plan = planEmailMedia(email.attachments, settings());
    expect(planHasImageSlots(plan)).toBe(true);
    const staged = stageEmailMedia(plan);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      filename: 'pic.webp',
      mimeType: 'image/webp',
      size: Buffer.from('WEBPDATA-C').byteLength,
    });
  });

  it('rejects an unsupported IMAGE MIME post-slot as unsupported_mime (slot consumed, no staging)', () => {
    const plan = planEmailMedia([attachment({ contentType: 'image/heic', filename: 'x.heic' })], settings());
    expect(planHasImageSlots(plan)).toBe(true);
    expect(plan.selection.excluded).toEqual([]);
    const staged = stageEmailMedia(plan);
    expect(staged).toEqual([
      { kind: 'rejected', rejectionReason: 'unsupported_mime', filename: 'x.heic', mimeType: 'image/heic', size: 8, sourcePosition: 0 },
    ]);
    expect(staged[0]).not.toHaveProperty('data');
  });

  it('normalizes MIME case and parameters for eligibility and payload metadata', () => {
    const plan = planEmailMedia([attachment({ contentType: 'IMAGE/JPEG;charset=binary' })], settings());
    const staged = stageEmailMedia(plan);
    expect(staged[0]).toMatchObject({ mimeType: 'image/jpeg' });
  });

  it('rejects oversized payloads on their ACTUAL Buffer length even when the declared size is tiny', () => {
    const big = Buffer.alloc(5_000, 0x4a);
    const plan = planEmailMedia([attachment({ content: big, size: 10 })], settings({ maxInputBytes: 1_000 }));
    const staged = stageEmailMedia(plan);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ kind: 'rejected', rejectionReason: 'size_limit', sourcePosition: 0 });
    // The oversized bytes are NOT carried out — nothing can stage them.
    expect(staged[0]).not.toHaveProperty('data');
  });

  it('caps slots per message: items past maxPerMessage are rejected as count_limit without staging', () => {
    const plan = planEmailMedia(
      [
        attachment({ filename: 'a.jpg', content: Buffer.from('A') }),
        attachment({ filename: 'b.jpg', content: Buffer.from('B') }),
        attachment({ filename: 'c.jpg', content: Buffer.from('C') }),
      ],
      settings({ maxPerMessage: 2 }),
    );
    const staged = stageEmailMedia(plan);
    expect(staged.map((a) => ('kind' in a ? a.kind : 'payload'))).toEqual(['payload', 'payload', 'rejected']);
    expect(staged[2]).toMatchObject({ rejectionReason: 'count_limit', sourcePosition: 2 });
    expect(staged[2]).not.toHaveProperty('data');
  });

  it('never backfills a consumed slot: an oversized first item keeps slot 0 and the next item overflows', () => {
    const plan = planEmailMedia(
      [
        attachment({ filename: 'big.jpg', content: Buffer.alloc(2_000), size: 2_000 }),
        attachment({ filename: 'small.jpg', content: Buffer.from('S'), size: 1 }),
      ],
      settings({ maxInputBytes: 1_000, maxPerMessage: 1 }),
    );
    const staged = stageEmailMedia(plan);
    expect(staged.map((a) => ('rejectionReason' in a ? a.rejectionReason : 'payload'))).toEqual([
      'size_limit',
      'count_limit',
    ]);
  });

  it('preserves source order across excluded, rejected and staged items', () => {
    const plan = planEmailMedia(
      [
        attachment({ contentType: 'application/pdf', filename: 'doc.pdf' }),
        attachment({ filename: 'one.jpg', content: Buffer.from('1') }),
        attachment({ contentDisposition: 'inline', filename: 'inline.png', contentType: 'image/png' }),
        attachment({ filename: 'two.png', contentType: 'image/png', content: Buffer.from('2') }),
      ],
      settings(),
    );
    const staged = stageEmailMedia(plan);
    expect(staged).toHaveLength(2);
    // Payload arms carry data; source order IS the array order (exclusions
    // never displace the remaining items).
    expect(staged[0]).toMatchObject({ filename: 'one.jpg' });
    expect((staged[0] as { data: Buffer }).data.toString()).toBe('1');
    expect((staged[1] as { data: Buffer }).data.toString()).toBe('2');
  });

  it('falls back to neutral MIME-derived filenames and never leaks path separators', () => {
    const plan = planEmailMedia(
      [
        attachment({ filename: 'https://evil.example/x.jpg' }),
        (() => {
          const a = attachment({ contentType: 'image/png' });
          delete a.filename;
          return a;
        })(),
      ],
      settings(),
    );
    const staged = stageEmailMedia(plan);
    // URL-bearing filename is dropped entirely by the shared sanitizer and
    // replaced by the neutral MIME hint.
    expect((staged[0] as { filename: string }).filename).toBe('photo.jpg');
    expect((staged[1] as { filename: string }).filename).toBe('photo.png');
    for (const a of staged) {
      expect((a as { filename: string }).filename).not.toContain('/');
    }
  });

  it('ignores malformed webhook entries without a Buffer content', () => {
    const broken = { contentType: 'image/jpeg', content: 'not-a-buffer' } as unknown as EmailAttachment;
    const plan = planEmailMedia([broken, attachment()], settings());
    expect(plan.items).toHaveLength(1);
    const staged = stageEmailMedia(plan);
    expect(staged).toHaveLength(1);
  });

  it('treats a non-finite declared size as unknown and still measures the real bytes', () => {
    const plan = planEmailMedia([attachment({ size: Number.NaN })], settings({ maxInputBytes: 4 }));
    const staged = stageEmailMedia(plan);
    // 8 real bytes > 4-byte cap: rejected on measured length despite junk metadata.
    expect(staged[0]).toMatchObject({ kind: 'rejected', rejectionReason: 'size_limit' });
  });

  it('exposes the config-mirrored default settings', () => {
    expect(DEFAULT_EMAIL_IMAGE_SETTINGS).toEqual({ maxInputBytes: 10_485_760, maxPerMessage: 5 });
  });
});

// ---------------------------------------------------------------------------
// Real-parser end-to-end through forwarding + planning + staging
// ---------------------------------------------------------------------------

describe('real MailParser fixtures end to end', () => {
  it('ordinary JPEG → staged payload; body text untouched', async () => {
    const email = mapParsedMail(await simpleParser(MIME_ORDINARY), 101);
    expect(email.text).toBe('body text here');
    const plan = planEmailMedia(email.attachments, settings());
    const staged = stageEmailMedia(plan);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ filename: 'photo.jpg', mimeType: 'image/jpeg', size: 9 });
    expect((staged[0] as { data: Buffer }).data.toString('utf8')).toBe('JPGDATA-A');
  });

  it('inline related CID image → excluded, zero slots, nothing staged', async () => {
    const email = mapParsedMail(await simpleParser(MIME_INLINE_RELATED), 102);
    const plan = planEmailMedia(email.attachments, settings());
    expect(planHasImageSlots(plan)).toBe(false);
    expect(stageEmailMedia(plan)).toEqual([]);
    expect(plan.selection.excluded[0]?.exclusionReason).toBe('inline_related');
  });

  it('Content-ID-only attachment → staged like any ordinary image', async () => {
    const email = mapParsedMail(await simpleParser(MIME_CID_BUT_ORDINARY), 103);
    const staged = stageEmailMedia(planEmailMedia(email.attachments, settings()));
    expect(staged).toHaveLength(1);
    expect(staged[0]).not.toHaveProperty('kind');
  });

  it('PDF + inline-HTML + dispositionless JPEG → only the JPEG stages, in source order', async () => {
    const email = mapParsedMail(await simpleParser(MIME_MIXED_EXCLUSIONS), 104);
    const plan = planEmailMedia(email.attachments, settings());
    const staged = stageEmailMedia(plan);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ filename: 'no-disposition.jpg', mimeType: 'image/jpeg' });
    expect(plan.selection.excluded).toHaveLength(1);
    expect(plan.selection.excluded[0]).toMatchObject({ sourcePosition: 0, exclusionReason: 'non_image_mime' });
  });
});

// ---------------------------------------------------------------------------
// Connector: authorization BEFORE staging
// ---------------------------------------------------------------------------

describe('EmailConnector authorization precedes attachment staging', () => {
  const imageOnlyEmail = (): ParsedEmail =>
    makeEmail({ text: '', attachments: [attachment()] });

  /** Zero-call assertions for the deny paths (P1 pin). */
  const expectNoMediaWork = (): void => {
    expect(vi.mocked(planEmailMedia)).not.toHaveBeenCalled();
    expect(vi.mocked(stageEmailMedia)).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    vi.mocked(planEmailMedia).mockClear();
    vi.mocked(stageEmailMedia).mockClear();
  });

  it('allows an authorized sender and stages the ordinary image attachment', async () => {
    const connector = makeConnector({ allowedSenders: ['alice@example.com'] });
    const { events, handler } = captureHandler();
    connector.onMessage(handler);
    await connector.feedInbound(imageOnlyEmail());
    expect(events).toHaveLength(1);
    expect(events[0]?.attachments).toHaveLength(1);
    expect(events[0]?.attachments?.[0]).toMatchObject({ filename: 'photo.jpg', mimeType: 'image/jpeg' });
    // The spies DO observe admitted work — the deny-side zero-call assertions
    // below are meaningful, not vacuously true.
    expect(vi.mocked(planEmailMedia)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(stageEmailMedia)).toHaveBeenCalledTimes(1);
  });

  it('denies a sender outside allowedSenders: ZERO events, ZERO media calls, ZERO staged bytes', async () => {
    const connector = makeConnector({ allowedSenders: ['alice@example.com'] });
    const { events, handler } = captureHandler();
    connector.onMessage(handler);
    await connector.feedInbound(makeEmail({ from: 'mallory@evil.com', text: '', attachments: [attachment()] }));
    expect(events).toHaveLength(0);
    expectNoMediaWork();
  });

  it('drops requireDmarcPass mail with NO Authentication-Results: zero staging from media alone', async () => {
    const connector = makeConnector({
      requireDmarcPass: true,
      trustedAuthServId: 'mx.example.com',
    });
    const { events, handler } = captureHandler();
    connector.onMessage(handler);
    await connector.feedInbound(imageOnlyEmail());
    expect(events).toHaveLength(0);
    expectNoMediaWork();
  });

  it('drops requireDmarcPass mail whose dmarc=pass is UNTRUSTED (forged authserv-id)', async () => {
    const connector = makeConnector({
      requireDmarcPass: true,
      trustedAuthServId: 'mx.example.com',
    });
    const { events, handler } = captureHandler();
    connector.onMessage(handler);
    // A FORGED (untrusted authserv-id) dmarc=pass on image-only mail: zero events.
    await connector.feedInbound(
      makeEmail({
        text: '',
        attachments: [attachment()],
        authenticationResults: ['mx.evil.com; dmarc=pass header.from=example.com'],
      }),
    );
    expect(events).toHaveLength(0);
    expectNoMediaWork();
  });

  it('drops requireDmarcPass mail whose trusted result says dmarc=fail', async () => {
    const connector = makeConnector({
      requireDmarcPass: true,
      trustedAuthServId: 'mx.example.com',
    });
    const { events, handler } = captureHandler();
    connector.onMessage(handler);
    await connector.feedInbound(
      makeEmail({
        text: '',
        attachments: [attachment()],
        authenticationResults: ['mx.example.com; dmarc=fail header.from=example.com'],
      }),
    );
    expect(events).toHaveLength(0);
    expectNoMediaWork();
  });

  it('admits requireDmarcPass mail attested by the trusted provider and stages its images', async () => {
    const connector = makeConnector({
      requireDmarcPass: true,
      trustedAuthServId: 'mx.example.com',
    });
    const { events, handler } = captureHandler();
    connector.onMessage(handler);
    await connector.feedInbound(
      makeEmail({ text: 'question?', attachments: [attachment()], authenticationResults: TRUSTED_AR }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.content).toBe('question?');
    expect(events[0]?.attachments).toHaveLength(1);
    expect(vi.mocked(planEmailMedia)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(stageEmailMedia)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Webhook boundary hardening: malformed operator-controlled entries are
// skipped or treated as absent — never thrown on (P2 pin).
// ---------------------------------------------------------------------------

describe('webhook boundary hardening (malformed operator-controlled entries)', () => {
  it('skips null and non-object entries without throwing and still stages the valid image', () => {
    const plan = planEmailMedia(
      [null, 42, 'garbage', undefined, attachment()] as unknown as EmailAttachment[],
      settings(),
    );
    expect(plan.items).toHaveLength(1);
    expect(planHasImageSlots(plan)).toBe(true);
    const staged = stageEmailMedia(plan);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ filename: 'photo.jpg', mimeType: 'image/jpeg' });
  });

  it('treats a non-string contentDisposition as absent (never inline, never throws)', () => {
    const weird = attachment({ contentDisposition: 5 as unknown as string });
    expect(() => isInlineOrRelatedEmailAttachment(weird)).not.toThrow();
    expect(isInlineOrRelatedEmailAttachment(weird)).toBe(false);
    const plan = planEmailMedia([weird], settings());
    expect(planHasImageSlots(plan)).toBe(true);
    const staged = stageEmailMedia(plan);
    expect(staged).toHaveLength(1);
    expect(staged[0]).not.toHaveProperty('kind');
  });

  it('connector survives [null, validAttachment] and delivers the valid attachment', async () => {
    const connector = makeConnector();
    const { events, handler } = captureHandler();
    connector.onMessage(handler);
    await connector.feedInbound(
      makeEmail({ attachments: [null, attachment()] as unknown as EmailAttachment[] }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.attachments).toHaveLength(1);
    expect(events[0]?.attachments?.[0]).toMatchObject({ filename: 'photo.jpg' });
  });
});

// ---------------------------------------------------------------------------
// Raw hygiene: buffers are transient; `event.raw` is metadata-only (P3 pin).
// ---------------------------------------------------------------------------

describe('raw hygiene — buffers never travel through event.raw', () => {
  function containsBuffer(value: unknown, depth = 0): boolean {
    if (Buffer.isBuffer(value)) {
      return true;
    }
    if (depth > 8 || value === null || typeof value !== 'object') {
      return false;
    }
    if (Array.isArray(value)) {
      return value.some((v) => containsBuffer(v, depth + 1));
    }
    return Object.values(value as Record<string, unknown>).some((v) => containsBuffer(v, depth + 1));
  }

  it('strips staged AND excluded attachment content from raw while the explicit field keeps payloads', async () => {
    const connector = makeConnector(undefined, { imageSettings: { maxInputBytes: 1_000 } });
    const { events, handler } = captureHandler();
    connector.onMessage(handler);
    await connector.feedInbound(
      makeEmail({
        text: 'mixed bag',
        attachments: [
          attachment({ filename: 'ok.jpg', content: Buffer.from('STAGED') }),
          attachment({ filename: 'huge.jpg', content: Buffer.alloc(2_000, 0x4a), size: 2_000 }),
          attachment({ contentDisposition: 'inline', contentType: 'image/png', content: Buffer.from('INLINE') }),
          attachment({ contentType: 'application/pdf', filename: 'doc.pdf', content: Buffer.from('PDFBYTES') }),
        ],
      }),
    );
    expect(events).toHaveLength(1);
    // Explicit persistence path unchanged: one payload + one closed rejection.
    const staged = events[0]?.attachments ?? [];
    expect(staged).toHaveLength(2);
    expect(Buffer.isBuffer((staged[0] as { data: unknown }).data)).toBe(true);
    expect(staged[1]).toMatchObject({ kind: 'rejected', rejectionReason: 'size_limit' });
    // Raw is metadata-only: no `attachments` key and NO Buffer anywhere inside.
    const raw = events[0]?.raw as Record<string, unknown>;
    expect(raw).toBeDefined();
    expect(raw).not.toHaveProperty('attachments');
    expect(containsBuffer(raw)).toBe(false);
    // The rest of the parsed metadata survives the strip (shape pin, not
    // just absence — raw must remain useful for the normalizer).
    expect(raw).toMatchObject({
      messageId: '<msg-001@example.com>',
      from: 'alice@example.com',
      subject: 'Hello',
      text: 'mixed bag',
    });
  });
});

// ---------------------------------------------------------------------------
// Connector: event composition (body preserved, image-only admitted,
// exclusions produce no attachments field)
// ---------------------------------------------------------------------------

describe('EmailConnector event composition with attachments', () => {
  it('preserves the body text verbatim alongside the staged attachment', async () => {
    const connector = makeConnector();
    const { events, handler } = captureHandler();
    connector.onMessage(handler);
    await connector.feedInbound(makeEmail({ text: '  keep me exact  ', attachments: [attachment()] }));
    expect(events).toHaveLength(1);
    expect(events[0]?.content).toBe('  keep me exact  ');
    expect(events[0]?.attachments).toHaveLength(1);
  });

  it('emits an event for an authorized attachments-ONLY message when slots are consumed', async () => {
    const connector = makeConnector();
    const { events, handler } = captureHandler();
    connector.onMessage(handler);
    await connector.feedInbound(makeEmail({ text: '', attachments: [attachment()] }));
    expect(events).toHaveLength(1);
    expect(events[0]?.content).toBe('');
    expect(events[0]?.attachments?.[0]).toMatchObject({ mimeType: 'image/jpeg' });
  });

  it('keeps the pre-media event shape (no attachments field) when every attachment is excluded', async () => {
    const connector = makeConnector();
    const { events, handler } = captureHandler();
    connector.onMessage(handler);
    await connector.feedInbound(
      makeEmail({
        text: 'just text',
        attachments: [
          attachment({ contentDisposition: 'inline', contentType: 'image/png' }),
          attachment({ contentType: 'application/pdf', filename: 'report.pdf' }),
        ],
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.content).toBe('just text');
    expect(events[0]).not.toHaveProperty('attachments');
  });

  it('emits an event for an attachments-only message whose media is fully excluded (unchanged dispatch)', async () => {
    // Dispatch semantics are unchanged: authorized email ALWAYS emits, with
    // or without media; only the attachments field is conditional.
    const connector = makeConnector();
    const { events, handler } = captureHandler();
    connector.onMessage(handler);
    await connector.feedInbound(makeEmail({ text: '', attachments: [attachment({ contentType: 'application/pdf' })] }));
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty('attachments');
  });

  it('applies the injected imageSettings caps (maxPerMessage) to staged payloads', async () => {
    const connector = makeConnector(undefined, {
      imageSettings: { maxPerMessage: 1 },
    });
    const { events, handler } = captureHandler();
    connector.onMessage(handler);
    await connector.feedInbound(
      makeEmail({
        attachments: [
          attachment({ filename: 'first.jpg', content: Buffer.from('1') }),
          attachment({ filename: 'second.jpg', content: Buffer.from('2') }),
        ],
      }),
    );
    expect(events).toHaveLength(1);
    const staged = events[0]?.attachments ?? [];
    expect(staged).toHaveLength(2);
    expect(staged[0]).toMatchObject({ filename: 'first.jpg' });
    expect(staged[1]).toMatchObject({ kind: 'rejected', rejectionReason: 'count_limit' });
    expect(staged[1]).not.toHaveProperty('data');
  });

  it('applies the injected imageSettings byte cap to oversized buffers', async () => {
    const connector = makeConnector(undefined, {
      imageSettings: { maxInputBytes: 4 },
    });
    const { events, handler } = captureHandler();
    connector.onMessage(handler);
    await connector.feedInbound(makeEmail({ attachments: [attachment({ content: Buffer.from('TOOLONG') })] }));
    const staged = events[0]?.attachments ?? [];
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({ kind: 'rejected', rejectionReason: 'size_limit' });
  });

  it('threads and idempotency semantics are unchanged for media-bearing mail', async () => {
    const connector = makeConnector();
    const { events, handler } = captureHandler();
    connector.onMessage(handler);
    await connector.feedInbound(
      makeEmail({
        messageId: '<reply-1@example.com>',
        references: '<root-1@example.com>',
        attachments: [attachment()],
      }),
    );
    expect(events[0]?.externalThreadId).toBe('alice@example.com:root-1@example.com');
    expect(events[0]?.idempotencyKey).toBe('reply-1@example.com');
  });
});
