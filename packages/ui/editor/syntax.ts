/**
 * Presentation-only syntax projection. The editor receives immutable spans
 * from the syntax service and clips them to visible UTF-16 ranges; it never
 * parses text or keeps a second editable buffer.
 */
import type { SyntaxSpan, SyntaxTokenKind } from '../../contracts/src/index';

export type EditorSyntaxTokenKind = SyntaxTokenKind;
export type EditorSyntaxSpan = SyntaxSpan;

export interface ClippedSyntaxSpan {
  /** Start/end are relative to the supplied visible range. */
  readonly start: number;
  readonly end: number;
  readonly kind: EditorSyntaxTokenKind;
}

export interface SyntaxRowProjection {
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly spans: readonly ClippedSyntaxSpan[];
  readonly truncated: boolean;
}

const DEFAULT_SPAN_LIMIT = 2_048;

/** Clip sorted or unsorted service spans to a visible UTF-16 range. */
export function clipSyntaxSpans(
  spans: readonly EditorSyntaxSpan[],
  visibleStart: number,
  visibleEnd: number,
  maxSpans = DEFAULT_SPAN_LIMIT,
): readonly ClippedSyntaxSpan[] {
  const start = Math.max(0, Math.min(visibleStart, visibleEnd));
  const end = Math.max(start, visibleEnd);
  const limit = Math.max(0, Math.floor(maxSpans));
  if (limit === 0 || end === start) return Object.freeze([]);
  const output: ClippedSyntaxSpan[] = [];
  const ordered = spans.length > 1
    ? [...spans].sort((left, right) => left.start - right.start || left.end - right.end)
    : spans;
  for (const span of ordered) {
    if (span.end <= start) continue;
    if (span.start >= end) break;
    if (output.length >= limit) break;
    const clippedStart = Math.max(start, span.start) - start;
    const clippedEnd = Math.min(end, span.end) - start;
    if (clippedEnd > clippedStart) output.push(Object.freeze({ start: clippedStart, end: clippedEnd, kind: span.kind }));
  }
  return Object.freeze(output);
}

/** Build one row's clipped decoration model without touching document text. */
export function projectSyntaxRow(
  spans: readonly EditorSyntaxSpan[],
  lineStart: number,
  lineEnd: number,
  maxSpans = DEFAULT_SPAN_LIMIT,
): SyntaxRowProjection {
  const start = Math.max(0, Math.min(lineStart, lineEnd));
  const end = Math.max(start, lineEnd);
  const clipped = clipSyntaxSpans(spans, start, end, maxSpans);
  let intersecting = 0;
  for (const span of spans) {
    if (span.end > start && span.start < end) intersecting += 1;
  }
  return Object.freeze({ lineStart: start, lineEnd: end, spans: clipped, truncated: intersecting > clipped.length });
}
