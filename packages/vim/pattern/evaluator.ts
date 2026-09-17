import type { DocumentSnapshot, LineIndex, Utf16Offset } from '../../document/src/index';
import { defaultCellWidthPolicy } from '../../layout/src/index';
import { compileNfa, type NfaInstruction, type NfaProgram } from './nfa';
import {
  compilePatternCharacterClasses,
  isUnicodeLowercaseLetter,
  isUnicodeUppercaseLetter,
  isWideKeywordCharacter,
  matchesOptionRule,
  optionRulesFor,
  type CompiledPatternCharacterClasses,
} from './character-classes';
import {
  PatternEvaluationError,
  type CaptureSpan,
  type CharacterClassName,
  type CharacterClassPart,
  type PatternMatch,
  type PatternNode,
  type PatternProgram,
  type PatternPositionContext,
  type PatternTextSnapshot,
  type PatternVisualArea,
  type PositionPredicate,
  type SourceSpan,
} from './types';

interface InternalCaptureSpan {
  readonly start: number;
  readonly end: number;
}

interface EvaluationState {
  readonly position: number;
  readonly captures: ReadonlyMap<number, InternalCaptureSpan>;
  readonly reportedStart: number | null;
  readonly reportedEnd: number | null;
}

interface RepeatState {
  readonly state: EvaluationState;
  readonly stalled: boolean;
}

interface EvaluationContext {
  readonly program: PatternProgram;
  readonly snapshot: PatternTextSnapshot;
  readonly text: PatternTextAccess;
  readonly characterClasses: CompiledPatternCharacterClasses;
  readonly lineStarts: number[];
  lineStartsReady: boolean;
  readonly positionLineCache: Map<number, PositionLineIndex>;
  readonly budget: StepBudget;
}

interface PatternTextAccess {
  readonly length: number;
  slice(start: number, end: number): string;
  charCodeAt(position: number): number;
  codePointAt(position: number): number | undefined;
  /**
   * Find the next UTF-16 code unit equal to `codeUnit` in `[fromIndex, toIndex)`,
   * or -1. Implemented with native `String.prototype.indexOf` over the
   * underlying window(s) so a bounded probe costs one native scan rather than
   * one step per skipped code unit; callers bound `toIndex` themselves to
   * keep each probe (and therefore each accounted step) cheap and to
   * preserve cooperative yield points between probes.
   */
  indexOfUnit(codeUnit: number, fromIndex: number, toIndex: number): number;
}

interface PositionCoordinates {
  readonly line: number;
  readonly byteColumn: number;
  readonly virtualColumn: number;
  readonly firstCell: number;
  readonly endCell: number;
}

interface PositionLineIndex {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly points: ReadonlyMap<number, PositionCoordinates>;
}

interface InternalMatch {
  readonly start: number;
  readonly end: number;
  readonly consumedStart: number;
  readonly consumedEnd: number;
  readonly captures: ReadonlyMap<number, InternalCaptureSpan>;
}

interface InternalResult {
  readonly matches: readonly InternalMatch[];
  readonly steps: number;
  readonly engine: 'nfa' | 'backtracking';
}

export interface PatternEvaluationResult {
  readonly snapshotVersion: PatternTextSnapshot['version'];
  readonly matches: readonly PatternMatch[];
  readonly steps: number;
  readonly engine: 'nfa' | 'backtracking';
}

export type PatternEvaluationProgress =
  | { readonly kind: 'pending'; readonly steps: number }
  | { readonly kind: 'complete'; readonly result: PatternEvaluationResult };

/**
 * A pure, resumable evaluation over one immutable document snapshot. Calling
 * `resume` performs at most the requested number of evaluator work units; no
 * document, cursor, repeat or search state is mutated by this object.
 */
export class PatternEvaluationSession {
  private readonly context: EvaluationContext;
  private readonly iterator: Generator<void, InternalResult, void>;
  private cancelled = false;
  private completed: PatternEvaluationResult | undefined;
  private failure: unknown;
  private readonly engine: 'nfa' | 'backtracking';

  constructor(program: PatternProgram, snapshot: PatternTextSnapshot) {
    validateSnapshot(snapshot);
    const capturedSnapshot: PatternTextSnapshot = Object.freeze({
      version: snapshot.version,
      text: snapshot.text,
      ...(snapshot.lengthUtf16 === undefined ? {} : { lengthUtf16: snapshot.lengthUtf16 }),
      ...(snapshot.read === undefined ? {} : { read: snapshot.read }),
      ...(snapshot.isPrintableAsciiRange === undefined ? {} : { isPrintableAsciiRange: snapshot.isPrintableAsciiRange }),
      ...(snapshot.lineIndexAt === undefined ? {} : { lineIndexAt: snapshot.lineIndexAt }),
      ...(snapshot.lineStartOffset === undefined ? {} : { lineStartOffset: snapshot.lineStartOffset }),
      ...(snapshot.lineCount === undefined ? {} : { lineCount: snapshot.lineCount }),
    });
    validatePositionVersions(program, capturedSnapshot);
    validatePositionOffsets(program, capturedSnapshot);
    this.context = {
      program,
      snapshot: capturedSnapshot,
      text: createTextAccess(capturedSnapshot),
      characterClasses: compilePatternCharacterClasses(program.characterClassContext),
      lineStarts: [0],
      lineStartsReady: false,
      positionLineCache: new Map(),
      budget: new StepBudget(program, () => this.cancelled),
    };
    const requiresFallback = program.features.containsBackreference || program.features.containsLookaround || program.features.containsIntersection || program.features.containsOptionalSequence || program.features.containsCombiningAtom;
    const fastLiteral = asciiLiteralFor(snapshot, program);
    if (fastLiteral !== undefined) {
      this.engine = 'nfa';
      this.iterator = evaluateFastAsciiLiteral(this.context, fastLiteral);
      return;
    }
    if (program.engineSelector === 1 || requiresFallback) {
      this.engine = 'backtracking';
      this.iterator = evaluateAll(this.context);
    } else {
      this.engine = 'nfa';
      this.iterator = evaluateNfaAll(this.context, compileNfa(program));
    }
  }

  get steps(): number {
    return this.context.budget.steps;
  }

  cancel(): void {
    this.cancelled = true;
  }

  resume(maxWorkUnits: number): PatternEvaluationProgress {
    if (!Number.isSafeInteger(maxWorkUnits) || maxWorkUnits <= 0) {
      throw new RangeError('pattern-resume-work-units-must-be-a-positive-safe-integer');
    }
    if (this.failure !== undefined) throw this.failure;
    if (this.completed !== undefined) return { kind: 'complete', result: this.completed };

    let workUnits = 0;
    try {
      while (workUnits < maxWorkUnits) {
        const step = this.iterator.next();
        if (step.done) {
          this.completed = freezeResult(this.context.snapshot.version, step.value);
          return { kind: 'complete', result: this.completed };
        }
        workUnits += 1;
      }
      return { kind: 'pending', steps: this.steps };
    } catch (error: unknown) {
      this.failure = error;
      throw error;
    }
  }
}

/** Capture text from a document-owned immutable snapshot, retaining its version. */
export function patternSnapshotFromDocument(snapshot: DocumentSnapshot): PatternTextSnapshot {
  const patternSnapshot: PatternTextSnapshot = Object.freeze({
    version: snapshot.version,
    text: '',
    lengthUtf16: snapshot.lengthUtf16,
    read: (start: Utf16Offset, end: Utf16Offset) => snapshot.slice(start, end),
    isPrintableAsciiRange: (start: Utf16Offset, end: Utf16Offset) => snapshot.isPrintableAsciiRange?.(start, end)
      ?? { ok: true, value: false },
    lineIndexAt: (offset: Utf16Offset) => snapshot.lineIndexAt(offset),
    lineStartOffset: (line: LineIndex) => snapshot.lineStartOffset(line),
    lineCount: snapshot.lineCount,
  });
  validateSnapshot(patternSnapshot);
  return patternSnapshot;
}

export function createPatternTextSnapshot(version: PatternTextSnapshot['version'], text: string): PatternTextSnapshot {
  const snapshot: PatternTextSnapshot = Object.freeze({ version, text });
  validateSnapshot(snapshot);
  return snapshot;
}

export function createPatternEvaluation(program: PatternProgram, snapshot: PatternTextSnapshot): PatternEvaluationSession {
  return new PatternEvaluationSession(program, snapshot);
}

/** Synchronous convenience for deterministic tests and short bounded queries. */
export function findAllMatches(program: PatternProgram, snapshot: PatternTextSnapshot): PatternEvaluationResult {
  const session = createPatternEvaluation(program, snapshot);
  const progress = session.resume(Number.MAX_SAFE_INTEGER);
  if (progress.kind !== 'complete') throw new Error('pattern-evaluation-did-not-complete-within-one-budget');
  return progress.result;
}

export function substituteAll(
  program: PatternProgram,
  snapshot: PatternTextSnapshot,
  replacement: string,
): { readonly text: string; readonly matches: readonly PatternMatch[]; readonly steps: number; readonly snapshotVersion: PatternTextSnapshot['version']; readonly engine: 'nfa' | 'backtracking' } {
  const evaluated = findAllMatches(program, snapshot);
  const text = materializePatternText(snapshot);
  const output: string[] = [];
  let previousEnd = 0;
  for (const match of evaluated.matches) {
    const start = match.start as number;
    const end = match.end as number;
    if (start < previousEnd) continue;
    output.push(text.slice(previousEnd, start));
    output.push(expandReplacement(replacement, text, match));
    previousEnd = end;
  }
  output.push(text.slice(previousEnd));
  return Object.freeze({
    text: output.join(''),
    matches: evaluated.matches,
    steps: evaluated.steps,
    snapshotVersion: evaluated.snapshotVersion,
    engine: evaluated.engine,
  });
}

function asciiLiteralFor(
  snapshot: PatternTextSnapshot,
  program: PatternProgram,
): Extract<PatternNode, { readonly kind: 'literal' }> | undefined {
  const node = program.root;
  if (node.kind !== 'literal' || node.value.length !== 1 || program.ignoreCombining || node.matchComposing === true) return undefined;
  const codePoint = node.value.charCodeAt(0);
  if (codePoint < 0x20 || codePoint > 0x7e || caseInsensitive(node.caseMode, program)) return undefined;
  const classify = snapshot.isPrintableAsciiRange;
  const length = snapshot.lengthUtf16 ?? snapshot.text.length;
  if (classify === undefined) return undefined;
  const result = classify(utf16Offset(0), utf16Offset(length));
  return result.ok && result.value ? node : undefined;
}

/**
 * Counted, cooperative scan for the common one-byte literal search.
 *
 * The budget charges one step per bounded `indexOf` probe of at most
 * `FAST_SCAN_BATCH` UTF-16 units (i.e. per candidate window examined or per
 * match found, whichever advances first), not per UTF-16 unit skipped
 * between candidates: `String.prototype.indexOf` scans the skipped units
 * natively in one call, so counting them one-by-one against the step budget
 * would fail long, sparse searches (e.g. a single match at the end of a
 * multi-MiB document) long before any real per-step work happened. Bounding
 * each probe to `FAST_SCAN_BATCH` units keeps the same cooperative
 * yield/cancellation cadence as before while making the accounted step cost
 * for a no-match/sparse scan proportional to the number of windows examined
 * instead of the number of units skipped; a dense run of matches still costs
 * about one step per match, same as before.
 */
function* evaluateFastAsciiLiteral(
  context: EvaluationContext,
  node: Extract<PatternNode, { readonly kind: 'literal' }>,
): Generator<void, InternalResult, void> {
  const expected = node.value.charCodeAt(0);
  const matches: InternalMatch[] = [];
  let offset = 0;
  while (offset < context.text.length) {
    const probeEnd = Math.min(context.text.length, offset + FAST_SCAN_BATCH);
    const index = context.text.indexOfUnit(expected, offset, probeEnd);
    context.budget.tick(node.source);
    if (index === -1) {
      offset = probeEnd;
    } else {
      if (matches.length >= context.program.outputLimit) {
        throw new PatternEvaluationError('output-limit-exceeded', `pattern-output-limit-exceeded: ${context.program.outputLimit}`, context.budget.steps, node.source);
      }
      matches.push({
        start: index,
        end: index + 1,
        consumedStart: index,
        consumedEnd: index + 1,
        captures: new Map(),
      });
      offset = index + 1;
    }
    yield;
  }
  return { matches, steps: context.budget.steps, engine: 'nfa' };
}

const FAST_SCAN_BATCH = 4096;

function* prepareLineStartIndex(context: EvaluationContext): Generator<void, void, void> {
  if (context.lineStartsReady) return;
  const visualArea = context.program.positionContext?.visualArea;
  const needsLineCoordinates = context.program.features.containsLineNumberAtom
    || context.program.features.containsColumnAtom
    || (context.program.features.containsVisualAreaAtom && visualArea?.kind !== 'characterwise');
  if (!needsLineCoordinates) {
    context.lineStartsReady = true;
    return;
  }
  if (context.snapshot.lineIndexAt !== undefined && context.snapshot.lineStartOffset !== undefined
    && context.snapshot.lineCount !== undefined) {
    context.lineStartsReady = true;
    return;
  }
  for (let index = 0; index < context.text.length; index += 1) {
    yield* visit(context, context.program.root.source);
    if (context.text.charCodeAt(index) === 10) context.lineStarts.push(index + 1);
  }
  context.lineStartsReady = true;
  const area = context.program.positionContext?.visualArea;
  if (area !== undefined && area.kind !== 'characterwise' && (area.lastLine as number) >= context.lineStarts.length) {
    throw new PatternEvaluationError('invalid-pattern', 'pattern-visual-area-line-outside-snapshot', context.budget.steps, context.program.root.source);
  }
}

function* evaluateAll(context: EvaluationContext): Generator<void, InternalResult, void> {
  yield* prepareLineStartIndex(context);
  const matches: InternalMatch[] = [];
  let offset = 0;
  while (offset <= context.text.length) {
    yield* visit(context, { start: 0, end: 0 });
    const initial: EvaluationState = { position: offset, captures: new Map(), reportedStart: null, reportedEnd: null };
    const states = yield* evaluate(context.program.root, initial, context);
    const matchState = states[0];
    if (matchState === undefined) {
      offset = yield* advanceVimCharacter(context, offset, context.program.root.source);
      continue;
    }
    const start = matchState.reportedStart ?? offset;
    const end = matchState.reportedEnd ?? matchState.position;
    if (start < 0 || end < start || end > context.text.length) {
      throw new PatternEvaluationError('invalid-pattern', `invalid-reported-match-range: ${start}..${end}`, context.budget.steps, context.program.root.source);
    }
    const zeroWidth = start === end && matchState.position === offset;
    const endOfLineBoundary = isEndOfLine(context.text, offset);
    const shouldSkipTerminalEmpty = zeroWidth && endOfLineBoundary && !context.program.features.containsLineBoundary;
    if (!shouldSkipTerminalEmpty) {
      if (matches.length >= context.program.outputLimit) {
        throw new PatternEvaluationError('output-limit-exceeded', `pattern-output-limit-exceeded: ${context.program.outputLimit}`, context.budget.steps, context.program.root.source);
      }
      matches.push({
        start,
        end,
        consumedStart: offset,
        consumedEnd: matchState.position,
        captures: matchState.captures,
      });
    }
    offset = matchState.position > offset
      ? matchState.position
      : yield* advanceVimCharacter(context, offset, context.program.root.source);
  }
  return { matches, steps: context.budget.steps, engine: 'backtracking' };
}

interface NfaThread {
  readonly pc: number;
  readonly matchStart: number;
  readonly captures: ReadonlyMap<number, InternalCaptureSpan>;
  readonly captureStarts: ReadonlyMap<number, number>;
  readonly reportedStart: number | null;
  readonly reportedEnd: number | null;
}

/** Execute the regular subset with ordered Thompson start threads (leftmost-first, greedy priority). */
function* evaluateNfaAll(context: EvaluationContext, nfa: NfaProgram): Generator<void, InternalResult, void> {
  yield* prepareLineStartIndex(context);
  const matches: InternalMatch[] = [];
  let offset = 0;
  while (offset <= context.text.length) {
    yield* visit(context, { start: 0, end: 0 });
    const match = yield* findNextNfaMatch(context, nfa, offset);
    if (match === undefined) break;
    if (match.start < 0 || match.end < match.start || match.end > context.text.length) {
      throw new PatternEvaluationError('invalid-pattern', `invalid-reported-match-range: ${match.start}..${match.end}`, context.budget.steps, context.program.root.source);
    }
    const zeroWidth = match.start === match.end && match.consumedEnd === match.consumedStart;
    const endOfLineBoundary = isEndOfLine(context.text, match.consumedStart);
    const shouldSkipTerminalEmpty = zeroWidth && endOfLineBoundary && !context.program.features.containsLineBoundary;
    if (!shouldSkipTerminalEmpty) {
      if (matches.length >= context.program.outputLimit) {
        throw new PatternEvaluationError('output-limit-exceeded', `pattern-output-limit-exceeded: ${context.program.outputLimit}`, context.budget.steps, context.program.root.source);
      }
      matches.push(match);
    }
    offset = match.consumedEnd > match.consumedStart
      ? match.consumedEnd
      : yield* advanceVimCharacter(context, match.consumedStart, context.program.root.source);
  }
  return { matches, steps: context.budget.steps, engine: 'nfa' };
}

function* findNextNfaMatch(context: EvaluationContext, nfa: NfaProgram, searchStart: number): Generator<void, InternalMatch | undefined, void> {
  let position = searchStart;
  let seeds: NfaThread[] = [];
  let active: NfaActiveThread[] = [];
  let fallback: InternalMatch | undefined;

  while (position <= context.text.length) {
    if (fallback === undefined) {
      seeds.push({
        pc: nfa.start,
        matchStart: position,
        captures: new Map(),
        captureStarts: new Map(),
        reportedStart: null,
        reportedEnd: null,
      });
    }
    active = yield* nfaClosure(context, nfa, position, seeds);
    seeds = [];
    const matchIndex = active.findIndex((thread) => thread.instruction.kind === 'match');
    if (matchIndex >= 0) {
      const accepted = active[matchIndex];
      if (accepted !== undefined) fallback = threadToMatch(accepted.thread, position);
      if (matchIndex === 0) return fallback;
      active = active.slice(0, matchIndex);
    }

    if (position >= context.text.length) return fallback;
    const nextPosition = yield* advanceVimCharacter(context, position, context.program.root.source);
    const codePoint = context.text.codePointAt(position);
    if (codePoint === undefined) return fallback;

    seeds = [];
    for (const current of active) {
      if (current.instruction.kind !== 'character') continue;
      yield* visit(context, current.instruction.source);
      if (!(yield* characterAtomMatches(current.instruction.atom, position, codePoint, context))) continue;
      seeds.push({ ...current.thread, pc: current.instruction.next });
    }
    if (seeds.length === 0 && fallback !== undefined) return fallback;
    position = nextPosition;
  }
  return fallback;
}

interface NfaActiveThread {
  readonly instruction: NfaInstruction;
  readonly thread: NfaThread;
}

function* nfaClosure(
  context: EvaluationContext,
  nfa: NfaProgram,
  position: number,
  seeds: readonly NfaThread[],
): Generator<void, NfaActiveThread[], void> {
  const result: NfaActiveThread[] = [];
  const visits = new Map<number, { readonly matchStart: number; count: number }>();
  const pending: NfaThread[] = [];
  for (let index = seeds.length - 1; index >= 0; index -= 1) {
    const seed = seeds[index];
    if (seed !== undefined) pending.push(seed);
  }
  while (pending.length > 0) {
    const thread = pending.pop();
    if (thread === undefined) continue;
    const priorVisit = visits.get(thread.pc);
    // One repeated visit preserves the submatch from a final empty iteration;
    // further visits are epsilon cycles and cannot consume additional input.
    if (priorVisit !== undefined) {
      if (priorVisit.matchStart !== thread.matchStart || priorVisit.count >= 2) continue;
      priorVisit.count += 1;
    } else {
      visits.set(thread.pc, { matchStart: thread.matchStart, count: 1 });
    }
    const instruction = nfa.instructions[thread.pc];
    if (instruction === undefined) throw new PatternEvaluationError('invalid-pattern', `nfa-program-counter-out-of-range: ${thread.pc}`, context.budget.steps);
    yield* visit(context, instruction.source);
    switch (instruction.kind) {
      case 'jump':
        pending.push({ ...thread, pc: instruction.next });
        break;
      case 'split':
        pending.push({ ...thread, pc: instruction.second });
        pending.push({ ...thread, pc: instruction.first });
        break;
      case 'capture-start': {
        const captureStarts = new Map(thread.captureStarts);
        captureStarts.set(instruction.group, position);
        const captures = new Map(thread.captures);
        captures.delete(instruction.group);
        pending.push({ ...thread, pc: instruction.next, captures, captureStarts });
        break;
      }
      case 'capture-end': {
        const captureStart = thread.captureStarts.get(instruction.group);
        const captures = new Map(thread.captures);
        const captureStarts = new Map(thread.captureStarts);
        captureStarts.delete(instruction.group);
        if (captureStart !== undefined) captures.set(instruction.group, { start: captureStart, end: position });
        pending.push({ ...thread, pc: instruction.next, captures, captureStarts });
        break;
      }
      case 'reported-start':
        pending.push({ ...thread, pc: instruction.next, reportedStart: position });
        break;
      case 'reported-end':
        pending.push({ ...thread, pc: instruction.next, reportedEnd: position });
        break;
      case 'anchor':
        if (yield* anchorMatches(instruction.atom, position, context)) pending.push({ ...thread, pc: instruction.next });
        break;
      case 'character':
      case 'match':
        result.push({ instruction, thread });
        break;
      default:
        unreachable(instruction);
    }
  }
  return result;
}

function* characterAtomMatches(
  atom: Extract<PatternNode, { kind: 'literal' | 'dot' | 'character-class' }>,
  position: number,
  codePoint: number,
  context: EvaluationContext,
): Generator<void, boolean, void> {
  if (atom.kind === 'literal') {
    const width = codePointWidthAt(context.text, position);
    const observed = context.text.slice(position, position + width);
    const isMark = isCombiningCodePoint(codePoint);
    if (isMark) return false;
    const composed = yield* followingComposing(context, position + width, atom.source);
    return composed.marks.length === 0
      && equalText(observed, atom.value, caseInsensitive(atom.caseMode, context.program));
  }
  if (atom.kind === 'dot') return (atom.includeNewline || codePoint !== 10) && !isAttachedComposingAt(context.text, position);
  const oldEngineIgnoreCase = context.program.engineSelector === 1 && caseInsensitive(atom.caseMode, context.program);
  const classResult = yield* classMatches(atom.parts, codePoint, oldEngineIgnoreCase, context, atom.source);
  const matches = atom.includeNewline && codePoint === 10 ? true : atom.negated ? !classResult : classResult;
  return matches && !isAttachedComposingAt(context.text, position);
}

function threadToMatch(thread: NfaThread, consumedEnd: number): InternalMatch {
  return {
    start: thread.reportedStart ?? thread.matchStart,
    end: thread.reportedEnd ?? consumedEnd,
    consumedStart: thread.matchStart,
    consumedEnd,
    captures: thread.captures,
  };
}

function* evaluate(
  node: PatternNode,
  state: EvaluationState,
  context: EvaluationContext,
): Generator<void, EvaluationState[], void> {
  yield* visit(context, node.source);
  switch (node.kind) {
    case 'empty':
      return [state];
    case 'literal': {
      if (isCombiningSequence(node.value)) {
        const end = yield* matchLeadingComposing(context, state.position, node.value, node.source);
        return end === undefined ? [] : [{ ...state, position: end }];
      }
      const width = codePointWidthAt(context.text, state.position);
      if (width === 0) return [];
      const codePoint = context.text.codePointAt(state.position);
      if (codePoint === undefined || isCombiningCodePoint(codePoint)) return [];
      const patternScalars = [...node.value];
      const patternBase = patternScalars[0];
      if (patternBase === undefined || isCombiningCodePoint(patternBase.codePointAt(0) ?? -1)) return [];
      const observedBase = context.text.slice(state.position, state.position + width);
      if (!equalText(observedBase, patternBase, caseInsensitive(node.caseMode, context.program))) return [];
      const baseEnd = state.position + width;
      const observedComposing = yield* followingComposing(context, baseEnd, node.source);
      const requiredMarks = patternScalars.slice(1);
      if (requiredMarks.length > 0) {
        if (context.program.engineSelector === 1) {
          if (!sameStrings(observedComposing.marks, requiredMarks)) return [];
        } else if (!containsComposingMarks(observedComposing.marks, requiredMarks, context, node.source)) {
          return [];
        }
        return [{ ...state, position: observedComposing.end }];
      }
      if (context.program.ignoreCombining) {
        const position = context.program.engineSelector === 1 ? baseEnd : observedComposing.end;
        return [{ ...state, position }];
      }
      if (node.matchComposing === true) return [{ ...state, position: baseEnd }];
      if (observedComposing.marks.length > 0) return [];
      return [{ ...state, position: baseEnd }];
    }
    case 'dot': {
      const width = codePointWidthAt(context.text, state.position);
      if (width === 0) return [];
      const codePoint = context.text.codePointAt(state.position);
      if (codePoint === undefined || (!node.includeNewline && codePoint === 10) || isAttachedComposingAt(context.text, state.position)) return [];
      const position = yield* vimCharacterEnd(context, state.position, node.source);
      return [{ ...state, position }];
    }
    case 'character-class': {
      const width = codePointWidthAt(context.text, state.position);
      if (width === 0) return [];
      const codePoint = context.text.codePointAt(state.position);
      if (codePoint === undefined) return [];
      if (isAttachedComposingAt(context.text, state.position)) return [];
      const oldEngineIgnoreCase = context.program.engineSelector === 1 && caseInsensitive(node.caseMode, context.program);
      const classResult = yield* classMatches(node.parts, codePoint, oldEngineIgnoreCase, context, node.source);
      const matches = node.includeNewline && codePoint === 10 ? true : (node.negated ? !classResult : classResult);
      if (!matches) return [];
      const baseEnd = state.position + width;
      const observedComposing = yield* followingComposing(context, baseEnd, node.source);
      const requiredMarks = classCombiningLiterals(node.parts);
      let position = baseEnd;
      if (requiredMarks.length > 0 && context.program.engineSelector === 1 && !isCombiningCodePoint(codePoint)) {
        if (observedComposing.marks.length < requiredMarks.length
          || !sameStrings(observedComposing.marks.slice(0, requiredMarks.length), requiredMarks)) return [];
        position = baseEnd + requiredMarks.reduce((total, mark) => total + mark.length, 0);
      } else if (context.program.engineSelector !== 1 || context.program.ignoreCombining) {
        position = observedComposing.end;
      }
      return [{ ...state, position }];
    }
    case 'sequence': {
      let states = [state];
      for (let index = 0; index < node.terms.length; index += 1) {
        const term = node.terms[index];
        if (term === undefined) continue;
        const suffix = node.terms.slice(index + 1);
        if (suffix.length > 0 && term.kind === 'assertion' && (term.assertion === 'behind-positive' || term.assertion === 'behind-negative')) {
          const referenced = backreferenceGroups(term.child);
          const forwardGroups = referenced.filter((group) =>
            !states.some((current) => current.captures.has(group)) && containsCaptureGroupInAny(suffix, group),
          );
          if (forwardGroups.length > 0) {
            const futureMatches: EvaluationState[] = [];
            const suffixNode: PatternNode = {
              kind: 'sequence',
              terms: suffix,
              source: { start: term.source.end, end: node.source.end },
            };
            for (const current of states) {
              const continuations = yield* evaluate(suffixNode, current, context);
              for (const continuation of continuations) {
                const lookbehindState = { ...current, captures: continuation.captures };
                const assertionResults = yield* evaluate(term, lookbehindState, context);
                const assertionMatch = assertionResults[0];
                if (assertionMatch === undefined) continue;
                const captures = new Map(assertionMatch.captures);
                for (const [group, capture] of continuation.captures) captures.set(group, capture);
                futureMatches.push({
                  ...continuation,
                  captures,
                  reportedStart: assertionMatch.reportedStart ?? continuation.reportedStart,
                  reportedEnd: assertionMatch.reportedEnd ?? continuation.reportedEnd,
                });
              }
            }
            return futureMatches;
          }
        }
        const next: EvaluationState[] = [];
        for (const current of states) next.push(...(yield* evaluate(term, current, context)));
        states = next;
        if (states.length === 0) break;
      }
      return states;
    }
    case 'alternate': {
      const results: EvaluationState[] = [];
      for (const branch of node.branches) results.push(...(yield* evaluate(branch, state, context)));
      return results;
    }
    case 'intersection': {
      let constraintState = state;
      for (let index = 0; index < node.concats.length - 1; index += 1) {
        const constraint = node.concats[index];
        if (constraint === undefined) return [];
        const matches = yield* evaluate(constraint, constraintState, context);
        const preferred = matches[0];
        if (preferred === undefined) return [];
        constraintState = { ...constraintState, captures: preferred.captures };
      }
      const finalConcat = node.concats.at(-1);
      return finalConcat === undefined ? [constraintState] : yield* evaluate(finalConcat, constraintState, context);
    }
    case 'optional-sequence': {
      let current = state;
      for (const atom of node.atoms) {
        const results = yield* evaluate(atom, current, context);
        const preferred = results[0];
        if (preferred === undefined) break;
        current = preferred;
      }
      return [current];
    }
    case 'capture': {
      const results = yield* evaluate(node.child, state, context);
      return results.map((result) => {
        const captures = new Map(result.captures);
        const composingOnlyOldEngine = context.program.engineSelector === 1
          && node.child.kind === 'literal'
          && isCombiningSequence(node.child.value);
        captures.set(node.group, {
          start: state.position,
          end: composingOnlyOldEngine ? state.position : result.position,
        });
        return { ...result, captures };
      });
    }
    case 'repeat':
      return yield* evaluateRepeat(node, state, context);
    case 'backreference': {
      const capture = state.captures.get(node.group);
      if (capture === undefined) return [];
      let capturedPosition = capture.start;
      let observedPosition = state.position;
      const ignoreCase = caseInsensitive(node.caseMode, context.program);
      while (capturedPosition < capture.end) {
        yield* visit(context, node.source);
        const capturedWidth = codePointWidthAt(context.text, capturedPosition);
        if (capturedWidth === 0) return [];
        const capturedScalar = context.text.slice(capturedPosition, capturedPosition + capturedWidth);
        const capturedCodePoint = capturedScalar.codePointAt(0);
        if (context.program.ignoreCombining && capturedCodePoint !== undefined && isCombiningCodePoint(capturedCodePoint)) {
          capturedPosition += capturedWidth;
          continue;
        }
        let observedWidth = codePointWidthAt(context.text, observedPosition);
        let observedScalar = context.text.slice(observedPosition, observedPosition + observedWidth);
        let observedCodePoint = observedScalar.codePointAt(0);
        while (context.program.ignoreCombining && observedWidth > 0 && observedCodePoint !== undefined && isCombiningCodePoint(observedCodePoint)) {
          yield* visit(context, node.source);
          observedPosition += observedWidth;
          observedWidth = codePointWidthAt(context.text, observedPosition);
          observedScalar = context.text.slice(observedPosition, observedPosition + observedWidth);
          observedCodePoint = observedScalar.codePointAt(0);
        }
        if (observedWidth === 0) return [];
        if (!equalText(observedScalar, capturedScalar, ignoreCase)) return [];
        capturedPosition += capturedWidth;
        observedPosition += observedWidth;
      }
      if (context.program.ignoreCombining) observedPosition = yield* consumeFollowingComposing(context, observedPosition, node.source);
      return [{ ...state, position: observedPosition }];
    }
    case 'assertion':
      return yield* evaluateAssertion(node, state, context);
    case 'skip-combining': {
      let position = state.position;
      while (position < context.text.length) {
        const codePoint = context.text.codePointAt(position);
        if (codePoint === undefined || !isCombiningCodePoint(codePoint)) break;
        yield* visit(context, node.source);
        position += codePointWidthAt(context.text, position);
      }
      return [{ ...state, position }];
    }
    case 'set-start':
      return [{ ...state, reportedStart: state.position }];
    case 'set-end':
      return [{ ...state, reportedEnd: state.position }];
    case 'anchor':
      return (yield* anchorMatches(node, state.position, context)) ? [state] : [];
    default:
      return unreachable(node);
  }
}

function backreferenceGroups(node: PatternNode): number[] {
  switch (node.kind) {
    case 'backreference':
      return [node.group];
    case 'sequence':
      return node.terms.flatMap(backreferenceGroups);
    case 'alternate':
      return node.branches.flatMap(backreferenceGroups);
    case 'intersection':
      return node.concats.flatMap(backreferenceGroups);
    case 'optional-sequence':
      return node.atoms.flatMap(backreferenceGroups);
    case 'capture':
    case 'repeat':
    case 'assertion':
      return backreferenceGroups(node.child);
    default:
      return [];
  }
}

function containsCaptureGroupInAny(nodes: readonly PatternNode[], group: number): boolean {
  return nodes.some((node) => containsCaptureGroup(node, group));
}

function containsCaptureGroup(node: PatternNode, group: number): boolean {
  switch (node.kind) {
    case 'capture':
      return node.group === group || containsCaptureGroup(node.child, group);
    case 'sequence':
      return node.terms.some((term) => containsCaptureGroup(term, group));
    case 'alternate':
      return node.branches.some((branch) => containsCaptureGroup(branch, group));
    case 'intersection':
      return node.concats.some((concat) => containsCaptureGroup(concat, group));
    case 'optional-sequence':
      return node.atoms.some((atom) => containsCaptureGroup(atom, group));
    case 'repeat':
    case 'assertion':
      return containsCaptureGroup(node.child, group);
    default:
      return false;
  }
}

function* evaluateRepeat(
  node: Extract<PatternNode, { kind: 'repeat' }>,
  state: EvaluationState,
  context: EvaluationContext,
): Generator<void, EvaluationState[], void> {
  const maximum = node.maximum ?? (context.text.length - state.position + node.minimum + 1);
  const levels: { readonly count: number; readonly states: readonly EvaluationState[] }[] = [{ count: 0, states: [state] }];
  let layer: RepeatState[] = [{ state, stalled: false }];
  for (let count = 1; count <= maximum; count += 1) {
    yield* visit(context, node.source);
    const next: RepeatState[] = [];
    for (const previous of layer) {
      if (previous.stalled) {
        if (count < node.minimum) next.push({ state: previous.state, stalled: true });
        continue;
      }
      for (const result of yield* evaluate(node.child, previous.state, context)) {
        next.push({ state: result, stalled: result.position === previous.state.position });
      }
    }
    if (next.length === 0) break;
    layer = next;
    levels.push({ count, states: next.map((entry) => entry.state) });
    if (next.every((entry) => entry.stalled) && count >= node.minimum) break;
  }
  const candidates = node.greedy ? [...levels].reverse() : levels;
  const results: EvaluationState[] = [];
  for (const candidate of candidates) {
    if (candidate.count >= node.minimum) results.push(...candidate.states);
  }
  return results;
}

function* evaluateAssertion(
  node: Extract<PatternNode, { kind: 'assertion' }>,
  state: EvaluationState,
  context: EvaluationContext,
): Generator<void, EvaluationState[], void> {
  const { assertion, child } = node;
  if (assertion === 'atomic') {
    const results = yield* evaluate(child, state, context);
    return results.length === 0 ? [] : [results[0] ?? state];
  }
  if (assertion === 'ahead-positive' || assertion === 'ahead-negative') {
    const results = yield* evaluate(child, state, context);
    if (assertion === 'ahead-positive') {
      const preferred = results[0];
      return preferred === undefined ? [] : [{ ...preferred, position: state.position, reportedStart: preferred.reportedStart, reportedEnd: preferred.reportedEnd }];
    }
    return results.length === 0 ? [state] : [];
  }

  const { lowerBound, currentLineStart } = yield* lookbehindBounds(context, state.position, node.source);
  const candidates = yield* precedingBoundaries(context, state.position, lowerBound, currentLineStart, node.source);
  for (const candidate of candidates) {
    if (node.lookbehindLimitBytes !== undefined && node.lookbehindLimitBytes !== 0) {
      const distance = candidate.position < currentLineStart ? candidate.previousLineBytes : candidate.currentLineBytes;
      if (distance > node.lookbehindLimitBytes) {
        // Vim's byte window may begin inside the first UTF-8 scalar; matching
        // then rounds that candidate back to the scalar's lead byte.
        const firstCodePoint = context.text.codePointAt(candidate.position);
        const firstCodePointBytes = firstCodePoint === undefined ? 0 : utf8Width(firstCodePoint);
        if (distance - node.lookbehindLimitBytes >= firstCodePointBytes) continue;
      }
    }
    yield* visit(context, child.source);
    const initial = { ...state, position: candidate.position, reportedStart: null, reportedEnd: null };
    const results = (yield* evaluate(child, initial, context)).filter((result) => result.position === state.position);
    const preferred = results[0];
    if (preferred !== undefined) {
      if (assertion === 'behind-positive') {
        return [{ ...preferred, position: state.position, reportedStart: preferred.reportedStart, reportedEnd: preferred.reportedEnd }];
      }
      return [];
    }
  }
  return assertion === 'behind-negative' ? [state] : [];
}

function* anchorMatches(
  node: Extract<PatternNode, { kind: 'anchor' }>,
  position: number,
  context: EvaluationContext,
): Generator<void, boolean, void> {
  const text = context.text;
  switch (node.anchor) {
    case 'line-start':
      return position === 0 || text.charCodeAt(position - 1) === 10;
    case 'line-end':
      return position === text.length || text.charCodeAt(position) === 10;
    case 'file-start':
      return position === 0;
    case 'file-end':
      return position === text.length;
    case 'word-start':
      return isWordAt(text, position) && !isWordBefore(text, position);
    case 'word-end':
      return isWordBefore(text, position) && !isWordAt(text, position);
    case 'cursor':
      return (yield* cursorPosition(context, node.source)) === position;
    case 'line-number':
      return node.expected === (yield* lineNumberAt(context, position, node.source));
    case 'position': {
      const actual = yield* coordinateValue(context, position, node.predicate.axis, node.source);
      const expected = node.predicate.target.kind === 'number'
        ? node.predicate.target.value
        : yield* cursorCoordinateValue(context, node.predicate.axis, node.source);
      return comparePosition(actual, expected, node.predicate);
    }
    case 'mark': {
      const mark = context.program.positionContext?.marks?.[node.mark];
      if (mark === undefined) {
        throw new PatternEvaluationError('unsupported-construct', `position-mark-context-not-provided: ${node.mark}`, context.budget.steps, node.source);
      }
      const target = mark as number;
      if (node.relation === 'equal') return position === target;
      if (node.relation === 'less-than') return position < target;
      return position > target;
    }
    case 'visual-area':
      return yield* visualAreaContains(context, position, node.source);
    default:
      return unreachable(node);
  }
}

function* cursorPosition(context: EvaluationContext, source: SourceSpan): Generator<void, number, void> {
  const cursor = context.program.positionContext?.cursor ?? context.program.cursor?.offset;
  if (cursor === undefined) {
    throw new PatternEvaluationError('unsupported-construct', 'position-atom-requires-versioned-cursor-context', context.budget.steps, source);
  }
  return cursor as number;
}

function* lineNumberAt(context: EvaluationContext, position: number, source: SourceSpan): Generator<void, number, void> {
  if (context.snapshot.lineIndexAt !== undefined) {
    const line = context.snapshot.lineIndexAt(utf16Offset(position));
    if (!line.ok) {
      throw new PatternEvaluationError('invalid-pattern', `pattern-line-position-read-failed: ${line.error.kind}`, context.budget.steps, source);
    }
    return (line.value as number) + 1;
  }
  yield* prepareLineStartIndex(context);
  return lineIndexAt(context.lineStarts, position) + 1;
}

function* coordinateValue(
  context: EvaluationContext,
  position: number,
  axis: PositionPredicate['axis'],
  source: SourceSpan,
): Generator<void, number, void> {
  if (axis === 'line') return yield* lineNumberAt(context, position, source);
  const coordinates = yield* positionCoordinatesAt(context, position, source);
  return axis === 'byte-column' ? coordinates.byteColumn : coordinates.virtualColumn;
}

function* cursorCoordinateValue(
  context: EvaluationContext,
  axis: PositionPredicate['axis'],
  source: SourceSpan,
): Generator<void, number, void> {
  const cursor = yield* cursorPosition(context, source);
  if (axis !== 'virtual-column') return yield* coordinateValue(context, cursor, axis, source);
  const coordinates = yield* positionCoordinatesAt(context, cursor, source);
  // Vim's cursor virtual column is its cell within the current character. For
  // tabs and wide glyphs this is the final occupied cell, while numeric `\%Nv`
  // predicates address the character's leading virtual column.
  return coordinates.endCell > coordinates.firstCell ? coordinates.endCell : coordinates.virtualColumn;
}

function comparePosition(actual: number, expected: number, predicate: PositionPredicate): boolean {
  if (predicate.relation === 'equal') return actual === expected;
  if (predicate.relation === 'less-than') return actual < expected;
  return actual > expected;
}

function* visualAreaContains(context: EvaluationContext, position: number, source: SourceSpan): Generator<void, boolean, void> {
  const area = context.program.positionContext?.visualArea;
  if (area === undefined) {
    throw new PatternEvaluationError('unsupported-construct', 'visual-position-atom-requires-versioned-selection-context', context.budget.steps, source);
  }
  if (area.kind === 'characterwise') return position >= (area.start as number) && position < (area.end as number);
  const line = (yield* lineNumberAt(context, position, source)) - 1;
  if (line < (area.firstLine as number) || line > (area.lastLine as number)) return false;
  if (area.kind === 'linewise') return true;
  const coordinates = yield* positionCoordinatesAt(context, position, source);
  return coordinates.firstCell <= (area.lastCell as number)
    && Math.max(coordinates.endCell, coordinates.firstCell + 1) - 1 >= (area.firstCell as number);
}

function* positionCoordinatesAt(
  context: EvaluationContext,
  position: number,
  source: SourceSpan,
): Generator<void, PositionCoordinates, void> {
  yield* prepareLineStartIndex(context);
  const line = (yield* lineNumberAt(context, position, source)) - 1;
  let cached = context.positionLineCache.get(line);
  if (cached === undefined) {
    const start = yield* lineStartAt(context, line, source);
    const end = yield* lineEndAt(context, line, start, source);
    cached = yield* buildPositionLineIndex(context, line, start, end, source);
    if (context.positionLineCache.size >= maximumCachedPositionLines) {
      const oldest = context.positionLineCache.keys().next().value as number | undefined;
      if (oldest !== undefined) context.positionLineCache.delete(oldest);
    }
    context.positionLineCache.set(line, cached);
  }
  const point = cached.points.get(position);
  if (point === undefined) {
    throw new PatternEvaluationError('invalid-pattern', 'pattern-coordinate-is-not-a-safe-vim-character-boundary', context.budget.steps, source);
  }
  return point;
}

const maximumCachedPositionLines = 8;

function* lineStartAt(context: EvaluationContext, line: number, source: SourceSpan): Generator<void, number, void> {
  if (context.snapshot.lineStartOffset !== undefined) {
    const result = context.snapshot.lineStartOffset(lineIndex(line));
    if (!result.ok) {
      throw new PatternEvaluationError('invalid-pattern', `pattern-line-start-read-failed: ${result.error.kind}`, context.budget.steps, source);
    }
    return result.value as number;
  }
  yield* prepareLineStartIndex(context);
  const start = context.lineStarts[line];
  if (start === undefined) {
    throw new PatternEvaluationError('invalid-pattern', `pattern-line-index-out-of-range: ${line}`, context.budget.steps, source);
  }
  return start;
}

function* lineEndAt(context: EvaluationContext, line: number, start: number, source: SourceSpan): Generator<void, number, void> {
  if (context.snapshot.lineStartOffset !== undefined && context.snapshot.lineCount !== undefined) {
    if (line + 1 >= context.snapshot.lineCount) return context.text.length;
    const next = context.snapshot.lineStartOffset(lineIndex(line + 1));
    if (!next.ok) {
      throw new PatternEvaluationError('invalid-pattern', `pattern-next-line-start-read-failed: ${next.error.kind}`, context.budget.steps, source);
    }
    return Math.max(start, (next.value as number) - 1);
  }
  yield* prepareLineStartIndex(context);
  const nextStart = context.lineStarts[line + 1];
  return nextStart === undefined ? context.text.length : Math.max(start, nextStart - 1);
}

function* buildPositionLineIndex(
  context: EvaluationContext,
  line: number,
  start: number,
  end: number,
  source: SourceSpan,
): Generator<void, PositionLineIndex, void> {
  const points = new Map<number, PositionCoordinates>();
  const position = context.program.positionContext;
  const tabstop = position?.tabstop ?? 8;
  const widthPolicy = position?.widthPolicy ?? defaultCellWidthPolicy();
  let offset = start;
  let byteColumn = 1;
  let cell = 0;
  while (offset < end) {
    const clusterStart = offset;
    const clusterStartByte = byteColumn;
    const scalars: { readonly offset: number; readonly byteColumn: number; readonly width: number; readonly value: string }[] = [];
    let cluster = '';
    let regionalCount = 0;
    let candidate = offset;
    while (candidate < end) {
      yield* visit(context, source);
      const codePoint = context.text.codePointAt(candidate);
      if (codePoint === undefined) break;
      const scalarWidth = codePoint > 0xffff ? 2 : 1;
      const scalar = context.text.slice(candidate, candidate + scalarWidth);
      if (cluster.length > 0 && !joinsPositionCluster(cluster, scalar, regionalCount)) break;
      scalars.push({ offset: candidate, byteColumn, width: utf8Width(codePoint), value: scalar });
      cluster += scalar;
      if (isRegionalIndicator(scalar)) regionalCount += 1;
      else if (scalar !== '\u200d' && !isPositionExtender(scalar)) regionalCount = 0;
      candidate += scalarWidth;
      byteColumn += utf8Width(codePoint);
    }
    if (candidate <= clusterStart) {
      throw new PatternEvaluationError('invalid-pattern', 'pattern-position-index-could-not-advance', context.budget.steps, source);
    }
    let width: number;
    try {
      width = cluster === '\t' ? tabstop - (cell % tabstop) : widthPolicy.widthOfCluster(cluster);
    } catch {
      throw new PatternEvaluationError('invalid-pattern', 'pattern-position-width-policy-failed', context.budget.steps, source);
    }
    if (!Number.isSafeInteger(width) || width < 0 || (cluster === '\t' ? width > tabstop : width > 2)) {
      throw new PatternEvaluationError('invalid-pattern', 'pattern-position-width-policy-returned-invalid-width', context.budget.steps, source);
    }
    for (const scalar of scalars) {
      points.set(scalar.offset, {
        line,
        byteColumn: scalar.byteColumn,
        virtualColumn: cell + 1,
        firstCell: cell,
        endCell: scalar.offset === clusterStart ? cell + width : cell,
      });
    }
    offset = candidate;
    cell += width;
    points.set(offset, { line, byteColumn, virtualColumn: cell + 1, firstCell: cell, endCell: cell });
    if (byteColumn <= clusterStartByte) {
      throw new PatternEvaluationError('invalid-pattern', 'pattern-position-byte-column-did-not-advance', context.budget.steps, source);
    }
  }
  if (!points.has(end)) points.set(end, { line, byteColumn, virtualColumn: cell + 1, firstCell: cell, endCell: cell });
  return { line, start, end, points };
}

function joinsPositionCluster(current: string, next: string, regionalCount: number): boolean {
  if (isPositionExtender(next) || next === '\u200d' || current.endsWith('\u200d')) return true;
  return isRegionalIndicator(next) && regionalCount === 1;
}

function isPositionExtender(value: string): boolean {
  return /\p{M}/u.test(value) || /\p{Emoji_Modifier}/u.test(value) || isVariationSelector(value) || isEmojiTag(value);
}

function isRegionalIndicator(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function isVariationSelector(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
}

function isEmojiTag(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return codePoint >= 0xe0020 && codePoint <= 0xe007f;
}

function expandReplacement(replacement: string, text: string, match: PatternMatch): string {
  const chunks: string[] = [];
  for (let index = 0; index < replacement.length; index += 1) {
    const char = replacement[index];
    if (char === '&') {
      chunks.push(text.slice(match.start as number, match.end as number));
      continue;
    }
    if (char !== '\\') {
      if (char !== undefined) chunks.push(char);
      continue;
    }
    const escaped = replacement[index + 1];
    if (escaped === undefined) throw new PatternEvaluationError('invalid-pattern', 'trailing-replacement-backslash', 0);
    index += 1;
    if (escaped === '&') chunks.push('&');
    else if (escaped === '\\') chunks.push('\\');
    else if (escaped === 'r') chunks.push('\n');
    else if (escaped >= '0' && escaped <= '9') {
      if (escaped === '0') chunks.push(text.slice(match.start as number, match.end as number));
      else {
        const capture = match.captures.get(Number(escaped));
        if (capture !== undefined) chunks.push(text.slice(capture.start as number, capture.end as number));
      }
    } else {
      throw new PatternEvaluationError('unsupported-construct', `unsupported-replacement-escape: \\${escaped}`, 0);
    }
  }
  return chunks.join('');
}

function* visit(context: EvaluationContext, source: SourceSpan): Generator<void, void, void> {
  context.budget.tick(source);
  yield;
}

class StepBudget {
  steps = 0;

  constructor(private readonly program: PatternProgram, private readonly isCancelled: () => boolean) {}

  tick(source: SourceSpan): void {
    this.steps += 1;
    if (this.steps > this.program.stepBudget) {
      throw new PatternEvaluationError('step-budget-exceeded', `pattern-step-budget-exceeded: ${this.program.stepBudget}`, this.steps, source);
    }
    if (this.isCancelled() || (this.steps % this.program.cancellationCheckInterval === 0 && this.program.shouldCancel?.() === true)) {
      throw new PatternEvaluationError('cancelled', `pattern-evaluation-cancelled-after-${this.steps}-steps`, this.steps, source);
    }
  }
}

function* classMatches(
  parts: readonly CharacterClassPart[],
  codePoint: number,
  oldEngineIgnoreCase: boolean,
  context: EvaluationContext,
  source: SourceSpan,
): Generator<void, boolean, void> {
  for (const part of parts) {
    let matches = false;
    if (part.kind === 'literal') {
      const value = part.value.codePointAt(0);
      matches = value === codePoint;
    } else if (part.kind === 'range') {
      matches = codePoint >= part.first && codePoint <= part.last;
    } else {
      matches = yield* classNameMatches(part.name, codePoint, oldEngineIgnoreCase, context, source);
      if (part.negated === true) matches = !matches;
    }
    if (matches) return true;
  }
  return false;
}

function* classNameMatches(
  name: CharacterClassName,
  codePoint: number,
  oldEngineIgnoreCase: boolean,
  context: EvaluationContext,
  source: SourceSpan,
): Generator<void, boolean, void> {
  const asciiAlpha = (codePoint >= 65 && codePoint <= 90) || (codePoint >= 97 && codePoint <= 122);
  const asciiDigit = codePoint >= 48 && codePoint <= 57;
  const asciiControl = codePoint <= 31 || codePoint === 127;
  switch (name) {
    case 'digit': return asciiDigit;
    case 'word': return isWordCodePoint(codePoint);
    case 'space': return codePoint === 32 || codePoint === 9;
    case 'posix-space': return codePoint === 32 || codePoint === 9 || codePoint === 10 || codePoint === 13 || codePoint === 11 || codePoint === 12;
    case 'hex': return asciiDigit || (codePoint >= 65 && codePoint <= 70) || (codePoint >= 97 && codePoint <= 102);
    case 'octal': return codePoint >= 48 && codePoint <= 55;
    case 'head': return asciiAlpha || codePoint === 95;
    case 'alpha': return asciiAlpha;
    case 'lower': return oldEngineIgnoreCase ? asciiAlpha : codePoint >= 97 && codePoint <= 122;
    case 'upper': return oldEngineIgnoreCase ? asciiAlpha : codePoint >= 65 && codePoint <= 90;
    case 'identifier': return yield* optionClassMatches('identifier', codePoint, context, source);
    case 'identifier-no-digit': return (yield* optionClassMatches('identifier', codePoint, context, source)) && !asciiDigit;
    case 'keyword': return codePoint >= 256 ? isWideKeywordCharacter(codePoint) : yield* optionClassMatches('keyword', codePoint, context, source);
    case 'keyword-no-digit': return (codePoint >= 256 ? isWideKeywordCharacter(codePoint) : yield* optionClassMatches('keyword', codePoint, context, source)) && !asciiDigit;
    case 'filename': return yield* optionClassMatches('filename', codePoint, context, source);
    case 'filename-no-digit': return (yield* optionClassMatches('filename', codePoint, context, source)) && !asciiDigit;
    case 'printable': return yield* optionClassMatches('printable', codePoint, context, source);
    case 'printable-no-digit': return (yield* optionClassMatches('printable', codePoint, context, source)) && !asciiDigit;
    case 'posix-lower':
      return context.program.engineSelector === 1
        ? (oldEngineIgnoreCase ? asciiAlpha : codePoint >= 97 && codePoint <= 122)
        : isUnicodeLowercaseLetter(codePoint);
    case 'posix-upper':
      return context.program.engineSelector === 1
        ? (oldEngineIgnoreCase ? asciiAlpha : codePoint >= 65 && codePoint <= 90)
        : isUnicodeUppercaseLetter(codePoint);
    case 'alnum': return asciiAlpha || asciiDigit;
    case 'blank': return codePoint === 32 || codePoint === 9;
    case 'control': return asciiControl;
    case 'graph': return codePoint >= 33 && codePoint <= 126;
    case 'punctuation': return (codePoint >= 33 && codePoint <= 47) || (codePoint >= 58 && codePoint <= 64) || (codePoint >= 91 && codePoint <= 96) || (codePoint >= 123 && codePoint <= 126);
    case 'xdigit': return asciiDigit || (codePoint >= 65 && codePoint <= 70) || (codePoint >= 97 && codePoint <= 102);
    case 'return': return codePoint === 13;
    case 'tab': return codePoint === 9;
    case 'escape': return codePoint === 27;
    case 'backspace': return codePoint === 8;
    default: return unreachable(name);
  }
}

function* optionClassMatches(
  name: 'identifier' | 'keyword' | 'filename' | 'printable',
  codePoint: number,
  context: EvaluationContext,
  source: SourceSpan,
): Generator<void, boolean, void> {
  if (name === 'identifier' && codePoint >= 256) return false;
  if (name === 'keyword' && codePoint >= 256) return isWideKeywordCharacter(codePoint);
  if (name === 'filename' && codePoint >= 256) return true;
  if (name === 'printable' && (codePoint >= 256 || (codePoint >= 32 && codePoint <= 126))) return true;

  let matched = (name === 'filename' || name === 'printable') && codePoint >= 160 && codePoint <= 255;
  const rules = optionRulesFor(name, context.characterClasses);
  for (const rule of rules) {
    yield* visit(context, source);
    if (matchesOptionRule(rule, codePoint)) matched = rule.include;
  }
  return name === 'printable' && codePoint >= 32 && codePoint <= 126 ? true : matched;
}

function caseInsensitive(mode: 'option' | 'sensitive' | 'insensitive', program: PatternProgram): boolean {
  return mode === 'insensitive' || (mode === 'option' && program.defaultIgnoreCase);
}

function equalText(left: string, right: string, ignoreCase: boolean): boolean {
  return ignoreCase ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isWordAt(text: PatternTextAccess, position: number): boolean {
  const codePoint = text.codePointAt(position);
  return codePoint !== undefined && isWordCodePoint(codePoint);
}

function isWordBefore(text: PatternTextAccess, position: number): boolean {
  if (position <= 0) return false;
  let before = position - 1;
  const last = text.charCodeAt(before);
  if (last >= 0xdc00 && last <= 0xdfff && before > 0) before -= 1;
  const codePoint = text.codePointAt(before);
  return codePoint !== undefined && isWordCodePoint(codePoint);
}

function isWordCodePoint(codePoint: number): boolean {
  return (codePoint >= 48 && codePoint <= 57) || (codePoint >= 65 && codePoint <= 90) || (codePoint >= 97 && codePoint <= 122) || codePoint === 95;
}

function lineIndexAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = starts[middle];
    if (value !== undefined && value <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function lineIndex(value: number): LineIndex {
  return value as LineIndex;
}

function validatePositionVersions(program: PatternProgram, snapshot: PatternTextSnapshot): void {
  if (program.characterClassContext !== undefined && program.characterClassContext.version !== snapshot.version) {
    const source = firstCharacterClassSource(program.root) ?? program.root.source;
    throw new PatternEvaluationError('stale-position', 'pattern-character-class-context-version-does-not-match-snapshot', 0, source);
  }
  if (!program.features.containsPositionAtom) return;
  const source = firstPositionSource(program.root) ?? program.root.source;
  if (program.positionContext !== undefined && program.positionContext.version !== snapshot.version) {
    throw new PatternEvaluationError('stale-position', 'pattern-position-context-version-does-not-match-snapshot', 0, source);
  }
  if (program.cursor !== undefined && program.cursor.version !== snapshot.version) {
    throw new PatternEvaluationError('stale-position', 'pattern-cursor-version-does-not-match-snapshot', 0, source);
  }
}

function firstCharacterClassSource(root: PatternNode): SourceSpan | undefined {
  const pending: PatternNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    if (node.kind === 'character-class') return node.source;
    switch (node.kind) {
      case 'sequence': pending.push(...node.terms); break;
      case 'alternate': pending.push(...node.branches); break;
      case 'intersection': pending.push(...node.concats); break;
      case 'optional-sequence': pending.push(...node.atoms); break;
      case 'capture':
      case 'repeat':
      case 'assertion': pending.push(node.child); break;
      default: break;
    }
  }
  return undefined;
}

function validatePositionOffsets(program: PatternProgram, snapshot: PatternTextSnapshot): void {
  if (!program.features.containsPositionAtom) return;
  const source = firstPositionSource(program.root) ?? program.root.source;
  const context = program.positionContext;
  const text = createTextAccess(snapshot);
  const validateOffset = (offset: number, label: string): void => {
    if (!isSafeUtf16Boundary(text, offset)) {
      throw new PatternEvaluationError('invalid-pattern', `pattern-${label}-is-not-a-safe-snapshot-utf16-boundary`, 0, source);
    }
  };
  if (context?.cursor !== undefined) validateOffset(context.cursor as number, 'cursor-position');
  if (context?.marks !== undefined) {
    for (const [name, offset] of Object.entries(context.marks)) validateOffset(offset as number, `mark-${name}-position`);
  }
  if (program.cursor !== undefined) validateOffset(program.cursor.offset as number, 'cursor-position');
  const area = context?.visualArea;
  if (area?.kind === 'characterwise') {
    validateOffset(area.start as number, 'visual-start-position');
    validateOffset(area.end as number, 'visual-end-position');
  }
  if (area !== undefined && area.kind !== 'characterwise' && snapshot.lineCount !== undefined
    && (area.lastLine as number) >= snapshot.lineCount) {
    throw new PatternEvaluationError('invalid-pattern', 'pattern-visual-area-exceeds-snapshot-line-count', 0, source);
  }
}

function firstPositionSource(root: PatternNode): SourceSpan | undefined {
  const pending: PatternNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) continue;
    if (node.kind === 'anchor' && (node.anchor === 'cursor' || node.anchor === 'line-number'
      || node.anchor === 'position' || node.anchor === 'mark' || node.anchor === 'visual-area')) return node.source;
    switch (node.kind) {
      case 'sequence': pending.push(...node.terms); break;
      case 'alternate': pending.push(...node.branches); break;
      case 'intersection': pending.push(...node.concats); break;
      case 'optional-sequence': pending.push(...node.atoms); break;
      case 'capture':
      case 'repeat':
      case 'assertion': pending.push(node.child); break;
      default: break;
    }
  }
  return undefined;
}

interface LookbehindCandidate {
  readonly position: number;
  readonly currentLineBytes: number;
  readonly previousLineBytes: number;
}

function* precedingBoundaries(
  context: EvaluationContext,
  end: number,
  lowerBound: number,
  currentLineStart: number,
  source: SourceSpan,
): Generator<void, LookbehindCandidate[], void> {
  const reversed: LookbehindCandidate[] = [];
  let position = end;
  let currentLineBytes = 0;
  let previousLineBytes = 0;
  reversed.push({ position, currentLineBytes, previousLineBytes });
  while (position > lowerBound) {
    yield* visit(context, source);
    const previous = previousCodePointStart(context.text, position);
    if (previous < lowerBound) break;
    const codePoint = context.text.codePointAt(previous);
    if (codePoint === undefined) break;
    const width = utf8Width(codePoint);
    currentLineBytes += width;
    position = previous;
    if (position < currentLineStart && position !== currentLineStart - 1) previousLineBytes += width;
    reversed.push({ position, currentLineBytes, previousLineBytes });
  }
  return reversed.reverse();
}

function* lookbehindBounds(
  context: EvaluationContext,
  position: number,
  source: SourceSpan,
): Generator<void, { readonly lowerBound: number; readonly currentLineStart: number }, void> {
  let currentLineStart = position;
  while (currentLineStart > 0 && context.text.charCodeAt(currentLineStart - 1) !== 10) {
    yield* visit(context, source);
    currentLineStart = previousCodePointStart(context.text, currentLineStart);
  }
  if (currentLineStart === 0) return { lowerBound: 0, currentLineStart };

  let lowerBound = currentLineStart - 1;
  while (lowerBound > 0 && context.text.charCodeAt(lowerBound - 1) !== 10) {
    yield* visit(context, source);
    lowerBound = previousCodePointStart(context.text, lowerBound);
  }
  return { lowerBound, currentLineStart };
}

function utf8Width(codePoint: number): number {
  return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
}

function previousCodePointStart(text: PatternTextAccess, position: number): number {
  let result = position - 1;
  const last = text.charCodeAt(result);
  if (last >= 0xdc00 && last <= 0xdfff && result > 0) result -= 1;
  return result;
}

function codePointWidthAt(text: PatternTextAccess, position: number): number {
  if (position >= text.length) return 0;
  const codePoint = text.codePointAt(position);
  return codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
}

function isCombiningCodePoint(codePoint: number): boolean {
  return /^\p{M}$/u.test(String.fromCodePoint(codePoint));
}

interface ComposingSuffix {
  readonly marks: readonly string[];
  readonly end: number;
}

function* followingComposing(
  context: EvaluationContext,
  position: number,
  source: SourceSpan,
): Generator<void, ComposingSuffix, void> {
  const marks: string[] = [];
  let end = position;
  while (end < context.text.length) {
    const codePoint = context.text.codePointAt(end);
    if (codePoint === undefined || !isCombiningCodePoint(codePoint)) break;
    yield* visit(context, source);
    marks.push(String.fromCodePoint(codePoint));
    end += codePointWidthAt(context.text, end);
  }
  return { marks, end };
}

function* vimCharacterEnd(
  context: EvaluationContext,
  position: number,
  source: SourceSpan,
): Generator<void, number, void> {
  const width = codePointWidthAt(context.text, position);
  if (width === 0) return position;
  const codePoint = context.text.codePointAt(position);
  if (codePoint === undefined || isCombiningCodePoint(codePoint)) return position + width;
  const suffix = yield* followingComposing(context, position + width, source);
  return suffix.end;
}

function* advanceVimCharacter(
  context: EvaluationContext,
  position: number,
  source: SourceSpan,
): Generator<void, number, void> {
  const width = codePointWidthAt(context.text, position);
  if (width === 0) return context.text.length + 1;
  const codePoint = context.text.codePointAt(position);
  if (codePoint === undefined || !isCombiningCodePoint(codePoint)) {
    return yield* vimCharacterEnd(context, position, source);
  }
  const attached = yield* isAttachedComposing(context, position, source);
  if (!attached) return position + width;
  return (yield* followingComposing(context, position, source)).end;
}

function* isAttachedComposing(
  context: EvaluationContext,
  position: number,
  source: SourceSpan,
): Generator<void, boolean, void> {
  let previous = position;
  while (previous > 0) {
    previous = previousCodePointStart(context.text, previous);
    const codePoint = context.text.codePointAt(previous);
    if (codePoint === undefined || codePoint === 10) return false;
    yield* visit(context, source);
    if (!isCombiningCodePoint(codePoint)) return true;
  }
  return false;
}

function isAttachedComposingAt(text: PatternTextAccess, position: number): boolean {
  const codePoint = text.codePointAt(position);
  if (codePoint === undefined || !isCombiningCodePoint(codePoint) || position === 0) return false;
  const previous = previousCodePointStart(text, position);
  const before = text.codePointAt(previous);
  return before !== undefined && before !== 10 && !isCombiningCodePoint(before);
}

function classCombiningLiterals(parts: readonly CharacterClassPart[]): string[] {
  const result: string[] = [];
  for (const part of parts) {
    if (part.kind !== 'literal') continue;
    for (const scalar of part.value) if (isCombiningCodePoint(scalar.codePointAt(0) ?? -1)) result.push(scalar);
  }
  return result;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function* containsComposingMarks(
  available: readonly string[],
  required: readonly string[],
  context: EvaluationContext,
  source: SourceSpan,
): Generator<void, boolean, void> {
  const remaining = [...available];
  for (const mark of required) {
    yield* visit(context, source);
    const index = remaining.indexOf(mark);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

function* consumeFollowingComposing(
  context: EvaluationContext,
  position: number,
  source: SourceSpan,
): Generator<void, number, void> {
  return (yield* followingComposing(context, position, source)).end;
}

function* matchLeadingComposing(
  context: EvaluationContext,
  position: number,
  required: string,
  source: SourceSpan,
): Generator<void, number | undefined, void> {
  const base = context.text.codePointAt(position);
  if (base === undefined) return undefined;
  if (isCombiningCodePoint(base)) {
    if (context.program.engineSelector !== 1) return undefined;
    const standaloneMarks = yield* followingComposing(context, position, source);
    return (yield* containsComposingMarks(standaloneMarks.marks, [...required], context, source))
      ? standaloneMarks.end
      : undefined;
  }
  let end = position + codePointWidthAt(context.text, position);
  const available: string[] = [];
  while (end < context.text.length) {
    const codePoint = context.text.codePointAt(end);
    if (codePoint === undefined || !isCombiningCodePoint(codePoint)) break;
    yield* visit(context, source);
    available.push(String.fromCodePoint(codePoint));
    end += codePointWidthAt(context.text, end);
  }
  for (const mark of required) {
    yield* visit(context, source);
    const index = available.indexOf(mark);
    if (index < 0) return undefined;
    available.splice(index, 1);
  }
  return end;
}

function isCombiningSequence(value: string): boolean {
  return value.length > 0 && [...value].every(isCombiningCodePointScalar);
}

function isCombiningCodePointScalar(value: string): boolean {
  return /^\p{M}$/u.test(value);
}


function isEndOfLine(text: PatternTextAccess, position: number): boolean {
  return position === text.length || text.charCodeAt(position) === 10;
}

function createTextAccess(snapshot: PatternTextSnapshot): PatternTextAccess {
  const length = snapshot.lengthUtf16 ?? snapshot.text.length;
  const materialized = snapshot.text.length === length ? snapshot.text : undefined;
  const reader = snapshot.read;
  const windowSize = 64 * 1024;
  let windowStart = -1;
  let windowText = '';
  const rawRead = (start: number, end: number): string => {
    if (materialized !== undefined) return materialized.slice(start, end);
    if (reader === undefined) throw new PatternEvaluationError('invalid-pattern', 'pattern-text-reader-missing', 0);
    const result = reader(utf16Offset(start), utf16Offset(end));
    if (!result.ok) throw new PatternEvaluationError('invalid-pattern', `pattern-text-read-failed: ${result.error.kind}`, 0);
    return result.value;
  };
  const loadWindow = (position: number): void => {
    if (materialized !== undefined || (position >= windowStart && position < windowStart + windowText.length)) return;
    let start = Math.floor(position / windowSize) * windowSize;
    let end = Math.min(length, start + windowSize);
    while (start < end) {
      try {
        windowText = rawRead(start, end);
        windowStart = start;
        return;
      } catch (error: unknown) {
        if (!(error instanceof PatternEvaluationError) || !error.message.includes('surrogate-split')) throw error;
        if (end - start > 1 && end < length) {
          end -= 1;
          continue;
        }
        if (start > 0) {
          start -= 1;
          continue;
        }
        throw error;
      }
    }
    throw new PatternEvaluationError('invalid-pattern', 'pattern-text-window-could-not-open', 0);
  };
  const read = (start: number, end: number): string => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > length) {
      throw new PatternEvaluationError('invalid-pattern', `pattern-text-range-invalid: ${start}..${end}`, 0);
    }
    if (start === end) return '';
    if (materialized !== undefined) return materialized.slice(start, end);
    loadWindow(start);
    if (start >= windowStart && end <= windowStart + windowText.length) return windowText.slice(start - windowStart, end - windowStart);
    return rawRead(start, end);
  };
  const unitAt = (position: number): number => {
    if (!Number.isSafeInteger(position) || position < 0 || position >= length) return Number.NaN;
    if (materialized === undefined) {
      loadWindow(position);
      const local = position - windowStart;
      if (local >= 0 && local < windowText.length) return windowText.charCodeAt(local);
    }
    try {
      const one = read(position, position + 1);
      if (one.length > 0) return one.charCodeAt(0);
    } catch (error: unknown) {
      if (!(error instanceof PatternEvaluationError)) throw error;
      if (position + 2 <= length) {
        try {
          const pair = read(position, position + 2);
          if (pair.length === 2) return pair.charCodeAt(0);
        } catch {
          // The requested unit may be the low half of a surrogate pair.
        }
      }
      if (position > 0) {
        const pair = read(position - 1, position + 1);
        if (pair.length === 2) return pair.charCodeAt(1);
      }
      throw error;
    }
    return Number.NaN;
  };
  const indexOfUnit = (codeUnit: number, fromIndex: number, toIndex: number): number => {
    const needle = String.fromCharCode(codeUnit);
    const end = Math.min(toIndex, length);
    if (materialized !== undefined) {
      const found = materialized.indexOf(needle, fromIndex);
      return found !== -1 && found < end ? found : -1;
    }
    let position = Math.max(0, fromIndex);
    while (position < end) {
      loadWindow(position);
      const local = position - windowStart;
      const localEnd = Math.min(windowText.length, end - windowStart);
      const found = windowText.indexOf(needle, local);
      if (found !== -1 && found < localEnd) return windowStart + found;
      position = windowStart + windowText.length;
    }
    return -1;
  };
  return {
    length,
    slice: read,
    charCodeAt: unitAt,
    codePointAt: (position: number): number | undefined => {
      const first = unitAt(position);
      if (!Number.isFinite(first)) return undefined;
      if (first >= 0xd800 && first <= 0xdbff && position + 1 < length) {
        const second = unitAt(position + 1);
        if (second >= 0xdc00 && second <= 0xdfff) return (first - 0xd800) * 0x400 + second - 0xdc00 + 0x10000;
      }
      return first;
    },
    indexOfUnit,
  };
}

function materializePatternText(snapshot: PatternTextSnapshot): string {
  const length = snapshot.lengthUtf16 ?? snapshot.text.length;
  if (snapshot.text.length === length) return snapshot.text;
  return createTextAccess(snapshot).slice(0, length);
}

function validateSnapshot(snapshot: PatternTextSnapshot): void {
  if (typeof snapshot !== 'object' || snapshot === null || typeof snapshot.text !== 'string') {
    throw new TypeError('pattern-snapshot-must-contain-immutable-text-and-version');
  }
  const length = snapshot.lengthUtf16 ?? snapshot.text.length;
  if (!Number.isSafeInteger(length) || length < 0 || (snapshot.read === undefined && snapshot.text.length !== length)) {
    throw new TypeError('pattern-snapshot-length-and-reader-are-invalid');
  }
  if (snapshot.read !== undefined && typeof snapshot.read !== 'function') {
    throw new TypeError('pattern-snapshot-reader-must-be-a-function');
  }
  if (snapshot.lineIndexAt !== undefined && typeof snapshot.lineIndexAt !== 'function') {
    throw new TypeError('pattern-snapshot-line-index-must-be-a-document-reader-function');
  }
  if (!Number.isSafeInteger(snapshot.version as number) || (snapshot.version as number) < 0) {
    throw new TypeError('pattern-snapshot-version-must-be-a-nonnegative-safe-integer');
  }
}

function isSafeUtf16Boundary(text: PatternTextAccess, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return false;
  if (offset === 0 || offset === text.length) return true;
  const left = text.charCodeAt(offset - 1);
  const right = text.charCodeAt(offset);
  return !(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff);
}

function freezeResult(version: PatternTextSnapshot['version'], result: InternalResult): PatternEvaluationResult {
  const matches = result.matches.map((match): PatternMatch => {
    const captures: [number, CaptureSpan][] = [...match.captures].map(([group, capture]) => [group, Object.freeze({ start: utf16Offset(capture.start), end: utf16Offset(capture.end) })]);
    return Object.freeze({
      start: utf16Offset(match.start),
      end: utf16Offset(match.end),
      consumedStart: utf16Offset(match.consumedStart),
      consumedEnd: utf16Offset(match.consumedEnd),
      captures: new ImmutableMap(captures),
    });
  });
  return Object.freeze({ snapshotVersion: version, matches: Object.freeze(matches), steps: result.steps, engine: result.engine });
}

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(entries: readonly (readonly [K, V])[]) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }

  get size(): number { return this.#values.size; }
  get(key: K): V | undefined { return this.#values.get(key); }
  has(key: K): boolean { return this.#values.has(key); }
  entries(): MapIterator<[K, V]> { return this.#values.entries(); }
  keys(): MapIterator<K> { return this.#values.keys(); }
  values(): MapIterator<V> { return this.#values.values(); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#values[Symbol.iterator](); }
  get [Symbol.toStringTag](): string { return 'ImmutableMap'; }
}

function unreachable(value: never): never {
  throw new Error(`unreachable-pattern-node: ${String(value)}`);
}

function utf16Offset(value: number): Utf16Offset {
  return value as Utf16Offset;
}
