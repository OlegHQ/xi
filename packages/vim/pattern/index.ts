export { compilePattern } from './parser';
export {
  createPatternEvaluation,
  createPatternTextSnapshot,
  findAllMatches,
  PatternEvaluationSession,
  patternSnapshotFromDocument,
  substituteAll,
} from './evaluator';
export type { PatternEvaluationProgress, PatternEvaluationResult } from './evaluator';
export { PatternEvaluationError } from './types';
export type {
  AssertionKind,
  CaptureSpan,
  CaseMode,
  CharacterClassName,
  CharacterClassPart,
  MagicMode,
  PatternErrorCode,
  PatternMatch,
  PatternNode,
  PatternOptions,
  PatternCharacterClassContext,
  PatternPositionContext,
  PatternProgram,
  PatternTextSnapshot,
  PatternVisualArea,
  PositionAxis,
  PositionPredicate,
  PositionRelation,
  SourceSpan,
} from './types';
