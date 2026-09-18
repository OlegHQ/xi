import type { CellColumn, DocumentReadFailure, DocumentVersion, LineIndex, Result, Utf16Offset } from '../../document/src/index';

export type MagicMode = 'magic' | 'nomagic' | 'very-magic' | 'very-nomagic';
export type CaseMode = 'option' | 'sensitive' | 'insensitive';
export type AssertionKind = 'ahead-positive' | 'ahead-negative' | 'behind-positive' | 'behind-negative' | 'atomic';
export type CharacterClassName =
  | 'digit' | 'word' | 'space' | 'hex' | 'octal' | 'head' | 'alpha' | 'lower' | 'upper'
  | 'identifier' | 'identifier-no-digit' | 'keyword' | 'keyword-no-digit' | 'filename' | 'filename-no-digit' | 'printable' | 'printable-no-digit'
  | 'posix-lower' | 'posix-upper'
  | 'alnum' | 'blank' | 'control' | 'graph' | 'posix-space' | 'punctuation' | 'xdigit'
  | 'return' | 'tab' | 'escape' | 'backspace';

export interface SourceSpan {
  /** UTF-16 code-unit range in the pattern source. */
  readonly start: number;
  readonly end: number;
}

interface NodeBase {
  readonly source: SourceSpan;
}

export type PositionAxis = 'line' | 'byte-column' | 'virtual-column';
export type PositionRelation = 'equal' | 'less-than' | 'greater-than';

export interface PositionPredicate {
  readonly axis: PositionAxis;
  readonly relation: PositionRelation;
  readonly target: { readonly kind: 'number'; readonly value: number } | { readonly kind: 'cursor' };
}

export type PatternVisualArea =
  /** Selected document range; offsets are half-open UTF-16 boundaries. */
  | { readonly kind: 'characterwise'; readonly start: Utf16Offset; readonly end: Utf16Offset }
  /** Inclusive zero-based logical line interval. */
  | { readonly kind: 'linewise'; readonly firstLine: LineIndex; readonly lastLine: LineIndex }
  /** Inclusive logical lines and zero-based display-cell interval. */
  | { readonly kind: 'blockwise'; readonly firstLine: LineIndex; readonly lastLine: LineIndex; readonly firstCell: CellColumn; readonly lastCell: CellColumn };

/**
 * Immutable Vim window context captured for one document version. Offsets use
 * UTF-16 boundaries; virtual/block columns use zero-based display cells, while
 * Vim's `\%c` and `\%v` pattern operands remain one-based.
 */
export interface PatternPositionContext {
  readonly version: DocumentVersion;
  readonly cursor?: Utf16Offset;
  readonly visualArea?: PatternVisualArea;
  /** Single-character Vim mark names mapped to UTF-16 document boundaries. */
  readonly marks?: Readonly<Record<string, Utf16Offset>>;
  /** Vim's `tabstop`; defaults to 8. */
  readonly tabstop?: number;
  /** Layout-compatible terminal cell measurement; defaults to Xi's standard width policy. */
  readonly widthPolicy?: {
    readonly id: string;
    readonly generation: number;
    readonly widthOfCluster: (cluster: string) => number;
  };
}

/** Buffer-local Vim options captured for one immutable document version. */
export interface PatternCharacterClassContext {
  readonly version: DocumentVersion;
  /** Vim `'iskeyword'`; defaults to `@,48-57,_,192-255`. */
  readonly isKeyword?: string;
  /** Vim `'isident'`; defaults to `@,48-57,_,192-255`. */
  readonly isIdent?: string;
  /** Vim `'isfname'`; defaults to `@,48-57,/,.,-,_,+,,,#,$,%,~,=`. */
  readonly isFilename?: string;
  /** Vim `'isprint'`; defaults to `@,161-255`. */
  readonly isPrintable?: string;
}

export type PatternNode =
  | (NodeBase & { readonly kind: 'empty' })
  | (NodeBase & { readonly kind: 'sequence'; readonly terms: readonly PatternNode[] })
  | (NodeBase & { readonly kind: 'alternate'; readonly branches: readonly PatternNode[] })
  | (NodeBase & { readonly kind: 'intersection'; readonly concats: readonly PatternNode[] })
  | (NodeBase & { readonly kind: 'optional-sequence'; readonly atoms: readonly PatternNode[] })
  | (NodeBase & { readonly kind: 'literal'; readonly value: string; readonly caseMode: CaseMode; readonly matchComposing?: boolean })
  | (NodeBase & { readonly kind: 'dot'; readonly includeNewline: boolean })
  | (NodeBase & { readonly kind: 'character-class'; readonly parts: readonly CharacterClassPart[]; readonly negated: boolean; readonly includeNewline: boolean; readonly caseMode: CaseMode })
  | (NodeBase & { readonly kind: 'anchor'; readonly anchor: 'line-start' | 'line-end' | 'file-start' | 'file-end' | 'word-start' | 'word-end' | 'cursor' })
  | (NodeBase & { readonly kind: 'anchor'; readonly anchor: 'line-number'; readonly expected: number })
  | (NodeBase & { readonly kind: 'anchor'; readonly anchor: 'position'; readonly predicate: PositionPredicate })
  | (NodeBase & { readonly kind: 'anchor'; readonly anchor: 'mark'; readonly mark: string; readonly relation: PositionRelation })
  | (NodeBase & { readonly kind: 'anchor'; readonly anchor: 'visual-area' })
  | (NodeBase & { readonly kind: 'capture'; readonly group: number; readonly child: PatternNode })
  | (NodeBase & { readonly kind: 'repeat'; readonly child: PatternNode; readonly minimum: number; readonly maximum: number | null; readonly greedy: boolean })
  | (NodeBase & { readonly kind: 'backreference'; readonly group: number; readonly caseMode: CaseMode })
  | (NodeBase & { readonly kind: 'assertion'; readonly assertion: AssertionKind; readonly child: PatternNode; readonly lookbehindLimitBytes?: number })
  | (NodeBase & { readonly kind: 'skip-combining' })
  | (NodeBase & { readonly kind: 'set-start' })
  | (NodeBase & { readonly kind: 'set-end' });

export type CharacterClassPart =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'range'; readonly first: number; readonly last: number }
  | { readonly kind: 'class'; readonly name: CharacterClassName; readonly negated?: boolean };

export interface PatternOptions {
  readonly magic?: boolean;
  readonly ignoreCase?: boolean;
  readonly smartCase?: boolean;
  /** Cursor positions are meaningful only in the exact immutable document version. */
  readonly cursor?: { readonly version: DocumentVersion; readonly offset: Utf16Offset };
  /** Complete snapshot-bound Vim positional context for built-in `\%` atoms. */
  readonly positionContext?: PatternPositionContext;
  /** Snapshot-bound Vim character-class options for `\i`, `\k`, `\f`, and `\p`. */
  readonly characterClassContext?: PatternCharacterClassContext;
  readonly stepBudget?: number;
  readonly outputLimit?: number;
  readonly cancellationCheckInterval?: number;
  readonly shouldCancel?: () => boolean;
  /** The last `:substitute` replacement text, for the `~` atom (matches it literally). */
  readonly previousSubstituteText?: string;
}

/** Immutable text and version captured from one Xi document snapshot. Offsets use UTF-16 units. */
export interface PatternTextSnapshot {
  readonly version: DocumentVersion;
  /** Materialized text for short/test snapshots. Document-backed snapshots may leave this empty. */
  readonly text: string;
  /** UTF-16 length; defaults to `text.length` for materialized snapshots. */
  readonly lengthUtf16?: number;
  /** Bounded UTF-16 range reader for document-backed snapshots. */
  readonly read?: (start: Utf16Offset, end: Utf16Offset) => Result<string, DocumentReadFailure>;
  /** Optional owner-provided aggregate for the ASCII literal scan path. */
  readonly isPrintableAsciiRange?: (start: Utf16Offset, end: Utf16Offset) => Result<boolean, DocumentReadFailure>;
  /** Optional document-owned indexed line conversion for bounded large-document position atoms. */
  readonly lineIndexAt?: (offset: Utf16Offset) => Result<LineIndex, DocumentReadFailure>;
  readonly lineStartOffset?: (line: LineIndex) => Result<Utf16Offset, DocumentReadFailure>;
  readonly lineCount?: number;
}

export interface PatternProgram {
  readonly source: string;
  readonly root: PatternNode;
  readonly captureCount: number;
  readonly stepBudget: number;
  readonly outputLimit: number;
  readonly cancellationCheckInterval: number;
  readonly shouldCancel?: () => boolean;
  readonly cursor?: { readonly version: DocumentVersion; readonly offset: Utf16Offset };
  readonly positionContext?: PatternPositionContext;
  readonly characterClassContext?: PatternCharacterClassContext;
  readonly initialCaseMode: CaseMode;
  readonly defaultIgnoreCase: boolean;
  readonly ignoreCombining: boolean;
  readonly leadingCombining: string;
  readonly engineSelector: 0 | 1 | 2;
  readonly features: {
    readonly containsNewlineAtom: boolean;
    readonly containsLineBoundary: boolean;
    readonly containsLookaround: boolean;
    readonly containsBackreference: boolean;
    readonly containsPositionAtom: boolean;
    readonly containsLineNumberAtom: boolean;
    readonly containsColumnAtom: boolean;
    readonly containsVisualAreaAtom: boolean;
    readonly containsIntersection: boolean;
    readonly containsOptionalSequence: boolean;
    readonly containsCombiningAtom: boolean;
  };
}

export interface CaptureSpan {
  readonly start: Utf16Offset;
  readonly end: Utf16Offset;
}

export interface PatternMatch {
  /** Reported half-open range after Vim's `\zs` and `\ze` adjustments. */
  readonly start: Utf16Offset;
  readonly end: Utf16Offset;
  /** Consumed half-open range used to advance the next search attempt. */
  readonly consumedStart: Utf16Offset;
  readonly consumedEnd: Utf16Offset;
  readonly captures: ReadonlyMap<number, CaptureSpan>;
}

export type PatternErrorCode =
  | 'invalid-pattern'
  | 'unsupported-construct'
  | 'step-budget-exceeded'
  | 'cancelled'
  | 'output-limit-exceeded'
  | 'stale-position'
  | 'program-limit-exceeded';

export class PatternEvaluationError extends Error {
  constructor(
    readonly code: PatternErrorCode,
    message: string,
    readonly steps: number,
    readonly source?: SourceSpan,
  ) {
    super(message);
    this.name = 'PatternEvaluationError';
  }
}
