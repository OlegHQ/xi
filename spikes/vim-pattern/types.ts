export type MagicMode = 'magic' | 'nomagic' | 'very-magic' | 'very-nomagic';
export type CaseMode = 'option' | 'sensitive' | 'insensitive';
export type AssertionKind = 'ahead-positive' | 'ahead-negative' | 'behind-positive' | 'behind-negative';
export type CharacterClassName = 'digit' | 'word' | 'space';

export interface SourceSpan {
  /** UTF-16 code-unit range in the pattern source. */
  readonly start: number;
  readonly end: number;
}

interface NodeBase {
  readonly source: SourceSpan;
}

export type PatternNode =
  | (NodeBase & { readonly kind: 'empty' })
  | (NodeBase & { readonly kind: 'sequence'; readonly terms: readonly PatternNode[] })
  | (NodeBase & { readonly kind: 'alternate'; readonly branches: readonly PatternNode[] })
  | (NodeBase & { readonly kind: 'literal'; readonly value: string; readonly caseMode: CaseMode })
  | (NodeBase & { readonly kind: 'dot'; readonly includeNewline: boolean })
  | (NodeBase & { readonly kind: 'character-class'; readonly parts: readonly CharacterClassPart[]; readonly negated: boolean; readonly includeNewline: boolean; readonly caseMode: CaseMode })
  | (NodeBase & { readonly kind: 'anchor'; readonly anchor: 'line-start' | 'line-end' | 'file-start' | 'file-end' | 'word-start' | 'word-end' | 'cursor' | 'line-number'; readonly expected?: number })
  | (NodeBase & { readonly kind: 'capture'; readonly group: number; readonly child: PatternNode })
  | (NodeBase & { readonly kind: 'repeat'; readonly child: PatternNode; readonly minimum: number; readonly maximum: number | null; readonly greedy: boolean })
  | (NodeBase & { readonly kind: 'backreference'; readonly group: number; readonly caseMode: CaseMode })
  | (NodeBase & { readonly kind: 'assertion'; readonly assertion: AssertionKind; readonly child: PatternNode })
  | (NodeBase & { readonly kind: 'set-start' })
  | (NodeBase & { readonly kind: 'set-end' });

export type CharacterClassPart =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'range'; readonly first: number; readonly last: number }
  | { readonly kind: 'class'; readonly name: CharacterClassName; readonly negated?: boolean };

export interface PatternOptions {
  readonly magic?: boolean;
  readonly ignoreCase?: boolean;
  readonly cursorOffset?: number;
  readonly stepBudget?: number;
  readonly outputLimit?: number;
  readonly cancellationCheckInterval?: number;
  readonly shouldCancel?: () => boolean;
}

export interface PatternProgram {
  readonly source: string;
  readonly root: PatternNode;
  readonly captureCount: number;
  readonly stepBudget: number;
  readonly outputLimit: number;
  readonly cancellationCheckInterval: number;
  readonly shouldCancel?: () => boolean;
  readonly cursorOffset?: number;
  readonly initialCaseMode: CaseMode;
  readonly features: {
    readonly containsNewlineAtom: boolean;
    readonly containsLineBoundary: boolean;
    readonly containsLookaround: boolean;
    readonly containsBackreference: boolean;
    readonly containsPositionAtom: boolean;
  };
}

export interface CaptureSpan {
  readonly start: number;
  readonly end: number;
}

export interface PatternMatch {
  /** Reported half-open range after Vim's `\zs` and `\ze` adjustments. */
  readonly start: number;
  readonly end: number;
  /** Consumed half-open range used to advance the next search attempt. */
  readonly consumedStart: number;
  readonly consumedEnd: number;
  readonly captures: ReadonlyMap<number, CaptureSpan>;
}

export type PatternErrorCode = 'invalid-pattern' | 'unsupported-construct' | 'step-budget-exceeded' | 'cancelled' | 'output-limit-exceeded';

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
