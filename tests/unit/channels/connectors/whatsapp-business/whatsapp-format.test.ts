/**
 * Unit tests for WhatsApp format conversion utilities.
 */

import { describe, it, expect } from 'vitest';
import { markdownToWhatsApp } from '../../../../../src/channels/connectors/whatsapp-business/whatsapp-format.js';

// ---------------------------------------------------------------------------
// markdownToWhatsApp
// ---------------------------------------------------------------------------

describe('markdownToWhatsApp', () => {
  // -------------------------------------------------------------------------
  // Plain text
  // -------------------------------------------------------------------------

  describe('plain text', () => {
    it('passes plain text through unchanged', () => {
      expect(markdownToWhatsApp('Hello world')).toBe('Hello world');
    });

    it('returns empty string unchanged', () => {
      expect(markdownToWhatsApp('')).toBe('');
    });

    it('preserves whitespace in plain text', () => {
      const result = markdownToWhatsApp('line one\nline two');
      expect(result).toBe('line one\nline two');
    });

    it('preserves numbers and punctuation unchanged', () => {
      expect(markdownToWhatsApp('1 + 1 = 2.')).toBe('1 + 1 = 2.');
    });
  });

  // -------------------------------------------------------------------------
  // Bold
  // -------------------------------------------------------------------------

  describe('bold', () => {
    it('converts **bold** to *bold*', () => {
      expect(markdownToWhatsApp('**bold text**')).toBe('*bold text*');
    });

    it('converts bold in a sentence', () => {
      expect(markdownToWhatsApp('This is **important** here')).toBe(
        'This is *important* here',
      );
    });

    it('preserves content inside bold unchanged', () => {
      expect(markdownToWhatsApp('**hello world**')).toBe('*hello world*');
    });
  });

  // -------------------------------------------------------------------------
  // Italic
  // -------------------------------------------------------------------------

  describe('italic', () => {
    it('converts *italic* (single asterisk) to _italic_', () => {
      expect(markdownToWhatsApp('*italic text*')).toBe('_italic text_');
    });

    it('converts _italic_ (underscore) to _italic_', () => {
      expect(markdownToWhatsApp('_italic text_')).toBe('_italic text_');
    });

    it('preserves content inside italic unchanged', () => {
      expect(markdownToWhatsApp('*hello world*')).toBe('_hello world_');
    });
  });

  // -------------------------------------------------------------------------
  // Strikethrough
  // -------------------------------------------------------------------------

  describe('strikethrough', () => {
    it('converts ~~text~~ to ~text~', () => {
      expect(markdownToWhatsApp('~~struck~~')).toBe('~struck~');
    });

    it('handles strikethrough in a sentence', () => {
      expect(markdownToWhatsApp('Price: ~~$100~~ $80')).toBe('Price: ~$100~ $80');
    });
  });

  // -------------------------------------------------------------------------
  // Inline code
  // -------------------------------------------------------------------------

  describe('inline code', () => {
    it('converts `code` to ```code```', () => {
      expect(markdownToWhatsApp('`some code`')).toBe('```some code```');
    });

    it('handles inline code in a sentence', () => {
      expect(markdownToWhatsApp('Use `npm install` to install')).toBe(
        'Use ```npm install``` to install',
      );
    });

    it('does not alter content inside inline code', () => {
      // Special markdown chars inside inline code should be left as-is.
      expect(markdownToWhatsApp('`a**b**c`')).toBe('```a**b**c```');
    });
  });

  // -------------------------------------------------------------------------
  // Fenced code blocks
  // -------------------------------------------------------------------------

  describe('fenced code blocks', () => {
    it('preserves fenced code block content without modification', () => {
      const md = '```typescript\nconst x = 1 + 2;\n```';
      const result = markdownToWhatsApp(md);
      expect(result).toBe(md);
    });

    it('includes language tag in output', () => {
      const md = '```python\nprint("hello")\n```';
      const result = markdownToWhatsApp(md);
      expect(result).toBe(md);
    });

    it('handles code block with no language tag', () => {
      const md = '```\nsome code\n```';
      const result = markdownToWhatsApp(md);
      expect(result).toBe(md);
    });

    it('does not convert **bold** inside a fenced block', () => {
      const md = '```\n**not bold**\n```';
      const result = markdownToWhatsApp(md);
      // The fenced block must be returned verbatim — double asterisks preserved.
      expect(result).toBe(md);
      expect(result).toContain('**not bold**');
    });
  });

  // -------------------------------------------------------------------------
  // Links
  // -------------------------------------------------------------------------

  describe('inline links', () => {
    it('converts [label](url) to label (url)', () => {
      expect(markdownToWhatsApp('[click here](https://example.com)')).toBe(
        'click here (https://example.com)',
      );
    });

    it('handles links in a sentence', () => {
      expect(markdownToWhatsApp('See [the docs](https://docs.example.com) for more')).toBe(
        'See the docs (https://docs.example.com) for more',
      );
    });

    it('preserves the URL exactly as written', () => {
      const url = 'https://example.com/path?q=1&r=2#anchor';
      expect(markdownToWhatsApp(`[link](${url})`)).toBe(`link (${url})`);
    });
  });

  // -------------------------------------------------------------------------
  // Headings
  // -------------------------------------------------------------------------

  describe('headings', () => {
    it('converts # heading to *bold*', () => {
      expect(markdownToWhatsApp('# My Heading')).toBe('*My Heading*');
    });

    it('converts ## heading to *bold*', () => {
      expect(markdownToWhatsApp('## Sub Heading')).toBe('*Sub Heading*');
    });

    it('converts ### heading to *bold*', () => {
      expect(markdownToWhatsApp('### Deep Heading')).toBe('*Deep Heading*');
    });

    it('preserves heading text unchanged', () => {
      expect(markdownToWhatsApp('# Hello World')).toBe('*Hello World*');
    });
  });

  // -------------------------------------------------------------------------
  // Lists (pass-through)
  // -------------------------------------------------------------------------

  describe('lists', () => {
    it('passes unordered lists through unchanged (WhatsApp renders natively)', () => {
      const md = '- item one\n- item two\n- item three';
      expect(markdownToWhatsApp(md)).toBe(md);
    });

    it('passes ordered list numbers through unchanged', () => {
      const md = '1. first\n2. second\n3. third';
      expect(markdownToWhatsApp(md)).toBe(md);
    });
  });

  // -------------------------------------------------------------------------
  // Mixed / complex documents
  // -------------------------------------------------------------------------

  describe('mixed content', () => {
    it('handles bold followed by plain text', () => {
      const result = markdownToWhatsApp('**Hello** world');
      expect(result).toBe('*Hello* world');
    });

    it('handles multiple formatting constructs in one document', () => {
      const md = '**bold** and *italic* and ~~struck~~';
      const result = markdownToWhatsApp(md);
      expect(result).toBe('*bold* and _italic_ and ~struck~');
    });

    it('handles a document with a code block and surrounding text', () => {
      const md = 'Here is code:\n```js\nconst x = 1;\n```\nAnd done.';
      const result = markdownToWhatsApp(md);
      expect(result).toContain('const x = 1;');
      expect(result).toContain('Here is code:');
      expect(result).toContain('And done.');
    });

    it('handles inline code mixed with formatted text', () => {
      const md = '**bold** with `code` inline';
      const result = markdownToWhatsApp(md);
      expect(result).toBe('*bold* with ```code``` inline');
    });

    it('handles heading followed by a list', () => {
      const md = '# Title\n- item one\n- item two';
      const result = markdownToWhatsApp(md);
      expect(result).toBe('*Title*\n- item one\n- item two');
    });

    it('handles link followed by strikethrough', () => {
      const md = '[visit](https://x.com) or ~~skip~~';
      const result = markdownToWhatsApp(md);
      expect(result).toBe('visit (https://x.com) or ~skip~');
    });
  });
});
