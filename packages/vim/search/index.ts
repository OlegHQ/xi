import type { Result } from '../../contracts/src/index';
import type { DocumentEdit, DocumentSnapshot, DocumentVersion, LineIndex, Utf16Offset } from '../../document/src/index';
import {
  compilePattern,
  createPatternEvaluation,
  maximumStepBudget,
  patternSnapshotFromDocument,
  PatternEvaluationError,
  type PatternMatch,
  type PatternOptions,
} from '../pattern/index';

/** Direction used by a buffer search. */
export type VimSearchDirection = 'forward' | 'backward';

/** Vim's search-offset families, expressed in UTF-16 document boundaries. */
export type VimSearchOffset =
  | { readonly kind: 'start'; readonly amount?: number }
  | { readonly kind: 'end'; readonly amount?: number }
  | { readonly kind: 'line-start'; readonly amount?: number }
  | { readonly kind: 'line-end'; readonly amount?: number }
  /** nvim's bare-number search-offset (`/pat/`, `/pat/+1`, `/pat/-2`): [num] lines
   * downwards/upwards from the match's line, cursor put in column 1 (`:help
   * search-offset`). An operator target using this offset becomes linewise. */
  | { readonly kind: 'line'; readonly amount: number };

export type VimSearchCommand = 'search' | 'next' | 'previous' | 'star' | 'hash' | 'gstar' | 'ghash';

export interface VimSearchView {
  /** Cursor boundary in the immutable snapshot's UTF-16 coordinate space. */
  readonly cursor: Utf16Offset;
  readonly desiredDisplayColumn: number;
  readonly scrollTop: number;
  readonly scrollLeft: number;
}

export interface VimSearchState {
  /** The committed Vim `/` pattern, or null before the first search. */
  readonly pattern: string | null;
  readonly direction: VimSearchDirection | null;
  readonly lastMatch: VimSearchMatch | null;
  /** Raw replacement used by `~`; this is separate from the search pattern. */
  readonly previousReplacement: string | null;
  /** Set by `*`/`#`/`g*`/`g#` (true only for `*`/`#`) so `n`/`N` keep matching whole
   * words; nvim achieves this by embedding `\<...\>` in the stored pattern, but this
   * engine has no word-boundary atom, so the constraint travels alongside the pattern. */
  readonly fullWord: boolean;
  /** The offset from the last `/`/`?` search, reused by a following `n`/`N` and cleared
   * by any command that redefines the search (a plain `/pat<CR>`, or `*`/`#`/`g*`/`g#`,
   * none of which nvim carries an offset through). */
  readonly offset?: VimSearchOffset;
}

export const EMPTY_VIM_SEARCH_STATE: VimSearchState = Object.freeze({
  pattern: null,
  direction: null,
  lastMatch: null,
  fullWord: false,
  previousReplacement: null,
});

export interface VimSearchRequest {
  readonly command: VimSearchCommand;
  /** Empty pattern means reuse the committed pattern. */
  readonly pattern?: string;
  readonly direction?: VimSearchDirection;
  readonly count?: number;
  readonly wrapscan?: boolean;
  readonly offset?: VimSearchOffset;
  readonly patternOptions?: PatternOptions;
}

export interface VimSearchMatch {
  readonly start: Utf16Offset;
  readonly end: Utf16Offset;
  readonly consumedStart: Utf16Offset;
  readonly consumedEnd: Utf16Offset;
  readonly cursor: Utf16Offset;
  readonly pattern: string;
  readonly direction: VimSearchDirection;
  readonly wrapped: boolean;
  readonly captures: ReadonlyMap<number, { readonly start: Utf16Offset; readonly end: Utf16Offset }>;
}

export type VimSearchFailure =
  | { readonly kind: 'invalid-cursor' }
  | { readonly kind: 'invalid-view' }
  | { readonly kind: 'invalid-count' }
  | { readonly kind: 'empty-pattern' }
  | { readonly kind: 'word-not-found' }
  | { readonly kind: 'stale-snapshot'; readonly expected: DocumentVersion; readonly actual: DocumentVersion }
  | { readonly kind: 'search-not-complete' }
  | { readonly kind: 'invalid-offset' }
  | { readonly kind: 'no-match'; readonly pattern: string }
  | { readonly kind: 'pattern-error'; readonly error: PatternEvaluationError }
  | { readonly kind: 'invalid-substitute-command'; readonly reason: string; readonly sourceOffset: number }
  | { readonly kind: 'unsupported-replacement'; readonly sourceOffset: number; readonly escape: string }
  | { readonly kind: 'trailing-replacement-backslash'; readonly sourceOffset: number }
  | { readonly kind: 'confirmation-required' };

export type VimSearchOutcome =
  | { readonly kind: 'found'; readonly match: VimSearchMatch; readonly view: VimSearchView; readonly state: VimSearchState }
  | { readonly kind: 'no-match'; readonly reason: 'target-not-found' | 'no-wrap'; readonly view: VimSearchView; readonly state: VimSearchState };

export type VimSearchProgress =
  | { readonly kind: 'pending'; readonly steps: number }
  | { readonly kind: 'complete'; readonly outcome: VimSearchOutcome };

export interface VimSearchCommit {
  readonly outcome: VimSearchOutcome;
  readonly view: VimSearchView;
  readonly state: VimSearchState;
}

export interface VimSearchCancellation {
  readonly kind: 'cancelled';
  readonly view: VimSearchView;
  readonly state: VimSearchState;
}

export interface VimOperatorSearchRange {
  readonly start: Utf16Offset;
  readonly end: Utf16Offset;
  readonly target: Utf16Offset;
  readonly direction: VimSearchDirection;
  readonly inclusive: true;
}

export interface VimOperatorSearchCommit {
  readonly search: VimSearchCommit;
  readonly range: VimOperatorSearchRange;
}

/**
 * A resumable preview over one immutable document snapshot. Previewing only
 * computes a candidate view; commit is the caller's explicit state transition.
 */
export class VimSearchPreview {
  readonly snapshotVersion: DocumentVersion;
  readonly initialView: VimSearchView;
  readonly initialState: VimSearchState;
  readonly pattern: string;
  readonly request: VimSearchRequest;
  readonly #evaluation: ReturnType<typeof createPatternEvaluation>;
  readonly #snapshot: DocumentSnapshot;
  readonly #fullWord: boolean;
  readonly #direction: VimSearchDirection;
  readonly #persistDirection: VimSearchDirection;
  readonly #offset: VimSearchOffset | undefined;
  private complete: VimSearchOutcome | undefined;
  private failure: VimSearchFailure | undefined;

  constructor(
    snapshot: DocumentSnapshot,
    initialView: VimSearchView,
    initialState: VimSearchState,
    request: VimSearchRequest,
    pattern: string,
    evaluation: ReturnType<typeof createPatternEvaluation>,
    fullWord: boolean,
    direction: VimSearchDirection,
    persistDirection: VimSearchDirection,
    offset: VimSearchOffset | undefined,
  ) {
    this.#snapshot = snapshot;
    this.snapshotVersion = snapshot.version;
    this.initialView = initialView;
    this.initialState = initialState;
    this.request = request;
    this.pattern = pattern;
    this.#evaluation = evaluation;
    this.#fullWord = fullWord;
    this.#direction = direction;
    this.#persistDirection = persistDirection;
    this.#offset = offset;
  }

  get steps(): number { return this.#evaluation.steps; }

  cancel(): VimSearchCancellation {
    this.#evaluation.cancel();
    return Object.freeze({ kind: 'cancelled', view: this.initialView, state: this.initialState });
  }

  resume(maxWorkUnits: number): Result<VimSearchProgress, VimSearchFailure> {
    if (this.failure !== undefined) return { ok: false, error: this.failure };
    if (this.complete !== undefined) return { ok: true, value: { kind: 'complete', outcome: this.complete } };
    if (!Number.isSafeInteger(maxWorkUnits) || maxWorkUnits <= 0) return { ok: false, error: { kind: 'invalid-count' } };
    try {
      const progress = this.#evaluation.resume(maxWorkUnits);
      if (progress.kind === 'pending') return { ok: true, value: progress };
      const outcome = selectOutcome(this.#snapshot, this.initialView, this.initialState, this.request, this.pattern, progress.result.matches, this.#fullWord, this.#direction, this.#persistDirection, this.#offset);
      if (!outcome.ok) {
        this.failure = outcome.error;
        return outcome;
      }
      this.complete = outcome.value;
      return { ok: true, value: { kind: 'complete', outcome: this.complete } };
    } catch (error: unknown) {
      const failure = patternFailure(error);
      this.failure = failure;
      return { ok: false, error: failure };
    }
  }

  commit(currentSnapshot: DocumentSnapshot): Result<VimSearchCommit, VimSearchFailure> {
    if (currentSnapshot.id !== this.#snapshot.id || currentSnapshot.version !== this.snapshotVersion) {
      return { ok: false, error: { kind: 'stale-snapshot', expected: this.snapshotVersion, actual: currentSnapshot.version } };
    }
    if (this.failure !== undefined) return { ok: false, error: this.failure };
    if (this.complete === undefined) return { ok: false, error: { kind: 'search-not-complete' } };
    return { ok: true, value: Object.freeze({ outcome: this.complete, view: this.complete.view, state: this.complete.state }) };
  }
}

/** Begin a version-bound search preview without changing cursor or repeat state. */
export function beginVimSearch(
  snapshot: DocumentSnapshot,
  view: VimSearchView,
  state: VimSearchState,
  request: VimSearchRequest,
): Result<VimSearchPreview, VimSearchFailure> {
  const validView = validateView(snapshot, view);
  if (!validView.ok) return validView;
  const validState = validateState(state);
  if (!validState.ok) return validState;
  const count = request.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1) return { ok: false, error: { kind: 'invalid-count' } };

  let resolved: ResolvedSearch;
  try {
    const result = resolveRequest(snapshot, view, state, request);
    if (!result.ok) return result;
    resolved = result.value;
    const baseOptions = request.patternOptions ?? {};
    const patternOptions = withScaledStepBudget(
      baseOptions.previousSubstituteText === undefined && state.previousReplacement !== null
        ? { ...baseOptions, previousSubstituteText: state.previousReplacement }
        : baseOptions,
      snapshot.lengthUtf16,
    );
    const program = compilePattern(resolved.pattern, patternOptions);
    const patternSnapshot = patternSnapshotFromDocument(snapshot);
    const evaluation = createPatternEvaluation(program, patternSnapshot);
    return {
      ok: true,
      value: new VimSearchPreview(snapshot, view, state, request, resolved.pattern, evaluation, resolved.fullWord, resolved.direction, resolved.persistDirection, resolved.offset),
    };
  } catch (error: unknown) {
    return { ok: false, error: patternFailure(error) };
  }
}

/** Synchronous convenience for short searches. */
export function searchVimBuffer(
  snapshot: DocumentSnapshot,
  view: VimSearchView,
  state: VimSearchState,
  request: VimSearchRequest,
): Result<VimSearchCommit, VimSearchFailure> {
  const preview = beginVimSearch(snapshot, view, state, request);
  if (!preview.ok) return preview;
  const progress = preview.value.resume(Number.MAX_SAFE_INTEGER);
  if (!progress.ok) return progress;
  return preview.value.commit(snapshot);
}

/**
 * Resolve `/` or `?` as the target of a pending delete/change/yank. The
 * operator layer can feed the returned range to its central normalizer; this
 * function performs no edit and does not duplicate operator semantics.
 */
export function searchVimOperator(
  snapshot: DocumentSnapshot,
  view: VimSearchView,
  state: VimSearchState,
  request: VimSearchRequest,
): Result<VimOperatorSearchCommit, VimSearchFailure> {
  if (request.command !== 'search' && request.command !== 'next' && request.command !== 'previous') {
    return { ok: false, error: { kind: 'invalid-offset' } };
  }
  const resolved = searchVimBuffer(snapshot, view, state, request);
  if (!resolved.ok) return resolved;
  if (resolved.value.outcome.kind !== 'found') return { ok: true, value: { search: resolved.value, range: { start: view.cursor, end: view.cursor, target: view.cursor, direction: request.direction ?? 'forward', inclusive: true } } };
  const target = resolved.value.outcome.match.cursor as number;
  const origin = view.cursor as number;
  const start = Math.min(origin, target);
  const end = Math.min(snapshot.lengthUtf16, nextBoundary(snapshot, Math.max(origin, target)));
  return {
    ok: true,
    value: Object.freeze({
      search: resolved.value,
      range: Object.freeze({ start: start as Utf16Offset, end: Math.max(start, end) as Utf16Offset, target: target as Utf16Offset, direction: resolved.value.outcome.match.direction, inclusive: true }),
    }),
  };
}

export interface VimSubstituteRange {
  readonly firstLine: LineIndex;
  readonly lastLine: LineIndex;
}

export interface VimSubstituteRequest {
  readonly pattern: string;
  readonly replacement: string;
  /** Current cursor used for the default single-line `:s` range. */
  readonly cursor?: Utf16Offset;
  readonly range?: VimSubstituteRange;
  /** Vim flags: g,c,e,n,p,#,l,i,I. */
  readonly flags?: string;
  readonly patternOptions?: PatternOptions;
  readonly confirm?: (match: VimSearchMatch, replacement: string) => 'yes' | 'no' | 'all' | 'quit';
}

export interface VimSubstitutePlan {
  readonly pattern: string;
  readonly replacement: string;
  readonly flags: string;
  readonly edits: readonly DocumentEdit[];
  readonly matches: readonly VimSearchMatch[];
  readonly replacedCount: number;
  readonly matchedCount: number;
  readonly skippedCount: number;
  readonly printedLines: readonly LineIndex[];
  readonly undoGroup: string;
  readonly state: VimSearchState;
}

/** Parse `:s{delimiter}{pattern}{delimiter}{replacement}{delimiter}{flags}`. */
export function parseVimSubstituteCommand(
  command: string,
  previousPattern: string | null = null,
): Result<Omit<VimSubstituteRequest, 'patternOptions' | 'confirm'> & { readonly flags: string }, VimSearchFailure> {
  if (!command.startsWith(':s') && !command.startsWith(':substitute')) {
    return { ok: false, error: { kind: 'invalid-substitute-command', reason: 'command-must-start-with-s-or-substitute', sourceOffset: 0 } };
  }
  const prefixLength = command.startsWith(':substitute') ? ':substitute'.length : 2;
  let index = prefixLength;
  if (command[index] === ' ') index += 1;
  const delimiter = command[index];
  if (delimiter === undefined || /[A-Za-z0-9\\s]/u.test(delimiter)) {
    return { ok: false, error: { kind: 'invalid-substitute-command', reason: 'missing-delimiter', sourceOffset: index } };
  }
  index += 1;
  const patternPart = readDelimited(command, index, delimiter);
  if (!patternPart.ok) return patternPart;
  index = patternPart.value.next;
  const replacementPart = readDelimited(command, index, delimiter);
  if (!replacementPart.ok) return replacementPart;
  index = replacementPart.value.next;
  const flags = command.slice(index);
  const allowed = new Set(['g', 'c', 'e', 'n', 'p', '#', 'l', 'i', 'I']);
  const seen = new Set<string>();
  for (let flagIndex = 0; flagIndex < flags.length; flagIndex += 1) {
    const flag = flags[flagIndex];
    if (flag === undefined || !allowed.has(flag) || seen.has(flag)) {
      return { ok: false, error: { kind: 'invalid-substitute-command', reason: `invalid-flag:${flag ?? ''}`, sourceOffset: index + flagIndex } };
    }
    seen.add(flag);
  }
  const pattern = patternPart.value.value.length === 0 ? previousPattern : patternPart.value.value;
  if (pattern === null || pattern === undefined || pattern.length === 0) return { ok: false, error: { kind: 'empty-pattern' } };
  return { ok: true, value: { pattern, replacement: replacementPart.value.value, flags } };
}

/** Prepare a bounded, atomic substitute edit plan against one document version. */
export function prepareVimSubstitute(
  snapshot: DocumentSnapshot,
  state: VimSearchState,
  request: VimSubstituteRequest,
): Result<VimSubstitutePlan, VimSearchFailure> {
  if (request.pattern.length === 0) {
    if (state.pattern === null || state.pattern.length === 0) return { ok: false, error: { kind: 'empty-pattern' } };
  }
  const flags = request.flags ?? '';
  const flagSet = new Set(flags);
  for (const flag of flagSet) {
    if (!'gce n p#liI'.replace(' ', '').includes(flag)) return { ok: false, error: { kind: 'invalid-substitute-command', reason: `invalid-flag:${flag}`, sourceOffset: 0 } };
  }
  if (flagSet.has('c') && request.confirm === undefined) return { ok: false, error: { kind: 'confirmation-required' } };
  const pattern = request.pattern.length === 0 ? state.pattern : request.pattern;
  if (pattern === null || pattern.length === 0) return { ok: false, error: { kind: 'empty-pattern' } };
  let evaluation: ReturnType<typeof createPatternEvaluation>;
  try {
    const baseOptions = substitutePatternOptions(request.patternOptions, flagSet);
    const patternOptions = withScaledStepBudget(
      baseOptions.previousSubstituteText === undefined && state.previousReplacement !== null
        ? { ...baseOptions, previousSubstituteText: state.previousReplacement }
        : baseOptions,
      snapshot.lengthUtf16,
    );
    const program = compilePattern(pattern, patternOptions);
    evaluation = createPatternEvaluation(program, patternSnapshotFromDocument(snapshot));
  } catch (error: unknown) {
    return { ok: false, error: patternFailure(error) };
  }
  let evaluated: ReturnType<typeof evaluation.resume>;
  try {
    evaluated = evaluation.resume(Number.MAX_SAFE_INTEGER);
  } catch (error: unknown) {
    return { ok: false, error: patternFailure(error) };
  }
  if (evaluated.kind !== 'complete') return { ok: false, error: { kind: 'search-not-complete' } };
  let range = request.range;
  if (range === undefined) {
    const cursor = request.cursor ?? (0 as Utf16Offset);
    const line = snapshot.lineIndexAt(cursor);
    if (!line.ok) return { ok: false, error: { kind: 'invalid-cursor' } };
    range = { firstLine: line.value, lastLine: line.value };
  }
  if (!validLineRange(snapshot, range)) return { ok: false, error: { kind: 'invalid-offset' } };

  const allMatches = evaluated.result.matches;
  const selected: VimSearchMatch[] = [];
  const edits: DocumentEdit[] = [];
  const printedLines = new Set<number>();
  const seenLines = new Set<number>();
  let skippedCount = 0;
  let confirmAll = false;
  for (const rawMatch of allMatches) {
    const line = snapshot.lineIndexAt(rawMatch.start);
    if (!line.ok || (line.value as number) < (range.firstLine as number) || (line.value as number) > (range.lastLine as number)) continue;
    if (!flagSet.has('g') && seenLines.has(line.value as number)) continue;
    seenLines.add(line.value as number);
    const match = toSearchMatch(rawMatch, pattern, 'forward', false, offsetForMatch(snapshot, rawMatch, undefined));
    const replacement = expandVimReplacement(request.replacement, snapshot, rawMatch, state.previousReplacement);
    if (!replacement.ok) return replacement;
    let decision: 'yes' | 'no' | 'all' = 'yes';
    if (flagSet.has('c') && !confirmAll) {
      const answer = request.confirm?.(match, replacement.value);
      if (answer === 'quit') break;
      if (answer === 'all') confirmAll = true;
      else if (answer === 'no') decision = 'no';
    }
    if (decision === 'no') {
      skippedCount += 1;
      continue;
    }
    selected.push(match);
    printedLines.add(line.value as number);
    if (!flagSet.has('n')) edits.push({ start: rawMatch.start, end: rawMatch.end, text: replacement.value });
  }
  const nextState: VimSearchState = Object.freeze({
    pattern,
    direction: 'forward',
    lastMatch: selected.at(-1) ?? state.lastMatch,
    previousReplacement: request.replacement,
    fullWord: state.fullWord,
  });
  return {
    ok: true,
    value: Object.freeze({
      pattern,
      replacement: request.replacement,
      flags,
      edits: Object.freeze(edits),
      matches: Object.freeze(selected),
      replacedCount: edits.length,
      matchedCount: selected.length + skippedCount,
      skippedCount,
      printedLines: Object.freeze([...printedLines].sort((left, right) => left - right).map((line) => line as LineIndex)),
      undoGroup: `vim-substitute-${snapshot.version as number}`,
      state: nextState,
    }),
  };
}

function resolveRequest(
  snapshot: DocumentSnapshot,
  view: VimSearchView,
  state: VimSearchState,
  request: VimSearchRequest,
): Result<ResolvedSearch, VimSearchFailure> {
  let pattern = request.pattern ?? '';
  let direction = request.direction ?? 'forward';
  let persistDirection: VimSearchDirection | undefined;
  let fullWord = false;
  // nvim only carries a typed search-offset (`/pat/+1`) forward through a following
  // `n`/`N`; a plain `/pat<CR>`/`?pat<CR>` (no offset text) and `*`/`#`/`g*`/`g#` (which
  // have no offset syntax at all) both reset it to none.
  let resolvedOffset: VimSearchOffset | undefined = request.offset;
  switch (request.command) {
    case 'search':
      if (pattern.length === 0) { pattern = state.pattern ?? ''; fullWord = state.fullWord; }
      break;
    case 'next':
      pattern = state.pattern ?? '';
      direction = state.direction ?? 'forward';
      fullWord = state.fullWord;
      resolvedOffset = request.offset ?? state.offset;
      break;
    case 'previous':
      pattern = state.pattern ?? '';
      // N flips direction for this one query only; the persisted "last search
      // direction" that a later plain `n` repeats stays whatever `*`/`/`/`?` set
      // (nvim: `n`/`N` never redefine each other's sense of "forward").
      direction = opposite(state.direction ?? 'forward');
      fullWord = state.fullWord;
      persistDirection = state.direction ?? 'forward';
      resolvedOffset = request.offset ?? state.offset;
      break;
    case 'star':
    case 'hash':
    case 'gstar':
    case 'ghash': {
      const word = wordAtCursor(snapshot, view.cursor);
      if (word === undefined) return { ok: false, error: { kind: 'word-not-found' } };
      pattern = literalPattern(word.value);
      direction = request.command === 'star' || request.command === 'gstar' ? 'forward' : 'backward';
      fullWord = request.command === 'star' || request.command === 'hash';
      resolvedOffset = undefined;
      break;
    }
  }
  if (pattern.length === 0) return { ok: false, error: { kind: 'empty-pattern' } };
  if (direction !== 'forward' && direction !== 'backward') return { ok: false, error: { kind: 'invalid-offset' } };
  return { ok: true, value: { pattern, direction, fullWord, persistDirection: persistDirection ?? direction, offset: resolvedOffset } };
}

interface ResolvedSearch {
  readonly pattern: string;
  readonly direction: VimSearchDirection;
  readonly fullWord: boolean;
  readonly persistDirection: VimSearchDirection;
  readonly offset: VimSearchOffset | undefined;
}

function selectOutcome(
  snapshot: DocumentSnapshot,
  initialView: VimSearchView,
  initialState: VimSearchState,
  request: VimSearchRequest,
  pattern: string,
  matches: readonly PatternMatch[],
  fullWord: boolean,
  direction: VimSearchDirection,
  persistDirection: VimSearchDirection,
  offset: VimSearchOffset | undefined,
): Result<VimSearchOutcome, VimSearchFailure> {
  const count = request.count ?? 1;
  const candidates = matches.filter((match) => !fullWord || isWholeWordMatch(snapshot, match));
  let position = initialView.cursor as number;
  let wrapped = false;
  let chosen: PatternMatch | undefined;
  // Rebuilt from scratch (not `{ ...initialState }`) so a resolved `offset` of
  // `undefined` actually clears any offset the prior state carried, rather than an
  // explicit-undefined assignment tripping exactOptionalPropertyTypes.
  const noMatchState = (): VimSearchState => Object.freeze({
    pattern,
    direction: persistDirection,
    lastMatch: initialState.lastMatch,
    previousReplacement: initialState.previousReplacement,
    fullWord,
    ...(offset === undefined ? {} : { offset }),
  });
  for (let iteration = 0; iteration < count; iteration += 1) {
    const found = nextCandidate(candidates, position, direction);
    if (found === undefined) {
      if (request.wrapscan === false || wrapped) {
        return { ok: true, value: { kind: 'no-match', reason: request.wrapscan === false ? 'no-wrap' : 'target-not-found', view: initialView, state: noMatchState() } };
      }
      wrapped = true;
      position = direction === 'forward' ? -1 : snapshot.lengthUtf16 + 1;
      const wrappedFound = nextCandidate(candidates, position, direction);
      if (wrappedFound === undefined) {
        return { ok: true, value: { kind: 'no-match', reason: 'target-not-found', view: initialView, state: noMatchState() } };
      }
      chosen = wrappedFound;
    } else chosen = found;
    position = direction === 'forward'
      ? advanceAfterMatch(snapshot, chosen, direction)
      : (chosen.start as number);
  }
  if (chosen === undefined) return { ok: false, error: { kind: 'no-match', pattern } };
  const searchMatch = toSearchMatch(snapshotMatch(chosen), pattern, direction, wrapped, offsetForMatch(snapshot, chosen, offset));
  const nextState: VimSearchState = Object.freeze({
    pattern,
    direction: persistDirection,
    lastMatch: searchMatch,
    previousReplacement: initialState.previousReplacement,
    fullWord,
    ...(offset === undefined ? {} : { offset }),
  });
  const nextView = Object.freeze({ ...initialView, cursor: searchMatch.cursor });
  return { ok: true, value: { kind: 'found', match: searchMatch, view: nextView, state: nextState } };
}

function nextCandidate(matches: readonly PatternMatch[], position: number, direction: VimSearchDirection): PatternMatch | undefined {
  if (direction === 'forward') return matches.find((match) => (match.start as number) > position);
  let found: PatternMatch | undefined;
  for (const match of matches) {
    if ((match.start as number) < position) found = match;
    else break;
  }
  return found;
}

function advanceAfterMatch(snapshot: DocumentSnapshot, match: PatternMatch, direction: VimSearchDirection): number {
  const consumedEnd = match.consumedEnd as number;
  if (direction === 'backward') return match.start as number;
  if (consumedEnd > (match.consumedStart as number)) return consumedEnd;
  return nextBoundary(snapshot, match.start as number);
}

function nextBoundary(snapshot: DocumentSnapshot, offset: number): number {
  if (offset >= snapshot.lengthUtf16) return offset + 1;
  const end = Math.min(offset + 2, snapshot.lengthUtf16);
  const textResult = snapshot.slice(offset as Utf16Offset, end as Utf16Offset);
  if (!textResult.ok || textResult.value.length === 0) return offset + 1;
  const codePoint = textResult.value.codePointAt(0);
  return offset + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
}

/** Zero-based UTF-16 offset just past the line's content, excluding its terminating newline. */
function lineEndOffset(snapshot: DocumentSnapshot, line: number): number {
  if (line + 1 < snapshot.lineCount) {
    const next = snapshot.lineStartOffset((line + 1) as LineIndex);
    if (next.ok) return (next.value as number) - 1;
  }
  return snapshot.lengthUtf16;
}

function wordAtCursor(snapshot: DocumentSnapshot, cursor: Utf16Offset): { readonly value: string; readonly start: number; readonly end: number } | undefined {
  const at = cursor as number;
  const lineResult = snapshot.lineIndexAt(cursor);
  if (!lineResult.ok) return undefined;
  const lineStartResult = snapshot.lineStartOffset(lineResult.value);
  if (!lineStartResult.ok) return undefined;
  const lineStart = lineStartResult.value as number;
  const lineEnd = lineEndOffset(snapshot, lineResult.value as number);
  if (at >= lineEnd) return undefined;
  const lineSlice = snapshot.slice(lineStart as Utf16Offset, lineEnd as Utf16Offset);
  if (!lineSlice.ok) return undefined;
  const text = lineSlice.value;
  const localAt = at - lineStart;
  const codePoint = text.codePointAt(localAt);
  if (codePoint === undefined || !isWordCodePoint(codePoint)) return undefined;
  let start = localAt;
  while (start > 0) {
    const previous = previousCodePoint(text, start);
    if (previous === undefined || !isWordCodePoint(previous.codePoint)) break;
    start = previous.start;
  }
  let end = localAt + (codePoint > 0xffff ? 2 : 1);
  while (end < text.length) {
    const next = text.codePointAt(end);
    if (next === undefined || !isWordCodePoint(next)) break;
    end += next > 0xffff ? 2 : 1;
  }
  return { value: text.slice(start, end), start: start + lineStart, end: end + lineStart };
}

const unicodeLetter = /^\p{L}$/u;
const unicodeNumber = /^\p{N}$/u;

function isWordCodePoint(codePoint: number): boolean {
  const value = String.fromCodePoint(codePoint);
  return value === '_' || unicodeLetter.test(value) || unicodeNumber.test(value);
}

function isWholeWordMatch(snapshot: DocumentSnapshot, match: PatternMatch): boolean {
  const start = match.start as number;
  const end = match.end as number;
  const beforeStart = Math.max(0, start - 2);
  const afterEnd = Math.min(snapshot.lengthUtf16, end + 2);
  const beforeSlice = start > beforeStart ? snapshot.slice(beforeStart as Utf16Offset, start as Utf16Offset) : undefined;
  const afterSlice = end < afterEnd ? snapshot.slice(end as Utf16Offset, afterEnd as Utf16Offset) : undefined;
  const beforeText = beforeSlice?.ok ? beforeSlice.value : '';
  const afterText = afterSlice?.ok ? afterSlice.value : '';
  const before = beforeText.length > 0 ? previousCodePoint(beforeText, beforeText.length)?.codePoint : undefined;
  const after = afterText.length > 0 ? afterText.codePointAt(0) : undefined;
  return (before === undefined || !isWordCodePoint(before)) && (after === undefined || !isWordCodePoint(after));
}

/** Build a `\V` (very-nomagic) literal pattern matching `value` verbatim, for `*`/`#`
 * (whole-word, filtered separately) and Visual-mode `*`/`#` (substring, no filtering). */
export function literalPattern(value: string): string {
  return `\\V${value.replaceAll('\\', '\\\\')}`;
}

function offsetForMatch(snapshot: DocumentSnapshot, match: PatternMatch, offset: VimSearchOffset | undefined): number {
  if (offset === undefined) return match.start as number;
  const amount = offset.amount ?? 0;
  if (!Number.isSafeInteger(amount)) return match.start as number;
  switch (offset.kind) {
    case 'start': return clampOffset((match.start as number) + amount, snapshot.lengthUtf16);
    case 'end': {
      const base = match.end > match.start
        ? lastCodePointStart(snapshot, match.start as number, match.end as number)
        : match.start as number;
      return clampOffset(stepCodePoints(snapshot, base, amount), snapshot.lengthUtf16);
    }
    case 'line-start': {
      const line = snapshot.lineIndexAt(match.start);
      if (!line.ok) return match.start as number;
      const lineStart = snapshot.lineStartOffset(line.value);
      return lineStart.ok ? clampOffset((lineStart.value as number) + amount, snapshot.lengthUtf16) : match.start as number;
    }
    case 'line-end': {
      const line = snapshot.lineIndexAt(match.start);
      if (!line.ok) return match.start as number;
      const next = snapshot.lineStartOffset(((line.value as number) + 1) as LineIndex);
      const end = next.ok ? (next.value as number) - 1 : snapshot.lengthUtf16;
      return clampOffset(end + amount, snapshot.lengthUtf16);
    }
    case 'line': {
      const line = snapshot.lineIndexAt(match.start);
      if (!line.ok) return match.start as number;
      const targetLine = Math.max(0, Math.min(snapshot.lineCount - 1, (line.value as number) + amount));
      const start = snapshot.lineStartOffset(targetLine as LineIndex);
      return start.ok ? clampOffset(start.value as number, snapshot.lengthUtf16) : match.start as number;
    }
  }
}

function clampOffset(offset: number, length: number): number { return Math.max(0, Math.min(length, offset)); }

/** Start offset of the last Unicode code point in `[start, end)`, or `start` if the range is empty. */
function lastCodePointStart(snapshot: DocumentSnapshot, start: number, end: number): number {
  if (end <= start) return start;
  const window = snapshot.slice(Math.max(start, end - 2) as Utf16Offset, end as Utf16Offset);
  if (!window.ok || window.value.length === 0) return Math.max(start, end - 1);
  const previous = previousCodePoint(window.value, window.value.length);
  return previous === undefined ? Math.max(start, end - 1) : end - (window.value.length - previous.start);
}

/** `/e` (and similar) search offsets count in characters, not UTF-16 code units; step by whole code points. */
function stepCodePoints(snapshot: DocumentSnapshot, start: number, count: number): number {
  let position = start;
  if (count > 0) {
    for (let index = 0; index < count && position < snapshot.lengthUtf16; index += 1) {
      const window = snapshot.slice(position as Utf16Offset, Math.min(position + 2, snapshot.lengthUtf16) as Utf16Offset);
      if (!window.ok || window.value.length === 0) break;
      const codePoint = window.value.codePointAt(0);
      position += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    }
  } else {
    for (let index = 0; index < -count && position > 0; index += 1) {
      const window = snapshot.slice(Math.max(0, position - 2) as Utf16Offset, position as Utf16Offset);
      if (!window.ok || window.value.length === 0) break;
      const previous = previousCodePoint(window.value, window.value.length);
      if (previous === undefined) break;
      position -= window.value.length - previous.start;
    }
  }
  return position;
}

function toSearchMatch(
  match: PatternMatch,
  pattern: string,
  direction: VimSearchDirection,
  wrapped: boolean,
  cursor: number,
): VimSearchMatch {
  const captures = new Map<number, { readonly start: Utf16Offset; readonly end: Utf16Offset }>();
  for (const [group, capture] of match.captures) captures.set(group, Object.freeze({ start: capture.start, end: capture.end }));
  return Object.freeze({ start: match.start, end: match.end, consumedStart: match.consumedStart, consumedEnd: match.consumedEnd, cursor: cursor as Utf16Offset, pattern, direction, wrapped, captures });
}

function snapshotMatch(match: PatternMatch): PatternMatch { return match; }

function expandVimReplacement(
  replacement: string,
  snapshot: DocumentSnapshot,
  match: PatternMatch,
  previousReplacement: string | null,
): Result<string, VimSearchFailure> {
  const output: string[] = [];
  let upperNext = false;
  let lowerNext = false;
  let upperMode = false;
  let lowerMode = false;
  const push = (value: string): void => {
    let converted = value;
    if (upperMode) converted = converted.toUpperCase();
    if (lowerMode) converted = converted.toLowerCase();
    if (upperNext) { converted = converted.slice(0, 1).toUpperCase() + converted.slice(1); upperNext = false; }
    if (lowerNext) { converted = converted.slice(0, 1).toLowerCase() + converted.slice(1); lowerNext = false; }
    output.push(converted);
  };
  const fullMatchResult = snapshot.slice(match.start, match.end);
  const fullMatch = fullMatchResult.ok ? fullMatchResult.value : '';
  for (let index = 0; index < replacement.length; index += 1) {
    const character = replacement[index];
    if (character === '&' || character === '~') { push(character === '&' ? fullMatch : previousReplacement ?? ''); continue; }
    if (character !== '\\') { if (character !== undefined) push(character); continue; }
    const escaped = replacement[index + 1];
    if (escaped === undefined) return { ok: false, error: { kind: 'trailing-replacement-backslash', sourceOffset: index } };
    index += 1;
    if (escaped === '&') push('&');
    else if (escaped === '~') push(previousReplacement ?? '');
    else if (escaped === '\\') push('\\');
    else if (escaped === 'r') push('\n');
    else if (escaped === 'n') push('\0');
    else if (escaped === 't') push('\t');
    else if (escaped === '0') push(fullMatch);
    else if (escaped >= '1' && escaped <= '9') {
      const capture = match.captures.get(Number(escaped));
      if (capture !== undefined) {
        const captureResult = snapshot.slice(capture.start, capture.end);
        if (captureResult.ok) push(captureResult.value);
      }
    } else if (escaped === 'u') upperNext = true;
    else if (escaped === 'l') lowerNext = true;
    else if (escaped === 'U') { upperMode = true; lowerMode = false; }
    else if (escaped === 'L') { lowerMode = true; upperMode = false; }
    else if (escaped === 'E') { upperMode = false; lowerMode = false; }
    else if (escaped === '=') return { ok: false, error: { kind: 'unsupported-replacement', sourceOffset: index - 1, escape: '=' } };
    else return { ok: false, error: { kind: 'unsupported-replacement', sourceOffset: index - 1, escape: escaped } };
  }
  return { ok: true, value: output.join('') };
}

const minimumStepBudget = 250_000;
/** Steps budgeted per UTF-16 code unit of document text, above the floor, so long lines don't starve a plain scan. */
const stepBudgetPerCodeUnit = 32;

/**
 * A fixed step budget fails ordinary searches on long lines (e.g. a 200 KB
 * single-line file) purely because there is more text to scan, not because
 * the pattern is pathological. Scale the default with document length while
 * leaving an explicit caller-supplied budget, and the cooperative
 * cancellation/slicing behavior it gates, untouched.
 */
function withScaledStepBudget(options: PatternOptions, lengthUtf16: number): PatternOptions {
  if (options.stepBudget !== undefined) return options;
  const scaled = Math.min(maximumStepBudget, Math.max(minimumStepBudget, Math.ceil(lengthUtf16 * stepBudgetPerCodeUnit)));
  return { ...options, stepBudget: scaled };
}

function substitutePatternOptions(options: PatternOptions | undefined, flags: ReadonlySet<string>): PatternOptions {
  const base = options ?? {};
  if (flags.has('i')) return { ...base, ignoreCase: true, smartCase: false };
  if (flags.has('I')) return { ...base, ignoreCase: false, smartCase: false };
  return base;
}

function readDelimited(command: string, start: number, delimiter: string): Result<{ readonly value: string; readonly next: number }, VimSearchFailure> {
  const output: string[] = [];
  for (let index = start; index < command.length; index += 1) {
    const character = command[index];
    if (character === '\\') {
      const next = command[index + 1];
      if (next === undefined) return { ok: false, error: { kind: 'invalid-substitute-command', reason: 'trailing-escape', sourceOffset: index } };
      output.push(character, next);
      index += 1;
      continue;
    }
    if (character === delimiter) return { ok: true, value: { value: output.join(''), next: index + 1 } };
    if (character !== undefined) output.push(character);
  }
  return { ok: false, error: { kind: 'invalid-substitute-command', reason: 'unterminated-part', sourceOffset: start } };
}

function validateView(snapshot: DocumentSnapshot, view: VimSearchView): Result<void, VimSearchFailure> {
  const cursor = view.cursor as number;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > snapshot.lengthUtf16) return { ok: false, error: { kind: 'invalid-cursor' } };
  if (!Number.isSafeInteger(view.desiredDisplayColumn) || view.desiredDisplayColumn < 0 || !Number.isSafeInteger(view.scrollTop) || view.scrollTop < 0 || !Number.isSafeInteger(view.scrollLeft) || view.scrollLeft < 0) {
    return { ok: false, error: { kind: 'invalid-view' } };
  }
  const boundary = snapshot.slice(view.cursor, view.cursor);
  return boundary.ok ? { ok: true, value: undefined } : { ok: false, error: { kind: 'invalid-cursor' } };
}

function validateState(state: VimSearchState): Result<void, VimSearchFailure> {
  if (state.pattern !== null && typeof state.pattern !== 'string') return { ok: false, error: { kind: 'empty-pattern' } };
  if (state.direction !== null && state.direction !== 'forward' && state.direction !== 'backward') return { ok: false, error: { kind: 'invalid-offset' } };
  return { ok: true, value: undefined };
}

function validLineRange(snapshot: DocumentSnapshot, range: VimSubstituteRange): boolean {
  const first = range.firstLine as number;
  const last = range.lastLine as number;
  return Number.isSafeInteger(first) && Number.isSafeInteger(last) && first >= 0 && first <= last && last < snapshot.lineCount;
}

function patternFailure(error: unknown): VimSearchFailure {
  if (error instanceof PatternEvaluationError) return { kind: 'pattern-error', error };
  if (error instanceof Error) return { kind: 'pattern-error', error: new PatternEvaluationError('invalid-pattern', error.message, 0) };
  return { kind: 'pattern-error', error: new PatternEvaluationError('invalid-pattern', 'unknown-pattern-failure', 0) };
}

function opposite(direction: VimSearchDirection): VimSearchDirection { return direction === 'forward' ? 'backward' : 'forward'; }

function previousCodePoint(text: string, offset: number): { readonly codePoint: number; readonly start: number } | undefined {
  if (offset <= 0) return undefined;
  const lastUnit = text.charCodeAt(offset - 1);
  const codePoint = lastUnit >= 0xdc00 && lastUnit <= 0xdfff && offset >= 2
    ? text.codePointAt(offset - 2)
    : text.codePointAt(offset - 1);
  if (codePoint === undefined) return undefined;
  return { codePoint, start: offset - (codePoint > 0xffff ? 2 : 1) };
}
