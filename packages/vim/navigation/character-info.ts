import type { DocumentSnapshot, Result, Utf16Offset } from '../../document/src/index.ts';

/** Read-only character metadata consumed by `ga` and `g8` message views. */
export interface VimCharacterInfo {
  /** One Vim grapheme at the supplied UTF-16 cursor boundary. */
  readonly grapheme: string;
  /** Unicode scalar values making up the grapheme, in source order. */
  readonly codePoints: readonly number[];
  /** UTF-8 bytes of the complete grapheme, in source order. */
  readonly utf8Bytes: readonly number[];
  readonly utf8Hex: string;
}

export type VimCharacterInfoFailure =
  | { readonly kind: 'invalid-cursor' }
  | { readonly kind: 'document-read-failed' }
  | { readonly kind: 'no-character' };

/** Resolve the character under a Normal cursor without producing UI output. */
export function resolveVimCharacterInfo(
  snapshot: DocumentSnapshot,
  cursorOffset: Utf16Offset,
): Result<VimCharacterInfo, VimCharacterInfoFailure> {
  const offset = cursorOffset as number;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.lengthUtf16 || !snapshot.slice(cursorOffset, cursorOffset).ok) {
    return failure('invalid-cursor');
  }
  const lineResult = snapshot.lineIndexAt(cursorOffset);
  if (!lineResult.ok) return failure('invalid-cursor');
  const startResult = snapshot.lineStartOffset(lineResult.value);
  if (!startResult.ok) return failure('document-read-failed');
  const nextStart = lineResult.value + 1 < snapshot.lineCount
    ? snapshot.lineStartOffset((lineResult.value + 1) as typeof lineResult.value)
    : null;
  if (nextStart !== null && !nextStart.ok) return failure('document-read-failed');
  const lineEnd = nextStart?.ok === true ? (nextStart.value as number) - 1 : snapshot.lengthUtf16;
  const line = snapshot.slice(startResult.value, lineEnd as Utf16Offset);
  if (!line.ok) return failure('document-read-failed');
  const local = offset - (startResult.value as number);
  let grapheme: string | undefined;
  if (local < 0 || local >= line.value.length) return failure('no-character');
  const segmenter = (Intl as typeof Intl & {
    readonly Segmenter?: new (_locales?: string | readonly string[], _options?: { readonly granularity: 'grapheme' }) => {
      segment(value: string): Iterable<{ readonly segment: string; readonly index: number }>;
    };
  }).Segmenter;
  if (typeof segmenter !== 'function') return failure('document-read-failed');
  for (const part of new segmenter('und', { granularity: 'grapheme' }).segment(line.value)) {
    if (part.index === local) {
      grapheme = part.segment;
      break;
    }
  }
  if (grapheme === undefined) return failure('invalid-cursor');
  const codePoints = Object.freeze([...grapheme].map((value) => value.codePointAt(0) ?? 0));
  const utf8Bytes = Object.freeze([...new TextEncoder().encode(grapheme)]);
  return {
    ok: true,
    value: Object.freeze({
      grapheme,
      codePoints,
      utf8Bytes,
      utf8Hex: utf8Bytes.map((value) => value.toString(16).padStart(2, '0')).join(' '),
    }),
  };
}

function failure(kind: VimCharacterInfoFailure['kind']): Result<never, VimCharacterInfoFailure> {
  return { ok: false, error: { kind } };
}
