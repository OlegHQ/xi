import type { Disposable, DocumentId, DocumentVersion, RequestId, SyntaxRead, SyntaxReadPort, SyntaxSpan } from '../../contracts/src/index';
import type { CommittedDocumentChange, DocumentSnapshot } from '../../document/src/index';
import {
  IncrementalSyntaxHighlighter,
  type SyntaxDelta,
  type SyntaxHighlightResult,
  type SyntaxHighlighterOptions,
  type SyntaxParseRequest,
} from './index';

export type SyntaxDocumentTrackerOptions = SyntaxHighlighterOptions;

export interface SyntaxOpenDocumentRequest {
  readonly documentId: DocumentId;
  readonly languageId: string | undefined;
  readonly snapshot: DocumentSnapshot;
}

/** Thin delegate: the highlighter's result already computes/caches spansInRange lazily. */
class DocumentSyntaxRead implements SyntaxRead {
  readonly #result: SyntaxHighlightResult;
  constructor(result: SyntaxHighlightResult) { this.#result = result; }
  get documentVersion(): DocumentVersion { return this.#result.documentVersion; }
  spansInRange(start: number, end: number): readonly SyntaxSpan[] { return this.#result.spansInRange(start, end); }
}

/**
 * Owns the syntax highlighter for every open document and exposes the read-only
 * `SyntaxReadPort` boundary the UI paints from. `changeDocument` only records the
 * committed snapshot/delta and schedules a background parse; it never parses
 * synchronously on the caller's stack.
 */
export class SyntaxDocumentTracker implements SyntaxReadPort, Disposable {
  readonly #highlighter: IncrementalSyntaxHighlighter;
  readonly #languageIds = new Map<DocumentId, string | undefined>();
  readonly #reads = new Map<DocumentId, DocumentSyntaxRead>();
  readonly #listeners = new Set<(result: SyntaxHighlightResult) => void>();
  readonly #resultSubscription: Disposable;
  #generation = 0;
  #requestSequence = 0;

  constructor(options: SyntaxDocumentTrackerOptions = {}) {
    this.#highlighter = new IncrementalSyntaxHighlighter(options);
    this.#resultSubscription = this.#highlighter.onResult((result) => {
      this.#reads.set(result.documentId, new DocumentSyntaxRead(result));
      for (const listener of this.#listeners) listener(result);
    });
  }

  openDocument(request: SyntaxOpenDocumentRequest): void {
    this.#languageIds.set(request.documentId, request.languageId);
    this.#submit(request.documentId, request.snapshot, request.languageId, undefined);
  }

  changeDocument(change: CommittedDocumentChange): void {
    if (!this.#languageIds.has(change.documentId)) return;
    const languageId = this.#languageIds.get(change.documentId);
    const delta: SyntaxDelta | undefined = change.changedSpans.length === 1
      ? { start: change.changedSpans[0]!.start, oldEnd: change.changedSpans[0]!.oldEnd, newEnd: change.changedSpans[0]!.newEnd }
      : undefined;
    this.#submit(change.documentId, change.snapshot, languageId, delta);
  }

  closeDocument(documentId: DocumentId): void {
    this.#languageIds.delete(documentId);
    this.#reads.delete(documentId);
    this.#highlighter.closeDocument(documentId);
  }

  onResult(listener: (result: SyntaxHighlightResult) => void): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => { this.#listeners.delete(listener); } };
  }

  readSyntax(documentId: DocumentId): SyntaxRead | undefined {
    return this.#reads.get(documentId);
  }

  diagnostics(): ReturnType<IncrementalSyntaxHighlighter['diagnostics']> { return this.#highlighter.diagnostics(); }

  dispose(): void {
    this.#resultSubscription.dispose();
    this.#highlighter.dispose();
    this.#languageIds.clear();
    this.#reads.clear();
    this.#listeners.clear();
  }

  #submit(documentId: DocumentId, snapshot: DocumentSnapshot, languageId: string | undefined, delta: SyntaxDelta | undefined): void {
    this.#requestSequence += 1;
    const generation = this.#generation;
    this.#generation += 1;
    const request: SyntaxParseRequest = {
      documentId,
      documentVersion: snapshot.version,
      requestId: `syntax-${documentId}-${this.#requestSequence}` as RequestId,
      generation,
      snapshot,
      ...(delta === undefined ? {} : { delta }),
      ...(languageId === undefined ? {} : { languageId }),
    };
    this.#highlighter.submit(request);
  }
}
