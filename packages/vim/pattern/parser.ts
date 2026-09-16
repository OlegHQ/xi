import {
  PatternEvaluationError,
  type AssertionKind,
  type CaseMode,
  type CharacterClassName,
  type CharacterClassPart,
  type MagicMode,
  type PatternNode,
  type PatternOptions,
  type PatternPositionContext,
  type PatternProgram,
  type PositionAxis,
  type PositionPredicate,
  type PositionRelation,
  type SourceSpan,
} from './types';
import { validatePatternCharacterClassContext } from './character-classes';
import type { Utf16Offset } from '../../document/src/index';

export function compilePattern(source: string, options: PatternOptions = {}): PatternProgram {
  validateCompileInputs(source, options);
  return deepFreeze(new Parser(source, options).compile());
}

const maximumPatternUtf16Units = 65_536;
// Large-file scans count every evaluator visit and therefore need a ceiling
// above the 100 MiB qualification corpus. The default remains intentionally
// small; callers must opt into a larger, still finite work budget.
const maximumStepBudget = 1_000_000_000;
const maximumOutputLimit = 1_000_000;
const maximumCancellationInterval = 4_096;
const maximumGroupDepth = 128;
const maximumCapturingGroups = 9;

function validateCompileInputs(source: string, options: PatternOptions): void {
  if (source.length > maximumPatternUtf16Units) {
    throw new PatternEvaluationError('invalid-pattern', `pattern-source-limit-exceeded: ${maximumPatternUtf16Units}`, 0, { start: 0, end: source.length });
  }
  if (!isPositiveSafeInteger(options.stepBudget ?? 250_000) || (options.stepBudget ?? 250_000) > maximumStepBudget) {
    throw new PatternEvaluationError('invalid-pattern', `pattern-step-budget-must-be-in-range: 1..${maximumStepBudget}`, 0, { start: 0, end: source.length });
  }
  if (!isPositiveSafeInteger(options.outputLimit ?? 100_000) || (options.outputLimit ?? 100_000) > maximumOutputLimit) {
    throw new PatternEvaluationError('invalid-pattern', `pattern-output-limit-must-be-in-range: 1..${maximumOutputLimit}`, 0, { start: 0, end: source.length });
  }
  if (!isPositiveSafeInteger(options.cancellationCheckInterval ?? 64) || (options.cancellationCheckInterval ?? 64) > maximumCancellationInterval) {
    throw new PatternEvaluationError('invalid-pattern', `pattern-cancellation-interval-must-be-in-range: 1..${maximumCancellationInterval}`, 0, { start: 0, end: source.length });
  }
  if (options.cursor !== undefined && (!Number.isSafeInteger(options.cursor.offset as number) || (options.cursor.offset as number) < 0)) {
    throw new PatternEvaluationError('invalid-pattern', 'pattern-cursor-offset-must-be-a-nonnegative-safe-utf16-offset', 0, { start: 0, end: source.length });
  }
  if (options.cursor !== undefined && (!Number.isSafeInteger(options.cursor.version as number) || (options.cursor.version as number) < 0)) {
    throw new PatternEvaluationError('invalid-pattern', 'pattern-cursor-version-must-be-a-nonnegative-safe-document-version', 0, { start: 0, end: source.length });
  }
  if (options.positionContext !== undefined) validatePositionContext(source, options.positionContext);
  if (options.characterClassContext !== undefined) {
    const problem = validatePatternCharacterClassContext(options.characterClassContext);
    if (problem !== undefined) {
      throw new PatternEvaluationError('invalid-pattern', `pattern-character-class-context-${problem}`, 0, { start: 0, end: source.length });
    }
  }
  if (options.cursor !== undefined && options.positionContext?.cursor !== undefined
    && (options.cursor.version !== options.positionContext.version || options.cursor.offset !== options.positionContext.cursor)) {
    throw new PatternEvaluationError('invalid-pattern', 'conflicting-pattern-cursor-contexts', 0, { start: 0, end: source.length });
  }
}

function validatePositionContext(source: string, context: PatternPositionContext): void {
  const span = { start: 0, end: source.length };
  if (!Number.isSafeInteger(context.version as number) || (context.version as number) < 0) {
    throw new PatternEvaluationError('invalid-pattern', 'pattern-position-context-needs-a-nonnegative-document-version', 0, span);
  }
  const validateOffset = (offset: Utf16Offset, label: string): void => {
    if (!Number.isSafeInteger(offset as number) || (offset as number) < 0) {
      throw new PatternEvaluationError('invalid-pattern', `pattern-position-${label}-must-be-a-nonnegative-utf16-offset`, 0, span);
    }
  };
  if (context.cursor !== undefined) validateOffset(context.cursor, 'cursor');
  if (context.tabstop !== undefined && (!Number.isSafeInteger(context.tabstop) || context.tabstop < 1 || context.tabstop > 999)) {
    throw new PatternEvaluationError('invalid-pattern', 'pattern-position-tabstop-must-be-in-range: 1..999', 0, span);
  }
  if (context.widthPolicy !== undefined && (typeof context.widthPolicy.id !== 'string' || context.widthPolicy.id.length === 0
    || !Number.isSafeInteger(context.widthPolicy.generation) || context.widthPolicy.generation < 0
    || typeof context.widthPolicy.widthOfCluster !== 'function')) {
    throw new PatternEvaluationError('invalid-pattern', 'pattern-position-width-policy-is-invalid', 0, span);
  }
  if (context.marks !== undefined) {
    for (const [name, offset] of Object.entries(context.marks)) {
      if (!isValidMarkName(name)) throw new PatternEvaluationError('invalid-pattern', `invalid-pattern-mark-name: ${name}`, 0, span);
      validateOffset(offset, `mark-${name}`);
    }
  }
  const area = context.visualArea;
  if (area === undefined) return;
  if (area.kind === 'characterwise') {
    validateOffset(area.start, 'visual-start');
    validateOffset(area.end, 'visual-end');
    if ((area.end as number) < (area.start as number)) {
      throw new PatternEvaluationError('invalid-pattern', 'pattern-visual-range-must-be-half-open-and-ordered', 0, span);
    }
  } else if (area.kind === 'linewise') {
    if (!isNonnegativeSafeInteger(area.firstLine as number) || !isNonnegativeSafeInteger(area.lastLine as number)
      || (area.lastLine as number) < (area.firstLine as number)) {
      throw new PatternEvaluationError('invalid-pattern', 'pattern-visual-line-range-must-be-ordered', 0, span);
    }
  } else if (area.kind === 'blockwise') {
    if (!isNonnegativeSafeInteger(area.firstLine as number) || !isNonnegativeSafeInteger(area.lastLine as number)
      || (area.lastLine as number) < (area.firstLine as number)
      || !isNonnegativeSafeInteger(area.firstCell as number) || !isNonnegativeSafeInteger(area.lastCell as number)
      || (area.lastCell as number) < (area.firstCell as number)) {
      throw new PatternEvaluationError('invalid-pattern', 'pattern-visual-block-range-must-be-ordered', 0, span);
    }
  }
}

function isValidMarkName(name: string): boolean {
  return name.length === 1 && ((name >= 'a' && name <= 'z') || (name >= 'A' && name <= 'Z')
    || (name >= '0' && name <= '9') || `"[]<>.^'`.includes(name));
}

function isNonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function freezePositionContext(context: PatternPositionContext): PatternPositionContext {
  return Object.freeze({
    version: context.version,
    ...(context.cursor === undefined ? {} : { cursor: context.cursor }),
    ...(context.visualArea === undefined ? {} : { visualArea: Object.freeze({ ...context.visualArea }) }),
    ...(context.marks === undefined ? {} : { marks: Object.freeze({ ...context.marks }) }),
    ...(context.tabstop === undefined ? {} : { tabstop: context.tabstop }),
    ...(context.widthPolicy === undefined ? {} : { widthPolicy: Object.freeze({ ...context.widthPolicy }) }),
  });
}

function freezeCharacterClassContext(context: NonNullable<PatternOptions['characterClassContext']>): NonNullable<PatternOptions['characterClassContext']> {
  return Object.freeze({ ...context });
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

class Parser {
  private index = 0;
  private captureCount = 0;
  private magic: MagicMode;
  private caseMode: CaseMode = 'option';
  private containsNewlineAtom = false;
  private containsLineBoundary = false;
  private containsLookaround = false;
  private containsBackreference = false;
  private containsPositionAtom = false;
  private containsLineNumberAtom = false;
  private containsColumnAtom = false;
  private containsVisualAreaAtom = false;
  private containsIntersection = false;
  private containsOptionalSequence = false;
  private containsCombiningAtom = false;
  private ignoreCombining = false;
  private leadingCombining = '';
  private engineSelector: 0 | 1 | 2 = 0;
  private groupDepth = 0;
  private optionalSequenceDepth = 0;

  constructor(private readonly source: string, private readonly options: PatternOptions) {
    this.magic = options.magic === false ? 'nomagic' : 'magic';
  }

  compile(): PatternProgram {
    const parsedRoot = this.parseAlternative(false);
    if (this.index !== this.source.length) this.invalid(`unexpected-pattern-token: ${this.source.slice(this.index)}`, this.index, this.source.length);
    let root = parsedRoot;
    if (this.ignoreCombining) {
      const leadingNodes = leadingCombiningNodes(parsedRoot);
      this.leadingCombining = leadingNodes.map((node) => node.value).join('');
      const leadingSources = new Set(leadingNodes.map((node) => `${node.source.start}:${node.source.end}`));
      root = stripNonleadingCombining(parsedRoot, leadingSources);
    }
    const hasUppercase = containsUppercaseLiteral(root);
    return {
      source: this.source,
      root,
      captureCount: this.captureCount,
      stepBudget: this.options.stepBudget ?? 250_000,
      outputLimit: this.options.outputLimit ?? 100_000,
      cancellationCheckInterval: Math.max(1, this.options.cancellationCheckInterval ?? 64),
      ...(this.options.shouldCancel === undefined ? {} : { shouldCancel: this.options.shouldCancel }),
      ...(this.options.cursor === undefined ? {} : { cursor: Object.freeze({ ...this.options.cursor }) }),
      ...(this.options.positionContext === undefined ? {} : { positionContext: freezePositionContext(this.options.positionContext) }),
      ...(this.options.characterClassContext === undefined ? {} : { characterClassContext: freezeCharacterClassContext(this.options.characterClassContext) }),
      initialCaseMode: 'option',
      defaultIgnoreCase: this.options.ignoreCase === true && !(this.options.smartCase === true && hasUppercase),
      ignoreCombining: this.ignoreCombining,
      leadingCombining: this.leadingCombining,
      engineSelector: this.engineSelector,
      features: {
        containsNewlineAtom: this.containsNewlineAtom,
        containsLineBoundary: this.containsLineBoundary,
        containsLookaround: this.containsLookaround,
        containsBackreference: this.containsBackreference,
        containsPositionAtom: this.containsPositionAtom,
        containsLineNumberAtom: this.containsLineNumberAtom,
        containsColumnAtom: this.containsColumnAtom,
        containsVisualAreaAtom: this.containsVisualAreaAtom,
        containsIntersection: this.containsIntersection,
        containsOptionalSequence: this.containsOptionalSequence,
        containsCombiningAtom: this.containsCombiningAtom,
      },
    };
  }

  private parseAlternative(inGroup: boolean): PatternNode {
    const start = this.index;
    let branchStart = this.index;
    let concatStart = this.index;
    const branches: PatternNode[] = [];
    const concats: PatternNode[] = [];
    let terms: PatternNode[] = [];
    let afterExplicitNewline = false;
    const finishConcat = (end: number): void => {
      concats.push(sequence(terms, concatStart, end));
      terms = [];
    };
    const finishBranch = (end: number): void => {
      finishConcat(end);
      branches.push(intersection(concats, branchStart, end));
      concats.length = 0;
    };
    while (this.index < this.source.length) {
      if (inGroup && this.isGroupClose()) break;
      if (this.isAlternative()) {
        finishBranch(this.index);
        afterExplicitNewline = false;
        this.consumeAlternative();
        branchStart = this.index;
        concatStart = this.index;
        continue;
      }
      if (this.isIntersection()) {
        finishConcat(this.index);
        this.containsIntersection = true;
        this.index += this.magic === 'very-magic' ? 1 : 2;
        concatStart = this.index;
        afterExplicitNewline = false;
        continue;
      }
      if (this.consumeDirective()) continue;
      const term = this.parsePiece(terms.length === 0 || afterExplicitNewline);
      terms.push(term);
      afterExplicitNewline = term.kind === 'literal' && term.value === '\n';
    }
    finishBranch(this.index);
    return branches.length === 1
      ? branches[0] ?? empty(start)
      : { kind: 'alternate', branches, source: { start, end: this.index } };
  }

  private parsePiece(atBranchStart: boolean): PatternNode {
    const start = this.index;
    let atom = this.parseAtom(atBranchStart);
    const repeat = this.parseQuantifier();
    if (repeat !== null) {
      atom = {
        kind: 'repeat',
        child: atom,
        minimum: repeat.minimum,
        maximum: repeat.maximum,
        greedy: repeat.greedy,
        source: { start, end: this.index },
      };
    }
    while (this.isAssertionOperator()) {
      const assertionStart = this.index;
      this.index += this.magic === 'very-magic' ? 1 : 2;
      let lookbehindLimitBytes: number | undefined;
      if (isDigit(this.source[this.index] ?? '')) {
        const numberStart = this.index;
        lookbehindLimitBytes = 0;
        while (isDigit(this.source[this.index] ?? '')) {
          lookbehindLimitBytes = lookbehindLimitBytes * 10 + Number(this.source[this.index]);
          if (!Number.isSafeInteger(lookbehindLimitBytes)) this.invalid('lookbehind-limit-out-of-range', assertionStart, this.index + 1);
          this.index += 1;
        }
        if (this.index === numberStart) lookbehindLimitBytes = undefined;
      }
      const next = this.source[this.index];
      let assertion: AssertionKind;
      if (next === '=' && lookbehindLimitBytes === undefined) {
        assertion = 'ahead-positive';
        this.index += 1;
      } else if (next === '!' && lookbehindLimitBytes === undefined) {
        assertion = 'ahead-negative';
        this.index += 1;
      } else if (next === '<' && this.source[this.index + 1] === '=') {
        assertion = 'behind-positive';
        this.index += 2;
      } else if (next === '<' && this.source[this.index + 1] === '!') {
        assertion = 'behind-negative';
        this.index += 2;
      } else if (next === '>' && lookbehindLimitBytes === undefined) {
        assertion = 'atomic';
        this.index += 1;
      } else {
        this.invalid('invalid-lookaround-operator', assertionStart, Math.min(this.source.length, this.index + 2));
      }
      this.containsLookaround = true;
      atom = {
        kind: 'assertion',
        assertion,
        child: atom,
        ...(lookbehindLimitBytes === undefined ? {} : { lookbehindLimitBytes }),
        source: { start, end: this.index },
      };
    }
    return atom;
  }

  private parseAtom(atBranchStart: boolean): PatternNode {
    const start = this.index;
    const value = this.source[this.index];
    if (value === undefined) return empty(start);

    if (this.isGroupOpen() || this.isNonCapturingGroupOpen()) {
      if (this.optionalSequenceDepth > 0) this.invalid('groups-not-allowed-in-optional-atom-sequence', start, Math.min(this.source.length, start + 3));
      return this.parseGroup(this.isGroupOpen());
    }
    if (value === '\\') return this.parseEscapedLiteral();

    if (value === '^' && this.magic !== 'very-nomagic' && atBranchStart) {
      this.index += 1;
      this.containsLineBoundary = true;
      return { kind: 'anchor', anchor: 'line-start', source: { start, end: this.index } };
    }
    if (value === '$' && this.magic !== 'very-nomagic' && this.isSequenceEnd(this.index + 1)) {
      this.index += 1;
      this.containsLineBoundary = true;
      return { kind: 'anchor', anchor: 'line-end', source: { start, end: this.index } };
    }
    if (value === '.' && (this.magic === 'magic' || this.magic === 'very-magic')) {
      this.index += 1;
      return { kind: 'dot', includeNewline: false, source: { start, end: this.index } };
    }
    if (value === '[' && (this.magic === 'magic' || this.magic === 'very-magic')) return this.parseCharacterClass(true, start);
    if (value === ']' && this.magic === 'very-magic') this.invalid('unmatched-character-class-close', start, start + 1);
    if ((value === '+' || value === '?' || value === '{' || value === '}') && this.magic === 'very-magic') {
      this.invalid(`quantifier-without-preceding-atom: ${value}`, start, start + 1);
    }
    if (value === '~' && (this.magic === 'magic' || this.magic === 'very-magic')) {
      this.unsupported('previous-substitute-pattern-requires-command-context', start, start + 1);
    }

    const width = codePointWidthAt(this.source, this.index);
    const literal = this.source.slice(this.index, this.index + width);
    this.index += width;
    if (isCombiningSequence(literal)) this.containsCombiningAtom = true;
    return { kind: 'literal', value: literal, caseMode: this.caseMode, source: { start, end: this.index } };
  }

  private parseGroup(capturing: boolean): PatternNode {
    const start = this.index;
    this.groupDepth += 1;
    if (this.groupDepth > maximumGroupDepth) {
      this.unsupported(`pattern-group-depth-exceeded: ${maximumGroupDepth}`, start, Math.min(this.source.length, start + 2));
    }
    const openingWidth = this.isNonCapturingGroupOpen() ? 3 : this.isEscape('(') ? 2 : 1;
    this.index += openingWidth;
    if (capturing && this.captureCount >= maximumCapturingGroups) {
      this.invalid(`pattern-capture-limit-exceeded: ${maximumCapturingGroups}`, start, this.index);
    }
    const group = capturing ? ++this.captureCount : 0;
    const child = this.parseAlternative(true);
    if (!this.isGroupClose()) this.invalid('unclosed-group', start, this.source.length);
    this.index += this.isEscape(')') ? 2 : 1;
    this.groupDepth -= 1;
    return capturing
      ? { kind: 'capture', group, child, source: { start, end: this.index } }
      : child;
  }

  private parseEscapedLiteral(): PatternNode {
    const start = this.index;
    this.index += 1;
    const escaped = this.source[this.index];
    if (escaped === undefined) this.invalid('trailing-pattern-backslash', start, this.index);
    this.index += 1;
    if (escaped === 'Z') {
      this.ignoreCombining = true;
      this.containsCombiningAtom = true;
      return empty(start);
    }
    if (escaped === 'z') {
      const marker = this.source[this.index];
      if (marker === 's') {
        this.index += 1;
        return { kind: 'set-start', source: { start, end: this.index } };
      }
      if (marker === 'e') {
        this.index += 1;
        return { kind: 'set-end', source: { start, end: this.index } };
      }
      if (marker === '(') this.unsupported('syntax-only-z-group-not-in-product-search', start, Math.min(this.source.length, this.index + 1));
      this.unsupported('unsupported-z-construct', start, Math.min(this.source.length, this.index + 1));
    }
    if (escaped === '%') return this.parsePositionAtom(start);
    if (escaped === '_') return this.parseNewlineClass(start);
    if (escaped === '@') this.invalid('assertion-without-atom', start, this.index);
    if (escaped === '1' || escaped === '2' || escaped === '3' || escaped === '4' || escaped === '5' || escaped === '6' || escaped === '7' || escaped === '8' || escaped === '9') {
      this.containsBackreference = true;
      return { kind: 'backreference', group: Number(escaped), caseMode: this.caseMode, source: { start, end: this.index } };
    }
    if (escaped === 'n') {
      this.containsNewlineAtom = true;
      return { kind: 'literal', value: '\n', caseMode: 'sensitive', source: { start, end: this.index } };
    }
    if (escaped === 't' || escaped === 'r' || escaped === 'e' || escaped === 'b' || escaped === '\\') {
      const literal = escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped === 'e' ? '\u001b' : escaped === 'b' ? '\b' : '\\';
      return { kind: 'literal', value: literal, caseMode: this.caseMode, source: { start, end: this.index } };
    }
    if (escaped === '.' && (this.magic === 'nomagic' || this.magic === 'very-nomagic')) {
      return { kind: 'dot', includeNewline: false, source: { start, end: this.index } };
    }
    if (escaped === '$' && this.magic === 'very-nomagic' && this.isSequenceEnd(this.index)) {
      this.containsLineBoundary = true;
      return { kind: 'anchor', anchor: 'line-end', source: { start, end: this.index } };
    }
    if (escaped === '[' && (this.magic === 'nomagic' || this.magic === 'very-nomagic')) return this.parseCharacterClass(true, start);
    if (escaped === '^' || escaped === '$' || escaped === '.' || escaped === '[' || escaped === ']' || escaped === '*' || escaped === '+' || escaped === '?' || escaped === '=' || escaped === '{' || escaped === '}' || escaped === '(' || escaped === ')' || escaped === '|' || escaped === '~') {
      if (escaped === '~' && (this.magic === 'nomagic' || this.magic === 'very-nomagic')) {
        this.unsupported('previous-substitute-pattern-requires-command-context', start, this.index);
      }
      if ((escaped === '+' || escaped === '?' || escaped === '=' || escaped === '{' || escaped === '|' || escaped === '(' || escaped === ')') && this.magic !== 'very-magic') {
        this.invalid(`unexpected-pattern-operator: \\${escaped}`, start, this.index);
      }
      if (escaped === '*' && (this.magic === 'nomagic' || this.magic === 'very-nomagic')) {
        this.invalid('quantifier-without-preceding-atom', start, this.index);
      }
    if (isCombiningSequence(escaped)) this.containsCombiningAtom = true;
    return { kind: 'literal', value: escaped, caseMode: this.caseMode, source: { start, end: this.index } };
    }
    const builtinClass = classEscape(escaped);
    if (builtinClass !== undefined) {
      return this.classNode(start, [{ kind: 'class', name: builtinClass.name }], builtinClass.negated, false);
    }
    if (escaped === '<' || escaped === '>') {
      return { kind: 'anchor', anchor: escaped === '<' ? 'word-start' : 'word-end', source: { start, end: this.index } };
    }
    if (escaped === 'm' || escaped === 'M' || escaped === 'v' || escaped === 'V' || escaped === 'c' || escaped === 'C') {
      this.applyDirective(escaped);
      return empty(start);
    }
    this.unsupported(`unsupported-vim-escape: \\${escaped}`, start, this.index);
  }

  private parsePositionAtom(start: number): PatternNode {
    const next = this.source[this.index];
    if (next === '#' && this.source[this.index + 1] === '=') {
      this.index += 2;
      const selector = this.readDecimal();
      if (selector === null || selector > 2) {
        this.invalid('regexp-engine-selector-must-be-0-1-or-2', start, this.index);
      }
      if (start !== 0) this.unsupported('regexp-engine-selector-must-prefix-pattern', start, this.index);
      this.engineSelector = selector as 0 | 1 | 2;
      return empty(start);
    }
    if (next === '^' || next === '$' || next === '#') {
      this.index += 1;
      this.containsPositionAtom = true;
      if (next === '^') return { kind: 'anchor', anchor: 'file-start', source: { start, end: this.index } };
      if (next === '$') return { kind: 'anchor', anchor: 'file-end', source: { start, end: this.index } };
      return { kind: 'anchor', anchor: 'cursor', source: { start, end: this.index } };
    }
    if (next === 'V') {
      this.index += 1;
      this.containsPositionAtom = true;
      this.containsVisualAreaAtom = true;
      return { kind: 'anchor', anchor: 'visual-area', source: { start, end: this.index } };
    }
    if (next === "'") return this.parseMarkAtom(start, 'equal');
    if (next === '<' || next === '>') {
      this.index += 1;
      const relation: PositionRelation = next === '<' ? 'less-than' : 'greater-than';
      if (this.source[this.index] === "'") return this.parseMarkAtom(start, relation);
      return this.parseCoordinateAtom(start, relation);
    }
    if (next === '.') return this.parseCoordinateAtom(start, 'equal');
    if (next !== undefined && isDigit(next)) {
      let value = 0;
      while (this.index < this.source.length && isDigit(this.source[this.index] ?? '')) {
        value = value * 10 + (this.source.charCodeAt(this.index) - 48);
        if (!Number.isSafeInteger(value)) this.invalid('position-number-out-of-range', start, this.index + 1);
        this.index += 1;
      }
      const axis = this.positionAxis(this.source[this.index], start);
      this.index += 1;
      this.containsPositionAtom = true;
      if (axis === 'line') {
        this.containsLineNumberAtom = true;
        return { kind: 'anchor', anchor: 'line-number', expected: value, source: { start, end: this.index } };
      }
      this.containsColumnAtom = true;
      const predicate: PositionPredicate = { axis, relation: 'equal', target: { kind: 'number', value } };
      return { kind: 'anchor', anchor: 'position', predicate, source: { start, end: this.index } };
    }
    if (next === 'd' || next === 'o' || next === 'x' || next === 'u' || next === 'U') {
      return this.parseCodePointAtom(start, next);
    }
    if (next === 'C') {
      this.index += 1;
      this.containsCombiningAtom = true;
      return { kind: 'skip-combining', source: { start, end: this.index } };
    }
    if (next === '[') return this.parseOptionalSequence(start);
    this.invalid('unsupported-position-atom', start, Math.min(this.source.length, this.index + 1));
  }

  private parseCoordinateAtom(start: number, relation: PositionRelation): PatternNode {
    let target: PositionPredicate['target'];
    if (this.source[this.index] === '.') {
      this.index += 1;
      target = { kind: 'cursor' };
    } else if (isDigit(this.source[this.index] ?? '')) {
      let value = 0;
      while (this.index < this.source.length && isDigit(this.source[this.index] ?? '')) {
        value = value * 10 + (this.source.charCodeAt(this.index) - 48);
        if (!Number.isSafeInteger(value)) this.invalid('position-number-out-of-range', start, this.index + 1);
        this.index += 1;
      }
      target = { kind: 'number', value };
    } else {
      this.invalid('position-atom-needs-line-byte-or-virtual-column', start, Math.min(this.source.length, this.index + 1));
    }
    const axis = this.positionAxis(this.source[this.index], start);
    this.index += 1;
    this.containsPositionAtom = true;
    if (axis === 'line') this.containsLineNumberAtom = true;
    else this.containsColumnAtom = true;
    const predicate: PositionPredicate = { axis, relation, target };
    return axis === 'line' && target.kind === 'number' && relation === 'equal'
      ? { kind: 'anchor', anchor: 'line-number', expected: target.value, source: { start, end: this.index } }
      : { kind: 'anchor', anchor: 'position', predicate, source: { start, end: this.index } };
  }

  private positionAxis(suffix: string | undefined, start: number): PositionAxis {
    if (suffix === 'l') return 'line';
    if (suffix === 'c') return 'byte-column';
    if (suffix === 'v') return 'virtual-column';
    this.invalid('position-atom-needs-line-byte-or-virtual-column-suffix', start, Math.min(this.source.length, this.index + 1));
  }

  private parseMarkAtom(start: number, relation: PositionRelation): PatternNode {
    if (this.source[this.index] !== "'") this.invalid('position-mark-atom-needs-mark-name', start, Math.min(this.source.length, this.index + 1));
    this.index += 1;
    const mark = this.source[this.index];
    if (mark === undefined || !isValidMarkName(mark)) this.invalid('position-mark-atom-needs-single-vim-mark-name', start, Math.min(this.source.length, this.index + 1));
    this.index += 1;
    this.containsPositionAtom = true;
    return { kind: 'anchor', anchor: 'mark', mark, relation, source: { start, end: this.index } };
  }

  private parseCodePointAtom(start: number, notation: 'd' | 'o' | 'x' | 'u' | 'U'): PatternNode {
    this.index += 1;
    const radix = notation === 'd' ? 10 : notation === 'o' ? 8 : notation === 'x' || notation === 'u' || notation === 'U' ? 16 : 10;
    const digitLimit = notation === 'x' ? 2 : notation === 'u' ? 4 : notation === 'U' ? 8 : Number.MAX_SAFE_INTEGER;
    let value = 0;
    let digitCount = 0;
    while (this.index < this.source.length) {
      const digit = digitValue(this.source[this.index] ?? '', radix);
      if (digit === null || digitCount >= digitLimit) break;
      value = value * radix + digit;
      if (!Number.isSafeInteger(value)) this.invalid('code-point-atom-out-of-range', start, this.index + 1);
      this.index += 1;
      digitCount += 1;
    }
    if (digitCount === 0) this.invalid('code-point-atom-requires-digits', start, this.index);
    if (notation === 'o' && value > 0xff) this.invalid('octal-code-point-exceeds-0o377', start, this.index);
    if (notation === 'x' && value > 0xff) this.invalid('hex-code-point-exceeds-0xff', start, this.index);
    if (notation === 'u' && value > 0xffff) this.invalid('unicode-code-point-exceeds-0xffff', start, this.index);
    if (notation === 'U' && value > 0x7fffffff) this.invalid('large-unicode-code-point-exceeds-0x7fffffff', start, this.index);
    if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
      this.invalid('code-point-atom-is-not-a-unicode-scalar', start, this.index);
    }
    if (notation === 'd' && this.index < this.source.length && isDigit(this.source[this.index] ?? '')) {
      this.invalid('decimal-code-point-atom-needs-nondigit-terminator', start, this.index + 1);
    }
    const character = String.fromCodePoint(value);
    if (isCombiningSequence(character)) this.containsCombiningAtom = true;
    if (character === '\n') this.containsNewlineAtom = true;
    return { kind: 'literal', value: character, caseMode: this.caseMode, source: { start, end: this.index } };
  }

  private parseOptionalSequence(start: number): PatternNode {
    this.index += 1;
    this.optionalSequenceDepth += 1;
    const atoms: PatternNode[] = [];
    while (this.index < this.source.length && this.source[this.index] !== ']') {
      if (this.isAlternative() || this.isIntersection()) {
        this.invalid('branch-operator-not-allowed-in-optional-atom-sequence', this.index, this.index + 2);
      }
      if (this.isEscape('%') && this.source[this.index + 2] === '[') {
        this.invalid('nested-optional-atom-sequence', this.index, this.index + 3);
      }
      if (this.isGroupOpen() || this.isNonCapturingGroupOpen()) {
        this.invalid('groups-not-allowed-in-optional-atom-sequence', this.index, Math.min(this.source.length, this.index + 3));
      }
      if (this.consumeDirective()) continue;
      atoms.push(this.parsePiece(atoms.length === 0));
    }
    this.optionalSequenceDepth -= 1;
    if (this.source[this.index] !== ']') this.invalid('unclosed-optional-atom-sequence', start, this.source.length);
    this.index += 1;
    this.containsOptionalSequence = true;
    return { kind: 'optional-sequence', atoms, source: { start, end: this.index } };
  }

  private parseNewlineClass(start: number): PatternNode {
    const code = this.source[this.index];
    if (code === undefined) this.invalid('trailing-newline-class-prefix', start, this.index);
    this.index += 1;
    if (code === '^' || code === '$') {
      this.containsLineBoundary = true;
      return { kind: 'anchor', anchor: code === '^' ? 'line-start' : 'line-end', source: { start, end: this.index } };
    }
    if (code === '.') {
      this.containsNewlineAtom = true;
      return { kind: 'dot', includeNewline: true, source: { start, end: this.index } };
    }
    if (code === '[') {
      this.containsNewlineAtom = true;
      return this.parseCharacterClass(true, start, true);
    }
    const builtin = classEscape(code);
    if (builtin !== undefined) {
      this.containsNewlineAtom = true;
      return this.classNode(start, [{ kind: 'class', name: builtin.name }], builtin.negated, true);
    }
    this.unsupported(`unsupported-newline-class: \\_${code}`, start, this.index);
  }

  private parseCharacterClass(negatedPrefixAllowed: boolean, start: number, includeNewline = false): PatternNode {
    if (this.source[this.index] === '[') this.index += 1;
    let negated = false;
    if (negatedPrefixAllowed && this.source[this.index] === '^') {
      negated = true;
      this.index += 1;
    }
    const parts: CharacterClassPart[] = [];
    let closed = false;
    while (this.index < this.source.length) {
      if (this.source[this.index] === '[' && this.source[this.index + 1] === ':') {
        parts.push(this.parsePosixClass(start));
        continue;
      }
      if (this.source[this.index] === ']' && parts.length > 0) {
        this.index += 1;
        closed = true;
        break;
      }
      const first = this.parseClassCharacter(start);
      if (this.source[this.index] === '-' && this.source[this.index + 1] !== ']' && this.source[this.index + 1] !== undefined) {
        this.index += 1;
        const last = this.parseClassCharacter(start);
        if (first.kind !== 'literal' || last.kind !== 'literal') this.invalid('class-range-needs-literal-endpoints', start, this.index);
        const firstPoint = first.value.codePointAt(0);
        const lastPoint = last.value.codePointAt(0);
        if (firstPoint === undefined || lastPoint === undefined || firstPoint > lastPoint) this.invalid('invalid-character-class-range', start, this.index);
        parts.push({ kind: 'range', first: firstPoint, last: lastPoint });
      } else {
        parts.push(first);
      }
    }
    if (!closed) this.invalid('unclosed-character-class', start, this.source.length);
    return this.classNode(start, parts, negated, includeNewline);
  }

  private parseClassCharacter(start: number): CharacterClassPart {
    if (this.source[this.index] !== '\\') {
      const width = codePointWidthAt(this.source, this.index);
      const value = this.source.slice(this.index, this.index + width);
      this.index += width;
      if (isCombiningSequence(value)) this.containsCombiningAtom = true;
      return { kind: 'literal', value };
    }
    const escapeStart = this.index;
    this.index += 1;
    const escaped = this.source[this.index];
    if (escaped === undefined) this.invalid('trailing-character-class-backslash', escapeStart, this.index);
    this.index += 1;
    const builtin = classEscape(escaped);
    if (builtin !== undefined) return { kind: 'class', name: builtin.name, ...(builtin.negated ? { negated: true } : {}) };
    const value = escaped === 't' ? '\t' : escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped;
    if (value === undefined) this.invalid('empty-character-class-escape', start, this.index);
    if (isCombiningSequence(value)) this.containsCombiningAtom = true;
    return { kind: 'literal', value };
  }

  private parsePosixClass(start: number): CharacterClassPart {
    const classStart = this.index;
    this.index += 2;
    let negated = false;
    if (this.source[this.index] === '^') {
      negated = true;
      this.index += 1;
    }
    const nameStart = this.index;
    while (this.index < this.source.length && !(this.source[this.index] === ':' && this.source[this.index + 1] === ']')) this.index += 1;
    if (this.index >= this.source.length) this.invalid('unclosed-posix-character-class', classStart, this.source.length);
    const name = this.source.slice(nameStart, this.index);
    this.index += 2;
    const mapped = posixClass(name);
    if (mapped === undefined) this.unsupported(`unsupported-posix-character-class: ${name}`, classStart, this.index);
    return { kind: 'class', name: mapped, ...(negated ? { negated: true } : {}) };
  }

  private classNode(start: number, parts: readonly CharacterClassPart[], negated: boolean, includeNewline: boolean): PatternNode {
    return { kind: 'character-class', parts, negated, includeNewline, caseMode: this.caseMode, source: { start, end: this.index } };
  }

  private parseQuantifier(): { readonly minimum: number; readonly maximum: number | null; readonly greedy: boolean } | null {
    const start = this.index;
    const char = this.source[this.index];
    if ((char === '*' && (this.magic === 'magic' || this.magic === 'very-magic')) ||
        (char === '+' && this.magic === 'very-magic') ||
        (char === '?' && this.magic === 'very-magic')) {
      this.index += 1;
      return char === '*' ? { minimum: 0, maximum: null, greedy: true }
        : char === '+' ? { minimum: 1, maximum: null, greedy: true }
          : { minimum: 0, maximum: 1, greedy: true };
    }
    if (this.source[this.index] === '\\') {
      const escaped = this.source[this.index + 1];
      if ((escaped === '+' || escaped === '?' || escaped === '=') && this.magic !== 'very-magic') {
        this.index += 2;
        return escaped === '+' ? { minimum: 1, maximum: null, greedy: true }
          : { minimum: 0, maximum: 1, greedy: true };
      }
      if (escaped === '*' && (this.magic === 'nomagic' || this.magic === 'very-nomagic')) {
        this.index += 2;
        return { minimum: 0, maximum: null, greedy: true };
      }
      if (escaped === '{' && this.magic !== 'very-magic') return this.parseBraceQuantifier(start, 2);
    }
    if (char === '{' && this.magic === 'very-magic') return this.parseBraceQuantifier(start, 1);
    return null;
  }

  private parseBraceQuantifier(start: number, openingWidth: number): { readonly minimum: number; readonly maximum: number | null; readonly greedy: boolean } {
    this.index += openingWidth;
    let greedy = true;
    if (this.source[this.index] === '-') {
      greedy = false;
      this.index += 1;
    }
    const first = this.readDecimal();
    let minimum: number;
    let maximum: number | null;
    if (this.source[this.index] === ',') {
      this.index += 1;
      const second = this.readDecimal();
      minimum = first ?? 0;
      maximum = second;
    } else if (first === null && this.source[this.index] === '}') {
      minimum = 0;
      maximum = null;
    } else {
      if (first === null) this.invalid('invalid-brace-quantifier', start, this.index);
      minimum = first;
      maximum = first;
    }
    if (this.source[this.index] !== '}') this.invalid('unclosed-brace-quantifier', start, this.index);
    this.index += 1;
    if (maximum !== null && maximum < minimum) this.invalid('invalid-brace-quantifier-range', start, this.index);
    return { minimum, maximum, greedy };
  }

  private readDecimal(): number | null {
    const start = this.index;
    let result = 0;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === undefined || !isDigit(char)) break;
      result = result * 10 + char.charCodeAt(0) - 48;
      if (!Number.isSafeInteger(result)) this.invalid('quantifier-out-of-range', start, this.index + 1);
      this.index += 1;
    }
    return this.index === start ? null : result;
  }

  private consumeDirective(): boolean {
    if (this.source[this.index] !== '\\') return false;
    const directive = this.source[this.index + 1];
    if (directive !== 'm' && directive !== 'M' && directive !== 'v' && directive !== 'V' && directive !== 'c' && directive !== 'C') return false;
    this.index += 2;
    this.applyDirective(directive);
    return true;
  }

  private applyDirective(directive: string): void {
    if (directive === 'm') this.magic = 'magic';
    else if (directive === 'M') this.magic = 'nomagic';
    else if (directive === 'v') this.magic = 'very-magic';
    else if (directive === 'V') this.magic = 'very-nomagic';
    else if (directive === 'c') this.caseMode = 'insensitive';
    else if (directive === 'C') this.caseMode = 'sensitive';
  }

  private isGroupOpen(): boolean {
    if (this.magic === 'very-magic' && this.source[this.index] === '(') return true;
    return this.magic !== 'very-magic' && this.isEscape('(');
  }

  private isNonCapturingGroupOpen(): boolean {
    return this.isEscape('%') && this.source[this.index + 2] === '(';
  }

  private isGroupClose(): boolean {
    if (this.magic === 'very-magic' && this.source[this.index] === ')') return true;
    return this.magic !== 'very-magic' && this.isEscape(')');
  }

  private isAlternative(): boolean {
    if (this.magic === 'very-magic' && this.source[this.index] === '|') return true;
    return this.magic !== 'very-magic' && this.isEscape('|');
  }

  private isIntersection(): boolean {
    return (this.magic === 'very-magic' && this.source[this.index] === '&') || (this.magic !== 'very-magic' && this.isEscape('&'));
  }

  private isAssertionOperator(): boolean {
    return (this.magic === 'very-magic' && this.source[this.index] === '@') || (this.magic !== 'very-magic' && this.isEscape('@'));
  }

  private consumeAlternative(): void {
    this.index += this.magic === 'very-magic' ? 1 : 2;
  }

  private isSequenceEnd(index: number): boolean {
    if (index >= this.source.length) return true;
    if (this.source[index] === '\\' && this.source[index + 1] === 'n') return true;
    if (this.magic === 'very-magic' && this.source[index] === '|') return true;
    if (this.magic !== 'very-magic' && this.source[index] === '\\' && this.source[index + 1] === '|') return true;
    if (this.magic === 'very-magic' && this.source[index] === ')') return true;
    if (this.magic !== 'very-magic' && this.source[index] === '\\' && this.source[index + 1] === ')') return true;
    return false;
  }

  private isEscape(char: string): boolean {
    return this.source[this.index] === '\\' && this.source[this.index + 1] === char;
  }

  private invalid(message: string, start: number, end: number): never {
    throw new PatternEvaluationError('invalid-pattern', message, 0, { start, end });
  }

  private unsupported(message: string, start: number, end: number): never {
    throw new PatternEvaluationError('unsupported-construct', message, 0, { start, end });
  }
}

function sequence(terms: readonly PatternNode[], start: number, end: number): PatternNode {
  if (terms.length === 0) return empty(start);
  const normalized: PatternNode[] = [];
  for (const term of terms) {
    const previous = normalized.at(-1);
    if (term.kind === 'literal' && previous?.kind === 'literal' && term.caseMode === previous.caseMode
      && isCombiningSequence(term.value)) {
      normalized[normalized.length - 1] = {
        ...previous,
        value: previous.value + term.value,
        source: { start: previous.source.start, end: term.source.end },
      };
    } else {
      normalized.push(term);
    }
  }
  for (let index = 0; index + 1 < normalized.length; index += 1) {
    const current = normalized[index];
    const next = normalized[index + 1];
    if (current?.kind === 'literal' && next?.kind === 'skip-combining' && !isCombiningSequence(current.value)) {
      normalized[index] = { ...current, matchComposing: true };
    }
  }
  if (normalized.length === 1) return normalized[0] ?? empty(start);
  return { kind: 'sequence', terms: normalized, source: { start, end } };
}

function intersection(concats: readonly PatternNode[], start: number, end: number): PatternNode {
  if (concats.length === 0) return empty(start);
  if (concats.length === 1) return concats[0] ?? empty(start);
  return { kind: 'intersection', concats: [...concats], source: { start, end } };
}

function leadingCombiningNodes(node: PatternNode): Extract<PatternNode, { kind: 'literal' }>[] {
  if (node.kind === 'alternate') return node.branches.flatMap(leadingCombiningNodes);
  if (node.kind === 'capture') return leadingCombiningNodes(node.child);
  if (node.kind === 'intersection') return node.concats.flatMap((concat, index) => index === 0 ? leadingCombiningNodes(concat) : []);
  const terms = node.kind === 'sequence' ? node.terms : [node];
  const result: Extract<PatternNode, { kind: 'literal' }>[] = [];
  for (const term of terms) {
    if (term.kind === 'empty') continue;
    if (term.kind === 'literal' && isCombiningSequence(term.value)) {
      result.push(term);
      continue;
    }
    if (term.kind === 'capture') result.push(...leadingCombiningNodes(term.child));
    break;
  }
  return result;
}

function stripNonleadingCombining(node: PatternNode, leadingSources: ReadonlySet<string>): PatternNode {
  switch (node.kind) {
    case 'literal':
      return isCombiningSequence(node.value) && !leadingSources.has(`${node.source.start}:${node.source.end}`)
        ? empty(node.source.start)
        : node;
    case 'sequence': {
      const terms: PatternNode[] = [];
      for (const term of node.terms) {
        if (term.kind === 'literal' && isCombiningScalar(term.value) && leadingSources.has(`${term.source.start}:${term.source.end}`)) {
          const previous = terms.at(-1);
          if (previous?.kind === 'literal' && isCombiningSequence(previous.value)) {
            terms[terms.length - 1] = {
              ...previous,
              value: previous.value + term.value,
              source: { start: previous.source.start, end: term.source.end },
            };
          } else {
            terms.push(term);
          }
        } else {
          terms.push(stripNonleadingCombining(term, leadingSources));
        }
      }
      return { ...node, terms };
    }
    case 'alternate':
      return { ...node, branches: node.branches.map((branch) => stripNonleadingCombining(branch, leadingSources)) };
    case 'intersection':
      return { ...node, concats: node.concats.map((concat) => stripNonleadingCombining(concat, leadingSources)) };
    case 'optional-sequence':
      return { ...node, atoms: node.atoms.map((atom) => stripNonleadingCombining(atom, leadingSources)) };
    case 'capture':
    case 'repeat':
    case 'assertion':
      return { ...node, child: stripNonleadingCombining(node.child, leadingSources) };
    default:
      return node;
  }
}

function isCombiningScalar(value: string): boolean {
  return [...value].length === 1 && /^\p{M}$/u.test(value);
}

function isCombiningSequence(value: string): boolean {
  return value.length > 0 && [...value].every(isCombiningScalar);
}

function empty(start: number): PatternNode {
  return { kind: 'empty', source: { start, end: start } };
}

function codePointWidthAt(value: string, offset: number): number {
  const codePoint = value.codePointAt(offset);
  return codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
}

function isDigit(value: string): boolean {
  return value.length === 1 && value >= '0' && value <= '9';
}

function digitValue(value: string, radix: number): number | null {
  const code = value.codePointAt(0);
  if (code === undefined) return null;
  const digit = code >= 48 && code <= 57 ? code - 48
    : code >= 65 && code <= 70 ? code - 55
      : code >= 97 && code <= 102 ? code - 87
        : -1;
  return digit >= 0 && digit < radix ? digit : null;
}

function classEscape(value: string): { readonly name: CharacterClassName; readonly negated: boolean } | undefined {
  if (value === 'I') return { name: 'identifier-no-digit', negated: false };
  if (value === 'K') return { name: 'keyword-no-digit', negated: false };
  if (value === 'F') return { name: 'filename-no-digit', negated: false };
  if (value === 'P') return { name: 'printable-no-digit', negated: false };
  const lower = value.toLowerCase();
  const name: CharacterClassName | undefined = lower === 'd' ? 'digit'
    : lower === 'w' ? 'word'
      : lower === 's' ? 'space'
        : lower === 'x' ? 'hex'
          : lower === 'o' ? 'octal'
            : lower === 'h' ? 'head'
              : lower === 'a' ? 'alpha'
                : lower === 'l' ? 'lower'
                  : lower === 'u' ? 'upper'
                    : lower === 'i' ? 'identifier'
                      : lower === 'k' ? 'keyword'
                        : lower === 'f' ? 'filename'
                          : lower === 'p' ? 'printable'
                            : undefined;
  return name === undefined ? undefined : { name, negated: value !== lower };
}

function posixClass(value: string): CharacterClassName | undefined {
  switch (value) {
    case 'alnum': return 'alnum';
    case 'alpha': return 'alpha';
    case 'blank': return 'blank';
    case 'cntrl': return 'control';
    case 'digit': return 'digit';
    case 'graph': return 'graph';
    case 'lower': return 'posix-lower';
    case 'print': return 'printable';
    case 'punct': return 'punctuation';
    case 'space': return 'posix-space';
    case 'upper': return 'posix-upper';
    case 'xdigit': return 'xdigit';
    case 'return': return 'return';
    case 'tab': return 'tab';
    case 'escape': return 'escape';
    case 'backspace': return 'backspace';
    case 'ident': return 'identifier';
    case 'keyword': return 'keyword';
    case 'fname': return 'filename';
    default: return undefined;
  }
}

function containsUppercaseLiteral(node: PatternNode): boolean {
  switch (node.kind) {
    case 'literal':
      return hasUppercase(node.value);
    case 'character-class':
      return node.parts.some((part) => part.kind === 'literal' && hasUppercase(part.value));
    case 'sequence':
      return node.terms.some(containsUppercaseLiteral);
    case 'alternate':
      return node.branches.some(containsUppercaseLiteral);
    case 'intersection':
      return node.concats.some(containsUppercaseLiteral);
    case 'optional-sequence':
      return node.atoms.some(containsUppercaseLiteral);
    case 'capture':
    case 'repeat':
    case 'assertion':
      return containsUppercaseLiteral(node.child);
    default:
      return false;
  }
}

function hasUppercase(value: string): boolean {
  for (const character of value) if (character.toLowerCase() !== character.toUpperCase() && character === character.toUpperCase()) return true;
  return false;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
