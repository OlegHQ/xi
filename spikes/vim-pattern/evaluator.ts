import {
  PatternEvaluationError,
  type CaptureSpan,
  type CharacterClassPart,
  type PatternMatch,
  type PatternNode,
  type PatternProgram,
  type SourceSpan,
} from './types';

interface EvaluationState {
  readonly position: number;
  readonly captures: ReadonlyMap<number, CaptureSpan>;
  readonly reportedStart: number | null;
  readonly reportedEnd: number | null;
}

interface RepeatState {
  readonly state: EvaluationState;
  readonly stalled: boolean;
}

interface EvaluationContext {
  readonly program: PatternProgram;
  readonly text: string;
  readonly lineStarts: readonly number[];
  readonly budget: StepBudget;
}

export function findAllMatches(program: PatternProgram, text: string): readonly PatternMatch[] {
  return findMatchesWithStats(program, text).matches;
}

function findMatchesWithStats(program: PatternProgram, text: string): {
  readonly matches: readonly PatternMatch[];
  readonly steps: number;
} {
  const context: EvaluationContext = {
    program,
    text,
    lineStarts: collectLineStarts(text),
    budget: new StepBudget(program),
  };
  const matches: PatternMatch[] = [];
  let offset = 0;
  while (offset <= text.length) {
    context.budget.tick({ start: 0, end: 0 });
    const initial: EvaluationState = { position: offset, captures: new Map(), reportedStart: null, reportedEnd: null };
    const states = evaluate(program.root, initial, context);
    const matchState = states[0];
    if (matchState === undefined) {
      offset = advanceCodePoint(text, offset);
      continue;
    }
    const start = matchState.reportedStart ?? offset;
    const end = matchState.reportedEnd ?? matchState.position;
    if (start < 0 || end < start || end > text.length) {
      throw new PatternEvaluationError('invalid-pattern', `invalid-reported-match-range: ${start}..${end}`, context.budget.steps);
    }
    const zeroWidth = start === end && matchState.position === offset;
    const endOfLineBoundary = isEndOfLine(text, offset);
    const shouldSkipTerminalEmpty = zeroWidth && endOfLineBoundary && !program.features.containsLineBoundary;
    if (!shouldSkipTerminalEmpty) {
      if (matches.length >= program.outputLimit) {
        throw new PatternEvaluationError('output-limit-exceeded', `pattern-output-limit-exceeded: ${program.outputLimit}`, context.budget.steps);
      }
      matches.push({
        start,
        end,
        consumedStart: offset,
        consumedEnd: matchState.position,
        captures: matchState.captures,
      });
    }
    offset = matchState.position > offset ? matchState.position : advanceCodePoint(text, offset);
  }
  return { matches, steps: context.budget.steps };
}

export function substituteAll(program: PatternProgram, text: string, replacement: string): {
  readonly text: string;
  readonly matches: readonly PatternMatch[];
  readonly steps: number;
} {
  const evaluated = findMatchesWithStats(program, text);
  const matches = evaluated.matches;
  const output: string[] = [];
  let previousEnd = 0;
  for (const match of matches) {
    if (match.start < previousEnd) continue;
    output.push(text.slice(previousEnd, match.start));
    output.push(expandReplacement(replacement, text, match));
    previousEnd = match.end;
  }
  output.push(text.slice(previousEnd));
  return { text: output.join(''), matches, steps: evaluated.steps };
}

export function evaluateWithStats(program: PatternProgram, text: string): {
  readonly matches: readonly PatternMatch[];
  readonly steps: number;
} {
  return findMatchesWithStats(program, text);
}

function evaluate(node: PatternNode, state: EvaluationState, context: EvaluationContext): EvaluationState[] {
  context.budget.tick(node.source);
  switch (node.kind) {
    case 'empty':
      return [state];
    case 'literal': {
      const width = codePointWidthAt(context.text, state.position);
      if (width === 0) return [];
      const observed = context.text.slice(state.position, state.position + width);
      return equalText(observed, node.value, caseInsensitive(node.caseMode, context.program))
        ? [{ ...state, position: state.position + width }]
        : [];
    }
    case 'dot': {
      const width = codePointWidthAt(context.text, state.position);
      if (width === 0) return [];
      const codePoint = context.text.codePointAt(state.position);
      if (codePoint === undefined || (!node.includeNewline && codePoint === 10)) return [];
      return [{ ...state, position: state.position + width }];
    }
    case 'character-class': {
      const width = codePointWidthAt(context.text, state.position);
      if (width === 0) return [];
      const codePoint = context.text.codePointAt(state.position);
      if (codePoint === undefined) return [];
      const classResult = classMatches(node.parts, codePoint, node.caseMode, context.program);
      const matches = node.includeNewline && codePoint === 10 ? true : (node.negated ? !classResult : classResult);
      return matches ? [{ ...state, position: state.position + width }] : [];
    }
    case 'sequence': {
      let states = [state];
      for (const term of node.terms) {
        const next: EvaluationState[] = [];
        for (const current of states) next.push(...evaluate(term, current, context));
        states = next;
        if (states.length === 0) break;
      }
      return states;
    }
    case 'alternate': {
      const results: EvaluationState[] = [];
      for (const branch of node.branches) results.push(...evaluate(branch, state, context));
      return results;
    }
    case 'capture': {
      const results = evaluate(node.child, state, context);
      return results.map((result) => {
        const captures = new Map(result.captures);
        captures.set(node.group, { start: state.position, end: result.position });
        return { ...result, captures };
      });
    }
    case 'repeat':
      return evaluateRepeat(node, state, context);
    case 'backreference': {
      const capture = state.captures.get(node.group);
      if (capture === undefined) return [];
      const capturedText = context.text.slice(capture.start, capture.end);
      const observed = context.text.slice(state.position, state.position + capturedText.length);
      if (!equalText(observed, capturedText, caseInsensitive(node.caseMode, context.program))) return [];
      return [{ ...state, position: state.position + capturedText.length }];
    }
    case 'assertion':
      return evaluateAssertion(node.assertion, node.child, state, context);
    case 'set-start':
      return [{ ...state, reportedStart: state.position }];
    case 'set-end':
      return [{ ...state, reportedEnd: state.position }];
    case 'anchor':
      return anchorMatches(node, state.position, context) ? [state] : [];
    default:
      return unreachable(node);
  }
}

function evaluateRepeat(node: Extract<PatternNode, { kind: 'repeat' }>, state: EvaluationState, context: EvaluationContext): EvaluationState[] {
  const maximum = node.maximum ?? (context.text.length - state.position + node.minimum + 1);
  const levels: { readonly count: number; readonly states: readonly EvaluationState[] }[] = [{ count: 0, states: [state] }];
  let layer: RepeatState[] = [{ state, stalled: false }];
  for (let count = 1; count <= maximum; count += 1) {
    const next: RepeatState[] = [];
    for (const previous of layer) {
      if (previous.stalled) {
        if (count < node.minimum) next.push({ state: previous.state, stalled: true });
        continue;
      }
      for (const result of evaluate(node.child, previous.state, context)) {
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

function evaluateAssertion(
  assertion: Extract<PatternNode, { kind: 'assertion' }>['assertion'],
  child: PatternNode,
  state: EvaluationState,
  context: EvaluationContext,
): EvaluationState[] {
  if (assertion === 'ahead-positive' || assertion === 'ahead-negative') {
    const results = evaluate(child, state, context);
    if (assertion === 'ahead-positive') {
      return results.map((result) => ({ ...result, position: state.position, reportedStart: state.reportedStart, reportedEnd: state.reportedEnd }));
    }
    return results.length === 0 ? [state] : [];
  }

  const width = measureWidth(child);
  if (width.maximum === null || width.maximum > 1024) {
    throw new PatternEvaluationError('unsupported-construct', 'variable-or-large-lookbehind-width', context.budget.steps, child.source);
  }
  const candidateStarts = precedingBoundaries(context.text, state.position, width.maximum);
  let found: EvaluationState[] = [];
  for (const candidate of candidateStarts) {
    const initial = { ...state, position: candidate, reportedStart: null, reportedEnd: null };
    const results = evaluate(child, initial, context).filter((result) => result.position === state.position);
    if (results.length > 0) found = [...found, ...results];
  }
  if (assertion === 'behind-positive') {
    return found.map((result) => ({ ...result, position: state.position, reportedStart: state.reportedStart, reportedEnd: state.reportedEnd }));
  }
  return found.length === 0 ? [state] : [];
}

function anchorMatches(node: Extract<PatternNode, { kind: 'anchor' }>, position: number, context: EvaluationContext): boolean {
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
      return context.program.cursorOffset === position;
    case 'line-number':
      return node.expected === lineIndexAt(context.lineStarts, position) + 1;
    default:
      return unreachable(node.anchor);
  }
}

function expandReplacement(replacement: string, text: string, match: PatternMatch): string {
  const chunks: string[] = [];
  for (let index = 0; index < replacement.length; index += 1) {
    const char = replacement[index];
    if (char === '&') {
      chunks.push(text.slice(match.start, match.end));
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
      if (escaped === '0') chunks.push(text.slice(match.start, match.end));
      else {
        const capture = match.captures.get(Number(escaped));
        if (capture !== undefined) chunks.push(text.slice(capture.start, capture.end));
      }
    } else {
      throw new PatternEvaluationError('unsupported-construct', `unsupported-replacement-escape: \\${escaped}`, 0);
    }
  }
  return chunks.join('');
}

class StepBudget {
  steps = 0;

  constructor(private readonly program: PatternProgram) {}

  tick(source: SourceSpan): void {
    this.steps += 1;
    if (this.steps > this.program.stepBudget) {
      throw new PatternEvaluationError('step-budget-exceeded', `pattern-step-budget-exceeded: ${this.program.stepBudget}`, this.steps, source);
    }
    if (this.steps % this.program.cancellationCheckInterval === 0 && this.program.shouldCancel?.() === true) {
      throw new PatternEvaluationError('cancelled', `pattern-evaluation-cancelled-after-${this.steps}-steps`, this.steps, source);
    }
  }
}

function classMatches(parts: readonly CharacterClassPart[], codePoint: number, caseMode: 'option' | 'sensitive' | 'insensitive', program: PatternProgram): boolean {
  for (const part of parts) {
    let matches = false;
    if (part.kind === 'literal') {
      const value = part.value.codePointAt(0);
      matches = value === codePoint || (caseInsensitive(caseMode, program) && equalText(String.fromCodePoint(codePoint), part.value, true));
    } else if (part.kind === 'range') {
      const point = caseInsensitive(caseMode, program) ? simpleFoldCodePoint(codePoint) : codePoint;
      const first = caseInsensitive(caseMode, program) ? simpleFoldCodePoint(part.first) : part.first;
      const last = caseInsensitive(caseMode, program) ? simpleFoldCodePoint(part.last) : part.last;
      matches = point >= first && point <= last;
    } else {
      matches = classNameMatches(part.name, codePoint);
      if (part.negated === true) matches = !matches;
    }
    if (matches) return true;
  }
  return false;
}

function classNameMatches(name: 'digit' | 'word' | 'space', codePoint: number): boolean {
  if (name === 'digit') return codePoint >= 48 && codePoint <= 57;
  if (name === 'word') return isWordCodePoint(codePoint);
  return codePoint === 32 || codePoint === 9;
}

function caseInsensitive(mode: 'option' | 'sensitive' | 'insensitive', program: PatternProgram): boolean {
  return mode === 'insensitive' || (mode === 'option' && program.initialCaseMode === 'insensitive');
}

function equalText(left: string, right: string, ignoreCase: boolean): boolean {
  return ignoreCase ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function simpleFoldCodePoint(codePoint: number): number {
  const folded = String.fromCodePoint(codePoint).toLowerCase().codePointAt(0);
  return folded ?? codePoint;
}

function isWordAt(text: string, position: number): boolean {
  const codePoint = text.codePointAt(position);
  return codePoint !== undefined && isWordCodePoint(codePoint);
}

function isWordBefore(text: string, position: number): boolean {
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

function collectLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) starts.push(index + 1);
  return starts;
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

function measureWidth(node: PatternNode): { readonly minimum: number; readonly maximum: number | null } {
  switch (node.kind) {
    case 'empty':
    case 'anchor':
    case 'set-start':
    case 'set-end':
      return { minimum: 0, maximum: 0 };
    case 'literal':
      return { minimum: node.value.length, maximum: node.value.length };
    case 'dot':
    case 'character-class':
      return { minimum: 1, maximum: 2 };
    case 'backreference':
      return { minimum: 0, maximum: null };
    case 'capture':
      return measureWidth(node.child);
    case 'assertion':
      return { minimum: 0, maximum: 0 };
    case 'sequence': {
      let minimum = 0;
      let maximum: number | null = 0;
      for (const term of node.terms) {
        const width = measureWidth(term);
        minimum += width.minimum;
        maximum = maximum === null || width.maximum === null ? null : maximum + width.maximum;
      }
      return { minimum, maximum };
    }
    case 'alternate': {
      const widths = node.branches.map(measureWidth);
      return {
        minimum: Math.min(...widths.map((width) => width.minimum)),
        maximum: widths.some((width) => width.maximum === null) ? null : Math.max(0, ...widths.map((width) => width.maximum ?? 0)),
      };
    }
    case 'repeat': {
      const child = measureWidth(node.child);
      return {
        minimum: child.minimum * node.minimum,
        maximum: node.maximum === null || child.maximum === null ? null : child.maximum * node.maximum,
      };
    }
    default:
      return unreachable(node);
  }
}

function precedingBoundaries(text: string, end: number, maximumWidth: number): number[] {
  const boundaries: number[] = [];
  let position = end;
  let width = 0;
  boundaries.push(position);
  while (position > 0 && width <= maximumWidth) {
    const previous = previousCodePointStart(text, position);
    width += position - previous;
    position = previous;
    if (width <= maximumWidth) boundaries.push(position);
  }
  return boundaries.reverse();
}

function previousCodePointStart(text: string, position: number): number {
  let result = position - 1;
  const last = text.charCodeAt(result);
  if (last >= 0xdc00 && last <= 0xdfff && result > 0) result -= 1;
  return result;
}

function codePointWidthAt(text: string, position: number): number {
  if (position >= text.length) return 0;
  const codePoint = text.codePointAt(position);
  return codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
}

function advanceCodePoint(text: string, position: number): number {
  return position >= text.length ? text.length + 1 : position + codePointWidthAt(text, position);
}

function isEndOfLine(text: string, position: number): boolean {
  return position === text.length || text.charCodeAt(position) === 10;
}

function unreachable(value: never): never {
  throw new Error(`unreachable-pattern-node: ${String(value)}`);
}
