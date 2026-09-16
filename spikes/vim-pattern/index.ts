export { compilePattern } from './parser';
export { evaluateWithStats, findAllMatches, substituteAll } from './evaluator';
export { PatternEvaluationError } from './types';
export type {
  AssertionKind,
  CaptureSpan,
  CaseMode,
  CharacterClassPart,
  MagicMode,
  PatternErrorCode,
  PatternMatch,
  PatternNode,
  PatternOptions,
  PatternProgram,
  SourceSpan,
} from './types';
