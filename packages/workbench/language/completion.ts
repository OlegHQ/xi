import { asIdentifier, type Disposable, type DocumentId, type Result, type UndoGroupId, type ViewId } from '../../contracts/src/index';
import type { DocumentEdit, DocumentSnapshot } from '../../document/src/index';
import type { SelectionSetSnapshot } from '../../selections/src/index';
import type { OwnedVimKeyEvent, OwnedVimSession } from '../vim-session';
import type { BufferHost } from '../host';
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
  complete(request: WorkbenchCompletionRequest): Promise<Result<WorkbenchCompletionList, WorkbenchCompletionFailure>>;
  resolve?(item: WorkbenchCompletionItem): Promise<Result<WorkbenchCompletionItem, WorkbenchCompletionFailure>>;
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
  request(request: WorkbenchNavigationRequest): Promise<Result<WorkbenchSignatureList, WorkbenchSignatureFailure>>;
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
  #completionRead: CompletionModelRead | undefined;
  #signatureRead: SignatureModelRead | undefined;
  readonly #options: CompletionSnippetControllerOptions;

  constructor(options: CompletionSnippetControllerOptions) {
    this.#options = options;
  }

  get isCompletionOpen(): boolean { return this.#completionOpen; }
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
          : Object.freeze({ state: model.state, label: signature?.label, documentation: signature?.documentation, activeParameter: model.activeParameter, message: model.message });
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
      if (this.#signatureOpen) this.#options.marker('XI_SIGNATURE_STATE', { state: model.state, signatures: model.signatures.length, message: model.message });
    });
    return { completionSubscription, signatureSubscription };
  }

  isInsertMode(mode: string | undefined): boolean { return mode === 'insert' || mode === 'replace'; }

  isCompletionTrigger(event: { readonly name: string; readonly raw: string; readonly ctrl: boolean; readonly shift: boolean }, mode: string | undefined): boolean {
    if (!event.ctrl || (event.raw !== ' ' && event.raw !== ' ' && event.name.toLowerCase() !== 'space')) return false;
    return this.isInsertMode(mode);
  }

  isSignatureTrigger(event: { readonly name: string; readonly raw: string; readonly ctrl: boolean; readonly shift: boolean }, mode: string | undefined): boolean {
    if (!event.ctrl || !event.shift || event.name.toLowerCase() !== 's') return false;
    return this.isInsertMode(mode);
  }

  openCompletion(trigger: 'invoked' | 'retrigger' = 'invoked'): boolean {
    const request = this.#currentCompletionRequest(trigger);
    const controller = this.#completion;
    const provider = this.#completionProvider;
    const session = this.#session;
    if (request === undefined || controller === undefined || provider === undefined || session === undefined) {
      if (request !== undefined) {
        this.#completionOpen = true;
        void this.#options.ensureLanguage().then(() => { if (this.#completionOpen) this.openCompletion(trigger); });
        return true;
      }
      this.#options.marker('XI_COMPLETION_STATE', { state: 'unavailable', items: 0 });
      return true;
    }
    this.#signatureOpen = false;
    this.#completionOpen = true;
    this.#completionSerial = controller.begin(request);
    this.#options.marker('XI_COMPLETION_OPEN', { version: request.documentVersion, selectionGeneration: request.selectionGeneration });
    void (async () => {
      const ready = await session.waitForReady();
      if (!this.#completionOpen || ready.ok === false || this.#completionSerial === 0) {
        if (this.#completionOpen && ready.ok === false) controller.fail(this.#completionSerial, request, { kind: 'unavailable', message: ready.error.message });
        return;
      }
      const result = await provider.complete(request);
      if (!this.#completionOpen) return;
      if (result.ok) controller.publish(this.#completionSerial, request, result.value);
      else controller.fail(this.#completionSerial, request, result.error);
    })();
    return true;
  }

  openSignature(): boolean {
    const request = this.#currentSignatureRequest();
    const controller = this.#signature;
    if (request === undefined) return true;
    const session = this.#session;
    if (controller === undefined || session === undefined) {
      this.#signatureOpen = true;
      void this.#options.ensureLanguage().then(() => { if (this.#signatureOpen) this.openSignature(); });
      return true;
    }
    this.#completionOpen = false;
    this.#signatureOpen = true;
    this.#options.marker('XI_SIGNATURE_OPEN');
    void (async () => {
      const ready = await session.waitForReady();
      if (!this.#signatureOpen || ready.ok === false) return;
      await controller.request(request);
    })();
    return true;
  }

  closeCompletion(cancel = true): void {
    this.#completionOpen = false;
    if (cancel) this.#completion?.cancel();
    this.#options.marker('XI_COMPLETION_CLOSED');
  }

  /** Plain panel-registry close (no key to forward), mirroring the original inline
   * `host.registerPanel('signature', { close: () => { signatureOpen = false; signatureController?.cancel(); } })`. */
  closeSignature(): void {
    this.#signatureOpen = false;
    this.#signature?.cancel();
  }

  async handleCompletionKeypress(event: OwnedVimKeyEvent): Promise<boolean> {
    const key = event.name.toLowerCase();
    if (key === 'escape' || event.raw === '') { this.closeCompletion(); return true; }
    if (event.ctrl && key === 'e') { this.closeCompletion(); return true; }
    if (event.ctrl && (key === 'n' || key === 'p')) {
      const direction = key === 'n' ? 1 : -1;
      this.#completion?.move(direction);
      void this.#resolveSelectedCompletion();
      return true;
    }
    if (event.ctrl && (key === 'd' || key === 'u')) {
      this.#completion?.scrollDocumentation(key === 'd' ? 1 : -1);
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
    this.closeCompletion();
    if (active !== undefined) await active.handleKey(event);
    if (retrigger && active !== undefined && this.isInsertMode(this.#activeMode())) this.openCompletion('retrigger');
    return true;
  }

  handleSignatureKeypress(event: OwnedVimKeyEvent): Promise<boolean> {
    return (async () => {
      const key = event.name.toLowerCase();
      if (key === 'escape' || event.raw === '') { this.#signatureOpen = false; this.#signature?.cancel(); this.#options.marker('XI_SIGNATURE_CLOSED'); return true; }
      this.#signatureOpen = false;
      this.#signature?.cancel();
      const active = this.#options.host.activeSession();
      if (active !== undefined) await active.handleKey(event);
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
  cancelSnippetOnExternalChange(): void {
    if (this.#snippetSession !== undefined && !this.#snippetApplying) this.#finishSnippet();
  }

  dispose(): void {
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

  #currentCompletionRequest(trigger: 'invoked' | 'retrigger' = 'invoked'): WorkbenchCompletionRequest | undefined {
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

  async #applyCompletion(request: WorkbenchCompletionRequest, item: WorkbenchCompletionItem, edits: readonly WorkbenchCompletionTextEdit[], primaryOnly: boolean): Promise<void> {
    let support = this.#options.getSnippetSupport();
    if (support === undefined) {
      await this.#options.ensureOptionalServices();
      support = this.#options.getSnippetSupport();
      if (support === undefined) return;
    }
    const activeViewId = this.#options.session.activeViewId;
    const view = activeViewId === undefined ? undefined : this.#options.session.readView(activeViewId);
    const current = this.#currentCompletionRequest();
    if (activeViewId === undefined || view === undefined || current === undefined || !sameCompletionRequest(request, current)) {
      this.#options.onError('xi: completion result is stale\n');
      return;
    }
    const plan = planCompletionEdits(view.document, view.selections, request, item, edits, this.#options.positionToOffset, support.expandSnippet, primaryOnly);
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
    if (plan.value.snippetExpansion !== undefined && plan.value.snippetExpansion.tabstops.length > 0 && plan.value.memberEdits.size > 0) {
      const activeTabstop = plan.value.snippetExpansion.tabstops.find((tabstop) => tabstop.mirror !== true);
      const session = this.#options.host.activeSession();
      if (activeTabstop !== undefined && session !== undefined) {
        const entries = new Map<string, ActiveSnippetMember>();
        const cursorOffsets = new Map<string, number>();
        for (const [memberId, memberEdit] of plan.value.memberEdits) {
          const base = mapPointThroughEdits(Number(memberEdit.start), proposalEdits.filter((edit) => edit !== memberEdit));
          const memberSession = new support.SnippetSession(plan.value.snippetExpansion, Number(view.selections.selectionGeneration));
          entries.set(memberId, { memberId, session: memberSession, baseOffset: base });
          cursorOffsets.set(memberId, base + activeTabstop.start);
        }
        if (session.setInsertCursors(cursorOffsets)) {
          const afterView = this.#options.session.readView(activeViewId);
          const generation = afterView === undefined ? undefined : Number(afterView.selections.selectionGeneration);
          if (generation !== undefined) {
            this.#snippetMembers = entries;
            this.#snippetSession = entries.get(String(view.selections.primaryId))?.session ?? entries.values().next().value?.session;
            this.#snippetViewId = activeViewId;
            this.#snippetUndoGroup = group.value;
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
    if (this.#snippetSession === undefined) void this.#options.session.endUndoGroup(activeViewId, group.value);
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
): Result<CompletionEditPlan, string> {
  let snippetExpansion: WorkbenchSnippetExpansion | undefined;
  const converted: Array<{ readonly source: WorkbenchCompletionTextEdit; readonly edit: DocumentEdit }> = [];
  for (const source of edits) {
    let candidate = source;
    if (item.insertTextFormat === 'snippet' && item.textEdit !== undefined && source === item.textEdit) {
      const expanded = expandSnippet(source.newText);
      if (!expanded.ok) return { ok: false, error: `snippet is invalid: ${expanded.error.message}` };
      snippetExpansion = expanded.value;
      candidate = { ...source, newText: expanded.value.text };
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
