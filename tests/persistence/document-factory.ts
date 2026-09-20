// PersistenceService (a service) no longer constructs documents itself
// (docs/architecture.md); every test that opens/recovers a real file must inject a
// `PersistenceDocumentFactory` the way the composition root (`apps/xi/src/main.ts`) does.
import { openTextDocument, openTextDocumentChunks, TextFileDocument } from '../../packages/document/src/index';
import type { PersistenceDocumentFactory } from '../../packages/services/persistence/index';

export const testDocumentFactory: PersistenceDocumentFactory = {
  openText: (documentId, bytes, seed, options) => openTextDocument(documentId, bytes, seed, options),
  openTextChunks: (documentId, chunks, seed, options) => openTextDocumentChunks(documentId, chunks, seed, options),
  restoreCheckpoint: (documentId, text, lineEndings, defaultLineEnding, hasUtf8Bom, seed, textIntent) =>
    TextFileDocument.create(documentId, text, lineEndings, defaultLineEnding, hasUtf8Bom, seed, textIntent),
};
