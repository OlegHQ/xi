import type { DocumentSnapshot, LineIndex, DocumentVersion, Utf16Offset, CellColumn, Result } from '../../document/src/index.ts';

export type VimStructuralMotionKey = '%' | '(' | ')' | '{' | '}' | '[[' | ']]' | '[]' | ']['
  | '[(' | '[{' | '])' | ']}';

export interface VimStructuralMotionCursor {
  readonly documentVersion: DocumentVersion;
  readonly offset: Utf16Offset;
  readonly desiredDisplayCellColumn: CellColumn | null;
}

export interface VimStructuralMotionInvocation {
  readonly key: VimStructuralMotionKey;
  /** An explicit count on `%` is a percentage-of-file address. */
  readonly count?: number;
}

export interface VimStructuralMotionOptions {
  /** Vim's comma-separated opening/closing pairs, e.g. `(:),{:},[:]`. */
  readonly matchPairs?: string;
  /** Paragraph macros; blank lines are always paragraph boundaries. */
  readonly paragraphs?: string;
  /** Section macros used by `[[`, `]]`, `[]`, and `][`. */
  readonly sections?: string;
  /** Bounded UTF-16 scan budget for one structural resolution. */
  readonly maxScanUtf16?: number;
}

export type VimStructuralMotionFailure =
  | { readonly kind: 'stale-document-version' }
  | { readonly kind: 'invalid-cursor' }
  | { readonly kind: 'invalid-count' }
  | { readonly kind: 'invalid-option' }
  | { readonly kind: 'unmatched-structure' }
  | { readonly kind: 'document-read-failed' }
  | { readonly kind: 'scan-limit' };

export interface VimStructuralMotionOutcome {
  readonly cursor: VimStructuralMotionCursor;
  readonly kind: 'characterwise' | 'linewise';
  readonly moved: boolean;
}

const DEFAULT_MATCH_PAIRS = '(:),{:},[:]';
const DEFAULT_MAX_SCAN_UTF16 = 1_000_000;

/** Resolve built-in sentence, paragraph, section and matching-pair motions. */
export function resolveVimStructuralMotion(
  snapshot: DocumentSnapshot,
  cursor: VimStructuralMotionCursor,
  invocation: VimStructuralMotionInvocation,
  options: VimStructuralMotionOptions = {},
): Result<VimStructuralMotionOutcome, VimStructuralMotionFailure> {
  if (cursor.documentVersion !== snapshot.version) return failure('stale-document-version');
  const offset = cursor.offset as number;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.lengthUtf16 || !snapshot.slice(cursor.offset, cursor.offset).ok) {
    return failure('invalid-cursor');
  }
  const count = invocation.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1) return failure('invalid-count');
  const maxScan = options.maxScanUtf16 ?? DEFAULT_MAX_SCAN_UTF16;
  if (!Number.isSafeInteger(maxScan) || maxScan < 1) return failure('scan-limit');
  if (invocation.key === '%' && invocation.count !== undefined) {
    const targetLine = Math.min(snapshot.lineCount - 1, Math.floor((snapshot.lineCount - 1) * count / 100));
    const target = snapshot.lineStartOffset(targetLine as LineIndex);
    if (!target.ok) return failure('document-read-failed');
    const nextCursor: VimStructuralMotionCursor = Object.freeze({
      documentVersion: snapshot.version,
      offset: target.value,
      desiredDisplayCellColumn: 0 as CellColumn,
    });
    return {
      ok: true,
      value: Object.freeze({ cursor: nextCursor, kind: 'characterwise', moved: target.value !== cursor.offset }),
    };
  }
  const source = readSource(snapshot, offset, maxScan);
  if (!source.ok) return source;
  const current = scalarIndexAt(source.value.scalars, offset);
  const currentLine = lineAt(source.value.lines, offset);
  if (current === null || currentLine === null) return failure('invalid-cursor');

  let targetOffset: number | null;
  let kind: VimStructuralMotionOutcome['kind'] = 'characterwise';
  switch (invocation.key) {
    case '%':
      targetOffset = matchingPair(source.value.scalars, current, parsePairs(options.matchPairs ?? DEFAULT_MATCH_PAIRS));
      break;
    case '(':
    case ')':
      targetOffset = sentenceTarget(source.value.scalars, current, invocation.key === ')', count);
      break;
    case '{':
    case '}':
      kind = 'linewise';
      targetOffset = paragraphTarget(source.value.lines, currentLine, invocation.key === '}', count, options.paragraphs ?? '');
      break;
    case '[[':
    case ']]':
    case '[]':
    case '][':
      kind = 'linewise';
      targetOffset = sectionTarget(source.value.lines, currentLine, invocation.key, count, options.sections ?? 'SHN');
      break;
    case '[(':
      targetOffset = unmatchedPairTarget(source.value.scalars, current, '(', ')', -1, count);
      break;
    case '[{':
      targetOffset = unmatchedPairTarget(source.value.scalars, current, '{', '}', -1, count);
      break;
    case '])':
      targetOffset = unmatchedPairTarget(source.value.scalars, current, '(', ')', 1, count);
      break;
    case ']}':
      targetOffset = unmatchedPairTarget(source.value.scalars, current, '{', '}', 1, count);
      break;
  }
  if (targetOffset === null) return failure('unmatched-structure');
  const nextCursor: VimStructuralMotionCursor = Object.freeze({
    documentVersion: snapshot.version,
    offset: targetOffset as Utf16Offset,
    desiredDisplayCellColumn: 0 as CellColumn,
  });
  return {
    ok: true,
    value: Object.freeze({
      cursor: nextCursor,
      kind,
      moved: targetOffset !== offset,
    }),
  };
}

interface SourceLine {
  readonly start: number;
  readonly text: string;
}

interface Source {
  readonly lines: readonly SourceLine[];
  readonly scalars: readonly { readonly value: string; readonly offset: number }[];
}

function readSource(snapshot: DocumentSnapshot, offset: number, maxScan: number): Result<Source, VimStructuralMotionFailure> {
  const currentLineResult = snapshot.lineIndexAt(offset as Utf16Offset);
  if (!currentLineResult.ok) return failure('document-read-failed');
  const currentLine = currentLineResult.value as number;
  const currentStartResult = lineStart(snapshot, currentLine);
  if (!currentStartResult.ok) return currentStartResult;
  const currentStart = currentStartResult.value;
  const beforeBudget = Math.floor(maxScan / 2);
  const afterBudget = maxScan - beforeBudget;
  let firstLine = currentLine;
  let lastLine = currentLine;
  // Expand by line starts only; text is sliced after the bounded window is
  // selected. This keeps distant structural regions out of the keystroke read.
  while (firstLine > 0) {
    const previous = lineStart(snapshot, firstLine - 1);
    if (!previous.ok) return previous;
    if (currentStart - previous.value > beforeBudget) break;
    firstLine -= 1;
  }
  while (lastLine + 1 < snapshot.lineCount) {
    const next = lineStart(snapshot, lastLine + 1);
    if (!next.ok) return next;
    if (next.value - currentStart > afterBudget) break;
    lastLine += 1;
  }
  const starts: number[] = [];
  for (let index = firstLine; index <= lastLine; index += 1) {
    const start = lineStart(snapshot, index);
    if (!start.ok) return start;
    starts.push(start.value);
  }
  const lineEnds: number[] = [];
  let windowLength = 0;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    if (start === undefined) return failure('document-read-failed');
    const nextStart = starts[index + 1];
    const end: Result<number, VimStructuralMotionFailure> = nextStart === undefined
      ? lineEnd(snapshot, lastLine)
      : { ok: true, value: nextStart };
    if (!end.ok) return end;
    const contentEnd = Math.max(start, end.value - (lastLine < snapshot.lineCount - 1 || index + 1 < starts.length ? 1 : 0));
    const contentLength = contentEnd - start;
    // Reject before slicing a single oversized line. This keeps both the
    // document read and scalar materialization within the caller's budget.
    if (contentLength > maxScan) return failure('scan-limit');
    windowLength += contentLength;
    if (index + 1 < starts.length) windowLength += 1;
    if (windowLength > maxScan) return failure('scan-limit');
    lineEnds.push(contentEnd);
  }
  const lines: SourceLine[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const contentEnd = lineEnds[index];
    if (start === undefined || contentEnd === undefined) return failure('document-read-failed');
    const text = sliceLine(snapshot, start, contentEnd);
    if (!text.ok) return text;
    lines.push(Object.freeze({ start, text: text.value }));
  }
  const scalars: { value: string; offset: number }[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === undefined) continue;
    let scalarOffset = line.start;
    for (const value of line.text) {
      scalars.push({ value, offset: scalarOffset });
      scalarOffset += value.length;
    }
    if (lineIndex + 1 < lines.length) scalars.push({ value: '\n', offset: scalarOffset });
  }
  return { ok: true, value: Object.freeze({ lines: Object.freeze(lines), scalars: Object.freeze(scalars) }) };
}

function lineStart(snapshot: DocumentSnapshot, line: number): Result<number, VimStructuralMotionFailure> {
  const result = snapshot.lineStartOffset(line as LineIndex);
  return result.ok
    ? { ok: true, value: result.value as number }
    : failure('document-read-failed');
}

function lineEnd(snapshot: DocumentSnapshot, line: number): Result<number, VimStructuralMotionFailure> {
  return line + 1 < snapshot.lineCount
    ? lineStart(snapshot, line + 1)
    : { ok: true, value: snapshot.lengthUtf16 };
}

function sliceLine(snapshot: DocumentSnapshot, start: number, end: number): Result<string, VimStructuralMotionFailure> {
  const result = snapshot.slice(start as Utf16Offset, end as Utf16Offset);
  return result.ok
    ? { ok: true, value: result.value }
    : failure('document-read-failed');
}

function scalarIndexAt(scalars: readonly { readonly value: string; readonly offset: number }[], offset: number): number | null {
  if (scalars.length === 0) return null;
  let candidate: number | null = null;
  for (let index = 0; index < scalars.length; index += 1) {
    const scalar = scalars[index];
    if (scalar === undefined) continue;
    if (scalar.offset === offset) return index;
    if (scalar.offset > offset) break;
    candidate = index;
  }
  return candidate;
}

function lineAt(lines: readonly SourceLine[], offset: number): number | null {
  let candidate: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (line.start > offset) break;
    candidate = index;
  }
  return candidate;
}

function parsePairs(value: string): ReadonlyMap<string, string> {
  const pairs = new Map<string, string>();
  for (const part of value.split(',')) {
    const chars = [...part];
    // `matchpairs` entries are written as `(:)`, `{:}`, and `[:]`: the
    // middle colon is a separator, so use the outer characters as the pair.
    if (chars.length >= 3 && chars[0] !== undefined && chars.at(-1) !== undefined) {
      pairs.set(chars[0], chars.at(-1)!);
    } else if (chars.length === 2 && chars[0] !== undefined && chars[1] !== undefined) {
      pairs.set(chars[0], chars[1]);
    }
  }
  return pairs;
}

function matchingPair(
  scalars: readonly { readonly value: string; readonly offset: number }[],
  current: number,
  pairs: ReadonlyMap<string, string>,
): number | null {
  const item = scalars[current];
  if (item === undefined) return null;
  let opening = item.value;
  let closing = pairs.get(opening);
  let direction = 1;
  if (closing === undefined) {
    for (const [candidate, end] of pairs) {
      if (end === opening) {
        opening = candidate;
        closing = end;
        direction = -1;
        break;
      }
    }
  }
  if (closing === undefined) return null;
  let depth = 0;
  for (let index = current; index >= 0 && index < scalars.length; index += direction) {
    const value = scalars[index]?.value;
    if (direction === 1 && value === opening) depth += 1;
    else if (direction === 1 && value === closing) {
      depth -= 1;
      if (depth === 0) return scalars[index]?.offset ?? null;
    } else if (direction === -1 && value === closing) depth += 1;
    else if (direction === -1 && value === opening) {
      depth -= 1;
      if (depth === 0) return scalars[index]?.offset ?? null;
    }
  }
  return null;
}

/** Find the Nth unmatched delimiter in one direction (`[(`, `[{`, `])`, `]}`). */
function unmatchedPairTarget(
  scalars: readonly { readonly value: string; readonly offset: number }[],
  current: number,
  opening: string,
  closing: string,
  direction: -1 | 1,
  count: number,
): number | null {
  let depth = 0;
  let found = 0;
  for (let index = current; index >= 0 && index < scalars.length; index += direction) {
    const value = scalars[index]?.value;
    if (value === undefined) continue;
    if (direction < 0) {
      if (value === closing) depth += 1;
      else if (value === opening) {
        if (depth > 0) depth -= 1;
        else {
          found += 1;
          if (found === count) return scalars[index]?.offset ?? null;
        }
      }
    } else if (value === opening) depth += 1;
    else if (value === closing) {
      if (depth > 0) depth -= 1;
      else {
        found += 1;
        if (found === count) return scalars[index]?.offset ?? null;
      }
    }
  }
  return null;
}

function sentenceTarget(
  scalars: readonly { readonly value: string; readonly offset: number }[],
  current: number,
  forward: boolean,
  count: number,
): number | null {
  const starts: number[] = [scalars[0]?.offset ?? 0];
  for (let index = 0; index < scalars.length; index += 1) {
    const value = scalars[index]?.value;
    if (value !== '.' && value !== '!' && value !== '?') continue;
    const next = scalars[index + 1]?.value;
    if (index + 1 >= scalars.length || next === undefined || /\s/u.test(next)) {
      let target = index + 1;
      while (target < scalars.length && /\s/u.test(scalars[target]?.value ?? '')) target += 1;
      if (target < scalars.length) starts.push(scalars[target]?.offset ?? 0);
    }
  }
  const currentOffset = scalars[current]?.offset ?? 0;
  let sentence = 0;
  for (let index = 0; index < starts.length; index += 1) {
    if ((starts[index] ?? 0) <= currentOffset) sentence = index;
  }
  const target = forward ? sentence + count : sentence - (currentOffset === (starts[sentence] ?? 0) ? count : count - 1);
  return starts[target] ?? null;
}

function paragraphTarget(lines: readonly SourceLine[], current: number, forward: boolean, count: number, paragraphs: string): number | null {
  let line = current;
  for (let step = 0; step < count; step += 1) {
    const direction = forward ? 1 : -1;
    let found = false;
    while (line + direction >= 0 && line + direction < lines.length) {
      line += direction;
      if (isParagraphBoundary(lines[line]?.text ?? '', paragraphs)) {
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  return lines[line]?.start ?? null;
}

function isParagraphBoundary(text: string, paragraphs: string): boolean {
  if (text.trim() === '') return true;
  for (let index = 0; index + 1 < paragraphs.length; index += 2) {
    const macro = paragraphs.slice(index, index + 2);
    if (/^[A-Za-z]{2}$/u.test(macro) && new RegExp(`^\\s*\\.?${macro}(?:\\s|$)`, 'u').test(text)) return true;
  }
  return false;
}

function sectionTarget(lines: readonly SourceLine[], current: number, key: VimStructuralMotionKey, count: number, sections: string): number | null {
  const headings: { readonly index: number; readonly line: SourceLine }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && isSectionHeading(line.text, sections)) headings.push({ index, line });
  }
  if (headings.length === 0) return key === ']]' || key === '][' ? lines.at(-1)?.start ?? null : lines[0]?.start ?? null;
  const forward = key === ']]' || key === '][';
  const end = key === '[]' || key === '][';
  let position = headings.findIndex(({ index }) => index > current);
  if (!forward) {
    position = 0;
    for (let index = headings.length - 1; index >= 0; index -= 1) {
      if ((headings[index]?.index ?? 0) < current) { position = index; break; }
    }
  } else if (position < 0) {
    // At the final section Vim leaves the cursor at the final heading.
    position = headings.length - 1;
  }
  const target = position + (forward ? count - 1 : -(count - 1));
  const heading = headings[target];
  if (heading === undefined) return null;
  const lineIndex = end ? nextSectionLine(headings, target, forward) : heading.index;
  return lines[lineIndex]?.start ?? null;
}

function isSectionHeading(text: string, sections: string): boolean {
  const macros: string[] = [];
  for (let index = 0; index + 1 < sections.length; index += 2) {
    const pair = sections.slice(index, index + 2);
    if (/^[A-Za-z]{2}$/u.test(pair)) macros.push(pair);
  }
  return macros.some((macro) => new RegExp(`^\\s*\\.?${macro}\\s`, 'u').test(text));
}

function nextSectionLine(headings: readonly { readonly index: number }[], position: number, forward: boolean): number {
  const current = headings[position]?.index ?? 0;
  const next = headings[position + (forward ? 1 : -1)]?.index;
  return next === undefined ? current : (forward ? Math.max(current, next - 1) : next);
}

function lineStartForPercentage(lines: readonly SourceLine[], count: number): number | null {
  if (lines.length === 0) return null;
  const index = Math.min(lines.length - 1, Math.floor((lines.length - 1) * count / 100));
  return lines[index]?.start ?? null;
}

function failure<K extends VimStructuralMotionFailure['kind']>(kind: K): { readonly ok: false; readonly error: Extract<VimStructuralMotionFailure, { readonly kind: K }> } {
  return { ok: false, error: { kind } as Extract<VimStructuralMotionFailure, { readonly kind: K }> };
}
