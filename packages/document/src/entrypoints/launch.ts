/** Small public document surface used by the standalone launcher. */
export {
  openTextDocument,
  openTextDocumentChunks,
  encodeTextFile,
  encodeTextFileChunks,
  TextFileDocument,
  ReadOnlyByteDocument,
} from '../text-fidelity';
export { createDocumentAnchor, DocumentChangeMap } from '../transactions';
export { positionToOffset } from '../coordinates';
export type { DocumentAnchor } from '../transactions';
export type {
  DocumentSnapshot,
  DocumentReadPort,
} from '../contracts';
export type {
  OpenTextDocumentOptions,
  OpenTextDocument,
  TextFileSnapshot,
  ReadOnlyByteReason,
  TextDocumentCreateFailure,
  TextEncodingFailure,
} from '../text-fidelity';
export type { RevisionId } from '../../../primitives/src/index';
