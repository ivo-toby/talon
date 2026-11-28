import { describe, it, expect } from 'vitest';
import {
  MESSAGE_CONTEXT_EXCERPT_MAX_CHARS,
  excerptForContext,
  prependReplyHeader,
  renderReactionContent,
  renderReplyHeader,
  renderOutboundNotice,
  renderOutboundNoticeHeader,
  prependOutboundNotices,
  OUTBOUND_NOTICES_END_LINE,
} from '../../../src/pipeline/message-context.js';

describe('excerptForContext', () => {
  it('returns empty for absent or blank text', () => {
    expect(excerptForContext(undefined)).toBe('');
    expect(excerptForContext('   \n ')).toBe('');
  });

  it('collapses whitespace and newlines', () => {
    expect(excerptForContext('  one\n\ntwo\t three ')).toBe('one two three');
  });

  it('leaves text at the bound untouched and truncates beyond it with an ellipsis', () => {
    const exact = 'a'.repeat(MESSAGE_CONTEXT_EXCERPT_MAX_CHARS);
    expect(excerptForContext(exact)).toBe(exact);

    const long = excerptForContext('b'.repeat(MESSAGE_CONTEXT_EXCERPT_MAX_CHARS + 50));
    expect(long).toHaveLength(MESSAGE_CONTEXT_EXCERPT_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('renderReplyHeader', () => {
  it("describes a reply to one of Talon's messages", () => {
    expect(
      renderReplyHeader(
        { externalMessageId: '4521', fromSelf: true, text: 'Shall I book the 14:00 slot?' },
        'user-1',
      ),
    ).toBe('[Replying to your message (id 4521): "Shall I book the 14:00 slot?"]');
  });

  it("describes a reply to the sender's own earlier message", () => {
    expect(
      renderReplyHeader(
        { externalMessageId: '9', fromSelf: false, senderId: 'user-1', text: 'earlier' },
        'user-1',
      ),
    ).toBe('[Replying to their own earlier message (id 9): "earlier"]');
  });

  it('names another participant by their channel identity', () => {
    expect(
      renderReplyHeader(
        { externalMessageId: '9', fromSelf: false, senderId: 'user-2', text: 'hi' },
        'user-1',
      ),
    ).toBe('[Replying to a message from user-2 (id 9): "hi"]');
  });

  it('falls back to "an earlier message" when the author is unknown', () => {
    expect(renderReplyHeader({ externalMessageId: '9' }, 'user-1')).toBe(
      '[Replying to an earlier message (id 9)]',
    );
  });

  it('omits the quote when there is no text', () => {
    expect(renderReplyHeader({ externalMessageId: '3', fromSelf: true, text: '  ' }, 'u')).toBe(
      '[Replying to your message (id 3)]',
    );
  });

  it('JSON-quotes the excerpt so quotes and brackets stay unambiguous', () => {
    expect(
      renderReplyHeader({ externalMessageId: '3', fromSelf: true, text: 'say "hi"] now' }, 'u'),
    ).toBe('[Replying to your message (id 3): "say \\"hi\\"] now"]');
  });
});

describe('prependReplyHeader', () => {
  it('puts the header on its own line above the content', () => {
    expect(prependReplyHeader('[H]', 'yes please')).toBe('[H]\nyes please');
  });

  it('returns the header alone for an empty message (image-only reply)', () => {
    expect(prependReplyHeader('[H]', '')).toBe('[H]');
  });
});

describe('renderReactionContent', () => {
  it('names the emoji, the target id and the quoted excerpt, and explains NO_REPLY', () => {
    const content = renderReactionContent('👍', {
      externalMessageId: '4521',
      fromSelf: true,
      text: 'Shall I book it?',
    });
    const [header, guidance] = content.split('\n');
    expect(header).toBe(
      '[Reaction: the user reacted with 👍 to your message (id 4521): "Shall I book it?"]',
    );
    expect(guidance).toContain('NO_REPLY');
  });

  it('omits the quote when the target text is unknown', () => {
    expect(renderReactionContent('🔥', { externalMessageId: '1' }).split('\n')[0]).toBe(
      '[Reaction: the user reacted with 🔥 to your message (id 1)]',
    );
  });
});

describe('outbound notices', () => {
  it('renders a header with source and ledger id, then the full body', () => {
    expect(
      renderOutboundNotice({
        body: 'Line one\nLine two',
        sentAt: '2026-11-28 08:00',
        source: 'schedule',
        externalMessageId: '4521',
      }),
    ).toBe(
      '[You sent this message to this chat at 2026-11-28 08:00, from a scheduled task (id 4521)]\n' +
        'Line one\nLine two',
    );
  });

  it('omits the id when the ledger has none', () => {
    expect(
      renderOutboundNoticeHeader({ body: 'x', sentAt: '2026-11-28 08:00', source: 'other_conversation' }),
    ).toBe('[You sent this message to this chat at 2026-11-28 08:00, from another conversation]');
  });

  it('prepends notices, an omitted count and an end line ahead of the content', () => {
    expect(prependOutboundNotices(['[a]\nA', '[b]\nB'], 2, 'reply')).toBe(
      '[2 earlier messages you sent to this chat are omitted]\n\n[a]\nA\n\n[b]\nB\n\n' +
        `${OUTBOUND_NOTICES_END_LINE}\nreply`,
    );
  });

  it('leaves content untouched when there is nothing to show', () => {
    expect(prependOutboundNotices([], 0, 'reply')).toBe('reply');
  });
});
