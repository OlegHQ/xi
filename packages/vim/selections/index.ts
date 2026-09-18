import type { DocumentSnapshot, LineIndex, Result, Utf16Offset } from '../../document/src/index';
import {
  updateSelectionSet,
  type EndpointInput,
  type SelectionEndpoint,
  type SelectionMember,
  type SelectionMemberInput,
  type SelectionSetSnapshot,
} from '../../selections/src/index';
import type { SelectionId } from '../../selections/src/index';
import { exchangeVimVisualEndpoints } from '../visual/index';
import { compilePattern, createPatternTextSnapshot, findAllMatches, patternSnapshotFromDocument, PatternEvaluationError } from '../pattern/index';

export type VimSelectionCommand =
  | 'selection.add-above' | 'selection.add-below' | 'selection.add-next-match' | 'selection.skip-next-match'
  | 'selection.select-all-matches' | 'selection.split-lines' | 'selection.select-regex'
  | 'selection.keep-matching' | 'selection.remove-primary' | 'selection.keep-primary'
  | 'selection.rotate-primary-next' | 'selection.rotate-primary-previous' | 'selection.collapse'
  | 'selection.flip' | 'selection.merge' | 'selection.undo';

export interface VimSelectionCommandInput {
  readonly snapshot: DocumentSnapshot;
  readonly selections: SelectionSetSnapshot;
  readonly command: VimSelectionCommand;
  readonly pattern?: string;
  readonly regex?: boolean;
  readonly ignoreCase?: boolean;
  readonly limit?: number;
  /** Most recent selection states, newest first, owned by the live Vim session. */
  readonly history?: readonly SelectionSetSnapshot[];
  readonly cancellation?: { readonly isCancelled: boolean };
}

export interface VimSelectionCommandResult {
  readonly selection: SelectionSetSnapshot;
  readonly added: number;
  readonly skipped: number;
  readonly progress: { readonly scanned: number; readonly matched: number; readonly limit: number };
}

export type VimSelectionCommandFailure =
  | { readonly kind: 'stale-selection' | 'invalid-selection' | 'no-matches' | 'empty-filter-result' }
  | { readonly kind: 'selection-history-empty' }
  | { readonly kind: 'selection-limit'; readonly limit: number }
  | { readonly kind: 'invalid-pattern' | 'cancelled' | 'unsupported-command' };

const DEFAULT_LIMIT = 10_000;
const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('und', { granularity: 'grapheme' }) : undefined;

/** Execute one selection-set command atomically against one immutable snapshot. */
export function applyVimSelectionCommand(input: VimSelectionCommandInput): Result<VimSelectionCommandResult, VimSelectionCommandFailure> {
  if (input.snapshot.id !== input.selections.documentId || input.snapshot.version !== input.selections.documentVersion) return fail('stale-selection');
  if (input.selections.members.length === 0) return fail('invalid-selection');
  if (input.cancellation?.isCancelled === true) return fail('cancelled');
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1) return fail('selection-limit', limit);
  switch (input.command) {
    case 'selection.add-above': return addLine(input, -1, limit);
    case 'selection.add-below': return addLine(input, 1, limit);
    case 'selection.add-next-match': return addMatch(input, false, limit);
    case 'selection.skip-next-match': return addMatch(input, true, limit);
    case 'selection.select-all-matches': return selectMatches(input, false, limit);
    case 'selection.select-regex': return selectMatches(input, true, limit);
    case 'selection.keep-matching': return filterMembers(input, true);
    case 'selection.remove-primary': return removePrimary(input);
    case 'selection.keep-primary': return keepPrimary(input);
    case 'selection.rotate-primary-next': return rotatePrimary(input, 1);
    case 'selection.rotate-primary-previous': return rotatePrimary(input, -1);
    case 'selection.collapse': return collapse(input);
    case 'selection.flip': return flip(input);
    case 'selection.merge': return merge(input);
    case 'selection.split-lines': return splitLines(input, limit);
    case 'selection.undo': return undoSelection(input);
  }
}

function addLine(input: VimSelectionCommandInput, delta: -1 | 1, limit: number): Result<VimSelectionCommandResult, VimSelectionCommandFailure> {
  const additions: SelectionMemberInput[] = input.selections.members.map((member) => {
    const line = input.snapshot.lineIndexAt(member.head.at.offset);
    if (!line.ok) throw new Error('selection-line');
    const target = (line.value as number) + delta;
    if (target < 0 || target >= input.snapshot.lineCount) return memberInput(member);
    const desiredColumn = member.desiredColumn.logicalUtf16 ?? member.desiredColumn.displayCell;
    const offset = offsetAtColumn(input.snapshot, target as LineIndex, desiredColumn as number | null);
    return { id: nextId(input.selections, member.id, target), kind: 'normal-cursor', direction: 'forward', anchor: endpointAt(input.snapshot, offset), head: endpointAt(input.snapshot, offset), desiredColumn: member.desiredColumn };
  });
  const existing = input.selections.members.map(memberInput);
  const unique = additions.filter((candidate) => !existing.some((member) => member.id === candidate.id));
  const primaryId = unique.at(-1)?.id ?? input.selections.primaryId;
  return update(input, [...existing, ...unique], unique.length, 0, limit, primaryId);
}

function addMatch(input: VimSelectionCommandInput, skip: boolean, limit: number): Result<VimSelectionCommandResult, VimSelectionCommandFailure> {
  const primary = input.selections.members.find((member) => member.id === input.selections.primaryId);
  if (primary === undefined) return fail('invalid-selection');
  const pattern = input.pattern ?? wordUnderPrimary(input.snapshot, primary);
  if (pattern === undefined || pattern.length === 0) return fail('invalid-pattern');
  const matches = evaluateSelectionPattern(input, pattern, Math.min(1_000_000, Math.max(limit + 1, 100_000)), limit);
  if (!matches.ok) return matches;
  const primaryRange = selectionRange(input.snapshot, primary);
  if (primaryRange === undefined) return fail('invalid-selection');
  const isFirstNormalInvocation = primary.kind === 'normal-cursor' || primary.kind === 'insert-caret';
  const currentMatch = isFirstNormalInvocation
    ? matches.value.find((match) => (match.start as number) <= primaryRange.start && (match.end as number) > primaryRange.start)
    : undefined;
  if (currentMatch !== undefined) {
    if (skip) return update(input, input.selections.members.map(memberInput), 0, 1, limit);
    const materialized = visualMember(input.snapshot, input.selections.primaryId, currentMatch.start as number, currentMatch.end as number);
    return materialized === undefined ? fail('invalid-selection') : update(input, [materialized], 1, 0, limit, materialized.id);
  }
  const next = matches.value.find((match) => (match.start as number) >= primaryRange.end
    && !input.selections.members.some((member) => rangesOverlap(selectionRange(input.snapshot, member), match.start as number, match.end as number)));
  if (next === undefined) return fail('no-matches');
  if (skip) return update(input, input.selections.members.map(memberInput), 0, 1, limit);
  const added = visualMember(input.snapshot, newId(input.selections, input.selections.members.length), next.start as number, next.end as number);
  if (added === undefined) return fail('invalid-selection');
  const existing = input.selections.members.map((member) => memberInput(member));
  return update(input, [...existing, added], 1, 0, limit, added.id);
}

function evaluateSelectionPattern(
  input: VimSelectionCommandInput,
  pattern: string,
  outputLimit: number,
  selectionLimit = outputLimit,
): Result<ReturnType<typeof findAllMatches>['matches'], VimSelectionCommandFailure> {
  return evaluateSelectionPatternOnSnapshot(input, pattern, outputLimit, selectionLimit, patternSnapshotFromDocument(input.snapshot));
}

function evaluateSelectionPatternOnSnapshot(
  input: VimSelectionCommandInput,
  pattern: string,
  outputLimit: number,
  selectionLimit: number,
  snapshot: Parameters<typeof findAllMatches>[1],
): Result<ReturnType<typeof findAllMatches>['matches'], VimSelectionCommandFailure> {
  try {
    const options = {
      outputLimit,
      ...(input.ignoreCase === undefined ? {} : { ignoreCase: input.ignoreCase }),
      ...(input.cancellation === undefined ? {} : { shouldCancel: () => input.cancellation?.isCancelled === true }),
    };
    const program = compilePattern(pattern, options);
    return { ok: true, value: findAllMatches(program, snapshot).matches };
  } catch (error: unknown) {
    if (error instanceof PatternEvaluationError && error.code === 'output-limit-exceeded') return fail('selection-limit', selectionLimit);
    if (error instanceof PatternEvaluationError && error.code === 'cancelled') return fail('cancelled');
    return fail('invalid-pattern');
  }
}

function selectionPattern(pattern: string, regex: boolean): string {
  if (!regex) return pattern;
  const lookaround = /^\(\?([=!])([\s\S]*)\)$/u.exec(pattern);
  if (lookaround === null) return pattern;
  const operator = lookaround[1] === '=' ? '@=' : '@!';
  return `\\(${lookaround[2] ?? ''}\\)\\${operator}`;
}

function selectMatches(input: VimSelectionCommandInput, regex: boolean, limit: number): Result<VimSelectionCommandResult, VimSelectionCommandFailure> {
  const pattern = input.pattern;
  if (pattern === undefined || pattern.length === 0) return fail('invalid-pattern');
  const evaluated = regex
    ? evaluateRegexInSelectedRegions(input, selectionPattern(pattern, true), limit)
    : evaluateSelectionPattern(input, pattern, Math.min(1_000_000, limit + 1), limit);
  if (!evaluated.ok) return evaluated;
  const members: SelectionMemberInput[] = [];
  for (const match of evaluated.value) {
    if (input.cancellation?.isCancelled === true) return fail('cancelled');
    if (members.length >= limit) return { ok: false, error: { kind: 'selection-limit', limit } };
    const member = visualMember(input.snapshot, newId(input.selections, members.length), match.start as number, match.end as number);
    if (member === undefined) return fail('invalid-selection');
    members.push(member);
  }
  if (members.length === 0) return fail('no-matches');
  const primaryId = members[0]?.id ?? input.selections.primaryId;
  return update(input, members, members.length, 0, limit, primaryId);
}

function evaluateRegexInSelectedRegions(
  input: VimSelectionCommandInput,
  pattern: string,
  limit: number,
): Result<readonly { readonly start: number; readonly end: number }[], VimSelectionCommandFailure> {
  const matches: { readonly start: number; readonly end: number }[] = [];
  for (const member of input.selections.members) {
    if (input.cancellation?.isCancelled === true) return fail('cancelled');
    const region = selectionRange(input.snapshot, member);
    if (region === undefined || region.end < region.start) return fail('invalid-selection');
    const text = input.snapshot.slice(region.start as Utf16Offset, region.end as Utf16Offset);
    if (!text.ok) return fail('invalid-selection');
    const evaluated = evaluateSelectionPatternOnSnapshot(
      input,
      pattern,
      Math.min(1_000_000, limit + 1),
      limit,
      createPatternTextSnapshot(input.snapshot.version, text.value),
    );
    if (!evaluated.ok) return evaluated;
    for (const match of evaluated.value) {
      if (matches.length >= limit) return { ok: false, error: { kind: 'selection-limit', limit } };
      matches.push({ start: region.start + (match.start as number), end: region.start + (match.end as number) });
    }
  }
  return { ok: true, value: matches };
}

function filterMembers(input: VimSelectionCommandInput, keep: boolean): Result<VimSelectionCommandResult, VimSelectionCommandFailure> {
  const pattern = input.pattern;
  if (pattern === undefined) return fail('invalid-pattern');
  const kept: SelectionMember[] = [];
  for (const member of input.selections.members) {
    if (input.cancellation?.isCancelled === true) return fail('cancelled');
    const text = input.snapshot.slice(memberTextStart(member) as Utf16Offset, memberTextEnd(member) as Utf16Offset);
    if (!text.ok) return fail('invalid-selection');
    if (text.value.includes(pattern) === keep) kept.push(member);
  }
  if (kept.length === 0) return fail('empty-filter-result');
  return update(input, kept.map(memberInput), 0, 0, DEFAULT_LIMIT);
}

function removePrimary(input: VimSelectionCommandInput): Result<VimSelectionCommandResult, VimSelectionCommandFailure> {
  if (input.selections.members.length === 1) return update(input, input.selections.members.map(memberInput), 0, 0, DEFAULT_LIMIT);
  const members = input.selections.members.filter((member) => member.id !== input.selections.primaryId).map(memberInput);
  const primary = members[0];
  if (primary === undefined) return fail('invalid-selection');
  return update(input, members, -1, 0, DEFAULT_LIMIT, primary.id);
}

function keepPrimary(input: VimSelectionCommandInput): Result<VimSelectionCommandResult, VimSelectionCommandFailure> {
  const primary = input.selections.members.find((member) => member.id === input.selections.primaryId);
  return primary === undefined ? fail('invalid-selection') : update(input, [memberInput(primary)], -input.selections.members.length + 1, 0, DEFAULT_LIMIT, primary.id);
}

function rotatePrimary(input: VimSelectionCommandInput, direction: 1 | -1): Result<VimSelectionCommandResult, VimSelectionCommandFailure> {
  const members = [...input.selections.members];
  const index = members.findIndex((member) => member.id === input.selections.primaryId);
  if (index < 0) return fail('invalid-selection');
  const next = members[(index + direction + members.length) % members.length];
  if (next === undefined) return fail('invalid-selection');
  return update(input, members.map(memberInput), 0, 0, DEFAULT_LIMIT, next.id);
}

function collapse(input: VimSelectionCommandInput): Result<VimSelectionCommandResult, VimSelectionCommandFailure> {
  return update(input, input.selections.members.map((member) => ({ ...memberInput(member), kind: 'normal-cursor', anchor: endpointInput(member.head), head: endpointInput(member.head) })), 0, 0, DEFAULT_LIMIT);
}

function flip(input: VimSelectionCommandInput): Result<VimSelectionCommandResult, VimSelectionCommandFailure> {
  const flipped = exchangeVimVisualEndpoints(input.snapshot, input.selections);
  return flipped.ok ? { ok: true, value: { selection: flipped.value, added: 0, skipped: 0, progress: { scanned: 0, matched: input.selections.members.length, limit: DEFAULT_LIMIT } } } : fail('invalid-selection');
}

function merge(input: VimSelectionCommandInput): Result<VimSelectionCommandResult, VimSelectionCommandFailure> {
  return update(input, input.selections.members.map(memberInput), 0, 0, DEFAULT_LIMIT);
}

function undoSelection(input: VimSelectionCommandInput): Result<VimSelectionCommandResult, VimSelectionCommandFailure> {
  const previous = input.history?.[0];
  if (previous === undefined) return fail('selection-history-empty');
  if (previous.documentId !== input.snapshot.id || previous.documentVersion !== input.snapshot.version) return fail('stale-selection');
  return update(input, previous.members.map(memberInput), 0, 0, input.limit ?? DEFAULT_LIMIT, previous.primaryId);
}

function splitLines(input: VimSelectionCommandInput, limit: number): Result<VimSelectionCommandResult, VimSelectionCommandFailure> {
  const members: SelectionMemberInput[] = [];
  for (const member of input.selections.members) {
    const region = selectionRange(input.snapshot, member);
    if (region === undefined) return fail('invalid-selection');
    const first = input.snapshot.lineIndexAt(region.start as Utf16Offset);
    const last = input.snapshot.lineIndexAt(Math.max(region.start, region.end - 1) as Utf16Offset);
    if (!first.ok || !last.ok) return fail('invalid-selection');
    for (let line = first.value as number; line <= (last.value as number); line += 1) {
      if (members.length >= limit) return { ok: false, error: { kind: 'selection-limit', limit } };
      const span = lineSpan(input.snapshot, line as LineIndex);
      if (span === undefined) return fail('invalid-selection');
      const start = Math.max(region.start, span.contentStart as number);
      const end = Math.min(region.end, span.contentEnd as number);
      const id = newId(input.selections, members.length);
      const next = start < end
        ? visualMember(input.snapshot, id, start, end)
        : span.contentStart === span.contentEnd && region.start <= (span.contentStart as number) && region.end >= (span.contentEnd as number)
          ? visualMember(input.snapshot, id, span.contentStart as number, span.contentEnd as number)
          : undefined;
      if (next === undefined) continue;
      members.push(next);
    }
  }
  const primaryId = members[0]?.id ?? input.selections.primaryId;
  return members.length === 0 ? fail('no-matches') : update(input, members, members.length, 0, limit, primaryId);
}

function update(input: VimSelectionCommandInput, members: readonly SelectionMemberInput[], added: number, skipped: number, limit: number, primaryId = input.selections.primaryId): Result<VimSelectionCommandResult, VimSelectionCommandFailure> {
  const result = updateSelectionSet(input.snapshot, input.selections, { primaryId, members });
  if (!result.ok) return fail(result.error.kind === 'empty-selection-set' ? 'empty-filter-result' : 'invalid-selection');
  return { ok: true, value: Object.freeze({ selection: result.value.selectionSet, added, skipped, progress: Object.freeze({ scanned: members.length, matched: members.length, limit }) }) };
}

function endpointAt(snapshot: DocumentSnapshot, offset: Utf16Offset): EndpointInput {
  if ((offset as number) >= snapshot.lengthUtf16) return { kind: 'eof' };
  const line = snapshot.lineIndexAt(offset); if (!line.ok) return { kind: 'eof' };
  const next = (line.value as number) + 1 < snapshot.lineCount ? snapshot.lineStartOffset((line.value as number + 1) as LineIndex) : null;
  const end = next?.ok === true ? (next.value as number) - 1 : snapshot.lengthUtf16 as number;
  if ((offset as number) >= end) return { kind: 'empty-line', lineIndex: line.value };
  const after = firstGraphemeEnd(snapshot, offset as number, end);
  return after === null ? { kind: 'eof' } : { kind: 'character', offset, after: after as Utf16Offset };
}

interface SelectionRange {
  readonly start: number;
  readonly end: number;
}

function selectionRange(snapshot: DocumentSnapshot, member: SelectionMember): SelectionRange | undefined {
  if (member.kind === 'visual-line') {
    const first = Math.min(member.anchor.lineIndex as number, member.head.lineIndex as number);
    const last = Math.max(member.anchor.lineIndex as number, member.head.lineIndex as number);
    const firstSpan = lineSpan(snapshot, first as LineIndex);
    const lastSpan = lineSpan(snapshot, last as LineIndex);
    return firstSpan === undefined || lastSpan === undefined
      ? undefined
      : { start: firstSpan.contentStart as number, end: lastSpan.contentEnd as number };
  }
  if (member.kind === 'visual-block') {
    const first = Math.min(member.anchor.lineIndex as number, member.head.lineIndex as number);
    const last = Math.max(member.anchor.lineIndex as number, member.head.lineIndex as number);
    const firstSpan = lineSpan(snapshot, first as LineIndex);
    const lastSpan = lineSpan(snapshot, last as LineIndex);
    if (firstSpan === undefined || lastSpan === undefined) return undefined;
    const start = Math.min(member.anchor.at.offset as number, member.head.at.offset as number);
    const end = Math.max(member.anchor.at.offset as number, member.head.at.offset as number);
    return { start: Math.max(firstSpan.contentStart as number, start), end: Math.min(lastSpan.contentEnd as number, end + 1) };
  }
  const start = Math.min(member.anchor.at.offset as number, member.head.at.offset as number);
  const end = Math.max(endpointEnd(member.anchor), endpointEnd(member.head));
  return { start, end };
}

function endpointEnd(endpoint: SelectionEndpoint): number {
  return endpoint.kind === 'character' ? endpoint.after.offset as number : endpoint.at.offset as number;
}

function rangesOverlap(region: SelectionRange | undefined, start: number, end: number): boolean {
  if (region === undefined) return false;
  if (start === end) return start >= region.start && start < region.end;
  return start < region.end && end > region.start;
}

function visualMember(snapshot: DocumentSnapshot, id: SelectionId, start: number, end: number): SelectionMemberInput | undefined {
  const first = endpointAt(snapshot, start as Utf16Offset);
  if (start === end) {
    if (first.kind === 'empty-line' || first.kind === 'eof') {
      return { id, kind: 'visual-character', direction: 'forward', inclusive: true, anchor: first, head: first, desiredColumn: { logicalUtf16: null, displayCell: null }, anchorDesiredColumn: { logicalUtf16: null, displayCell: null } };
    }
    if (first.kind === 'character') {
      return { id, kind: 'visual-character', direction: 'forward', inclusive: true, anchor: first, head: first, desiredColumn: { logicalUtf16: null, displayCell: null }, anchorDesiredColumn: { logicalUtf16: null, displayCell: null } };
    }
    const line = snapshot.lineIndexAt(start as Utf16Offset);
    if (!line.ok) return undefined;
    const span = lineSpan(snapshot, line.value);
    if (span === undefined) return undefined;
    const previous = previousGraphemeStart(snapshot, span.contentStart as number, start);
    if (previous === undefined) return undefined;
    const endpoint = endpointAt(snapshot, previous as Utf16Offset);
    return endpoint.kind === 'character'
      ? { id, kind: 'visual-character', direction: 'forward', inclusive: true, anchor: endpoint, head: endpoint, desiredColumn: { logicalUtf16: null, displayCell: null }, anchorDesiredColumn: { logicalUtf16: null, displayCell: null } }
      : undefined;
  }
  if (first.kind !== 'character') return undefined;
  const lastStart = previousGraphemeStart(snapshot, start, end);
  if (lastStart === undefined) return undefined;
  const last = endpointAt(snapshot, lastStart as Utf16Offset);
  if (last.kind !== 'character') return undefined;
  return { id, kind: 'visual-character', direction: 'forward', inclusive: true, anchor: first, head: last, desiredColumn: { logicalUtf16: null, displayCell: null }, anchorDesiredColumn: { logicalUtf16: null, displayCell: null } };
}

function previousGraphemeStart(snapshot: DocumentSnapshot, start: number, end: number): number | undefined {
  if (end <= start) return undefined;
  const text = snapshot.slice(start as Utf16Offset, end as Utf16Offset);
  if (!text.ok || text.value.length === 0) return undefined;
  if (GRAPHEME_SEGMENTER === undefined) {
    let candidate = end - 1;
    const unit = text.value.charCodeAt(text.value.length - 1);
    if (unit >= 0xdc00 && unit <= 0xdfff) candidate -= 1;
    return candidate;
  }
  let last = 0;
  for (const part of GRAPHEME_SEGMENTER.segment(text.value)) last = part.index;
  return start + last;
}

function wordUnderPrimary(snapshot: DocumentSnapshot, member: SelectionMember): string | undefined {
  const range = selectionRange(snapshot, member);
  if (range === undefined) return undefined;
  const line = snapshot.lineIndexAt(range.start as Utf16Offset);
  if (!line.ok) return undefined;
  const span = lineSpan(snapshot, line.value);
  if (span === undefined) return undefined;
  const text = snapshot.slice(span.contentStart, span.contentEnd);
  if (!text.ok) return undefined;
  const local = Math.max(0, range.start - (span.contentStart as number));
  let cursor = 0;
  let wordStart = -1;
  let wordEnd = -1;
  for (const character of text.value) {
    const next = cursor + character.length;
    if (local >= cursor && local < next) {
      if (!isKeywordCharacter(character)) return character;
      wordStart = cursor;
      wordEnd = next;
      break;
    }
    cursor = next;
  }
  if (wordStart < 0) return undefined;
  while (wordStart > 0) {
    const previous = previousCodePoint(text.value, wordStart);
    if (previous === undefined || !isKeywordCharacter(previous.value)) break;
    wordStart = previous.start;
  }
  while (wordEnd < text.value.length) {
    const next = nextCodePoint(text.value, wordEnd);
    if (next === undefined || !isKeywordCharacter(next.value)) break;
    wordEnd = next.end;
  }
  return text.value.slice(wordStart, wordEnd);
}

function previousCodePoint(text: string, end: number): { readonly start: number; readonly value: string } | undefined {
  if (end <= 0) return undefined;
  let start = end - 1;
  const last = text.charCodeAt(start);
  if (last >= 0xdc00 && last <= 0xdfff && start > 0) {
    const first = text.charCodeAt(start - 1);
    if (first >= 0xd800 && first <= 0xdbff) start -= 1;
  }
  return { start, value: text.slice(start, end) };
}

function nextCodePoint(text: string, start: number): { readonly end: number; readonly value: string } | undefined {
  if (start >= text.length) return undefined;
  const first = text.charCodeAt(start);
  const end = first >= 0xd800 && first <= 0xdbff && start + 1 < text.length && text.charCodeAt(start + 1) >= 0xdc00 && text.charCodeAt(start + 1) <= 0xdfff
    ? start + 2
    : start + 1;
  return { end, value: text.slice(start, end) };
}

function isKeywordCharacter(value: string): boolean {
  return /^[\p{L}\p{N}_]$/u.test(value);
}

function lineSpan(snapshot: DocumentSnapshot, lineIndex: LineIndex): { readonly contentStart: Utf16Offset; readonly contentEnd: Utf16Offset } | undefined {
  const start = snapshot.lineStartOffset(lineIndex);
  if (!start.ok) return undefined;
  const next = snapshot.lineStartOffset((lineIndex as number + 1) as LineIndex);
  const end = next.ok ? (next.value as number) - 1 : snapshot.lengthUtf16;
  return { contentStart: start.value, contentEnd: end as Utf16Offset };
}

function firstGraphemeEnd(snapshot: DocumentSnapshot, start: number, end: number): number | null {
  if (GRAPHEME_SEGMENTER === undefined) return Math.min(end, start + 1);
  const segmenter = GRAPHEME_SEGMENTER;
  let offset = start;
  let windowSize = 8;
  let text = '';
  while (offset < end) {
    const targetEnd = Math.min(end, start + windowSize);
    const parts: string[] = [text];
    while (offset < targetEnd) {
      let chunkEnd = Math.min(targetEnd, offset + 256);
      let chunk = snapshot.slice(offset as Utf16Offset, chunkEnd as Utf16Offset);
      while (!chunk.ok && chunk.error.kind === 'surrogate-split' && chunkEnd > offset + 1) {
        chunkEnd -= 1;
        chunk = snapshot.slice(offset as Utf16Offset, chunkEnd as Utf16Offset);
      }
      if (!chunk.ok) return null;
      parts.push(chunk.value);
      offset = chunkEnd;
    }
    text = parts.join('');
    const iterator = segmenter.segment(text)[Symbol.iterator]();
    const first = iterator.next();
    if (first.done) return null;
    const following = iterator.next();
    if (!following.done) return start + first.value.segment.length;
    if (offset === end) return start + first.value.segment.length;
    windowSize = Math.min(end - start, windowSize * 2);
  }
  return start + text.length;
}

function endpointInput(endpoint: SelectionEndpoint): EndpointInput {
  switch (endpoint.kind) {
    case 'character': return { kind: 'character', offset: endpoint.at.offset, after: endpoint.after.offset };
    case 'empty-line': return { kind: 'empty-line', lineIndex: endpoint.lineIndex };
    case 'eof': return { kind: 'eof' };
    case 'gap': return { kind: 'gap', offset: endpoint.at.offset };
    case 'line': return { kind: 'line', lineIndex: endpoint.lineIndex };
    case 'block-cell': return { kind: 'block-cell', offset: endpoint.at.offset, logicalUtf16Column: endpoint.logicalUtf16Column, displayCellColumn: endpoint.displayCellColumn, virtualCells: endpoint.virtualCells };
  }
}

function memberInput(member: SelectionMember): SelectionMemberInput {
  const base = { id: member.id, direction: member.direction, anchor: endpointInput(member.anchor), head: endpointInput(member.head), desiredColumn: member.desiredColumn, creationOrdinal: member.creationOrdinal as number };
  if (member.kind === 'normal-cursor') return { ...base, kind: member.kind };
  if (member.kind === 'insert-caret') return { ...base, kind: member.kind };
  if (member.kind === 'visual-character') return { ...base, kind: member.kind, inclusive: member.inclusive, anchorDesiredColumn: member.anchorDesiredColumn };
  if (member.kind === 'visual-line') return { ...base, kind: member.kind, anchorDesiredColumn: member.anchorDesiredColumn };
  return { ...base, kind: member.kind, anchorDesiredColumn: member.anchorDesiredColumn };
}

function offsetAtColumn(snapshot: DocumentSnapshot, line: LineIndex, column: number | null): Utf16Offset {
  const start = snapshot.lineStartOffset(line); if (!start.ok) return snapshot.lengthUtf16 as Utf16Offset;
  const lineNumber = line as number;
  const next = lineNumber + 1 < snapshot.lineCount ? snapshot.lineStartOffset((lineNumber + 1) as LineIndex) : null;
  const end = next?.ok === true ? (next.value as number) - 1 : snapshot.lengthUtf16;
  let target = (start.value as number) + Math.max(0, Math.min(column ?? 0, end - (start.value as number)));
  while (target > (start.value as number)) {
    const boundary = snapshot.lineIndexAt(target as Utf16Offset);
    if (boundary.ok) break;
    if (boundary.error.kind !== 'surrogate-split') break;
    target -= 1;
  }
  return target as Utf16Offset;
}

function memberTextStart(member: SelectionMember): number { return Math.min(member.anchor.at.offset as number, member.head.at.offset as number); }
function memberTextEnd(member: SelectionMember): number {
  const endpoint = (member.anchor.at.offset as number) > (member.head.at.offset as number) ? member.anchor : member.head;
  return endpoint.kind === 'character' ? endpoint.after.offset as number : endpoint.at.offset as number;
}
function newId(selections: SelectionSetSnapshot, index: number): SelectionId { return `selection-${selections.selectionGeneration as number}-${index}` as SelectionId; }
function nextId(selections: SelectionSetSnapshot, id: SelectionId, line: number): SelectionId { return `${id}-${line}-${selections.selectionGeneration as number}` as SelectionId; }
function fail(kind: VimSelectionCommandFailure['kind'], limit?: number): { readonly ok: false; readonly error: VimSelectionCommandFailure } {
  return kind === 'selection-limit'
    ? { ok: false, error: { kind, limit: limit ?? DEFAULT_LIMIT } }
    : { ok: false, error: { kind } as VimSelectionCommandFailure };
}
