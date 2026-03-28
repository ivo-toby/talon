/**
 * WhatsApp format conversion utilities.
 *
 * Converts standard Markdown input into WhatsApp's native formatting syntax.
 * WhatsApp uses a simplified subset of formatting markers:
 *
 * - Bold:         *text*
 * - Italic:       _text_
 * - Strikethrough: ~text~
 * - Monospace:    ```text```
 *
 * WhatsApp auto-links bare URLs, so links are rendered as "label (url)".
 * Headings have no native equivalent and are rendered as bold text.
 * Code blocks using triple backticks are preserved as-is.
 * List markers (- and *) are rendered natively by WhatsApp.
 *
 * Reference: https://faq.whatsapp.com/539178204879377
 */

// ---------------------------------------------------------------------------
// Markdown to WhatsApp format conversion
// ---------------------------------------------------------------------------

/**
 * Convert a standard Markdown string to WhatsApp's native format.
 *
 * Handles the following Markdown constructs:
 * - Fenced code blocks (``` ... ```) — kept as-is (WhatsApp supports triple backtick)
 * - Inline code (`code`) — rendered as ```code```
 * - Bold (**text**) — rendered as *text*
 * - Italic (*text* or _text_) — rendered as _text_
 * - Strikethrough (~~text~~) — rendered as ~text~
 * - Inline links [label](url) — rendered as label (url)
 * - Headings (# text) — rendered as *text* (bold fallback)
 * - Plain text — passed through unchanged
 *
 * @param markdown - Standard Markdown input.
 * @returns WhatsApp-formatted string.
 */
export function markdownToWhatsApp(markdown: string): string {
  // Process segment by segment. Fenced code blocks are handled first so their
  // content is never modified by other replacement rules.

  let result = '';
  let remaining = markdown;

  while (remaining.length > 0) {
    // --- Fenced code block (backtick variant) ---
    const fenceMatch = remaining.match(/^```(?:\w*\n)([\s\S]*?)^```/m);
    if (fenceMatch && fenceMatch.index === 0) {
      // Preserve the fenced block verbatim (WhatsApp renders triple-backtick blocks).
      result += fenceMatch[0];
      remaining = remaining.slice(fenceMatch[0].length);
      continue;
    }

    // Find the next special construct.
    const nextSpecial = findNextSpecial(remaining);

    if (nextSpecial === null) {
      // Rest is plain text — pass through unchanged.
      result += remaining;
      break;
    }

    // Append any plain text preceding this construct.
    if (nextSpecial.index > 0) {
      result += remaining.slice(0, nextSpecial.index);
    }

    result += nextSpecial.formatted;
    remaining = remaining.slice(nextSpecial.index + nextSpecial.length);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SpecialConstruct {
  /** Offset in the input string where the construct starts. */
  index: number;
  /** Number of characters consumed from the input. */
  length: number;
  /** WhatsApp-formatted representation. */
  formatted: string;
}

/**
 * Search `text` for the first Markdown formatting construct and return
 * information needed to process it. Returns null if no construct is found.
 *
 * Constructs checked (in order of precedence):
 * 1. Fenced code block  ``` ... ```
 * 2. Inline code        `code`
 * 3. Bold               **text**
 * 4. Italic             *text* or _text_
 * 5. Strikethrough      ~~text~~
 * 6. Inline link        [label](url)
 * 7. ATX heading        # text
 */
function findNextSpecial(text: string): SpecialConstruct | null {
  const candidates: Array<SpecialConstruct | null> = [
    matchFencedCode(text),
    matchInlineCode(text),
    matchBold(text),
    matchItalic(text),
    matchStrikethrough(text),
    matchLink(text),
    matchHeading(text),
  ];

  // Pick the candidate with the smallest index (earliest in the string).
  let best: SpecialConstruct | null = null;
  for (const c of candidates) {
    if (c === null) continue;
    if (best === null || c.index < best.index) {
      best = c;
    }
  }
  return best;
}

function matchFencedCode(text: string): SpecialConstruct | null {
  const re = /```(?:\w*)\n[\s\S]*?^```/gm;
  const m = re.exec(text);
  if (!m) return null;
  // Keep fenced blocks verbatim.
  return {
    index: m.index,
    length: m[0].length,
    formatted: m[0],
  };
}

function matchInlineCode(text: string): SpecialConstruct | null {
  // Single-backtick inline code — convert to WhatsApp monospace (triple backtick).
  const re = /`([^`\n]+)`/g;
  const m = re.exec(text);
  if (!m) return null;
  return {
    index: m.index,
    length: m[0].length,
    formatted: '```' + m[1] + '```',
  };
}

function matchBold(text: string): SpecialConstruct | null {
  // **text** — WhatsApp bold is *text*
  const re = /\*{2}([^*\n]+)\*{2}/g;
  const m = re.exec(text);
  if (!m) return null;
  return {
    index: m.index,
    length: m[0].length,
    formatted: '*' + m[1] + '*',
  };
}

function matchItalic(text: string): SpecialConstruct | null {
  // *text* (single asterisk, not preceded/followed by another *) or _text_
  // WhatsApp italic is _text_
  const re = /(?<!\*)\*(?!\*)([^*\n]+)(?<!\*)\*(?!\*)|(?<!_)_(?!_)([^_\n]+)(?<!_)_(?!_)/g;
  const m = re.exec(text);
  if (!m) return null;
  const inner = m[1] ?? m[2];
  return {
    index: m.index,
    length: m[0].length,
    formatted: '_' + inner + '_',
  };
}

function matchStrikethrough(text: string): SpecialConstruct | null {
  // ~~text~~ — WhatsApp strikethrough is ~text~
  const re = /~~([^~\n]+)~~/g;
  const m = re.exec(text);
  if (!m) return null;
  return {
    index: m.index,
    length: m[0].length,
    formatted: '~' + m[1] + '~',
  };
}

function matchLink(text: string): SpecialConstruct | null {
  // [label](url) — WhatsApp does not support inline links; render as "label (url)"
  const re = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
  const m = re.exec(text);
  if (!m) return null;
  return {
    index: m.index,
    length: m[0].length,
    formatted: m[1] + ' (' + m[2] + ')',
  };
}

function matchHeading(text: string): SpecialConstruct | null {
  // ATX heading: # text or ## text etc. at start of a line.
  // WhatsApp has no heading support — render as bold.
  const re = /^#{1,6}\s+(.+)$/m;
  const m = re.exec(text);
  if (!m) return null;
  return {
    index: m.index,
    length: m[0].length,
    formatted: '*' + m[1] + '*',
  };
}
