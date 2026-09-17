import {
  type DocumentVersion,
  type LineIndex,
  type Utf16Column,
  type Utf16Offset,
  type Utf32Column,
  type Utf32Offset,
  type Utf8ByteColumn,
  type Utf8ByteOffset,
} from '../../primitives/src/index';
import type { DocumentReadFailure, DocumentSnapshot, Result } from './contracts.ts';

export type PositionEncoding = 'utf-8' | 'utf-16' | 'utf-32';

/** Zero-based line/character coordinates; character unit is selected by encoding. */
export type EncodedTextPosition =
  | { readonly version: DocumentVersion; readonly line: LineIndex; readonly encoding: 'utf-8'; readonly character: Utf8ByteColumn }
  | { readonly version: DocumentVersion; readonly line: LineIndex; readonly encoding: 'utf-16'; readonly character: Utf16Column }
  | { readonly version: DocumentVersion; readonly line: LineIndex; readonly encoding: 'utf-32'; readonly character: Utf32Column };

export type CoordinateFailure = DocumentReadFailure
  | { readonly kind: 'invalid-column' }
  | { readonly kind: 'invalid-encoding' };

interface LineBaseOffsets {
  readonly utf16: number;
  readonly utf8: number;
  readonly utf32: number;
}

/** Convert a safe UTF-16 boundary to a line/character position for the snapshot's version. */
export function offsetToPosition(
  snapshot: DocumentSnapshot,
  offset: Utf16Offset,
  encoding: PositionEncoding,
): Result<EncodedTextPosition, CoordinateFailure> {
  const lineResult = snapshot.lineIndexAt(offset);
  if (!lineResult.ok) return lineResult;
  const line = lineResult.value;
  const base = getLineBase(snapshot, line);
  if (!base.ok) return base;
  switch (encoding) {
    case 'utf-8': {
      const absolute = snapshot.utf8OffsetAt(offset);
      return absolute.ok
        ? { ok: true, value: { version: snapshot.version, line, encoding, character: utf8Column((absolute.value as number) - base.value.utf8) } }
        : absolute;
    }
    case 'utf-16':
      return {
        ok: true,
        value: { version: snapshot.version, line, encoding, character: utf16Column((offset as number) - base.value.utf16) },
      };
    case 'utf-32': {
      const absolute = snapshot.utf32OffsetAt(offset);
      return absolute.ok
        ? { ok: true, value: { version: snapshot.version, line, encoding, character: utf32Column((absolute.value as number) - base.value.utf32) } }
        : absolute;
    }
    default:
      return { ok: false, error: { kind: 'invalid-encoding' } };
  }
}

/** Convert only positions from the same snapshot version to a safe UTF-16 boundary. */
export function positionToOffset(
  snapshot: DocumentSnapshot,
  position: EncodedTextPosition,
): Result<Utf16Offset, CoordinateFailure> {
  if (position.version !== snapshot.version) return { ok: false, error: { kind: 'stale-version' } };
  if (position.encoding !== 'utf-8' && position.encoding !== 'utf-16' && position.encoding !== 'utf-32') {
    return { ok: false, error: { kind: 'invalid-encoding' } };
  }
  const lineNumber = position.line as number;
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 0 || lineNumber >= snapshot.lineCount) {
    return { ok: false, error: { kind: 'invalid-line' } };
  }
  const base = getLineBase(snapshot, position.line);
  if (!base.ok) return base;
  const column = position.character as number;
  if (!Number.isSafeInteger(column) || column < 0) return { ok: false, error: { kind: 'invalid-column' } };

  let converted: Result<Utf16Offset, DocumentReadFailure>;
  switch (position.encoding) {
    case 'utf-8':
      converted = snapshot.offsetAtUtf8(utf8Offset(base.value.utf8 + column));
      break;
    case 'utf-16': {
      const offset = utf16Offset(base.value.utf16 + column);
      const boundary = snapshot.lineIndexAt(offset);
      if (!boundary.ok) return boundary.error.kind === 'surrogate-split'
        ? { ok: false, error: { kind: 'surrogate-split' } }
        : { ok: false, error: { kind: 'invalid-column' } };
      converted = { ok: true, value: offset };
      break;
    }
    case 'utf-32':
      converted = snapshot.offsetAtUtf32(utf32Offset(base.value.utf32 + column));
      break;
    default:
      return { ok: false, error: { kind: 'invalid-encoding' } };
  }
  if (!converted.ok) {
    return converted.error.kind === 'invalid-encoded-offset' || converted.error.kind === 'invalid-range'
      ? { ok: false, error: { kind: 'invalid-column' } }
      : converted;
  }
  const resolvedLine = snapshot.lineIndexAt(converted.value);
  if (!resolvedLine.ok) return resolvedLine;
  return resolvedLine.value === position.line
    ? converted
    : { ok: false, error: { kind: 'invalid-column' } };
}

// Not cached: the rope keeps precomputed per-subtree UTF-8/UTF-32 byte-length aggregates
// (rope.ts's `rootUtf8Bytes`/`rootScalars`, consumed by `countUtf8Before`/`countScalarsBefore`),
// so `utf8OffsetAt`/`utf32OffsetAt` are already O(log n) tree descents, not O(n) scans. A
// per-snapshot line-base cache used to sit here, but it was keyed on the snapshot wrapper
// itself, so LSP re-sync (a fresh wrapper per version) recomputed it on every version even
// when the underlying rope was unchanged -- while buying nothing the rope's own aggregates
// didn't already provide in the same O(log n) budget. Measured: a 100x file-size increase
// (100 KiB -> 10 MiB) changed the average `utf8OffsetAt` call from ~3.4us to ~5.2us, not
// ~100x -- see the T7 benchmark referenced in docs/evidence.
function getLineBase(snapshot: DocumentSnapshot, line: LineIndex): Result<LineBaseOffsets, DocumentReadFailure> {
  const utf16Start = snapshot.lineStartOffset(line);
  if (!utf16Start.ok) return utf16Start;
  const utf8Start = snapshot.utf8OffsetAt(utf16Start.value);
  if (!utf8Start.ok) return utf8Start;
  const utf32Start = snapshot.utf32OffsetAt(utf16Start.value);
  if (!utf32Start.ok) return utf32Start;
  return {
    ok: true,
    value: Object.freeze({
      utf16: utf16Start.value as number,
      utf8: utf8Start.value as number,
      utf32: utf32Start.value as number,
    }),
  };
}

function utf16Offset(value: number): Utf16Offset { return value as Utf16Offset; }
function utf8Offset(value: number): Utf8ByteOffset { return value as Utf8ByteOffset; }
function utf32Offset(value: number): Utf32Offset { return value as Utf32Offset; }
function utf8Column(value: number): Utf8ByteColumn { return value as Utf8ByteColumn; }
function utf16Column(value: number): Utf16Column { return value as Utf16Column; }
function utf32Column(value: number): Utf32Column { return value as Utf32Column; }
