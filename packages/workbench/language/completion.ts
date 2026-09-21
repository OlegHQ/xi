import { asIdentifier, asLineIndex, asUtf16Offset, CancellationSource, type CancellationToken, type Disposable, type DocumentId, type Result, type UndoGroupId, type Utf16Offset, type ViewId } from '../../contracts/src/index';
import { offsetToPosition, type CommittedDocumentChange, type DocumentEdit, type DocumentSnapshot } from '../../document/src/index';
import type { SelectionSetSnapshot } from '../../selections/src/index';
import type { OwnedVimKeyEvent, OwnedVimSession } from '../vim-session';
import type { BufferHost } from '../host';
import type { WorkbenchViewSnapshot } from '../src/read-model';
import { buildNavigationRequest, type LanguageServerSessionPort, type LanguageWorkbenchSessionPort, type WorkbenchNavigationRequest } from './overlays';

export type { OwnedVimKeyEvent as CompletionKeyEvent };

/** Mirrors `packages/services/language`'s completion position/edit/item/request types. */
export interface WorkbenchCompletionPosition { readonly line: number; readonly utf16: number; }
export interface WorkbenchCompletionTextEdit { readonly start: WorkbenchCompletionPosition; readonly end: WorkbenchCompletionPosition; readonly newText: string; }
export interface WorkbenchCompletionItem {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly documentation?: string;
  readonly textEdit?: WorkbenchCompletionTextEdit;
  readonly textEditReplace?: WorkbenchCompletionTextEdit;
  readonly textEditIsFallback?: boolean;
  readonly textEditIsWordSuffix?: boolean;
  readonly additionalTextEdits?: readonly WorkbenchCompletionTextEdit[];
  readonly commitCharacters?: readonly string[];
  readonly insertTextFormat?: 'plain' | 'snippet';
  readonly resolveData?: unknown;
}
export interface WorkbenchCompletionRequest extends WorkbenchNavigationRequest { readonly trigger: 'invoked' | 'character' | 'retrigger'; }
export interface WorkbenchCompletionList { readonly isIncomplete: boolean; readonly items: readonly WorkbenchCompletionItem[]; }
export type WorkbenchCompletionFailure = { readonly kind: 'stale' | 'invalid-edit' | 'overlap' | 'disposed' | 'unavailable'; readonly message: string };
export type WorkbenchCompletionAction =
  | { readonly kind: 'newline' }
  | { readonly kind: 'insert'; readonly item: WorkbenchCompletionItem; readonly edits: readonly WorkbenchCompletionTextEdit[] }
  | { readonly kind: 'move'; readonly delta: -1 | 1 }
  | { readonly kind: 'cancel' };

export interface PathCompletionToken { readonly start: number; readonly text: string; }

/** Recognizes only path-shaped text; ordinary identifiers stay on the LSP completion path. */
export function pathCompletionToken(source: string): PathCompletionToken | undefined {
  const match = /(?:^|[\s"'`()=])((?:\/|\.\.?\/|[\p{L}\p{N}_.-]+\/)[^\s"'`()<>]*)$/u.exec(source);
  const text = match?.[1];
  if (match === null || text === undefined) return undefined;
  return { start: match.index + match[0].length - text.length, text };
}
export interface WorkbenchCompletionModel {
  readonly state: 'idle' | 'loading' | 'ready' | 'error';
  readonly request: WorkbenchCompletionRequest | undefined;
  readonly items: readonly WorkbenchCompletionItem[];
  readonly isIncomplete: boolean;
  readonly selectedId: string | undefined;
  readonly documentation: string | undefined;
  readonly documentationOffset: number;
  readonly message: string | undefined;
}
/** Mirrors `packages/services/language`'s `CompletionController`. */
export interface CompletionControllerPort {
  readonly model: WorkbenchCompletionModel;
  subscribe(listener: (model: WorkbenchCompletionModel) => void): Disposable;
  begin(request: WorkbenchCompletionRequest): number;
  publish(serial: number, request: WorkbenchCompletionRequest, list: WorkbenchCompletionList): boolean;
  fail(serial: number, request: WorkbenchCompletionRequest, failure: WorkbenchCompletionFailure): boolean;
  publishResolved(request: WorkbenchCompletionRequest, item: WorkbenchCompletionItem): boolean;
  move(delta: -1 | 1): WorkbenchCompletionAction;
  scrollDocumentation(delta: -1 | 1): void;
  accept(key: 'enter' | 'tab'): Result<WorkbenchCompletionAction, WorkbenchCompletionFailure>;
  cancel(): WorkbenchCompletionAction;
}
/** Mirrors `packages/services/language`'s `LanguageServerCompletionProvider`. */
export interface CompletionProviderPort {
  complete(request: WorkbenchCompletionRequest, cancellation?: CancellationToken): Promise<Result<WorkbenchCompletionList, WorkbenchCompletionFailure>>;
  resolve?(item: WorkbenchCompletionItem): Promise<Result<WorkbenchCompletionItem, WorkbenchCompletionFailure>>;
}

export type WordCompletionDocumentSource = () => readonly DocumentSnapshot[];

/** Bounded lexical fallback matching Helix's open-buffer word completion. */
export function createWordCompletionProvider(readDocuments: WordCompletionDocumentSource, triggerLength = 7): CompletionProviderPort {
  return {
    async complete(request, cancellation): Promise<Result<WorkbenchCompletionList, WorkbenchCompletionFailure>> {
      const cancelled = (): boolean => cancellation?.isCancelled ?? false;
      if (cancelled()) return { ok: false, error: { kind: 'stale', message: 'word completion was cancelled' } };
      const documents = readDocuments();
      const current = documents.find((snapshot) => String(snapshot.id) === request.documentId);
      if (current === undefined) return { ok: true, value: { isIncomplete: false, items: Object.freeze([]) } };
      const line = asLineIndex(request.position.line);
      if (!line.ok) return { ok: false, error: { kind: 'invalid-edit', message: 'word completion position is invalid' } };
      const lineStart = current.lineStartOffset(line.value);
      const cursor = asUtf16Offset((lineStart.ok ? Number(lineStart.value) : 0) + request.position.utf16);
      if (!lineStart.ok || !cursor.ok) return { ok: false, error: { kind: 'invalid-edit', message: 'word completion position is invalid' } };
      let prefixStart = Math.max(Number(lineStart.value), Number(cursor.value) - 256);
      if (!current.slice(prefixStart as Utf16Offset, prefixStart as Utf16Offset).ok) prefixStart -= 1;
      const prefixRead = current.slice(prefixStart as Utf16Offset, cursor.value);
      if (!prefixRead.ok) return { ok: false, error: { kind: 'invalid-edit', message: 'word completion position is invalid' } };
      const prefix = /[\p{L}\p{N}_]+$/u.exec(prefixRead.value)?.[0] ?? '';
      if ([...prefix].length < triggerLength) return { ok: true, value: { isIncomplete: false, items: Object.freeze([]) } };
      const words = new Set<string>();
      let remaining = 128 * 1024;
      for (const snapshot of documents) {
        if (cancelled()) return { ok: false, error: { kind: 'stale', message: 'word completion was cancelled' } };
        if (remaining === 0) break;
        // ponytail: total scan cap is 128 KiB; use an incremental worker index for wider coverage.
        const length = Math.min(snapshot.lengthUtf16 as number, remaining);
        const end = asUtf16Offset(length);
        const start = asUtf16Offset(0);
        if (!end.ok || !start.ok) continue;
        const text = snapshot.slice(start.value, end.value);
        if (!text.ok) continue;
        remaining -= length;
        for (const match of text.value.matchAll(/[\p{L}\p{N}_]{3,50}/gu)) {
          const word = match[0];
          if (word !== undefined && word.startsWith(prefix) && word.length > prefix.length) words.add(word);
          if (words.size >= 128) break;
        }
        if (words.size >= 128) break;
      }
      const items = [...words].sort((left, right) => left.localeCompare(right)).map((word) => Object.freeze({
        id: `word:${word}`,
        label: word,
        textEdit: { start: request.position, end: request.position, newText: word.slice(prefix.length) },
        textEditIsFallback: true,
        textEditIsWordSuffix: true,
        insertTextFormat: 'plain' as const,
      }));
      return { ok: true, value: { isIncomplete: false, items: Object.freeze(items) } };
    },
  };
}

/** Mirrors `packages/services/language`'s signature position/information/request types. */
export interface WorkbenchSignatureParameter { readonly label: string; readonly documentation?: string; }
export interface WorkbenchSignatureInformation { readonly id: string; readonly label: string; readonly documentation?: string; readonly parameters: readonly WorkbenchSignatureParameter[]; }
export type WorkbenchSignatureFailure = { readonly kind: 'stale' | 'unavailable' | 'disposed'; readonly message: string };
export interface WorkbenchSignatureList { readonly signatures: readonly WorkbenchSignatureInformation[]; readonly activeSignature: number; readonly activeParameter: number | undefined; }
export interface WorkbenchSignatureModel {
  readonly state: 'idle' | 'loading' | 'ready' | 'error';
  readonly request: WorkbenchNavigationRequest | undefined;
  readonly signatures: readonly WorkbenchSignatureInformation[];
  readonly activeSignature: number;
  readonly activeParameter: number | undefined;
  readonly message: string | undefined;
}
/** Mirrors `packages/services/language`'s `SignatureController`. */
export interface SignatureControllerPort {
  readonly model: WorkbenchSignatureModel;
  subscribe(listener: (model: WorkbenchSignatureModel) => void): Disposable;
  request(request: WorkbenchNavigationRequest, cancellation?: CancellationToken): Promise<Result<WorkbenchSignatureList, WorkbenchSignatureFailure>>;
  cancel(): void;
}

/** Mirrors `packages/services/language`'s snippet-expansion types. */
export interface WorkbenchSnippetTransform { readonly regex: string; readonly format: string; readonly options: string; }
export interface WorkbenchSnippetTabstop { readonly index: number; readonly start: number; readonly end: number; readonly defaultText: string; readonly mirror?: boolean; readonly transform?: WorkbenchSnippetTransform; }
export interface WorkbenchSnippetExpansion { readonly text: string; readonly tabstops: readonly WorkbenchSnippetTabstop[]; }
export interface WorkbenchSnippetEdit { readonly start: number; readonly end: number; readonly text: string; }
export type WorkbenchSnippetFailure = { readonly kind: 'invalid' | 'stale' | 'disposed' | 'outside-edit'; readonly message: string };
/** Mirrors `packages/services/language`'s `SnippetSession` instance surface. */
export interface SnippetSessionPort {
  readonly active: WorkbenchSnippetTabstop | undefined;
  next(generation: number): Result<WorkbenchSnippetTabstop | undefined, WorkbenchSnippetFailure>;
  previous(generation: number): Result<WorkbenchSnippetTabstop | undefined, WorkbenchSnippetFailure>;
  reanchor(generation: number): Result<void, WorkbenchSnippetFailure>;
  mapExternalEdits(edits: readonly WorkbenchSnippetEdit[], generation: number): Result<void, WorkbenchSnippetFailure>;
  replaceActive(text: string, generation: number): Result<readonly WorkbenchSnippetEdit[], WorkbenchSnippetFailure>;
  dispose(): void;
}
export type ExpandSnippetFn = (template: string) => Result<WorkbenchSnippetExpansion, WorkbenchSnippetFailure>;
export interface SnippetSessionCtor { new (expansion: WorkbenchSnippetExpansion, generation: number): SnippetSessionPort; }
export interface SnippetSupport { readonly expandSnippet: ExpandSnippetFn; readonly SnippetSession: SnippetSessionCtor; }

interface ActiveSnippetMember { readonly memberId: string; readonly session: SnippetSessionPort; baseOffset: number; }
interface CompletionEditPlan {
  readonly proposalEdits: readonly DocumentEdit[];
  readonly memberEdits: ReadonlyMap<string, DocumentEdit>;
  readonly snippetExpansion: WorkbenchSnippetExpansion | undefined;
}

interface CompletionPreview {
  readonly viewId: ViewId;
  readonly request: WorkbenchCompletionRequest;
  readonly baseView: WorkbenchViewSnapshot;
  readonly item: WorkbenchCompletionItem;
  readonly plan: CompletionEditPlan;
  readonly inverseEdits: readonly DocumentEdit[];
  readonly undoGroup: UndoGroupId;
  readonly revisionId: DocumentSnapshot['revisionId'];
  version: number;
}

export interface CompletionModelRead { readonly model: { readonly state: 'idle' | 'loading' | 'ready' | 'error'; readonly items: readonly WorkbenchCompletionItem[]; readonly selectedId: string | undefined; readonly documentation: string | undefined; readonly documentationOffset?: number; readonly message: string | undefined }; subscribe(listener: (model: CompletionModelRead['model']) => void): Disposable; }
export interface SignatureModelRead { readonly model: { readonly state: 'idle' | 'loading' | 'ready' | 'error'; readonly label: string | undefined; readonly documentation: string | undefined; readonly activeParameter: number | undefined; readonly message: string | undefined }; subscribe(listener: (model: SignatureModelRead['model']) => void): Disposable; }

export interface CompletionSnippetControllerOptions {
  readonly host: BufferHost;
  readonly session: LanguageWorkbenchSessionPort;
  readonly marker: (name: string, payload?: unknown) => void;
  /** PTY-visible stderr sink; never writes to `process.stderr` itself. */
  readonly onError: (message: string) => void;
  readonly fileUri: (path: string) => string;
  readonly positionToOffset: typeof import('../../document/src/index').positionToOffset;
  /** Lazily constructs (memoized) the language session/completion/signature controllers --
   * composition-root work, never duplicated here; a no-op (already-resolved) promise when no
   * language server applies to the current file. */
  readonly ensureLanguage: () => Promise<void>;
  /** Lazily constructs (memoized) the optional services (explorer/search/snippets) -- needed
   * here only for snippet expansion support. */
  readonly ensureOptionalServices: () => Promise<void>;
  /** Reads the currently-resolved snippet support (`expandSnippet`/`SnippetSession`), or
   * `undefined` while optional services are still loading. */
  readonly getSnippetSupport: () => SnippetSupport | undefined;
  readonly autoCompletion?: boolean;
  readonly completionTimeoutMs?: number;
  readonly completionTriggerLen?: number;
  readonly previewCompletionInsert?: boolean;
  readonly completionReplace?: boolean;
  readonly wordCompletion?: boolean;
  readonly wordCompletionProvider?: CompletionProviderPort;
  /** When true, Helix's smart-tab binding wins over the open completion menu. */
  readonly smartTabSupersedeMenu?: boolean;
  readonly pathCompletion?: boolean;
  readonly pathCompletionProvider?: CompletionProviderPort;
  readonly snippets?: boolean;
  readonly autoSignatureHelp?: boolean;
  readonly displaySignatureHelpDocs?: boolean;
}

const UNAVAILABLE_COMPLETION_MODEL: CompletionModelRead['model'] = Object.freeze({ state: 'error', items: Object.freeze([]), selectedId: undefined, documentation: undefined, documentationOffset: 0, message: 'No language server available' });
const UNAVAILABLE_SIGNATURE_MODEL: SignatureModelRead['model'] = Object.freeze({ state: 'error', label: undefined, documentation: undefined, activeParameter: undefined, message: 'No language server available' });
const NOOP_DISPOSABLE: Disposable = Object.freeze({ dispose: () => {} });

/**
 * Owns the Completion and Signature-help overlay panels and the active snippet-session
 * lifecycle they share (accepting a snippet completion opens a multi-cursor snippet session;
 * Tab/typing advance it; Escape or an edit outside its placeholders cancels it). Moved out of
 * `apps/xi/src/main.ts`'s `main()` closure. Applies edits (completion insert, snippet field
 * fill-in) only through the workbench's document/edit coordinator (`session.applyTextEdits`),
 * preserving the original undo-group and dot-repeat boundaries exactly.
 */
export class CompletionSnippetController {
  #completionOpen = false;
  #signatureOpen = false;
  #completionCancellation: CancellationSource | undefined;
  #completionDelayTimer: ReturnType<typeof setTimeout> | undefined;
  #signatureCancellation: CancellationSource | undefined;
  #completionSerial = 0;
  #operationNumber = 0;
  #completion: CompletionControllerPort | undefined;
  #completionProvider: CompletionProviderPort | undefined;
  #signature: SignatureControllerPort | undefined;
  #session: LanguageServerSessionPort | undefined;
  #snippetSession: SnippetSessionPort | undefined;
  #snippetMembers = new Map<string, ActiveSnippetMember>();
  #snippetViewId: ViewId | undefined;
  #snippetUndoGroup: UndoGroupId | undefined;
  #snippetApplying = false;
  #completionPreview: CompletionPreview | undefined;
  #previewApplyingDocumentId: string | undefined;
  #previewRestoringDocumentId: string | undefined;
  #previewRollback: Promise<void> | undefined;
  readonly #unrevertedPreviews = new Map<string, { base: DocumentSnapshot['revisionId']; preview?: DocumentSnapshot['revisionId']; active: boolean }>();
  #previewOperation = 0;
  #completionRead: CompletionModelRead | undefined;
  #signatureRead: SignatureModelRead | undefined;
  /** Guards against an infinite `ensureLanguage().then(() => openCompletion/openSignature())`
   * microtask loop when no language applies to the current file: `ensureLanguage` is a memoized,
   * already-resolved promise in that case, so without this guard the retry would re-enter with
   * the same unresolved controller/session forever (F1-1). Reset once a request attempt starts
   * fresh (open) or completes/closes. */
  #completionEnsureRetried = false;
  #signatureEnsureRetried = false;
  #signatureAutomaticPending = false;
  #signatureAutomaticOpen = false;
  readonly #options: CompletionSnippetControllerOptions;

  constructor(options: CompletionSnippetControllerOptions) {
    this.#options = options;
  }

  get isCompletionOpen(): boolean { return this.#completionOpen || this.#completionDelayTimer !== undefined; }
  isCompletionPreviewActiveFor(documentId: DocumentId): boolean { return this.#previewApplyingDocumentId === String(documentId) || this.#previewRestoringDocumentId === String(documentId) || this.#completionPreview?.request.documentId === String(documentId) || this.#unrevertedPreviews.get(String(documentId))?.active === true; }
  get isSignatureOpen(): boolean { return this.#signatureOpen; }
  /** An active snippet session intercepts every keypress until Tab exhausts its placeholders,
   * Escape cancels it, or an edit lands outside its active placeholder. */
  get isSnippetActive(): boolean { return this.#snippetSession !== undefined; }

  get completionRead(): CompletionModelRead {
    const self = this;
    this.#completionRead ??= {
      get model() {
        const model = self.#completion?.model;
        return model === undefined ? UNAVAILABLE_COMPLETION_MODEL : Object.freeze({ state: model.state, items: model.items, selectedId: model.selectedId, documentation: model.documentation, documentationOffset: model.documentationOffset, message: model.message });
      },
      subscribe: (listener) => self.#completion?.subscribe(() => listener(self.completionRead.model)) ?? NOOP_DISPOSABLE,
    };
    return this.#completionRead;
  }

  get signatureRead(): SignatureModelRead {
    const self = this;
    this.#signatureRead ??= {
      get model() {
        const model = self.#signature?.model;
        const signature = model?.signatures[model.activeSignature];
        return model === undefined
          ? UNAVAILABLE_SIGNATURE_MODEL
          : Object.freeze({ state: model.state, label: signature?.label, documentation: self.#options.displaySignatureHelpDocs !== false ? signature?.documentation : undefined, activeParameter: model.activeParameter, message: model.message });
      },
      subscribe: (listener) => self.#signature?.subscribe(() => listener(self.signatureRead.model)) ?? NOOP_DISPOSABLE,
    };
    return this.#signatureRead;
  }

  /** Binds the lazily-constructed completion/signature controllers and language session, and
   * starts forwarding their state as `XI_COMPLETION_STATE`/`XI_SIGNATURE_STATE` markers while
   * open. Returns both subscriptions for `apps/xi/src/main.ts` to hold and dispose at the exact
   * two (adjacent) points the original teardown already disposed them. */
  attachLanguage(session: LanguageServerSessionPort, completion: CompletionControllerPort, completionProvider: CompletionProviderPort, signature: SignatureControllerPort): { readonly completionSubscription: Disposable; readonly signatureSubscription: Disposable } {
    this.#session = session;
    this.#completion = completion;
    this.#completionProvider = completionProvider;
    this.#signature = signature;
    const completionSubscription = completion.subscribe((model) => {
      this.#options.host.notifySurfaceChange();
      if (this.#completionOpen) this.#options.marker('XI_COMPLETION_STATE', { state: model.state, items: model.items.length, selectedId: model.selectedId, documentation: model.documentation !== undefined, message: model.message });
    });
    const signatureSubscription = signature.subscribe((model) => {
      this.#options.host.notifySurfaceChange();
      if (this.#signatureOpen) this.#options.marker('XI_SIGNATURE_STATE', { state: model.state, signatures: model.signatures.length, documentation: this.signatureRead.model.documentation !== undefined, message: model.message });
    });
    return { completionSubscription, signatureSubscription };
  }

  detachLanguage(): void {
    this.closeCompletion();
    this.closeSignature();
    this.#completion = undefined;
    this.#completionProvider = undefined;
    this.#signature = undefined;
    this.#session = undefined;
  }

  isInsertMode(mode: string | undefined): boolean { return mode === 'insert' || mode === 'replace'; }

  isCompletionTrigger(event: { readonly name: string; readonly raw: string; readonly ctrl: boolean; readonly shift: boolean }, mode: string | undefined): boolean {
    if (!event.ctrl || (event.raw !== ' ' && event.raw !== '\0' && event.name.toLowerCase() !== 'space')) return false;
    return this.isInsertMode(mode);
  }

  /** Helix's automatic completion trigger runs after an inserted identifier reaches the configured length. */
  isAutoCompletionTrigger(event: OwnedVimKeyEvent, mode: string | undefined): boolean {
    if (this.#options.autoCompletion === false || !this.isInsertMode(mode)
      || event.ctrl || event.meta || event.option || event.raw.length !== 1
      || !/[\p{L}\p{N}_$]/u.test(event.raw)) return false;
    const activeViewId = this.#options.session.activeViewId;
    const view = activeViewId === undefined ? undefined : this.#options.session.readView(activeViewId);
    const member = view?.selections.members.find(candidate => candidate.id === view.selections.primaryId);
    if (view === undefined || member === undefined) return false;
    const line = view.document.lineIndexAt(member.head.at.offset);
    if (!line.ok) return false;
    const start = view.document.lineStartOffset(line.value);
    if (!start.ok) return false;
    const prefix = view.document.slice(start.value, member.head.at.offset);
    if (!prefix.ok) return false;
    const word = /[\p{L}\p{N}_$]+$/u.exec(prefix.value)?.[0] ?? '';
    return [...word, event.raw].length >= (this.#options.completionTriggerLen ?? 2);
  }

  /** Helix's path completion is automatic only after a path-like token is present. */
  isPathCompletionTrigger(event: OwnedVimKeyEvent, mode: string | undefined): boolean {
    if (this.#options.pathCompletion === false || this.#options.pathCompletionProvider === undefined || !this.isInsertMode(mode)
      || event.ctrl || event.meta || event.option || event.raw.length !== 1) return false;
    const request = this.#currentCompletionRequest('character');
    if (request === undefined) return false;
    const activeViewId = this.#options.session.activeViewId;
    const view = activeViewId === undefined ? undefined : this.#options.session.readView(activeViewId);
    const primary = view?.selections.members.find((member) => member.id === view.selections.primaryId);
    const line = primary === undefined || view === undefined ? undefined : view.document.lineIndexAt(primary.head.at.offset);
    if (view === undefined || primary === undefined || line === undefined || !line.ok) return false;
    const start = view.document.lineStartOffset(line.value);
    if (!start.ok) return false;
    const prefix = view.document.slice(start.value, primary.head.at.offset);
    if (!prefix.ok) return false;
    return pathCompletionToken(prefix.value + event.raw) !== undefined;
  }

  isSignatureTrigger(event: { readonly name: string; readonly raw: string; readonly ctrl: boolean; readonly shift: boolean }, mode: string | undefined): boolean {
    if (!event.ctrl || !event.shift || event.name.toLowerCase() !== 's') return false;
    return this.isInsertMode(mode);
  }

  /** Helix re-requests automatic signature help after insert-mode document changes. */
  isAutoSignatureTrigger(event: OwnedVimKeyEvent, mode: string | undefined): boolean {
    return this.#options.autoSignatureHelp !== false
      && this.isInsertMode(mode)
      && !event.ctrl && !event.meta && !event.option
      && event.raw.length === 1 && event.raw !== '\x1b';
  }

  openCompletion(trigger: 'invoked' | 'retrigger' | 'character' = 'invoked'): boolean {
    const timeout = this.#options.completionTimeoutMs ?? 0;
    if (trigger === 'character' && timeout > 0) {
      if (this.#completionDelayTimer !== undefined) clearTimeout(this.#completionDelayTimer);
      this.#completionOpen = false;
      this.#completionCancellation?.cancel();
      this.#completionDelayTimer = setTimeout(() => {
        this.#completionDelayTimer = undefined;
        this.#openCompletion(trigger, false);
      }, timeout);
      return true;
    }
    return this.#openCompletion(trigger, false);
  }

  openPathCompletion(): boolean {
    const timeout = this.#options.completionTimeoutMs ?? 0;
    if (timeout > 0) {
      if (this.#completionDelayTimer !== undefined) clearTimeout(this.#completionDelayTimer);
      this.#completionOpen = false;
      this.#completionCancellation?.cancel();
      this.#completionDelayTimer = setTimeout(() => {
        this.#completionDelayTimer = undefined;
        this.#openCompletion('character', true);
      }, timeout);
      return true;
    }
    return this.#openCompletion('character', true);
  }

  #openCompletion(trigger: 'invoked' | 'retrigger' | 'character', path = false): boolean {
    const request = this.#currentCompletionRequest(trigger);
    const controller = this.#completion;
    const provider = path ? this.#options.pathCompletionProvider : this.#completionProvider;
    const wordProvider = path ? undefined : this.#options.wordCompletionProvider;
    const session = this.#session;
    if (request === undefined || controller === undefined || path && provider === undefined || !path && provider === undefined && wordProvider === undefined || !path && provider !== undefined && session === undefined) {
      if (request !== undefined && !this.#completionEnsureRetried && !path && provider === undefined) {
        this.#completionEnsureRetried = true;
        this.#completionOpen = true;
        void this.#options.ensureLanguage().then(() => { if (this.#completionOpen) this.#openCompletion(trigger, path); });
        return true;
      }
      this.#completionEnsureRetried = false;
      this.#options.marker('XI_COMPLETION_STATE', { state: 'unavailable', items: 0 });
      return true;
    }
    this.#completionEnsureRetried = false;
    this.#signatureOpen = false;
    this.#completionOpen = true;
    this.#completionCancellation?.cancel();
    const cancellation = new CancellationSource();
    this.#completionCancellation = cancellation;
    this.#completionSerial = controller.begin(request);
    this.#options.marker('XI_COMPLETION_OPEN', { version: request.documentVersion, selectionGeneration: request.selectionGeneration, trigger, ...(path ? { source: 'path' } : {}) });
    void (async () => {
      if (!path && session !== undefined) {
        const ready = await session!.waitForReady();
        if (!this.#completionOpen || this.#completionSerial === 0) return;
        if (ready.ok === false && wordProvider === undefined) {
          controller.fail(this.#completionSerial, request, { kind: 'unavailable', message: ready.error.message });
          return;
        }
      }
      const result = provider === undefined
        ? { ok: true as const, value: { isIncomplete: false, items: Object.freeze([] as WorkbenchCompletionItem[]) } }
        : await provider.complete(request, cancellation.token);
      if (!this.#completionOpen || cancellation.token.isCancelled) return;
      if (result.ok) {
        let list = result.value;
        if (wordProvider !== undefined && this.#options.wordCompletion !== false) {
          const words = await wordProvider.complete(request, cancellation.token);
          if (words.ok) list = { ...list, items: Object.freeze([...list.items, ...words.value.items]), isIncomplete: true };
        }
        list = this.#options.snippets === false
          ? { ...list, items: list.items.filter((item) => item.insertTextFormat !== 'snippet') }
          : list;
        controller.publish(this.#completionSerial, request, list);
      } else if (wordProvider !== undefined && this.#options.wordCompletion !== false) {
        const words = await wordProvider.complete(request, cancellation.token);
        if (words.ok) controller.publish(this.#completionSerial, request, { ...words.value, isIncomplete: true });
        else controller.fail(this.#completionSerial, request, result.error);
      } else controller.fail(this.#completionSerial, request, result.error);
    })();
    return true;
  }

  openSignature(automatic = false): boolean {
    const request = this.#currentSignatureRequest();
    const controller = this.#signature;
    if (request === undefined) return true;
    const session = this.#session;
    if (controller === undefined || session === undefined) {
      if (automatic) {
        if (this.#signatureAutomaticPending) return true;
        this.#signatureAutomaticPending = true;
        void this.#options.ensureLanguage().then(() => {
          this.#signatureAutomaticPending = false;
          if (this.#signature !== undefined) this.openSignature(true);
        });
        return true;
      }
      if (this.#signatureEnsureRetried) {
        this.#signatureEnsureRetried = false;
        if (automatic) this.closeSignature();
        return true;
      }
      this.#signatureEnsureRetried = true;
      this.#signatureOpen = true;
      void this.#options.ensureLanguage().then(() => { if (this.#signatureOpen) this.openSignature(automatic); });
      return true;
    }
    this.#signatureEnsureRetried = false;
    this.#completionOpen = false;
    this.#signatureOpen = !automatic;
    this.#signatureCancellation?.cancel();
    const cancellation = new CancellationSource();
    this.#signatureCancellation = cancellation;
    void (async () => {
      const ready = await session.waitForReady();
      if ((!this.#signatureOpen && !automatic) || cancellation.token.isCancelled) return;
      if (ready.ok === false) { if (automatic) this.closeSignature(); return; }
      if (automatic && !session.supportsRequest('textDocument/signatureHelp', request.uri)) return;
      if (automatic) {
        this.#signatureOpen = true;
        this.#signatureAutomaticOpen = true;
      }
      this.#options.marker('XI_SIGNATURE_OPEN');
      await controller.request(request, cancellation.token);
    })();
    return true;
  }

  closeCompletion(cancel = true): void {
    if (this.#completionDelayTimer !== undefined) {
      clearTimeout(this.#completionDelayTimer);
      this.#completionDelayTimer = undefined;
    }
    this.#completionOpen = false;
    this.#completionEnsureRetried = false;
    this.#completionCancellation?.cancel();
    this.#completionCancellation = undefined;
    if (cancel) void this.#discardCompletionPreview();
    if (cancel) this.#completion?.cancel();
    this.#options.marker('XI_COMPLETION_CLOSED');
  }

  /** Plain panel-registry close (no key to forward), mirroring the original inline
   * `host.registerPanel('signature', { close: () => { signatureOpen = false; signatureController?.cancel(); } })`. */
  closeSignature(): void {
    this.#signatureOpen = false;
    this.#signatureEnsureRetried = false;
    this.#signatureAutomaticPending = false;
    this.#signatureAutomaticOpen = false;
    this.#signatureCancellation?.cancel();
    this.#signatureCancellation = undefined;
    this.#signature?.cancel();
  }

  async handleCompletionKeypress(event: OwnedVimKeyEvent): Promise<boolean> {
    const key = event.name.toLowerCase();
    if (key === 'escape' || event.raw === '') {
      await this.#discardCompletionPreview();
      this.closeCompletion();
      // Dismissing completion must preserve Vim's Escape semantics: one Escape leaves
      // Insert mode even when the popup happened to be open.
      const active = this.#options.host.activeSession();
      if (active !== undefined) await active.handleKey(event);
      return true;
    }
    if (event.ctrl && key === 'e') { await this.#discardCompletionPreview(); this.closeCompletion(); return true; }
    if (event.ctrl && (key === 'n' || key === 'p')) {
      const direction = key === 'n' ? 1 : -1;
      this.#completion?.move(direction);
      void this.#resolveSelectedCompletion();
      await this.#previewSelectedCompletion();
      return true;
    }
    if (event.ctrl && (key === 'd' || key === 'u')) {
      this.#completion?.scrollDocumentation(key === 'd' ? 1 : -1);
      return true;
    }
    if (key === 'tab' && !event.shift && this.#options.smartTabSupersedeMenu === true) {
      const active = this.#options.host.activeSession();
      await this.#discardCompletionPreview();
      this.closeCompletion();
      if (active !== undefined) await active.handleKey(event);
      return true;
    }
    if (!event.ctrl && !event.meta && !event.option && event.raw.length === 1) {
      const controller = this.#completion;
      const request = controller?.model.request;
      const selected = controller?.model.selectedId === undefined ? undefined : controller.model.items.find((item) => item.id === controller.model.selectedId);
      if (controller !== undefined && request !== undefined && selected?.commitCharacters?.includes(event.raw) === true) {
        const accepted = controller.accept('tab');
        this.closeCompletion(false);
        if (accepted.ok && accepted.value.kind === 'insert') await this.#applyCompletion(request, accepted.value.item, accepted.value.edits, false);
        const active = this.#options.host.activeSession();
        if (active !== undefined) await active.handleKey(event);
        return true;
      }
    }
    if (key === 'tab' || key === 'enter' || key === 'return' || event.raw === '\r' || event.raw === '\n') {
      const controller = this.#completion;
      const request = controller?.model.request;
      if (controller === undefined || request === undefined) { this.closeCompletion(); return true; }
      const accepted = controller.accept(key === 'tab' ? 'tab' : 'enter');
      if (!accepted.ok) { this.#options.onError(`xi: completion acceptance failed: ${accepted.error.message}\n`); this.closeCompletion(); return true; }
      this.closeCompletion(false);
      if (accepted.value.kind === 'newline') {
        const active = this.#options.host.activeSession();
        if (active !== undefined) await active.handleKey(event);
      } else if (accepted.value.kind === 'insert') {
        await this.#applyCompletion(request, accepted.value.item, accepted.value.edits, event.shift);
      }
      return true;
    }
    const active = this.#options.host.activeSession();
    const retrigger = this.#completion?.model.isIncomplete === true && !event.ctrl && !event.meta && !event.option && event.raw.length === 1;
    await this.#discardCompletionPreview();
    this.closeCompletion();
    if (active !== undefined) await active.handleKey(event);
    if (retrigger && active !== undefined && this.isInsertMode(this.#activeMode())) this.openCompletion('retrigger');
    return true;
  }

  handleSignatureKeypress(event: OwnedVimKeyEvent): Promise<boolean> {
    return (async () => {
      const key = event.name.toLowerCase();
      if (key === 'escape' || event.raw === '') {
        const automatic = this.#signatureAutomaticOpen;
        this.closeSignature();
        this.#options.marker('XI_SIGNATURE_CLOSED');
        if (automatic) {
          const active = this.#options.host.activeSession();
          if (active !== undefined) await active.handleKey(event);
        }
        return true;
      }
      this.#signatureOpen = false;
      this.#signatureCancellation?.cancel();
      this.#signatureCancellation = undefined;
      this.#signature?.cancel();
      const active = this.#options.host.activeSession();
      if (active !== undefined) {
        const handled = await active.handleKey(event);
        if (handled !== false && this.isAutoSignatureTrigger(event, this.#activeMode())) this.openSignature(true);
      }
      return true;
    })();
  }

  async handleSnippetKeypress(event: OwnedVimKeyEvent): Promise<boolean | 'quit'> {
    const viewId = this.#snippetViewId;
    const activeView = viewId === undefined ? undefined : this.#options.session.readView(viewId);
    const vim = this.#options.host.activeSession();
    const members = this.#snippetMembers;
    if (this.#snippetSession === undefined || members.size === 0 || viewId === undefined || activeView === undefined || vim === undefined || this.#options.session.activeViewId !== viewId) {
      this.#finishSnippet();
      return vim === undefined ? false : vim.handleKey(event);
    }
    const generation = Number(activeView.selections.selectionGeneration);
    const key = event.name.toLowerCase();
    if (key === 'escape' || event.raw === '') {
      this.#finishSnippet();
      return vim.handleKey(event);
    }
    if (key === 'tab' || event.raw === '\t') {
      const moved = new Map<string, WorkbenchSnippetTabstop>();
      for (const [memberId, entry] of members) {
        const result = event.shift ? entry.session.previous(generation) : entry.session.next(generation);
        if (!result.ok) return this.#cancelSnippetAndForward(vim, event);
        if (result.value !== undefined) moved.set(memberId, result.value);
      }
      if (moved.size === 0) {
        this.#finishSnippet();
        return true;
      }
      const cursorOffsets = new Map<string, number>();
      for (const [memberId, field] of moved) {
        const entry = members.get(memberId);
        if (entry === undefined) return this.#cancelSnippetAndForward(vim, event);
        cursorOffsets.set(memberId, entry.baseOffset + field.start);
      }
      if (!vim.setInsertCursors(cursorOffsets)) return this.#cancelSnippetAndForward(vim, event);
      const nextView = this.#options.session.readView(viewId);
      const nextGeneration = nextView === undefined ? undefined : Number(nextView.selections.selectionGeneration);
      if (nextGeneration === undefined) return this.#cancelSnippetAndForward(vim, event);
      for (const entry of members.values()) if (!entry.session.reanchor(nextGeneration).ok) return this.#cancelSnippetAndForward(vim, event);
      this.#options.marker('XI_SNIPPET_MULTI_TAB', { members: moved.size, direction: event.shift ? 'previous' : 'next' });
      return true;
    }
    if (event.ctrl || event.meta || event.option || event.raw.length !== 1 || event.raw === '\r' || event.raw === '\n') {
      this.#finishSnippet();
      return vim.handleKey(event);
    }
    const fields = new Map<string, WorkbenchSnippetEdit[]>();
    const documentEdits: DocumentEdit[] = [];
    for (const [memberId, entry] of members) {
      const planned = entry.session.replaceActive(event.raw, generation);
      if (!planned.ok) return this.#cancelSnippetAndForward(vim, event);
      const translated: WorkbenchSnippetEdit[] = [];
      for (const edit of planned.value) {
        const start = entry.baseOffset + edit.start;
        const end = entry.baseOffset + edit.end;
        const translatedEdit = { start, end, text: edit.text };
        translated.push(translatedEdit);
        documentEdits.push(translatedEdit as unknown as DocumentEdit);
      }
      fields.set(memberId, translated);
    }
    if (!nonOverlappingDocumentEdits(documentEdits)) return this.#cancelSnippetAndForward(vim, event);
    const group = this.#snippetUndoGroup === undefined ? asIdentifier<UndoGroupId>(`xi-snippet-${this.#operationNumber += 1}`, 'undoGroupId') : { ok: true as const, value: this.#snippetUndoGroup };
    if (!group.ok) return this.#cancelSnippetAndForward(vim, event);
    this.#snippetApplying = true;
    const applied = await this.#options.session.applyTextEdits(viewId, documentEdits, group.value, 'lsp', true);
    this.#snippetApplying = false;
    if (!applied.ok) return this.#cancelSnippetAndForward(vim, event);
    const cursorOffsets = new Map<string, number>();
    for (const [memberId, entry] of members) {
      const own = fields.get(memberId) ?? [];
      const external = documentEdits.filter((edit) => !own.some((candidate) => candidate.start === Number(edit.start) && candidate.end === Number(edit.end) && candidate.text === edit.text));
      const oldBase = entry.baseOffset;
      entry.baseOffset = mapPointThroughEdits(oldBase, external);
      const afterBase = external.filter((edit) => Number(edit.start) >= oldBase);
      if (afterBase.length > 0) {
        const relative = afterBase.map((edit) => ({ start: Number(edit.start) - oldBase, end: Number(edit.end) - oldBase, text: edit.text }));
        if (!entry.session.mapExternalEdits(relative, generation).ok) return this.#cancelSnippetAndForward(vim, event);
      }
      const field = entry.session.active;
      if (field !== undefined) cursorOffsets.set(memberId, entry.baseOffset + field.end);
    }
    if (!vim.setInsertCursors(cursorOffsets)) return this.#cancelSnippetAndForward(vim, event);
    const nextView = this.#options.session.readView(viewId);
    const nextGeneration = nextView === undefined ? undefined : Number(nextView.selections.selectionGeneration);
    if (nextGeneration === undefined) return this.#cancelSnippetAndForward(vim, event);
    for (const entry of members.values()) if (!entry.session.reanchor(nextGeneration).ok) return this.#cancelSnippetAndForward(vim, event);
    return true;
  }

  /** Called on every document change (`onDocumentChange`) not originated by this feature's own
   * applying flag, to cancel a snippet an outside edit invalidated -- mirrors the original
   * `if (snippetSession !== undefined && !snippetApplying) finishSnippet()`. */
  cancelSnippetOnExternalChange(change?: CommittedDocumentChange): void {
    if (change !== undefined) {
      const conflict = this.#unrevertedPreviews.get(String(change.snapshot.id));
      if (conflict !== undefined) {
        if (change.snapshot.revisionId === conflict.base) conflict.active = false;
        else if (change.snapshot.revisionId === conflict.preview) conflict.active = true;
        else if (!conflict.active) this.#unrevertedPreviews.delete(String(change.snapshot.id));
      }
    }
    if (this.#completionDelayTimer !== undefined) {
      clearTimeout(this.#completionDelayTimer);
      this.#completionDelayTimer = undefined;
    }
    if (this.#snippetSession !== undefined && !this.#snippetApplying) this.#finishSnippet();
  }

  async dispose(): Promise<void> {
    if (this.#completionDelayTimer !== undefined) {
      clearTimeout(this.#completionDelayTimer);
      this.#completionDelayTimer = undefined;
    }
    this.#previewOperation += 1;
    this.#completionCancellation?.cancel();
    this.#signatureCancellation?.cancel();
    await this.#discardCompletionPreview();
    this.#finishSnippet();
    this.#completion = undefined;
    this.#completionProvider = undefined;
    this.#signature = undefined;
    this.#session = undefined;
  }

  #activeMode(): string | undefined {
    const activeViewId = this.#options.session.activeViewId;
    return activeViewId === undefined ? undefined : this.#options.session.readView(activeViewId)?.session.mode;
  }

  #currentCompletionRequest(trigger: 'invoked' | 'retrigger' | 'character' = 'invoked'): WorkbenchCompletionRequest | undefined {
    const request = buildNavigationRequest(this.#options.session, this.#options.fileUri);
    return request === undefined ? undefined : { ...request, trigger };
  }

  #currentSignatureRequest(): WorkbenchNavigationRequest | undefined {
    return buildNavigationRequest(this.#options.session, this.#options.fileUri);
  }

  async #resolveSelectedCompletion(): Promise<void> {
    const controller = this.#completion;
    const provider = this.#completionProvider;
    const request = controller?.model.request;
    const item = controller?.model.selectedId === undefined ? undefined : controller.model.items.find((candidate) => candidate.id === controller.model.selectedId);
    if (controller === undefined || provider === undefined || request === undefined || item === undefined || provider.resolve === undefined) return;
    const resolved = await provider.resolve(item);
    if (resolved.ok) controller.publishResolved(request, resolved.value);
  }

  async #previewSelectedCompletion(): Promise<void> {
    if (this.#options.previewCompletionInsert === false) return;
    const controller = this.#completion;
    const request = controller?.model.request;
    const item = controller?.model.selectedId === undefined ? undefined : controller.model.items.find((candidate) => candidate.id === controller.model.selectedId);
    if (controller === undefined || request === undefined || item === undefined) return;
    await this.#discardCompletionPreview();
    const operation = ++this.#previewOperation;
    let support = this.#options.getSnippetSupport();
    if (support === undefined) {
      await this.#options.ensureOptionalServices();
      support = this.#options.getSnippetSupport();
      if (support === undefined || operation !== this.#previewOperation) return;
    }
    const activeViewId = this.#options.session.activeViewId;
    const view = activeViewId === undefined ? undefined : this.#options.session.readView(activeViewId);
    const current = this.#currentCompletionRequest();
    if (activeViewId === undefined || view === undefined || current === undefined
      || current.documentId !== request.documentId || current.position.line !== request.position.line || current.position.utf16 !== request.position.utf16) return;
    const plan = planCompletionEdits(view.document, view.selections, request, item, [item.textEdit, ...(item.additionalTextEdits ?? [])].filter((edit): edit is WorkbenchCompletionTextEdit => edit !== undefined), this.#options.positionToOffset, support.expandSnippet, false, this.#options.completionReplace === true);
    if (!plan.ok) {
      this.#options.onError(`xi: completion ${plan.error}\n`);
      this.#options.marker('XI_COMPLETION_REJECTED', { reason: plan.error, primaryOnly: false });
      return;
    }
    const inverse = inverseCompletionEdits(view.document, plan.value.proposalEdits);
    if (!inverse.ok) { this.#options.onError(`xi: completion preview ${inverse.error}\n`); return; }
    const group = asIdentifier<UndoGroupId>(`xi-completion-preview-${this.#operationNumber += 1}`, 'undoGroupId');
    if (!group.ok) return;
    const vim = this.#options.host.activeSession();
    if (vim !== undefined && !vim.closeInsertUndoGroup()) return;
    this.#finishSnippet();
    const opened = this.#options.session.beginUndoGroup(activeViewId, group.value, 'lsp');
    if (!opened.ok) return;
    this.#snippetApplying = true;
    this.#previewApplyingDocumentId = request.documentId;
    let applied: Awaited<ReturnType<LanguageWorkbenchSessionPort['applyTextEdits']>>;
    try { applied = await this.#options.session.applyTextEdits(activeViewId, plan.value.proposalEdits, group.value, 'lsp', true); }
    finally { this.#snippetApplying = false; this.#previewApplyingDocumentId = undefined; }
    if (!applied.ok) {
      void this.#options.session.endUndoGroup(activeViewId, group.value);
      return;
    }
    if (operation !== this.#previewOperation) {
      const currentView = this.#options.session.readView(activeViewId);
      if (currentView?.document.version === applied.value.version) {
        const restored = await this.#options.session.applyTextEdits(activeViewId, inverse.value, group.value, 'lsp', true);
        if (!restored.ok) {
          this.#unrevertedPreviews.set(request.documentId, { base: view.document.revisionId, active: true });
          this.#options.onError(`xi: completion preview could not be reverted: ${restored.error.kind}\n`);
        }
      } else {
        this.#unrevertedPreviews.set(request.documentId, { base: view.document.revisionId, active: true });
        this.#options.onError('xi: completion preview changed during cancellation; undo it before saving\n');
      }
      void this.#options.session.endUndoGroup(activeViewId, group.value);
      return;
    }
    const previewRevision = this.#options.session.readView(activeViewId)?.document.revisionId;
    if (previewRevision === undefined) return;
    this.#completionPreview = { viewId: activeViewId, request, baseView: view, item, plan: plan.value, inverseEdits: inverse.value, undoGroup: group.value, revisionId: previewRevision, version: Number(applied.value.version) };
    this.#options.marker('XI_COMPLETION_PREVIEW', { version: applied.value.version, item: item.id, edits: plan.value.proposalEdits.length });
  }

  async #discardCompletionPreview(): Promise<void> {
    if (this.#previewRollback !== undefined) return this.#previewRollback;
    const preview = this.#completionPreview;
    if (preview === undefined) return;
    this.#previewOperation += 1;
    this.#completionPreview = undefined;
    const rollback = this.#restoreCompletionPreview(preview);
    this.#previewRollback = rollback;
    try { await rollback; }
    finally { if (this.#previewRollback === rollback) this.#previewRollback = undefined; }
  }

  async #restoreCompletionPreview(preview: CompletionPreview): Promise<void> {
    this.#previewRestoringDocumentId = preview.request.documentId;
    const view = this.#options.session.readView(preview.viewId);
    if (view === undefined || Number(view.document.version) !== preview.version) {
      void this.#options.session.endUndoGroup(preview.viewId, preview.undoGroup);
      this.#unrevertedPreviews.set(preview.request.documentId, { base: preview.baseView.document.revisionId, preview: preview.revisionId, active: true });
      this.#options.onError('xi: completion preview could not be reverted after another edit; undo it before saving\n');
      this.#previewRestoringDocumentId = undefined;
      return;
    }
    this.#snippetApplying = true;
    let restored: Awaited<ReturnType<LanguageWorkbenchSessionPort['applyTextEdits']>>;
    try { restored = await this.#options.session.applyTextEdits(preview.viewId, preview.inverseEdits, preview.undoGroup, 'lsp', true); }
    finally {
      this.#snippetApplying = false;
      this.#previewRestoringDocumentId = undefined;
      void this.#options.session.endUndoGroup(preview.viewId, preview.undoGroup);
    }
    if (!restored.ok) {
      this.#unrevertedPreviews.set(preview.request.documentId, { base: preview.baseView.document.revisionId, preview: preview.revisionId, active: true });
      this.#options.onError(`xi: completion preview could not be reverted: ${restored.error.kind}\n`);
    }
  }

  async #applyCompletion(request: WorkbenchCompletionRequest, item: WorkbenchCompletionItem, edits: readonly WorkbenchCompletionTextEdit[], primaryOnly: boolean): Promise<void> {
    let support = this.#options.getSnippetSupport();
    if (support === undefined) {
      await this.#options.ensureOptionalServices();
      support = this.#options.getSnippetSupport();
      if (support === undefined) return;
    }
    const preview = this.#completionPreview;
    const previewView = preview === undefined ? undefined : this.#options.session.readView(preview.viewId);
    if (preview !== undefined && previewView !== undefined && Number(previewView.document.version) === preview.version && !primaryOnly && preview.item.id === item.id && preview.request.documentId === request.documentId) {
      this.#completionPreview = undefined;
      this.#previewOperation += 1;
      this.#options.marker('XI_COMPLETION_APPLIED', { version: preview.version, edits: preview.plan.proposalEdits.length, members: preview.plan.memberEdits.size, selectionCount: preview.baseView.selections.members.length, primaryOnly: false, preview: true });
      await this.#openSnippetAfterCompletion(preview.viewId, preview.baseView, preview.plan, preview.plan.proposalEdits, false, support, preview.undoGroup);
      return;
    }
    if (preview !== undefined) await this.#discardCompletionPreview();
    const activeViewId = this.#options.session.activeViewId;
    const view = activeViewId === undefined ? undefined : this.#options.session.readView(activeViewId);
    const current = this.#currentCompletionRequest();
    if (activeViewId === undefined || view === undefined || current === undefined || !sameCompletionRequest(request, current)) {
      this.#options.onError('xi: completion result is stale\n');
      return;
    }
    const plan = planCompletionEdits(view.document, view.selections, request, item, edits, this.#options.positionToOffset, support.expandSnippet, primaryOnly, this.#options.completionReplace === true);
    if (!plan.ok) {
      this.#options.onError(`xi: completion ${plan.error}\n`);
      this.#options.marker('XI_COMPLETION_REJECTED', { reason: plan.error, primaryOnly });
      return;
    }
    const proposalEdits = plan.value.proposalEdits;
    const group = asIdentifier<UndoGroupId>(`xi-completion-${this.#operationNumber += 1}`, 'undoGroupId');
    if (!group.ok) { this.#options.onError('xi: completion undo group is invalid\n'); return; }
    const vim = this.#options.host.activeSession();
    if (vim !== undefined && !vim.closeInsertUndoGroup()) {
      this.#options.onError('xi: completion could not close the active Vim insert group\n');
      return;
    }
    this.#finishSnippet();
    const openedGroup = this.#options.session.beginUndoGroup(activeViewId, group.value, 'lsp');
    if (!openedGroup.ok) {
      this.#options.onError(`xi: completion undo group could not open: ${openedGroup.error.kind}\n`);
      return;
    }
    this.#snippetApplying = true;
    const applied = await this.#options.session.applyTextEdits(activeViewId, proposalEdits, group.value, 'lsp', true);
    this.#snippetApplying = false;
    if (!applied.ok) {
      this.#options.onError(`xi: completion edit failed: ${applied.error.kind}\n`);
      void this.#options.session.endUndoGroup(activeViewId, group.value);
      return;
    }
    this.#options.marker('XI_COMPLETION_APPLIED', { version: applied.value.version, edits: proposalEdits.length, members: plan.value.memberEdits.size, selectionCount: view.selections.members.length, primaryOnly });
    await this.#openSnippetAfterCompletion(activeViewId, view, plan.value, proposalEdits, primaryOnly, support, group.value);
  }

  async #openSnippetAfterCompletion(viewId: ViewId, view: WorkbenchViewSnapshot, plan: CompletionEditPlan, proposalEdits: readonly DocumentEdit[], primaryOnly: boolean, support: SnippetSupport, undoGroup: UndoGroupId): Promise<void> {
    if (plan.snippetExpansion !== undefined && plan.snippetExpansion.tabstops.length > 0 && plan.memberEdits.size > 0) {
      const activeTabstop = plan.snippetExpansion.tabstops.find((tabstop) => tabstop.mirror !== true);
      const session = this.#options.host.activeSession();
      if (activeTabstop !== undefined && session !== undefined) {
        const entries = new Map<string, ActiveSnippetMember>();
        const cursorOffsets = new Map<string, number>();
        for (const [memberId, memberEdit] of plan.memberEdits) {
          const base = mapPointThroughEdits(Number(memberEdit.start), proposalEdits.filter((edit) => edit !== memberEdit));
          const memberSession = new support.SnippetSession(plan.snippetExpansion, Number(view.selections.selectionGeneration));
          entries.set(memberId, { memberId, session: memberSession, baseOffset: base });
          cursorOffsets.set(memberId, base + activeTabstop.start);
        }
        if (session.setInsertCursors(cursorOffsets)) {
          const afterView = this.#options.session.readView(viewId);
          const generation = afterView === undefined ? undefined : Number(afterView.selections.selectionGeneration);
          if (generation !== undefined) {
            this.#snippetMembers = entries;
            this.#snippetSession = entries.get(String(view.selections.primaryId))?.session ?? entries.values().next().value?.session;
            this.#snippetViewId = viewId;
            this.#snippetUndoGroup = undoGroup;
            for (const entry of entries.values()) entry.session.reanchor(generation);
            this.#options.marker('XI_SNIPPET_MULTI_OPEN', { members: entries.size, primaryOnly, generation });
          } else {
            for (const entry of entries.values()) entry.session.dispose();
          }
        } else {
          for (const entry of entries.values()) entry.session.dispose();
        }
      }
    }
    if (this.#snippetSession === undefined) void this.#options.session.endUndoGroup(viewId, undoGroup);
  }

  #cancelSnippetAndForward(vim: OwnedVimSession, event: OwnedVimKeyEvent): Promise<boolean | 'quit'> {
    this.#finishSnippet();
    return Promise.resolve(vim.handleKey(event));
  }

  #finishSnippet(): void {
    const viewId = this.#snippetViewId;
    const undoGroup = this.#snippetUndoGroup;
    if (viewId !== undefined && undoGroup !== undefined) void this.#options.session.endUndoGroup(viewId, undoGroup);
    for (const entry of this.#snippetMembers.values()) entry.session.dispose();
    this.#snippetMembers = new Map();
    this.#snippetSession = undefined;
    this.#snippetViewId = undefined;
    this.#snippetUndoGroup = undefined;
  }
}

function sameCompletionRequest(left: WorkbenchCompletionRequest, right: WorkbenchNavigationRequest): boolean {
  return left.documentId === right.documentId
    && left.documentVersion === right.documentVersion
    && left.selectionGeneration === right.selectionGeneration
    && left.position.line === right.position.line
    && left.position.utf16 === right.position.utf16
    && left.uri === right.uri;
}

function completionWordRange(
  snapshot: DocumentSnapshot,
  request: WorkbenchCompletionRequest,
  positionToOffset: typeof import('../../document/src/index').positionToOffset,
): { readonly start: WorkbenchCompletionPosition; readonly end: WorkbenchCompletionPosition } | undefined {
  const cursor = positionToOffset(snapshot, { version: snapshot.version, line: request.position.line as never, encoding: 'utf-16', character: request.position.utf16 as never });
  if (!cursor.ok) return undefined;
  const line = snapshot.lineIndexAt(cursor.value);
  if (!line.ok) return undefined;
  const lineStart = snapshot.lineStartOffset(line.value);
  if (!lineStart.ok) return undefined;
  const lineEnd = (line.value as number) + 1 < snapshot.lineCount
    ? snapshot.lineStartOffset(((line.value as number) + 1) as never)
    : { ok: true as const, value: snapshot.lengthUtf16 };
  if (!lineEnd.ok) return undefined;
  const prefix = snapshot.slice(lineStart.value, cursor.value);
  const suffix = snapshot.slice(cursor.value, lineEnd.value as never);
  if (!prefix.ok || !suffix.ok) return undefined;
  const before = /[\p{L}\p{N}_$]+$/u.exec(prefix.value)?.[0] ?? '';
  const after = /^[\p{L}\p{N}_$]+/u.exec(suffix.value)?.[0] ?? '';
  if (before.length === 0 && after.length === 0) return undefined;
  const start = offsetToPosition(snapshot, ((cursor.value as number) - before.length) as never, 'utf-16');
  const end = offsetToPosition(snapshot, ((cursor.value as number) + after.length) as never, 'utf-16');
  if (!start.ok || !end.ok) return undefined;
  return { start: { line: start.value.line as number, utf16: start.value.character as number }, end: { line: end.value.line as number, utf16: end.value.character as number } };
}

function completionEdit(
  snapshot: DocumentSnapshot,
  edit: WorkbenchCompletionTextEdit,
  positionToOffset: typeof import('../../document/src/index').positionToOffset,
): Result<DocumentEdit, string> {
  if (!Number.isSafeInteger(edit.start.line) || edit.start.line < 0 || !Number.isSafeInteger(edit.start.utf16) || edit.start.utf16 < 0
    || !Number.isSafeInteger(edit.end.line) || edit.end.line < 0 || !Number.isSafeInteger(edit.end.utf16) || edit.end.utf16 < 0) return { ok: false, error: 'completion position is invalid' };
  const start = positionToOffset(snapshot, { version: snapshot.version, line: edit.start.line as import('../../document/src/index').LineIndex, encoding: 'utf-16', character: edit.start.utf16 as import('../../document/src/index').Utf16Column });
  const end = positionToOffset(snapshot, { version: snapshot.version, line: edit.end.line as import('../../document/src/index').LineIndex, encoding: 'utf-16', character: edit.end.utf16 as import('../../document/src/index').Utf16Column });
  if (!start.ok || !end.ok || (end.value as number) < (start.value as number)) return { ok: false, error: 'completion range is invalid' };
  return { ok: true, value: { start: start.value, end: end.value, text: edit.newText } };
}

export function planCompletionEdits(
  snapshot: DocumentSnapshot,
  selections: SelectionSetSnapshot,
  request: WorkbenchCompletionRequest,
  item: WorkbenchCompletionItem,
  edits: readonly WorkbenchCompletionTextEdit[],
  positionToOffset: typeof import('../../document/src/index').positionToOffset,
  expandSnippet: ExpandSnippetFn,
  primaryOnly: boolean,
  replaceEntireWord = false,
): Result<CompletionEditPlan, string> {
  let snippetExpansion: WorkbenchSnippetExpansion | undefined;
  const converted: Array<{ readonly source: WorkbenchCompletionTextEdit; readonly edit: DocumentEdit }> = [];
  const selectedPrimary = replaceEntireWord && item.textEditReplace !== undefined ? item.textEditReplace : item.textEdit;
  for (const source of edits) {
    let candidate = source === item.textEdit && selectedPrimary !== undefined ? selectedPrimary : source;
    if (replaceEntireWord && item.textEditIsFallback === true && source === item.textEdit) {
      const word = completionWordRange(snapshot, request, positionToOffset);
      if (word !== undefined) candidate = { ...source, start: word.start, end: word.end, newText: item.textEditIsWordSuffix === true ? item.label : source.newText };
    }
    if (item.insertTextFormat === 'snippet' && item.textEdit !== undefined && source === item.textEdit) {
      const expanded = expandSnippet(candidate.newText);
      if (!expanded.ok) return { ok: false, error: `snippet is invalid: ${expanded.error.message}` };
      snippetExpansion = expanded.value;
      candidate = { ...candidate, newText: expanded.value.text };
    }
    const convertedEdit = completionEdit(snapshot, candidate, positionToOffset);
    if (!convertedEdit.ok) return convertedEdit;
    converted.push({ source, edit: convertedEdit.value });
  }
  const primarySource = item.textEdit === undefined ? undefined : converted.find((candidate) => candidate.source === item.textEdit)?.edit;
  const additional: DocumentEdit[] = [];
  const seenAdditional = new Set<string>();
  for (const candidate of converted) {
    if (candidate.source === item.textEdit) continue;
    const key = editKey(candidate.edit);
    if (seenAdditional.has(key)) continue;
    seenAdditional.add(key);
    additional.push(candidate.edit);
  }
  if (primarySource === undefined) {
    const proposalEdits = additional.slice();
    if (!nonOverlappingDocumentEdits(proposalEdits)) return { ok: false, error: 'additional edits overlap' };
    return { ok: true, value: { proposalEdits: Object.freeze(proposalEdits), memberEdits: new Map(), snippetExpansion: undefined } };
  }

  const primaryMember = selections.members.find((member) => member.id === selections.primaryId) ?? selections.members[0];
  if (primaryMember === undefined || primaryMember.kind !== 'insert-caret') return { ok: false, error: 'active selection is incompatible with completion' };
  if (!Number.isSafeInteger(request.position.line) || request.position.line < 0 || !Number.isSafeInteger(request.position.utf16) || request.position.utf16 < 0) return { ok: false, error: 'completion request position is invalid' };
  const requestOffset = positionToOffset(snapshot, { version: snapshot.version, line: request.position.line as import('../../document/src/index').LineIndex, encoding: 'utf-16', character: request.position.utf16 as import('../../document/src/index').Utf16Column });
  if (!requestOffset.ok) return { ok: false, error: 'completion request is stale' };
  const primaryOffset = Number(requestOffset.value);
  const primaryStart = Number(primarySource.start);
  const primaryEnd = Number(primarySource.end);
  const primaryText = snapshot.slice(primarySource.start, primarySource.end);
  if (!primaryText.ok) return { ok: false, error: 'completion range is outside the current document' };
  const memberEdits = new Map<string, DocumentEdit>();
  const proposalEdits: DocumentEdit[] = [];
  for (const member of selections.members) {
    if (primaryOnly && member.id !== selections.primaryId) continue;
    if (member.kind !== 'insert-caret') return { ok: false, error: 'completion requires insert carets' };
    const memberOffset = Number(member.head.at.offset);
    const start = memberOffset + primaryStart - primaryOffset;
    const end = memberOffset + primaryEnd - primaryOffset;
    if (end < start) return { ok: false, error: 'completion replacement topology is incompatible' };
    const localText = snapshot.slice(start as unknown as DocumentEdit['start'], end as unknown as DocumentEdit['end']);
    if (!localText.ok || localText.value !== primaryText.value) return { ok: false, error: 'completion replacement context differs between carets' };
    const local = member.id === primaryMember.id ? primarySource : { start: start as unknown as DocumentEdit['start'], end: end as unknown as DocumentEdit['end'], text: primarySource.text };
    if (!nonOverlappingDocumentEdits([...proposalEdits, local])) return { ok: false, error: 'completion replacements overlap' };
    memberEdits.set(String(member.id), local);
    proposalEdits.push(local);
  }
  if (memberEdits.size === 0) return { ok: false, error: 'completion has no applicable selection' };
  const filteredAdditional = primaryOnly ? [] : additional.filter((edit) => ![...proposalEdits].some((candidate) => editKey(candidate) === editKey(edit)));
  const combined = [...proposalEdits, ...filteredAdditional];
  if (!nonOverlappingDocumentEdits(combined)) return { ok: false, error: 'additional edits overlap a selection replacement' };
  return { ok: true, value: { proposalEdits: Object.freeze(combined), memberEdits, snippetExpansion } };
}

export function nonOverlappingDocumentEdits(edits: readonly { readonly start: number; readonly end: number; readonly text: string }[]): boolean {
  const ordered = [...edits].sort((left, right) => Number(left.start) - Number(right.start) || Number(left.end) - Number(right.end));
  for (let index = 1; index < ordered.length; index += 1) {
    const prior = ordered[index - 1];
    const current = ordered[index];
    if (prior === undefined || current === undefined) continue;
    if (Number(current.start) < Number(prior.end) || (Number(current.start) === Number(prior.start) && Number(current.end) === Number(prior.end) && current.text !== prior.text)) return false;
  }
  return true;
}

function editKey(edit: { readonly start: number; readonly end: number; readonly text: string }): string {
  return `${Number(edit.start)}:${Number(edit.end)}:${edit.text}`;
}

function inverseCompletionEdits(snapshot: DocumentSnapshot, edits: readonly DocumentEdit[]): Result<readonly DocumentEdit[], string> {
  const inverse: DocumentEdit[] = [];
  let delta = 0;
  for (const edit of [...edits].sort((left, right) => Number(left.start) - Number(right.start) || Number(left.end) - Number(right.end))) {
    const original = snapshot.slice(edit.start, edit.end);
    if (!original.ok) return { ok: false, error: 'preview range is outside the current document' };
    const start = Number(edit.start) + delta;
    inverse.push({ start: start as DocumentEdit['start'], end: (start + edit.text.length) as DocumentEdit['end'], text: original.value });
    delta += edit.text.length - (Number(edit.end) - Number(edit.start));
  }
  return { ok: true, value: Object.freeze(inverse) };
}

function mapPointThroughEdits(point: number, edits: readonly { readonly start: number; readonly end: number; readonly text: string }[]): number {
  let delta = 0;
  const ordered = [...edits].sort((left, right) => Number(left.start) - Number(right.start) || Number(left.end) - Number(right.end));
  for (const edit of ordered) {
    const start = Number(edit.start);
    const end = Number(edit.end);
    if (point < start) break;
    if (point >= end) delta += edit.text.length - (end - start);
  }
  return point + delta;
}
