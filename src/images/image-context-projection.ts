/**
 * Bounded projection of Image descriptors and Findings into automatic context.
 *
 * Pure projection/formatter service: no repository access, no authorization
 * decisions, no availability refresh, no pixel fetches, no provider wiring.
 * Callers (foreground context assembly / rotation) supply refreshed
 * `ImageDescriptor`s and canonical `Finding`s; this module only formats them
 * within the approved fixed budgets. Canonical records are never mutated.
 *
 * Approved projection table:
 * - Image descriptors: at most 20 entries, at most 1000 characters each and
 *   8000 aggregate. Live current-message descriptors come first, in source
 *   order; their IDs are excluded from the inventory. The remaining budget
 *   (count and characters) is filled by inventory entries newest-first
 *   (receipt descending, then ID ascending) — one shared descriptor budget,
 *   consumed live-first.
 * - Findings: at most 10 projections, at most 2000 characters each and 8000
 *   aggregate. Selection runs newest-first (creation descending, then ID
 *   ascending); selected Findings are presented chronologically.
 *
 * Every bound counts JavaScript `String.prototype.length` (code units, not
 * UTF-8 bytes) and includes framing and omission notices. All projected
 * material is framed as historical data. Unknown metadata stays unknown:
 * absent optional fields are rendered as absent (or `null` in the lookup
 * DTO), never invented. Only optional display text is clipped or omitted;
 * Image IDs, state, reasons, receipt and expiry are never clipped. Excerpted
 * text and omitted source references are marked. The `image_lookup` hint is
 * named only when the caller's actual tool-exposure flag is true.
 *
 * Terminology: CONTEXT.md (Image descriptor, Image descriptor inventory,
 * Finding). Placement contract: docs/adr/0002-image-context-placement.md.
 */

import type {
  ImageDescriptor,
  ImageExifMetadata,
  ImageRejectionReason,
  ImageState,
  ImageUnavailabilityReason,
} from './image-types.js';
import type { Finding } from './finding-types.js';

// ---------------------------------------------------------------------------
// Approved literal budgets
// ---------------------------------------------------------------------------

/**
 * The fixed automatic-projection budgets. These literal limits are approved
 * independently of this formatter; tests pin them to the spec table.
 */
export const IMAGE_CONTEXT_BUDGET = Object.freeze({
  /** Maximum live + inventory descriptors in one projection (shared). */
  descriptorMaxCount: 20,
  /** Maximum characters (JavaScript length) per descriptor line. */
  descriptorMaxChars: 1000,
  /** Maximum characters (JavaScript length) for the whole descriptor section. */
  descriptorAggregateChars: 8000,
  /** Maximum Finding projections in one projection. */
  findingMaxCount: 10,
  /** Maximum characters (JavaScript length) per Finding projection. */
  findingMaxChars: 2000,
  /** Maximum characters (JavaScript length) for the whole Findings section. */
  findingAggregateChars: 8000,
} as const);

/**
 * Framing lines of the projections. Framing and omission notices count toward
 * the aggregate budgets, so they are exported and reserved before entries are
 * selected. The `image_lookup` name appears only in the `*WithLookup` notices.
 */
export const IMAGE_CONTEXT_FRAMING = Object.freeze({
  imageSectionHeader:
    'Images (historical data; state shown was current at projection time):',
  liveSectionHeader: 'Current message:',
  inventorySectionHeader: 'Image inventory:',
  imageOmissionNotice: 'Some images are omitted from this projection.',
  imageOmissionNoticeWithLookup:
    'Some images are omitted from this projection. Use image_lookup to see them.',
  findingSectionHeader: 'Findings (historical data):',
  findingOmissionNotice: 'Some findings are omitted from this projection.',
  findingOmissionNoticeWithLookup:
    'Some findings are omitted from this projection. Use image_lookup to see them.',
} as const);

const EXCERPT = '…[excerpted]';
const EXCERPT_WITH_OMITTED = '…[excerpted; fields omitted]';
const SOURCE_REFS_OMITTED = '…[source image refs omitted]';

/**
 * Worst-case omission-marker length. A marker line (newline + marker) is
 * reserved before any optional Finding segment is accepted, so a required
 * marker can never force backtracking into already-accepted content or the
 * mandatory core.
 */
const MAX_FINDING_MARKER_LENGTH = Math.max(
  EXCERPT_WITH_OMITTED.length,
  SOURCE_REFS_OMITTED.length,
);

const iso = (timestamp: number): string => new Date(timestamp).toISOString();

// ---------------------------------------------------------------------------
// Single-entry rendering
// ---------------------------------------------------------------------------

/**
 * Optional (clippable) display segments of a descriptor, in stable order.
 * Absent fields produce no segment: unknown metadata stays unknown.
 */
function descriptorOptionalSegments(descriptor: ImageDescriptor): string[] {
  const segments: string[] = [];
  if (descriptor.filename !== undefined) {
    segments.push(`file="${descriptor.filename}"`);
  }
  if (descriptor.mimeType !== undefined) {
    segments.push(`mime=${descriptor.mimeType}`);
  }
  if (descriptor.dimensions !== undefined) {
    segments.push(
      `size=${descriptor.dimensions.width}x${descriptor.dimensions.height}`,
    );
  }
  const exif = descriptorExifSegment(descriptor.exif);
  if (exif !== undefined) {
    segments.push(exif);
  }
  return segments;
}

function descriptorExifSegment(exif: ImageExifMetadata | undefined): string | undefined {
  if (exif === undefined) {
    return undefined;
  }
  const parts: string[] = [];
  if (exif.capturedAt !== undefined) {
    parts.push(`capture="${exif.capturedAt}"`);
  }
  if (exif.capturedAtOffset !== undefined) {
    parts.push(`offset="${exif.capturedAtOffset}"`);
  }
  if (exif.cameraMake !== undefined || exif.cameraModel !== undefined) {
    parts.push(`camera="${[exif.cameraMake, exif.cameraModel].filter(Boolean).join(' ')}"`);
  }
  if (exif.orientation !== undefined) {
    parts.push(`orientation=${exif.orientation}`);
  }
  if (exif.gps !== undefined) {
    const gps = exif.gps;
    let gpsText = `gps=${gps.latitude},${gps.longitude}`;
    if (gps.altitude !== undefined) {
      gpsText += ` alt=${gps.altitude}${gps.altitudeRef !== undefined ? ` ${gps.altitudeRef}` : ''}`;
    }
    parts.push(gpsText);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return `exif[${parts.join(' ')}]`;
}

/**
 * Mandatory core of a descriptor line. IDs, state, reason, receipt and
 * expiry are never clipped; when even this core cannot fit, the whole entry
 * is omitted instead (the caller receives `null`).
 */
function descriptorCore(descriptor: ImageDescriptor): string {
  let core = `img ${descriptor.imageId} state=${descriptor.state}`;
  if (descriptor.state === 'rejected') {
    const reason: ImageRejectionReason = descriptor.rejectionReason;
    core += ` (${reason})`;
  } else if (descriptor.state === 'unavailable') {
    const reason: ImageUnavailabilityReason = descriptor.unavailabilityReason;
    core += ` (${reason})`;
  }
  core += ` received=${iso(descriptor.receivedAt)} expires=${iso(descriptor.expiresAt)} msg=${descriptor.messageId} ord=${descriptor.ordinal}`;
  return core;
}

/**
 * Render one Image descriptor line within `maxChars` (JavaScript length,
 * default the approved per-descriptor cap).
 *
 * Appends optional display segments (filename, MIME, dimensions, EXIF) while
 * they fit; the first segment that overflows is clipped with a trailing
 * `…`, which ends the optional section. Returns `null` only when the
 * mandatory core alone exceeds `maxChars` — mandatory material is never
 * clipped, so the entry must be omitted entirely.
 */
export function renderImageDescriptor(
  descriptor: ImageDescriptor,
  maxChars: number = IMAGE_CONTEXT_BUDGET.descriptorMaxChars,
): string | null {
  const core = descriptorCore(descriptor);
  if (core.length > maxChars) {
    return null;
  }
  let text = core;
  for (const segment of descriptorOptionalSegments(descriptor)) {
    const candidate = `${text} ${segment}`;
    if (candidate.length <= maxChars) {
      text = candidate;
      continue;
    }
    const room = maxChars - text.length - 2; // separator + clipping mark
    if (room >= 1) {
      text += ` ${segment.slice(0, room)}…`;
      break; // the clipped segment ends the optional section
    }
    // else: skip this segment entirely; a later smaller segment may still fit
  }
  return text;
}

/**
 * Full (uncapped) rendering of a descriptor for lookup, where automatic
 * display budgets must not truncate fields. Absent optional fields simply
 * do not appear.
 */
export function renderImageDescriptorFull(descriptor: ImageDescriptor): string {
  const line = renderImageDescriptor(descriptor, Number.MAX_SAFE_INTEGER);
  return line ?? descriptorCore(descriptor);
}

/**
 * Ordered render segments of one Finding. The core (Finding ID, creation
 * time, model) is mandatory; everything after it is clippable.
 */
function findingSegments(finding: Finding): string[] {
  const segments = [
    `finding ${finding.findingId} at ${iso(finding.createdAt)} model=${finding.modelName}`,
  ];
  if (finding.imageIds.length > 0) {
    segments.push(`images=${finding.imageIds.join(',')}`);
  }
  segments.push(`question: ${finding.question}`);
  segments.push(`answer: ${finding.answer}`);
  if (finding.extractedText !== undefined) {
    segments.push(`extracted: ${finding.extractedText}`);
  }
  if (finding.uncertainty !== undefined) {
    segments.push(`uncertainty: ${finding.uncertainty}`);
  }
  return segments;
}

/**
 * Render one canonical Finding within `maxChars` (JavaScript length, default
 * the approved per-Finding cap).
 *
 * Includes the complete entry when it fits. Otherwise optional segments are
 * accepted only while the required marker line (newline + worst-case marker)
 * still fits, so accepted content is never retracted and the mandatory core
 * is never clipped. The projection then ends with exactly one mark:
 * `…[excerpted]` (or `…[excerpted; fields omitted]` when further segments
 * follow) for clipped field text, or `…[source image refs omitted]` when the
 * source Image reference list itself is removed. When even the required
 * marker line cannot fit alongside the core, the entry is omitted entirely
 * (`null`) rather than clipping IDs or re-marking removed references.
 */
export function renderFinding(
  finding: Finding,
  maxChars: number = IMAGE_CONTEXT_BUDGET.findingMaxChars,
): string | null {
  const segments = findingSegments(finding);
  const core = segments[0];
  if (core.length > maxChars) {
    return null;
  }
  const full = segments.join('\n');
  if (full.length <= maxChars) {
    return full; // complete entry: no mark needed
  }
  const refsIndex = finding.imageIds.length > 0 ? 1 : -1;
  // Accept segments only while the required marker envelope still fits.
  let base = core;
  let index = 1;
  while (
    index < segments.length &&
    base.length + 1 + segments[index].length + 1 + MAX_FINDING_MARKER_LENGTH <= maxChars
  ) {
    base += `\n${segments[index]}`;
    index += 1;
  }
  if (index < segments.length) {
    const rest = segments.slice(index).join('\n');
    if (base.length + 1 + rest.length <= maxChars) {
      return `${base}\n${rest}`; // everything still fits: complete entry
    }
  }
  const refsIncluded = refsIndex === -1 || index > refsIndex;
  const marker = refsIncluded
    ? segments.length - index - 1 > 0
      ? EXCERPT_WITH_OMITTED
      : EXCERPT
    : SOURCE_REFS_OMITTED;
  if (base.length + 1 + marker.length > maxChars) {
    return null; // required mark cannot fit: omit the entry, never clip the core
  }
  const contentRoom = maxChars - base.length - 1 - marker.length;
  if (contentRoom >= 1) {
    return `${base}\n${segments[index].slice(0, contentRoom)}${marker}`;
  }
  return `${base}\n${marker}`;
}

/**
 * Full (uncapped) rendering of a Finding for lookup: exact canonical content,
 * verbatim, never excerpted.
 */
export function renderFindingFull(finding: Finding): string {
  const block = renderFinding(finding, Number.MAX_SAFE_INTEGER);
  if (block !== null) {
    return block;
  }
  // Theoretically unreachable at MAX_SAFE_INTEGER; keep the contract total.
  return findingSegments(finding).join('\n');
}

// ---------------------------------------------------------------------------
// Complete structured descriptor DTO (lookup)
//
// Automatic display budgets never apply here: every field is present either
// with its value or an explicit `null` (unknown), and no text is truncated.
// ---------------------------------------------------------------------------

/** Structured GPS metadata for lookup; absent values are explicit `null`. */
export interface ImageDescriptorGpsDto {
  latitude: number;
  longitude: number;
  altitude: number | null;
  altitudeRef: 'aboveSeaLevel' | 'belowSeaLevel' | null;
}

/** Structured EXIF subset for lookup; absent values are explicit `null`. */
export interface ImageDescriptorExifDto {
  gps: ImageDescriptorGpsDto | null;
  capturedAt: string | null;
  capturedAtOffset: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  orientation: number | null;
}

/**
 * Complete structured descriptor DTO for lookup. Unlike the automatic
 * projection lines, no field is clipped: unknowns are explicit `null`s.
 */
export interface ImageDescriptorDto {
  imageId: string;
  threadId: string;
  messageId: string;
  ordinal: number;
  receivedAt: string;
  expiresAt: string;
  state: ImageState;
  rejectionReason: ImageRejectionReason | null;
  unavailabilityReason: ImageUnavailabilityReason | null;
  filename: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  exif: ImageDescriptorExifDto | null;
}

export function toImageDescriptorDto(descriptor: ImageDescriptor): ImageDescriptorDto {
  const gps =
    descriptor.exif?.gps !== undefined
      ? {
          latitude: descriptor.exif.gps.latitude,
          longitude: descriptor.exif.gps.longitude,
          altitude: descriptor.exif.gps.altitude ?? null,
          altitudeRef: descriptor.exif.gps.altitudeRef ?? null,
        }
      : null;
  const exif: ImageDescriptorExifDto | null =
    descriptor.exif !== undefined
      ? {
          gps,
          capturedAt: descriptor.exif.capturedAt ?? null,
          capturedAtOffset: descriptor.exif.capturedAtOffset ?? null,
          cameraMake: descriptor.exif.cameraMake ?? null,
          cameraModel: descriptor.exif.cameraModel ?? null,
          orientation: descriptor.exif.orientation ?? null,
        }
      : null;
  return {
    imageId: descriptor.imageId,
    threadId: descriptor.threadId,
    messageId: descriptor.messageId,
    ordinal: descriptor.ordinal,
    receivedAt: iso(descriptor.receivedAt),
    expiresAt: iso(descriptor.expiresAt),
    state: descriptor.state,
    rejectionReason: descriptor.state === 'rejected' ? descriptor.rejectionReason : null,
    unavailabilityReason:
      descriptor.state === 'unavailable' ? descriptor.unavailabilityReason : null,
    filename: descriptor.filename ?? null,
    mimeType: descriptor.mimeType ?? null,
    width: descriptor.dimensions?.width ?? null,
    height: descriptor.dimensions?.height ?? null,
    exif,
  };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Refreshed inputs for one projection. `inventoryImages` is the current
 * thread's non-Processing Image descriptors (it may include the live ones;
 * their IDs are excluded from the inventory by the projection).
 * `findings` are the thread's canonical Findings. Callers are responsible for
 * refreshing availability first — this service neither queries nor mutates
 * canonical records.
 */
export interface ImageContextProjectionInput {
  liveImages: readonly ImageDescriptor[];
  inventoryImages: readonly ImageDescriptor[];
  findings: readonly Finding[];
  /**
   * Actual current tool exposure of `image_lookup` to the persona. Only when
   * true does any omission notice name the tool; otherwise the notice stays
   * neutral.
   */
  imageLookupExposed: boolean;
}

/**
 * One bounded projection. `descriptorsText` and `findingsText` each stay
 * within their 8000-character aggregate (JavaScript length, framing and
 * notices included). `text` is the two non-empty sections joined.
 */
export interface ImageContextProjection {
  descriptorsText: string;
  findingsText: string;
  text: string;
  /** Selected live descriptor IDs, in source order. */
  liveImageIds: string[];
  /** Selected inventory descriptor IDs, newest-first selection order. */
  inventoryImageIds: string[];
  /** Selected Finding IDs in presentation (chronological) order. */
  findingIds: string[];
  /** Live + inventory descriptors that could not be projected. */
  omittedImageCount: number;
  /** Findings that could not be projected. */
  omittedFindingCount: number;
  /** True when any omission notice in the output names `image_lookup`. */
  lookupHintIncluded: boolean;
}

/** Newest-first key: receipt descending, then ID ascending (plain lexicographic). */
const newestFirst = (a: ImageDescriptor, b: ImageDescriptor): number => {
  if (b.receivedAt !== a.receivedAt) {
    return b.receivedAt - a.receivedAt;
  }
  return a.imageId < b.imageId ? -1 : 1;
};

/** Selection key: creation descending, then ID ascending (plain lexicographic). */
const findingsNewestFirst = (a: Finding, b: Finding): number => {
  if (b.createdAt !== a.createdAt) {
    return b.createdAt - a.createdAt;
  }
  return a.findingId < b.findingId ? -1 : 1;
};

/** Presentation key: chronological (creation ascending, then ID ascending). */
const findingsChronological = (a: Finding, b: Finding): number => {
  if (b.createdAt !== a.createdAt) {
    return a.createdAt - b.createdAt;
  }
  return a.findingId < b.findingId ? -1 : 1;
};

/**
 * Project refreshed Image descriptors and canonical Findings into bounded,
 * historical, automatically injected context text.
 *
 * Budget policy (all measured by JavaScript `String.length`):
 * - Framing and the longest (lookup) omission notice are reserved first, so
 *   the final sections including framing/notices fit the aggregates.
 * - Live descriptors consume the shared descriptor count/character budget in
 *   source order; their IDs are then excluded from the inventory.
 * - Inventory descriptors fill the remainder newest-first.
 * - Findings are selected newest-first within their budget and presented
 *   chronologically.
 *
 * Processing-state descriptors are internal and are excluded without being
 * counted as omissions.
 */
export function projectImageContext(input: ImageContextProjectionInput): ImageContextProjection {
  const framing = IMAGE_CONTEXT_FRAMING;
  const budget = IMAGE_CONTEXT_BUDGET;

  const liveImages = input.liveImages.filter((descriptor) => descriptor.state !== 'processing');
  const liveIds = new Set(liveImages.map((descriptor) => descriptor.imageId));
  const inventoryImages = input.inventoryImages
    .filter((descriptor) => descriptor.state !== 'processing' && !liveIds.has(descriptor.imageId))
    .sort(newestFirst);

  // Reserve framing + the longest notice so entries plus actual framing and
  // notices always fit the aggregate.
  let remaining =
    budget.descriptorAggregateChars -
    (framing.imageSectionHeader.length +
      1 +
      framing.liveSectionHeader.length +
      1 +
      framing.inventorySectionHeader.length +
      1 +
      framing.imageOmissionNoticeWithLookup.length +
      1);
  let countLeft = budget.descriptorMaxCount;

  const liveSelected: Array<{ descriptor: ImageDescriptor; line: string }> = [];
  const inventorySelected: Array<{ descriptor: ImageDescriptor; line: string }> = [];
  let omittedImages = 0;

  const projectDescriptor = (
    descriptor: ImageDescriptor,
    selected: Array<{ descriptor: ImageDescriptor; line: string }>,
  ): void => {
    if (countLeft <= 0) {
      omittedImages += 1;
      return;
    }
    const cap = Math.min(budget.descriptorMaxChars, remaining - 1);
    const line = cap >= 0 ? renderImageDescriptor(descriptor, cap) : null;
    if (line === null) {
      omittedImages += 1;
      return;
    }
    selected.push({ descriptor, line });
    remaining -= line.length + 1;
    countLeft -= 1;
  };

  for (const descriptor of liveImages) {
    projectDescriptor(descriptor, liveSelected);
  }
  for (const descriptor of inventoryImages) {
    projectDescriptor(descriptor, inventorySelected);
  }

  const imageLines: string[] = [framing.imageSectionHeader];
  if (liveSelected.length > 0) {
    imageLines.push(framing.liveSectionHeader, ...liveSelected.map((entry) => entry.line));
  }
  if (inventorySelected.length > 0) {
    imageLines.push(framing.inventorySectionHeader, ...inventorySelected.map((entry) => entry.line));
  }
  if (omittedImages > 0) {
    imageLines.push(
      input.imageLookupExposed
        ? framing.imageOmissionNoticeWithLookup
        : framing.imageOmissionNotice,
    );
  }
  const descriptorsText =
    liveSelected.length === 0 && inventorySelected.length === 0 && omittedImages === 0
      ? ''
      : `${imageLines.join('\n')}\n`;

  // Findings: select newest-first, present chronologically.
  const findingCandidates = [...input.findings].sort(findingsNewestFirst);
  let remainingFindings =
    budget.findingAggregateChars -
    (framing.findingSectionHeader.length + 1 + framing.findingOmissionNoticeWithLookup.length + 1);
  let findingCountLeft = budget.findingMaxCount;
  const selectedFindings: Array<{ finding: Finding; block: string }> = [];

  for (const finding of findingCandidates) {
    if (findingCountLeft <= 0) {
      continue;
    }
    const cap = Math.min(budget.findingMaxChars, remainingFindings - 1);
    const block = cap >= 0 ? renderFinding(finding, cap) : null;
    if (block === null) {
      continue;
    }
    selectedFindings.push({ finding, block });
    remainingFindings -= block.length + 1;
    findingCountLeft -= 1;
  }
  const omittedFindings = input.findings.length - selectedFindings.length;
  selectedFindings.sort((left, right) => findingsChronological(left.finding, right.finding));

  let findingsText = '';
  if (selectedFindings.length > 0 || omittedFindings > 0) {
    const findingLines: string[] = [framing.findingSectionHeader];
    for (const entry of selectedFindings) {
      findingLines.push(entry.block);
    }
    if (omittedFindings > 0) {
      findingLines.push(
        input.imageLookupExposed
          ? framing.findingOmissionNoticeWithLookup
          : framing.findingOmissionNotice,
      );
    }
    findingsText = `${findingLines.join('\n')}\n`;
  }

  const sections = [descriptorsText, findingsText].filter((section) => section.length > 0);

  return {
    descriptorsText,
    findingsText,
    text: sections.join('\n\n'),
    liveImageIds: liveSelected.map((entry) => entry.descriptor.imageId),
    inventoryImageIds: inventorySelected.map((entry) => entry.descriptor.imageId),
    findingIds: selectedFindings.map((entry) => entry.finding.findingId),
    omittedImageCount: omittedImages,
    omittedFindingCount: omittedFindings,
    lookupHintIncluded:
      input.imageLookupExposed && (omittedImages > 0 || omittedFindings > 0),
  };
}
