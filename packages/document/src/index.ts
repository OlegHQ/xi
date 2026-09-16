export type * from './contracts.ts';
export type { DocumentEdit, DocumentMutationFailure, DocumentTextIntent, RopeStorageMetrics } from './rope';
export { offsetToPosition, positionToOffset } from './coordinates';
export type { CoordinateFailure, EncodedTextPosition, PositionEncoding } from './coordinates';
export { encodeTextFile, encodeTextFileChunks, openTextDocument, openTextDocumentChunks, ReadOnlyByteDocument, TextFileDocument } from './text-fidelity';
export { LineEndingSequence } from './line-endings';
export type {
  LineEnding,
  LineEndingStorageMetrics,
  ChangeListenerFailure,
  ChangeListenerFailureDrain,
  OpenTextDocumentOptions,
  OpenTextDocument,
  ReadOnlyByteReason,
  TextDocumentCreateFailure,
  TextEncodingFailure,
  TextFileFormat,
  TextFileSnapshot,
} from './text-fidelity';
export { createDocumentAnchor, DocumentChangeMap, INSERTION_REPLACEMENT_BOUNDARY_POLICY, SAME_POSITION_INSERT_POLICY } from './transactions';
export type {
  AnchorAffinity,
  ChangeMapFailure,
  ChangedSpan,
  CommitOutcome,
  CommittedDocumentChange,
  DocumentAnchor,
  DocumentTransactionFailure,
  EditOrigin,
  EditProposal,
  SaveRevisionFailure,
  SaveRevisionIdentity,
  VersionedAnchor,
} from './transactions';
export { UNDO_HISTORY_FORMAT_VERSION, UNDO_HISTORY_POLICY } from './undo';
export type {
  RedoBranchInfo,
  UndoEntryInfo,
  UndoGroupFailure,
  UndoHistoryFailure,
  UndoHistoryStats,
  UndoOperationFailure,
  UndoOutcome,
} from './undo';
