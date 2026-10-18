/**
 * Boundary tests for the bounded descriptor and Finding projections.
 *
 * The approved projection table is independent of the formatter, so every
 * expectation here is literal: the fixed limits (20/1000/8000 descriptors,
 * 10/2000/8000 findings), selection orders, tiebreaks, live-first shared
 * budgets, inventory exclusion of live IDs, marking of excerpts and omitted
 * source references, notice/exposure behaviour, and JavaScript `string.length`
 * (code units, not UTF-8 bytes) accounting of framing and notices.
 *
 * Aggregate-bound tests assert the bound is hit exactly: the expected count
 * is derived arithmetically from the literal framing lengths and the maximum
 * count satisfies `count * (lineLength + 1) <= available` while
 * `(count + 1) * (lineLength + 1) > available`.
 */

import { describe, expect, it } from 'vitest';
import {
  IMAGE_CONTEXT_BUDGET,
  IMAGE_CONTEXT_FRAMING,
  projectImageContext,
  renderFinding,
  renderFindingFull,
  renderImageDescriptor,
  renderImageDescriptorFull,
  toImageDescriptorDto,
  type ImageContextProjectionInput,
} from '../../../src/images/image-context-projection.js';
import type { ImageDescriptor } from '../../../src/images/image-types.js';
import type { Finding } from '../../../src/images/finding-types.js';

// ---------------------------------------------------------------------------
// Deterministic fixtures
// ---------------------------------------------------------------------------

const RECEIVED_MS = 1700000000000; // 2023-11-14T22:13:20.000Z
const EXPIRES_MS = 1700864000000; // 2023-11-24T22:13:20.000Z
const RECEIVED_ISO = '2023-11-14T22:13:20.000Z';
const EXPIRES_ISO = '2023-11-24T22:13:20.000Z';
const CREATED_MS = 1700100000000; // 2023-11-16T02:00:00.000Z
const CREATED_ISO = '2023-11-16T02:00:00.000Z';

function makeImage(overrides: Partial<Record<string, unknown>> = {}): ImageDescriptor {
  return {
    imageId: 'img-0001',
    threadId: 'thread-1',
    messageId: 'msg-0001',
    ordinal: 0,
    receivedAt: RECEIVED_MS,
    expiresAt: EXPIRES_MS,
    state: 'available',
    ...overrides,
  } as ImageDescriptor;
}

function makeFinding(overrides: Partial<Record<string, unknown>> = {}): Finding {
  return {
    findingId: 'fnd-0001',
    threadId: 'thread-1',
    runId: 'run-0001',
    imageIds: ['img-0001'],
    question: 'What is shown?',
    answer: 'A red car.',
    modelName: 'vision-model-1',
    createdAt: CREATED_MS,
    ...overrides,
  } as Finding;
}

function padId(index: number): string {
  return `img-${String(index).padStart(4, '0')}`;
}

function padFindingId(index: number): string {
  return `fnd-${String(index).padStart(4, '0')}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value as Record<string, unknown>)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

// Minimal available descriptor line built independently of the formatter so
// boundary arithmetic below does not call the implementation:
//   'img ' (4) + id 'img-0001' (8) + ' state=available' (16) + ' received=' (10) +
//   iso (24) + ' expires=' (9) + iso (24) + ' msg=' (5) + 'msg-0001' (8) +
//   ' ord=0' (6) = 114
const MINIMAL_LINE_LENGTH = 4 + 8 + 16 + 10 + 24 + 9 + 24 + 5 + 8 + 6;

// Reserved framing for the descriptor section (longest, lookup-bearing
// notice), each framing line counted with its trailing newline.
const RESERVED_IMAGE_FRAMING =
  IMAGE_CONTEXT_FRAMING.imageSectionHeader.length +
  1 +
  IMAGE_CONTEXT_FRAMING.liveSectionHeader.length +
  1 +
  IMAGE_CONTEXT_FRAMING.inventorySectionHeader.length +
  1 +
  IMAGE_CONTEXT_FRAMING.imageOmissionNoticeWithLookup.length +
  1;

const RESERVED_FINDING_FRAMING =
  IMAGE_CONTEXT_FRAMING.findingSectionHeader.length +
  1 +
  IMAGE_CONTEXT_FRAMING.findingOmissionNoticeWithLookup.length +
  1;

function emptyInput(
  overrides: Partial<ImageContextProjectionInput> = {},
): ImageContextProjectionInput {
  return {
    liveImages: [],
    inventoryImages: [],
    findings: [],
    imageLookupExposed: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Literal budget table
// ---------------------------------------------------------------------------

describe('approved literal budgets', () => {
  const budgetTable = [
    { field: 'descriptorMaxCount', expected: 20 },
    { field: 'descriptorMaxChars', expected: 1000 },
    { field: 'descriptorAggregateChars', expected: 8000 },
    { field: 'findingMaxCount', expected: 10 },
    { field: 'findingMaxChars', expected: 2000 },
    { field: 'findingAggregateChars', expected: 8000 },
  ] as const;

  it.each(budgetTable)('$field is $expected', ({ field, expected }) => {
    expect(IMAGE_CONTEXT_BUDGET[field]).toBe(expected);
  });

  it('image_lookup is named only in the WithLookup notices', () => {
    expect(IMAGE_CONTEXT_FRAMING.imageOmissionNotice).not.toContain('image_lookup');
    expect(IMAGE_CONTEXT_FRAMING.findingOmissionNotice).not.toContain('image_lookup');
    expect(IMAGE_CONTEXT_FRAMING.imageOmissionNoticeWithLookup).toContain('image_lookup');
    expect(IMAGE_CONTEXT_FRAMING.findingOmissionNoticeWithLookup).toContain('image_lookup');
  });
});

// ---------------------------------------------------------------------------
// Single descriptor rendering
// ---------------------------------------------------------------------------

describe('renderImageDescriptor', () => {
  it('renders a fully populated descriptor verbatim', () => {
    const descriptor = makeImage({
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      dimensions: { width: 8, height: 16 },
      exif: {
        gps: { latitude: 1.5, longitude: 2.5, altitude: 3, altitudeRef: 'belowSeaLevel' },
        capturedAt: '2026-03-01 09:15:23',
        capturedAtOffset: '+02:00',
        cameraMake: 'ACME',
        cameraModel: 'Z1',
        orientation: 1,
      },
    });
    expect(renderImageDescriptor(descriptor)).toBe(
      'img img-0001 state=available ' +
        `received=${RECEIVED_ISO} expires=${EXPIRES_ISO} msg=msg-0001 ord=0 ` +
        'file="photo.jpg" mime=image/jpeg size=8x16 ' +
        'exif[capture="2026-03-01 09:15:23" offset="+02:00" camera="ACME Z1" ' +
        'orientation=1 gps=1.5,2.5 alt=3 belowSeaLevel]',
    );
  });

  it('renders terminal reasons and keeps unknown metadata absent', () => {
    const rejected = makeImage({ state: 'rejected', rejectionReason: 'animated' });
    expect(renderImageDescriptor(rejected)).toBe(
      `img img-0001 state=rejected (animated) received=${RECEIVED_ISO} ` +
        `expires=${EXPIRES_ISO} msg=msg-0001 ord=0`,
    );
    const unavailable = makeImage({
      state: 'unavailable',
      unavailabilityReason: 'expired',
    });
    expect(renderImageDescriptor(unavailable)).toContain('state=unavailable (expired)');
    // Unknown stays unknown: no invented values anywhere in the line.
    expect(renderImageDescriptor(makeImage())).not.toMatch(/unknown|null|undefined/i);
  });

  it('clips a long filename to exactly 1000 JavaScript characters, core intact', () => {
    const descriptor = makeImage({ filename: 'x'.repeat(900) });
    const line = renderImageDescriptor(descriptor);
    expect(line).not.toBeNull();
    expect(line!.length).toBe(1000);
    expect(line!.startsWith(`img img-0001 state=available received=${RECEIVED_ISO}`)).toBe(true);
    expect(line).toContain(`expires=${EXPIRES_ISO}`);
    expect(line!.endsWith('…')).toBe(true);
  });

  it('measures Unicode by JavaScript length, not UTF-8 bytes', () => {
    // 500 emoji = 1000 UTF-16 code units but >= 2000 UTF-8 bytes.
    const descriptor = makeImage({ filename: '😀'.repeat(500) });
    const line = renderImageDescriptor(descriptor);
    expect(line!.length).toBe(1000); // JS length, exactly at the cap
    expect(Buffer.byteLength(line!, 'utf8')).toBeGreaterThan(1000);
    // A 2-byte-per-unit string is 1 JS char per unit.
    // core 114 + ' ' + 'file="' + 434 + '"' fits below the 1000 cap.
    const accented = makeImage({ filename: 'é'.repeat(434) });
    expect(renderImageDescriptor(accented)!.length).toBe(114 + 1 + 7 + 434);
  });

  it('returns null rather than clipping mandatory core material', () => {
    const descriptor = makeImage();
    const coreLength =
      `img img-0001 state=available received=${RECEIVED_ISO} expires=${EXPIRES_ISO} msg=msg-0001 ord=0`
        .length;
    expect(renderImageDescriptor(descriptor, coreLength)).not.toBeNull();
    expect(renderImageDescriptor(descriptor, coreLength - 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Single Finding rendering
// ---------------------------------------------------------------------------

describe('renderFinding', () => {
  it('renders a short Finding completely and verbatim', () => {
    expect(renderFinding(makeFinding())).toBe(
      `finding fnd-0001 at ${CREATED_ISO} model=vision-model-1\n` +
        'images=img-0001\nquestion: What is shown?\nanswer: A red car.',
    );
  });

  it('clips a long answer to exactly 2000 characters and marks the excerpt', () => {
    const finding = makeFinding({ answer: 'A'.repeat(5000) });
    const block = renderFinding(finding);
    expect(block!.length).toBe(2000);
    expect(block!.endsWith('…[excerpted]')).toBe(true);
    expect(block).toContain(`finding fnd-0001 at ${CREATED_ISO}`);
  });

  it('marks when later fields are omitted after an excerpt', () => {
    const finding = makeFinding({
      answer: 'A'.repeat(3000),
      extractedText: 'TEXT',
      uncertainty: 'LOW',
    });
    const block = renderFinding(finding, 200);
    expect(block!.length).toBe(200);
    expect(block!.endsWith('…[excerpted; fields omitted]')).toBe(true);
  });

  it('marks omitted source image references while preserving the Finding ID', () => {
    const finding = makeFinding({
      imageIds: Array.from({ length: 20 }, (_, i) => padId(i + 1)),
    });
    const coreLength = `finding fnd-0001 at ${CREATED_ISO} model=vision-model-1`.length;
    // Room for exactly 5 characters of the images segment plus the mark.
    const block = renderFinding(finding, coreLength + 1 + 28 + 5);
    expect(block!.length).toBe(coreLength + 1 + 28 + 5);
    expect(block!.endsWith('…[source image refs omitted]')).toBe(true);
    expect(block).toContain('finding fnd-0001');
  });

  it('omits the entry when the source-refs mark cannot fit (no core backtracking)', () => {
    // Reviewer-traced regression: 65-char core + fully accepted 15-char
    // source-ref line = 81 chars; the next segment overflows and the required
    // 28-char refs mark no longer fits. The entry must be omitted whole —
    // never by re-tracting the refs line with the wrong mark or clipping the
    // mandatory core.
    const finding = makeFinding();
    const coreLength = `finding fnd-0001 at ${CREATED_ISO} model=vision-model-1`.length;
    expect(coreLength).toBe(65);
    expect(renderFinding(finding, coreLength + 1 + 15)).toBeNull(); // 81
    // Exactly the required envelope: core + newline + refs mark, nothing else.
    const block = renderFinding(finding, coreLength + 1 + 28);
    expect(block).toBe(
      `finding fnd-0001 at ${CREATED_ISO} model=vision-model-1\n…[source image refs omitted]`,
    );
    expect(block!.length).toBe(coreLength + 1 + 28);
    // One more char of room: the mark plus 1 character of the refs line.
    const partial = renderFinding(finding, coreLength + 1 + 28 + 1);
    expect(partial).toBe(
      `finding fnd-0001 at ${CREATED_ISO} model=vision-model-1\ni…[source image refs omitted]`,
    );
  });

  it('full rendering never excerpts canonical content', () => {
    const long = 'A'.repeat(5000);
    const block = renderFindingFull(makeFinding({ answer: long }));
    expect(block).toContain(long);
    expect(block).not.toContain('[excerpted]');
  });
});

// ---------------------------------------------------------------------------
// Projection: live descriptors, inventory, shared budgets
// ---------------------------------------------------------------------------

describe('projectImageContext descriptors', () => {
  it('keeps live descriptors in source order and caps at 20', () => {
    // Descending timestamps prove the order is source order, not recency.
    const liveImages = Array.from({ length: 25 }, (_, i) =>
      makeImage({ imageId: padId(i), receivedAt: RECEIVED_MS - i * 1000 }),
    );
    const result = projectImageContext(emptyInput({ liveImages }));
    expect(result.liveImageIds).toEqual(liveImages.slice(0, 20).map((d) => d.imageId));
    expect(result.omittedImageCount).toBe(5);
    expect(result.descriptorsText.length).toBeLessThanOrEqual(8000);
  });

  it('excludes live Image IDs from the inventory without counting them omitted', () => {
    const a = makeImage({ imageId: 'img-0001' });
    const b = makeImage({ imageId: 'img-0002' });
    const c = makeImage({ imageId: 'img-0003' });
    const result = projectImageContext(
      emptyInput({ liveImages: [a, b], inventoryImages: [a, b, c] }),
    );
    expect(result.inventoryImageIds).toEqual(['img-0003']);
    expect(result.omittedImageCount).toBe(0);
    expect(result.descriptorsText).not.toContain('omitted');
  });

  it('shares the count budget live-first', () => {
    const liveImages = Array.from({ length: 18 }, (_, i) => makeImage({ imageId: padId(i) }));
    const inventoryImages = Array.from({ length: 5 }, (_, i) =>
      makeImage({ imageId: `inv-${String(i).padStart(2, '0')}` }),
    );
    const result = projectImageContext(emptyInput({ liveImages, inventoryImages }));
    expect(result.liveImageIds).toHaveLength(18);
    expect(result.inventoryImageIds).toHaveLength(2);
    expect(result.omittedImageCount).toBe(3);
  });

  it('respects the 8000-char descriptor aggregate under real overflow (framing counted)', () => {
    // Each line: minimal core (114) + ' ' + 'file="<name>"' padded to exactly
    // 700. The exact 8000-character hit (mixed live/inventory, lookup
    // exposed) is proven by the dedicated exact-bound case below; this case
    // pins the boundary arithmetic and the exact section length (7844).
    const nameLength = 700 - MINIMAL_LINE_LENGTH - 1 - 7;
    const candidates = Array.from({ length: 12 }, (_, i) =>
      makeImage({ imageId: padId(i), filename: 'x'.repeat(nameLength) }),
    );
    const available = IMAGE_CONTEXT_BUDGET.descriptorAggregateChars - RESERVED_IMAGE_FRAMING;
    const expectedSelected = Math.floor(available / (700 + 1));
    // The bound is hit, not merely respected:
    expect(expectedSelected * 701).toBeLessThanOrEqual(available);
    expect((expectedSelected + 1) * 701).toBeGreaterThan(available);
    expect(expectedSelected).toBe(11);

    const result = projectImageContext(emptyInput({ inventoryImages: candidates }));
    expect(result.inventoryImageIds).toHaveLength(expectedSelected);
    expect(result.omittedImageCount).toBe(12 - expectedSelected);

    // Exact section length: header + inventory subheader + entries + notice,
    // each line with its newline; no live section is emitted.
    const notice = IMAGE_CONTEXT_FRAMING.imageOmissionNotice.length;
    const expectedLength =
      IMAGE_CONTEXT_FRAMING.imageSectionHeader.length +
      1 +
      IMAGE_CONTEXT_FRAMING.inventorySectionHeader.length +
      1 +
      expectedSelected * (700 + 1) +
      notice +
      1;
    expect(result.descriptorsText.length).toBe(expectedLength);
    expect(result.descriptorsText.length).toBeLessThanOrEqual(8000);
  });

  // Input order within each equal-timestamp group deliberately runs ID
  // descending, so a stable sort without the ID tiebreak (or with the
  // tiebreak inverted) produces an observably different order.
  const orderTable = [
    {
      name: 'receivedAt descending, then ID ascending on equal timestamps',
      images: [
        { id: 'img-0001', receivedAt: 10 },
        { id: 'img-0002', receivedAt: 30 },
        { id: 'img-0005', receivedAt: 20 },
        { id: 'img-0004', receivedAt: 30 },
        { id: 'img-0003', receivedAt: 20 },
      ],
      expected: ['img-0002', 'img-0004', 'img-0003', 'img-0005', 'img-0001'],
    },
  ] as const;

  it.each(orderTable)('$name', ({ images, expected }) => {
    const result = projectImageContext(
      emptyInput({
        inventoryImages: images.map((entry) =>
          makeImage({ imageId: entry.id, receivedAt: entry.receivedAt }),
        ),
      }),
    );
    expect(result.inventoryImageIds).toEqual([...expected]);
  });

  it('includes old uninspected images in the inventory', () => {
    const old = makeImage({ imageId: 'img-old', receivedAt: 1000, expiresAt: 2000 });
    const result = projectImageContext(emptyInput({ inventoryImages: [old] }));
    expect(result.inventoryImageIds).toEqual(['img-old']);
    expect(result.descriptorsText).toContain('img-old');
  });

  it('excludes internal Processing descriptors without counting them omitted', () => {
    const internal = makeImage({ imageId: 'img-proc', state: 'processing' });
    const visible = makeImage({ imageId: 'img-vis' });
    const result = projectImageContext(
      emptyInput({ liveImages: [internal], inventoryImages: [internal, visible] }),
    );
    expect(result.descriptorsText).not.toContain('img-proc');
    expect(result.inventoryImageIds).toEqual(['img-vis']);
    expect(result.omittedImageCount).toBe(0);
  });

  it('clips optional display text, never IDs/state/expiry, at the per-entry cap', () => {
    const live = makeImage({ filename: 'y'.repeat(4000) });
    const result = projectImageContext(emptyInput({ liveImages: [live] }));
    const line = result.descriptorsText
      .split('\n')
      .find((candidate) => candidate.startsWith('img img-0001'));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThanOrEqual(1000);
    expect(line).toContain('state=available');
    expect(line).toContain(`expires=${EXPIRES_ISO}`);
    expect(line!.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Projection: Findings
// ---------------------------------------------------------------------------

describe('projectImageContext findings', () => {
  // Identical createdAt, input deliberately ID-descending: a stable sort
  // without the ID tiebreak (or with it inverted) would select
  // fnd-0012..fnd-0003 instead of fnd-0001..fnd-0010 and fail.
  it('selects by ID ascending on equal timestamps (tiebreak) and caps at 10', () => {
    const findings = Array.from({ length: 12 }, (_, i) =>
      makeFinding({ findingId: padFindingId(12 - i) }), // identical createdAt
    );
    const result = projectImageContext(emptyInput({ findings }));
    expect(result.findingIds).toEqual(
      Array.from({ length: 10 }, (_, i) => padFindingId(i + 1)),
    );
    expect(result.omittedFindingCount).toBe(2);
  });

  it('selects newest-first but presents selected Findings chronologically', () => {
    const findings = Array.from({ length: 12 }, (_, i) =>
      makeFinding({
        findingId: padFindingId(i + 1),
        createdAt: CREATED_MS + i * 100_000,
      }),
    );
    const result = projectImageContext(emptyInput({ findings }));
    // Newest 10 are fnd-0003..fnd-0012; presentation is chronological.
    expect(result.findingIds).toEqual(
      Array.from({ length: 10 }, (_, i) => padFindingId(i + 3)),
    );
    expect(result.omittedFindingCount).toBe(2);
    const text = result.findingsText;
    const positions = result.findingIds.map((id) => text.indexOf(id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('hits the 8000-character finding aggregate exactly, clipping at 2000 each', () => {
    const findings = Array.from({ length: 12 }, (_, i) =>
      makeFinding({
        findingId: padFindingId(i + 1),
        createdAt: CREATED_MS + i * 100_000,
        answer: 'A'.repeat(5000),
      }),
    );
    const result = projectImageContext(
      emptyInput({ findings, imageLookupExposed: true }),
    );
    // Blocks are capped at min(2000, remaining - 1) with a huge answer, so
    // each block is exactly its cap: 2000, 2000, 2000, then the last one
    // consumes the exact remainder of the reserved budget.
    expect(result.findingIds).toHaveLength(4);
    expect(result.omittedFindingCount).toBe(8);
    expect(result.findingsText.length).toBe(8000); // exact aggregate bound
    // Selection order was newest-first (caps 2000, 2000, 2000, then the exact
    // remainder 1890 on the 4th-selected = oldest-selected finding, presented
    // first chronologically).
    const lengths = result.findingIds.map((id) => {
      const start = result.findingsText.indexOf(`finding ${id} at`);
      const next = result.findingsText.indexOf('finding fnd-', start + 1);
      const noticeAt = result.findingsText.indexOf('Some findings are omitted', start);
      const stop = Math.min(
        next === -1 ? Number.MAX_SAFE_INTEGER : next - 1,
        noticeAt === -1 ? Number.MAX_SAFE_INTEGER : noticeAt - 1,
      );
      return stop - start;
    });
    expect(lengths).toEqual([1890, 2000, 2000, 2000]);
  });

  it('hits the 8000-character descriptor aggregate exactly (mixed live/inventory, lookup exposed)', () => {
    // With lookup exposed the reserved framing is header + live subheader +
    // inventory subheader + lookup notice = 180 JS chars, so the shared
    // entry budget is exactly 7820. Thirteen entries fill it exactly: twelve
    // 600-char lines (601 each) + one 607-char line (608) = 12*601 + 608,
    // exhausting the shared char budget; the two oldest inventory candidates
    // are omitted and the lookup notice is emitted.
    const lineName = (lineLength: number): string =>
      'x'.repeat(lineLength - MINIMAL_LINE_LENGTH - 1 - 7);
    const liveImages = Array.from({ length: 3 }, (_, i) =>
      makeImage({ imageId: `live-${String(i).padStart(3, '0')}`, filename: lineName(600) }),
    );
    const inventoryImages = [
      ...Array.from({ length: 9 }, (_, i) =>
        makeImage({
          imageId: padId(i),
          receivedAt: RECEIVED_MS - i * 1000,
          filename: lineName(600),
        }),
      ),
      makeImage({ imageId: 'img-fill', receivedAt: RECEIVED_MS - 9000, filename: lineName(607) }),
      makeImage({ imageId: 'img-olda', receivedAt: RECEIVED_MS - 10_000_000, filename: lineName(600) }),
      makeImage({ imageId: 'img-oldb', receivedAt: RECEIVED_MS - 11_000_000, filename: lineName(600) }),
    ];
    const available = IMAGE_CONTEXT_BUDGET.descriptorAggregateChars - RESERVED_IMAGE_FRAMING;
    expect(12 * 601 + 608).toBe(available); // the exact fill
    expect(12 * 601 + 608 + 601).toBeGreaterThan(available); // one more 600-line cannot fit

    const result = projectImageContext(
      emptyInput({ liveImages, inventoryImages, imageLookupExposed: true }),
    );
    expect(result.liveImageIds).toHaveLength(3);
    expect(result.inventoryImageIds).toHaveLength(10);
    expect(result.omittedImageCount).toBe(2);
    expect(result.lookupHintIncluded).toBe(true);
    expect(result.descriptorsText.includes('image_lookup')).toBe(true);
    expect(result.descriptorsText.length).toBe(8000); // exact aggregate bound
  });

  it('marks excerpted Finding text and omitted image references in the projection', () => {
    const huge = makeFinding({
      findingId: 'fnd-huge',
      answer: 'A'.repeat(3000),
      imageIds: ['img-1', 'img-2'],
    });
    const result = projectImageContext(emptyInput({ liveImages: [], findings: [huge] }));
    expect(result.findingsText).toContain('…[excerpted]');
    expect(result.findingsText).toContain('finding fnd-huge');
  });

  it('full canonical findings stay verbatim via renderFindingFull', () => {
    const long = 'A'.repeat(5000);
    expect(renderFindingFull(makeFinding({ answer: long }))).toContain(long);
  });
});

// ---------------------------------------------------------------------------
// Notices, exposure flag, framing as historical data
// ---------------------------------------------------------------------------

describe('omission notices and tool exposure', () => {
  const many = Array.from({ length: 25 }, (_, i) => makeImage({ imageId: padId(i) }));

  const exposureTable = [
    { exposed: true, expectsLookup: true },
    { exposed: false, expectsLookup: false },
  ] as const;

  it.each(exposureTable)(
    'omitted images with imageLookupExposed=$exposed names image_lookup: $expectsLookup',
    ({ exposed, expectsLookup }) => {
      const result = projectImageContext(emptyInput({ liveImages: many, imageLookupExposed: exposed }));
      expect(result.descriptorsText).toContain('Some images are omitted from this projection.');
      expect(result.descriptorsText.includes('image_lookup')).toBe(expectsLookup);
      expect(result.lookupHintIncluded).toBe(expectsLookup);
    },
  );

  it.each(exposureTable)(
    'omitted findings with imageLookupExposed=$exposed name image_lookup: $expectsLookup',
    ({ exposed, expectsLookup }) => {
      const findings = Array.from({ length: 12 }, (_, i) =>
        makeFinding({ findingId: padFindingId(i + 1) }),
      );
      const result = projectImageContext(emptyInput({ findings, imageLookupExposed: exposed }));
      expect(result.findingsText).toContain('Some findings are omitted from this projection.');
      expect(result.findingsText.includes('image_lookup')).toBe(expectsLookup);
    },
  );

  it('gives no notice and no image_lookup mention when nothing is omitted', () => {
    const result = projectImageContext(
      emptyInput({
        liveImages: [makeImage()],
        findings: [makeFinding()],
        imageLookupExposed: true,
      }),
    );
    expect(result.text).not.toContain('omitted');
    expect(result.text).not.toContain('image_lookup');
    expect(result.lookupHintIncluded).toBe(false);
  });

  it('frames every projected section as historical data', () => {
    const result = projectImageContext(
      emptyInput({ liveImages: [makeImage()], findings: [makeFinding()] }),
    );
    expect(result.descriptorsText).toContain('historical data');
    expect(result.findingsText).toContain('historical data');
  });

  it('returns empty text for empty input', () => {
    const result = projectImageContext(emptyInput());
    expect(result.text).toBe('');
    expect(result.descriptorsText).toBe('');
    expect(result.findingsText).toBe('');
    expect(result.omittedImageCount).toBe(0);
    expect(result.omittedFindingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unicode budget accounting through the projection
// ---------------------------------------------------------------------------

describe('Unicode JavaScript-length accounting through the projection', () => {
  it('counts JavaScript length, allowing more than 8000 UTF-8 bytes', () => {
    // Same arithmetic as the exact-aggregate case: 700 JS-char lines, 11 fit.
    const asciiPrefixLength = 100;
    const unicodeLength = 700 - MINIMAL_LINE_LENGTH - 1 - 7 - asciiPrefixLength;
    const name = `${'x'.repeat(asciiPrefixLength)}${'é'.repeat(unicodeLength)}`;
    expect(name.length).toBe(578);
    const candidates = Array.from({ length: 12 }, (_, i) =>
      makeImage({ imageId: padId(i), filename: name }),
    );
    const result = projectImageContext(emptyInput({ inventoryImages: candidates }));
    expect(result.inventoryImageIds).toHaveLength(11);
    expect(result.descriptorsText.length).toBeLessThanOrEqual(8000);
    expect(Buffer.byteLength(result.descriptorsText, 'utf8')).toBeGreaterThan(8000);
  });
});

// ---------------------------------------------------------------------------
// Canonical records are never mutated
// ---------------------------------------------------------------------------

describe('canonical records are never mutated', () => {
  it('a deep-frozen, fully populated input projects without mutation', () => {
    const liveImages = deepFreeze([
      makeImage({
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        dimensions: { width: 8, height: 16 },
        exif: {
          gps: { latitude: 1.5, longitude: 2.5, altitude: 3, altitudeRef: 'aboveSeaLevel' },
          capturedAt: '2026-03-01 09:15:23',
          orientation: 1,
        },
      }),
      makeImage({ imageId: 'img-0002', state: 'rejected', rejectionReason: 'animated' }),
    ]);
    const inventoryImages = deepFreeze([
      ...liveImages,
      makeImage({ imageId: 'img-0003', state: 'unavailable', unavailabilityReason: 'expired' }),
    ]);
    const findings = deepFreeze([
      makeFinding({
        extractedText: 'STOP 42',
        uncertainty: 'possibly blurred',
        imageIds: ['img-0001', 'img-0003'],
      }),
      makeFinding({ findingId: 'fnd-0002', answer: 'B'.repeat(3000) }),
    ]);
    const beforeImages = structuredClone(liveImages);
    const beforeInventory = structuredClone(inventoryImages);
    const beforeFindings = structuredClone(findings);

    const result = projectImageContext(
      emptyInput({ liveImages, inventoryImages, findings, imageLookupExposed: true }),
    );

    expect(result.liveImageIds).toEqual(['img-0001', 'img-0002']);
    expect(result.inventoryImageIds).toEqual(['img-0003']);
    expect(liveImages).toEqual(beforeImages);
    expect(inventoryImages).toEqual(beforeInventory);
    expect(findings).toEqual(beforeFindings);
  });
});

// ---------------------------------------------------------------------------
// Complete structured descriptor DTO (lookup)
// ---------------------------------------------------------------------------

describe('toImageDescriptorDto', () => {
  it('renders every field without truncation; unknowns are explicit nulls', () => {
    const longName = 'z'.repeat(3000);
    const descriptor = makeImage({
      filename: longName,
      dimensions: { width: 8, height: 16 },
      exif: { gps: { latitude: 1.5, longitude: -2.5 }, cameraModel: 'Z1' },
    });
    const dto = toImageDescriptorDto(descriptor);
    expect(dto).toEqual({
      imageId: 'img-0001',
      threadId: 'thread-1',
      messageId: 'msg-0001',
      ordinal: 0,
      receivedAt: RECEIVED_ISO,
      expiresAt: EXPIRES_ISO,
      state: 'available',
      rejectionReason: null,
      unavailabilityReason: null,
      filename: longName,
      mimeType: null,
      width: 8,
      height: 16,
      exif: {
        gps: { latitude: 1.5, longitude: -2.5, altitude: null, altitudeRef: null },
        capturedAt: null,
        capturedAtOffset: null,
        cameraMake: null,
        cameraModel: 'Z1',
        orientation: null,
      },
    });
    expect(renderImageDescriptorFull(descriptor).length).toBeGreaterThan(1000);
    expect(renderImageDescriptorFull(descriptor)).toContain(longName);
  });

  it('maps terminal reasons and keeps non-terminal reasons null', () => {
    const rejected = toImageDescriptorDto(
      makeImage({ state: 'rejected', rejectionReason: 'size_limit' }),
    );
    expect(rejected.rejectionReason).toBe('size_limit');
    expect(rejected.unavailabilityReason).toBeNull();
    const unavailable = toImageDescriptorDto(
      makeImage({ state: 'unavailable', unavailabilityReason: 'file_missing' }),
    );
    expect(unavailable.unavailabilityReason).toBe('file_missing');
    expect(unavailable.rejectionReason).toBeNull();
  });
});
