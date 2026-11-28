import { describe, it, expect } from 'vitest';
import {
  bareJid,
  extractMentionedJids,
  resolveGroupContent,
  type GroupAddressingInput,
} from '../../../../../src/channels/connectors/whatsapp-baileys/whatsapp-baileys-addressing.js';

const base: GroupAddressingInput = {
  text: '',
  mentionedJids: [],
  selfIds: new Set(['31624544584', '96490886312027']),
  triggerWords: ['@Talon'],
  requireMention: true,
};

describe('bareJid', () => {
  it('strips the domain and device suffix', () => {
    expect(bareJid('31624544584:49@s.whatsapp.net')).toBe('31624544584');
    expect(bareJid('96490886312027@lid')).toBe('96490886312027');
  });
});

describe('extractMentionedJids', () => {
  it('reads mentionedJid from the contextInfo of any content part', () => {
    expect(
      extractMentionedJids({
        extendedTextMessage: { text: 'hi @1', contextInfo: { mentionedJid: ['1@lid'] } },
      }),
    ).toEqual(['1@lid']);
    expect(
      extractMentionedJids({
        imageMessage: { caption: '@1', contextInfo: { mentionedJid: ['1@lid', '', 7] } },
      }),
    ).toEqual(['1@lid']);
  });

  it('returns [] without mentions', () => {
    expect(extractMentionedJids({ conversation: 'hi' })).toEqual([]);
    expect(extractMentionedJids(undefined)).toEqual([]);
  });
});

describe('resolveGroupContent', () => {
  it('addresses the bot on an @mention of its LID and strips the token', () => {
    expect(
      resolveGroupContent({
        ...base,
        text: '@96490886312027 what is the weather?',
        mentionedJids: ['96490886312027@lid'],
      }),
    ).toBe('what is the weather?');
  });

  it('addresses the bot on an @mention of its phone number, mid-sentence', () => {
    expect(
      resolveGroupContent({
        ...base,
        text: 'can you check @31624544584 the lights',
        mentionedJids: ['31624544584@s.whatsapp.net'],
      }),
    ).toBe('can you check the lights');
  });

  it('leaves a longer id that starts with the bot id alone', () => {
    expect(
      resolveGroupContent({
        ...base,
        text: '@96490886312027 ask @964908863120271',
        mentionedJids: ['96490886312027@lid', '964908863120271@lid'],
      }),
    ).toBe('ask @964908863120271');
  });

  it('ignores a mention of someone else', () => {
    expect(
      resolveGroupContent({ ...base, text: '@111 hello', mentionedJids: ['111@lid'] }),
    ).toBeNull();
  });

  it('returns an empty string for a mention-only message', () => {
    expect(
      resolveGroupContent({
        ...base,
        text: '@96490886312027',
        mentionedJids: ['96490886312027@lid'],
      }),
    ).toBe('');
  });

  it('addresses the bot on a leading trigger word and strips it', () => {
    expect(resolveGroupContent({ ...base, text: '@talon do something' })).toBe('do something');
  });

  it('does not match a trigger word mid-message', () => {
    expect(resolveGroupContent({ ...base, text: 'hey @Talon do something' })).toBeNull();
  });

  it('addresses the bot on a quoted reply to its account, keeping the text', () => {
    expect(
      resolveGroupContent({
        ...base,
        text: 'and tomorrow?',
        quotedSenderId: '31624544584:49@s.whatsapp.net',
      }),
    ).toBe('and tomorrow?');
    expect(
      resolveGroupContent({ ...base, text: 'and tomorrow?', quotedSenderId: '96490886312027@lid' }),
    ).toBe('and tomorrow?');
  });

  it('ignores a quoted reply to someone else', () => {
    expect(
      resolveGroupContent({ ...base, text: 'agreed', quotedSenderId: '111@s.whatsapp.net' }),
    ).toBeNull();
  });

  it('answers every message when requireMention is false', () => {
    expect(resolveGroupContent({ ...base, text: 'just chatting', requireMention: false })).toBe(
      'just chatting',
    );
  });

  it('still strips a trigger word when requireMention is false', () => {
    expect(resolveGroupContent({ ...base, text: '@Talon hi', requireMention: false })).toBe('hi');
  });

  it('drops a plain message by default', () => {
    expect(resolveGroupContent({ ...base, text: 'just chatting' })).toBeNull();
  });

  it('works without trigger words', () => {
    expect(resolveGroupContent({ ...base, triggerWords: [], text: '@Talon hi' })).toBeNull();
    expect(
      resolveGroupContent({
        ...base,
        triggerWords: [],
        text: '@96490886312027 hi',
        mentionedJids: ['96490886312027@lid'],
      }),
    ).toBe('hi');
  });
});
