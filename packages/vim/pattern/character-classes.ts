import type { PatternCharacterClassContext } from './types';

export interface VimCharacterClassRule {
  readonly include: boolean;
  readonly kind: 'alpha' | 'range';
  readonly first: number;
  readonly last: number;
}

export interface CompiledPatternCharacterClasses {
  readonly identifier: readonly VimCharacterClassRule[];
  readonly keyword: readonly VimCharacterClassRule[];
  readonly filename: readonly VimCharacterClassRule[];
  readonly printable: readonly VimCharacterClassRule[];
}

const defaultIdentifier = '@,48-57,_,192-255';
const defaultKeyword = '@,48-57,_,192-255';
const defaultFilename = '@,48-57,/,.,-,_,+,,,#,$,%,~,=';
const defaultPrintable = '@,161-255';
const maximumOptionLength = 4_096;
const maximumOptionRules = 1_024;

const unicodeLetter = /^\p{L}$/u;
const unicodeDecimalDigit = /^\p{Nd}$/u;
const unicodeEmoji = /^\p{Extended_Pictographic}$/u;

/**
 * Validates option syntax when a program is compiled. Vim's option grammar
 * only permits numeric/character endpoints through U+00FF; `@` is the option
 * token that describes the supported alphabetic multibyte behavior.
 */
export function validatePatternCharacterClassContext(
  context: PatternCharacterClassContext,
): string | undefined {
  if (!Number.isSafeInteger(context.version as number) || (context.version as number) < 0) return 'invalid-version';
  const options = [
    ['isKeyword', context.isKeyword],
    ['isIdent', context.isIdent],
    ['isFilename', context.isFilename],
    ['isPrintable', context.isPrintable],
  ] as const;
  for (const [name, value] of options) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > maximumOptionLength) return `${name}-option-limit-exceeded`;
    if (parseVimOption(value) === undefined) return `invalid-${name}-option`;
  }
  return undefined;
}

export function compilePatternCharacterClasses(
  context: PatternCharacterClassContext | undefined,
): CompiledPatternCharacterClasses {
  return {
    identifier: requireVimOption(context?.isIdent ?? defaultIdentifier),
    keyword: requireVimOption(context?.isKeyword ?? defaultKeyword),
    filename: requireVimOption(context?.isFilename ?? defaultFilename),
    printable: requireVimOption(context?.isPrintable ?? defaultPrintable),
  };
}

export function matchesOptionRule(rule: VimCharacterClassRule, codePoint: number): boolean {
  return rule.kind === 'alpha'
    ? isAlphaOptionCharacter(codePoint)
    : codePoint >= rule.first && codePoint <= rule.last;
}

export function optionRulesFor(
  name: 'identifier' | 'keyword' | 'filename' | 'printable',
  options: CompiledPatternCharacterClasses,
): readonly VimCharacterClassRule[] {
  switch (name) {
    case 'identifier': return options.identifier;
    case 'keyword': return options.keyword;
    case 'filename': return options.filename;
    case 'printable': return options.printable;
    default: return unreachable(name);
  }
}

export function isWideKeywordCharacter(codePoint: number): boolean {
  if (codePoint < 256) return false;
  const scalar = String.fromCodePoint(codePoint);
  // The pinned matcher recognizes Unicode letters, BMP decimal digits and
  // extended pictographs. Supplementary numeric symbols are not `\k` matches
  // in Neovim 0.12.4 despite being general-category numbers.
  return unicodeLetter.test(scalar) || (codePoint <= 0xffff && unicodeDecimalDigit.test(scalar)) || unicodeEmoji.test(scalar);
}

export function isUnicodeLowercaseLetter(codePoint: number): boolean {
  return unicodeLowercaseLetter.test(String.fromCodePoint(codePoint));
}

export function isUnicodeUppercaseLetter(codePoint: number): boolean {
  return unicodeUppercaseLetter.test(String.fromCodePoint(codePoint));
}

export function isUnicodeLetter(codePoint: number): boolean {
  return unicodeLetter.test(String.fromCodePoint(codePoint));
}

function isAlphaOptionCharacter(codePoint: number): boolean {
  return codePoint <= 0xff && unicodeLetter.test(String.fromCodePoint(codePoint));
}

function parseVimOption(value: string): readonly VimCharacterClassRule[] | undefined {
  if (value.length === 0) return [];
  const rules: VimCharacterClassRule[] = [];
  for (const item of value.split(',')) {
    let include = true;
    let token = item;
    if (token.startsWith('^')) {
      include = false;
      token = token.slice(1);
    }
    if (token.length === 0) {
      rules.push({ include, kind: 'range', first: 44, last: 44 });
      continue;
    }
    if (token === '@') {
      rules.push({ include, kind: 'alpha', first: 0, last: 255 });
      continue;
    }
    if (token === '@-@') {
      rules.push({ include, kind: 'range', first: 64, last: 64 });
      continue;
    }
    const separator = token.indexOf('-');
    if (separator > 0 && separator < token.length - 1) {
      const first = parseOptionEndpoint(token.slice(0, separator));
      const last = parseOptionEndpoint(token.slice(separator + 1));
      if (first === undefined || last === undefined || first > last) return undefined;
      rules.push({ include, kind: 'range', first, last });
      continue;
    }
    const point = parseOptionEndpoint(token);
    if (point === undefined) return undefined;
    rules.push({ include, kind: 'range', first: point, last: point });
    if (rules.length > maximumOptionRules) return undefined;
  }
  return rules.length <= maximumOptionRules ? rules : undefined;
}

function parseOptionEndpoint(value: string): number | undefined {
  if (/^\d+$/u.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 && number <= 255 ? number : undefined;
  }
  const scalars = [...value];
  const codePoint = scalars.length === 1 ? scalars[0]?.codePointAt(0) : undefined;
  return codePoint !== undefined && codePoint <= 255 ? codePoint : undefined;
}

function requireVimOption(value: string): readonly VimCharacterClassRule[] {
  const rules = parseVimOption(value);
  if (rules === undefined) throw new Error('validated-vim-class-option-became-invalid');
  return rules;
}

const unicodeLowercaseLetter = /^\p{Lowercase_Letter}$/u;
const unicodeUppercaseLetter = /^\p{Uppercase_Letter}$/u;

function unreachable(value: never): never {
  throw new Error(`unreachable-vim-character-class-option: ${String(value)}`);
}
