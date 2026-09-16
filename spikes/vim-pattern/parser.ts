import {
  PatternEvaluationError,
  type AssertionKind,
  type CaseMode,
  type CharacterClassName,
  type CharacterClassPart,
  type MagicMode,
  type PatternNode,
  type PatternOptions,
  type PatternProgram,
  type SourceSpan,
} from './types';

export function compilePattern(source: string, options: PatternOptions = {}): PatternProgram {
  return new Parser(source, options).compile();
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

  constructor(private readonly source: string, private readonly options: PatternOptions) {
    this.magic = options.magic === false ? 'nomagic' : 'magic';
  }

  compile(): PatternProgram {
    const root = this.parseAlternative(false);
    if (this.index !== this.source.length) this.invalid(`unexpected-pattern-token: ${this.source.slice(this.index)}`, this.index, this.source.length);
    return {
      source: this.source,
      root,
      captureCount: this.captureCount,
      stepBudget: this.options.stepBudget ?? 250_000,
      outputLimit: this.options.outputLimit ?? 100_000,
      cancellationCheckInterval: Math.max(1, this.options.cancellationCheckInterval ?? 64),
      ...(this.options.shouldCancel === undefined ? {} : { shouldCancel: this.options.shouldCancel }),
      ...(this.options.cursorOffset === undefined ? {} : { cursorOffset: this.options.cursorOffset }),
      initialCaseMode: this.options.ignoreCase === true ? 'insensitive' : 'sensitive',
      features: {
        containsNewlineAtom: this.containsNewlineAtom,
        containsLineBoundary: this.containsLineBoundary,
        containsLookaround: this.containsLookaround,
        containsBackreference: this.containsBackreference,
        containsPositionAtom: this.containsPositionAtom,
      },
    };
  }

  private parseAlternative(inGroup: boolean): PatternNode {
    const start = this.index;
    const branches: PatternNode[] = [];
    let terms: PatternNode[] = [];
    while (this.index < this.source.length) {
      if (inGroup && this.isGroupClose()) break;
      if (this.isAlternative()) {
        branches.push(sequence(terms, start, this.index));
        terms = [];
        this.consumeAlternative();
        continue;
      }
      if (this.consumeDirective()) continue;
      terms.push(this.parsePiece(terms.length === 0));
    }
    branches.push(sequence(terms, start, this.index));
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
    while (this.isEscape('@')) {
      const assertionStart = this.index;
      this.index += 2;
      const next = this.source[this.index];
      let assertion: AssertionKind;
      if (next === '=') {
        assertion = 'ahead-positive';
        this.index += 1;
      } else if (next === '!') {
        assertion = 'ahead-negative';
        this.index += 1;
      } else if (next === '<' && this.source[this.index + 1] === '=') {
        assertion = 'behind-positive';
        this.index += 2;
      } else if (next === '<' && this.source[this.index + 1] === '!') {
        assertion = 'behind-negative';
        this.index += 2;
      } else if (next === '>') {
        this.unsupported('atomic-pattern-not-implemented', assertionStart, this.index + 1);
      } else {
        this.unsupported('assertion-form-not-implemented', assertionStart, Math.min(this.source.length, this.index + 2));
      }
      this.containsLookaround = true;
      atom = { kind: 'assertion', assertion, child: atom, source: { start, end: this.index } };
    }
    return atom;
  }

  private parseAtom(atBranchStart: boolean): PatternNode {
    const start = this.index;
    const value = this.source[this.index];
    if (value === undefined) return empty(start);

    if (this.isGroupOpen()) return this.parseGroup(true);
    if (this.isNonCapturingGroupOpen()) return this.parseGroup(false);
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

    const width = codePointWidthAt(this.source, this.index);
    const literal = this.source.slice(this.index, this.index + width);
    this.index += width;
    return { kind: 'literal', value: literal, caseMode: this.caseMode, source: { start, end: this.index } };
  }

  private parseGroup(capturing: boolean): PatternNode {
    const start = this.index;
    const openingWidth = this.isNonCapturingGroupOpen() ? 3 : this.isEscape('(') ? 2 : 1;
    this.index += openingWidth;
    const group = capturing ? ++this.captureCount : 0;
    const child = this.parseAlternative(true);
    if (!this.isGroupClose()) this.invalid('unclosed-group', start, this.source.length);
    this.index += this.isEscape(')') ? 2 : 1;
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
      this.invalid('unsupported-z-construct', start, Math.min(this.source.length, this.index + 1));
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
    if (escaped === 'd' || escaped === 'D' || escaped === 'w' || escaped === 'W' || escaped === 's' || escaped === 'S') {
      const name = escaped.toLowerCase() === 'd' ? 'digit' : escaped.toLowerCase() === 'w' ? 'word' : 'space';
      return this.classNode(start, [{ kind: 'class', name }], escaped === 'D' || escaped === 'W' || escaped === 'S', false);
    }
    if (escaped === '<' || escaped === '>') {
      return { kind: 'anchor', anchor: escaped === '<' ? 'word-start' : 'word-end', source: { start, end: this.index } };
    }
    if (escaped === 'm' || escaped === 'M' || escaped === 'v' || escaped === 'V' || escaped === 'c' || escaped === 'C') {
      this.applyDirective(escaped);
      return empty(start);
    }
    if (escaped === '(' || escaped === ')' || escaped === '|' || escaped === '+' || escaped === '?' || escaped === '=' || escaped === '*' || escaped === '{') {
      if (this.magic === 'very-magic') {
        return { kind: 'literal', value: escaped, caseMode: this.caseMode, source: { start, end: this.index } };
      }
      if (escaped === '*' && this.magic !== 'nomagic' && this.magic !== 'very-nomagic') {
        return { kind: 'literal', value: '*', caseMode: this.caseMode, source: { start, end: this.index } };
      }
      this.invalid(`unexpected-pattern-operator: \\${escaped}`, start, this.index);
    }
    this.invalid(`unsupported-escape: \\${escaped}`, start, this.index);
  }

  private parsePositionAtom(start: number): PatternNode {
    const next = this.source[this.index];
    if (next === '#' && this.source[this.index + 1] === '=') {
      this.unsupported('regexp-engine-selector-not-implemented', start, this.index + 2);
    }
    if (next === '^' || next === '$' || next === '#') {
      this.index += 1;
      this.containsPositionAtom = true;
      if (next === '^') return { kind: 'anchor', anchor: 'file-start', source: { start, end: this.index } };
      if (next === '$') return { kind: 'anchor', anchor: 'file-end', source: { start, end: this.index } };
      return { kind: 'anchor', anchor: 'cursor', source: { start, end: this.index } };
    }
    if (next !== undefined && isDigit(next)) {
      let value = 0;
      while (this.index < this.source.length) {
        const digit = this.source.charCodeAt(this.index) - 48;
        if (digit < 0 || digit > 9) break;
        value = value * 10 + digit;
        if (!Number.isSafeInteger(value)) this.invalid('position-number-out-of-range', start, this.index + 1);
        this.index += 1;
      }
      const kind = this.source[this.index];
      if (kind !== 'l') this.invalid('unsupported-position-atom: expected line-position suffix l', start, this.index + 1);
      this.index += 1;
      this.containsPositionAtom = true;
      return { kind: 'anchor', anchor: 'line-number', expected: value, source: { start, end: this.index } };
    }
    this.invalid('unsupported-position-atom', start, Math.min(this.source.length, this.index + 1));
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
    if (code === 's' || code === 'S' || code === 'w' || code === 'W' || code === 'd' || code === 'D') {
      const name = code.toLowerCase() === 'd' ? 'digit' : code.toLowerCase() === 'w' ? 'word' : 'space';
      this.containsNewlineAtom = true;
      return this.classNode(start, [{ kind: 'class', name }], code === 'S' || code === 'W' || code === 'D', true);
    }
    this.invalid(`unsupported-newline-class: \\_${code}`, start, this.index);
  }

  private parseCharacterClass(negatedPrefixAllowed: boolean, start: number): PatternNode {
    this.index += 1;
    let negated = false;
    if (negatedPrefixAllowed && this.source[this.index] === '^') {
      negated = true;
      this.index += 1;
    }
    const parts: CharacterClassPart[] = [];
    let closed = false;
    while (this.index < this.source.length) {
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
    return this.classNode(start, parts, negated, false);
  }

  private parseClassCharacter(start: number): CharacterClassPart {
    if (this.source[this.index] !== '\\') {
      const width = codePointWidthAt(this.source, this.index);
      const value = this.source.slice(this.index, this.index + width);
      this.index += width;
      return { kind: 'literal', value };
    }
    const escapeStart = this.index;
    this.index += 1;
    const escaped = this.source[this.index];
    if (escaped === undefined) this.invalid('trailing-character-class-backslash', escapeStart, this.index);
    this.index += 1;
    if (escaped === 'd' || escaped === 'D' || escaped === 'w' || escaped === 'W' || escaped === 's' || escaped === 'S') {
      return { kind: 'class', name: escaped.toLowerCase() === 'd' ? 'digit' : escaped.toLowerCase() === 'w' ? 'word' : 'space', ...(escaped === 'D' || escaped === 'W' || escaped === 'S' ? { negated: true } : {}) } as CharacterClassPart;
    }
    const value = escaped === 't' ? '\t' : escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped;
    if (value === undefined) this.invalid('empty-character-class-escape', start, this.index);
    return { kind: 'literal', value };
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

  private consumeAlternative(): void {
    this.index += this.magic === 'very-magic' ? 1 : 2;
  }

  private isSequenceEnd(index: number): boolean {
    if (index >= this.source.length) return true;
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
  if (terms.length === 1) return terms[0] ?? empty(start);
  return { kind: 'sequence', terms, source: { start, end } };
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
