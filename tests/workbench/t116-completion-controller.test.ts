import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import type { Disposable, Result } from '../../packages/contracts/src/index';
import { positionToOffset } from '../../packages/document/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { CompletionController } from '../../packages/services/language/completion';
import { expandSnippet, SnippetSession } from '../../packages/services/language/snippets';
import { WorkbenchSession } from '../../packages/workbench/session/index';
import { BufferHost } from '../../packages/workbench/host/index';
import {
  CompletionSnippetController,
  nonOverlappingDocumentEdits,
  planCompletionEdits,
  type CompletionControllerPort,
  type CompletionProviderPort,
  type ExpandSnippetFn,
  type SignatureControllerPort,
  type WorkbenchCompletionAction,
  type WorkbenchCompletionFailure,
  type WorkbenchCompletionList,
  type WorkbenchCompletionModel,
  type WorkbenchCompletionRequest,
} from '../../packages/workbench/language/completion';
import type { LanguageServerSessionPort } from '../../packages/workbench/language/overlays';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T116-completion-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(documentId: DocumentId, value: string): TextFileDocument {
  const result = TextFileDocument.create(documentId, value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function documentText(value: TextFileDocument): string {
  const text = value.snapshot().slice(0 as never, value.snapshot().lengthUtf16 as never);
  if (!text.ok) throw new Error(text.error.kind);
  return text.value;
}

function key(name: string, raw: string): { readonly name: string; readonly raw: string; readonly shift: boolean; readonly option: boolean; readonly ctrl: boolean; readonly meta: boolean } {
  return { name, raw, shift: false, option: false, ctrl: false, meta: false };
}

const throwingExpandSnippet: ExpandSnippetFn = () => { throw new Error('T116-completion: expandSnippet must not be called for a plain-format item'); };

// -- T116-COMPLETION-01: planCompletionEdits (a pure helper kept in this module) rejects
// overlapping additional edits instead of silently applying an incoherent replacement. --
{
  const documentId = id<DocumentId>('T116-completion-plan-document');
  const doc = document(documentId, 'hello world');
  const snapshot = doc.snapshot();
  const session = new WorkbenchSession({ workspaceId: 'T116-completion-plan' });
  const viewId = id<ViewId>('T116-completion-plan-view');
  session.openBuffer(doc, { viewId });
  const selections = session.readView(viewId)!.selections;
  const request: WorkbenchCompletionRequest = { documentId: String(documentId), documentVersion: doc.version as unknown as number, selectionGeneration: 0, position: { line: 0, utf16: 0 }, trigger: 'invoked' };
  const overlapping = planCompletionEdits(
    snapshot,
    selections,
    request,
    { id: 'item-1', label: 'hello' },
    [
      { start: { line: 0, utf16: 0 }, end: { line: 0, utf16: 5 }, newText: 'HELLO' },
      { start: { line: 0, utf16: 3 }, end: { line: 0, utf16: 8 }, newText: 'XXXXX' },
    ],
    positionToOffset,
    throwingExpandSnippet,
    false,
  );
  assert.equal(overlapping.ok, false, 'T116-COMPLETION-01a overlapping additional edits are rejected');
  assert.equal(overlapping.ok ? '' : overlapping.error, 'additional edits overlap', 'T116-COMPLETION-01b the rejection reports the overlap reason');

  const nonOverlapping = planCompletionEdits(
    snapshot,
    selections,
    request,
    { id: 'item-2', label: 'hello' },
    [{ start: { line: 0, utf16: 0 }, end: { line: 0, utf16: 5 }, newText: 'HELLO' }],
    positionToOffset,
    throwingExpandSnippet,
    false,
  );
  assert.equal(nonOverlapping.ok, true, 'T116-COMPLETION-01c a single, non-overlapping additional edit is accepted');
  assert.equal(nonOverlappingDocumentEdits([{ start: 0, end: 5, text: 'a' }, { start: 5, end: 10, text: 'b' }]), true, 'T116-COMPLETION-01d adjacent (non-overlapping) edits pass the guard directly');
  assert.equal(nonOverlappingDocumentEdits([{ start: 0, end: 5, text: 'a' }, { start: 3, end: 10, text: 'b' }]), false, 'T116-COMPLETION-01e overlapping edits fail the guard directly');

  const replaceDocumentId = id<DocumentId>('T116-completion-replace-document');
  const replaceDocument = document(replaceDocumentId, 'alpha');
  const replaceSession = new WorkbenchSession({ workspaceId: 'T116-completion-replace' });
  const replaceViewId = id<ViewId>('T116-completion-replace-view');
  replaceSession.openBuffer(replaceDocument, { viewId: replaceViewId });
  const replaceHost = new BufferHost(replaceSession, replaceDocument, {
    openDocument: async () => undefined,
    workspaceRelativePath: () => undefined,
    marker: () => {},
    launchViewId: replaceViewId,
  });
  replaceHost.createSession(replaceDocument, replaceViewId);
  await replaceHost.activeSession()?.handleKey(key('i', 'i'));
  replaceHost.activeSession()?.setInsertCursor(2);
  const replaceSelections = replaceSession.readView(replaceViewId)!.selections;
  const replaceRequest: WorkbenchCompletionRequest = { documentId: String(replaceDocumentId), documentVersion: replaceDocument.version as unknown as number, selectionGeneration: replaceSelections.selectionGeneration as number, position: { line: 0, utf16: 2 }, trigger: 'invoked' };
  const fallbackEdit = { start: { line: 0, utf16: 2 }, end: { line: 0, utf16: 2 }, newText: 'beta' };
  const replaced = planCompletionEdits(replaceDocument.snapshot(), replaceSelections, replaceRequest, { id: 'item-3', label: 'beta', textEdit: fallbackEdit, textEditIsFallback: true }, [fallbackEdit], positionToOffset, throwingExpandSnippet, false, true);
  assert.equal(replaced.ok, true, `T116-COMPLETION-REPLACE-03 completion-replace plans a full-word replacement: ${replaced.ok ? 'ok' : replaced.error}`);
  if (replaced.ok) assert.deepEqual(replaced.value.proposalEdits.map((edit) => [Number(edit.start), Number(edit.end)]), [[0, 5]], 'T116-COMPLETION-REPLACE-03 full-word range includes the suffix after the cursor');
  const insertEdit = { start: { line: 0, utf16: 2 }, end: { line: 0, utf16: 3 }, newText: 'whole' };
  const insertReplace = planCompletionEdits(replaceDocument.snapshot(), replaceSelections, replaceRequest, {
    id: 'item-4', label: 'whole', textEdit: insertEdit,
    textEditReplace: { start: { line: 0, utf16: 0 }, end: { line: 0, utf16: 5 }, newText: 'whole' },
  }, [insertEdit], positionToOffset, throwingExpandSnippet, false, true);
  assert.equal(insertReplace.ok, true, 'T116-COMPLETION-REPLACE-04 explicit InsertReplaceEdit replacement is accepted');
  if (insertReplace.ok) assert.deepEqual(insertReplace.value.proposalEdits.map((edit) => [Number(edit.start), Number(edit.end)]), [[0, 5]], 'T116-COMPLETION-REPLACE-04 planner selects the replace range when enabled');
}

// -- A fake completion controller/provider/language session driving the workbench controller
// through the same begin/publish/fail/cancel lifecycle the real services own. --
class FakeCompletionController implements CompletionControllerPort {
  #model: WorkbenchCompletionModel = Object.freeze({ state: 'idle', request: undefined, items: Object.freeze([]), isIncomplete: false, selectedId: undefined, documentation: undefined, documentationOffset: 0, message: undefined });
  #serial = 0;
  readonly publishedSerials: number[] = [];
  get model(): WorkbenchCompletionModel { return this.#model; }
  subscribe(_listener: (model: WorkbenchCompletionModel) => void): Disposable { return Object.freeze({ dispose: () => {} }); }
  begin(request: WorkbenchCompletionRequest): number {
    this.#serial += 1;
    this.#model = { ...this.#model, state: 'loading', request };
    return this.#serial;
  }
  publish(serial: number, request: WorkbenchCompletionRequest, list: WorkbenchCompletionList): boolean {
    this.publishedSerials.push(serial);
    if (serial !== this.#serial) return false;
    this.#model = { ...this.#model, state: 'ready', request, items: list.items, isIncomplete: list.isIncomplete };
    return true;
  }
  fail(): boolean { return true; }
  publishResolved(): boolean { return true; }
  move(delta: -1 | 1): WorkbenchCompletionAction { return { kind: 'move', delta }; }
  scrollDocumentation(): void {}
  accept(): Result<WorkbenchCompletionAction, WorkbenchCompletionFailure> { return { ok: true, value: { kind: 'cancel' } }; }
  cancel(): WorkbenchCompletionAction {
    this.#serial += 1;
    this.#model = Object.freeze({ state: 'idle', request: undefined, items: Object.freeze([]), isIncomplete: false, selectedId: undefined, documentation: undefined, documentationOffset: 0, message: undefined });
    return { kind: 'cancel' };
  }
}

class DeferredCompletionProvider implements CompletionProviderPort {
  #resolve: ((value: Result<WorkbenchCompletionList, WorkbenchCompletionFailure>) => void) | undefined;
  readonly completeCalls: WorkbenchCompletionRequest[] = [];
  complete(request: WorkbenchCompletionRequest): Promise<Result<WorkbenchCompletionList, WorkbenchCompletionFailure>> {
    this.completeCalls.push(request);
    return new Promise((resolve) => { this.#resolve = resolve; });
  }
  resolveWith(list: WorkbenchCompletionList): void {
    this.#resolve?.({ ok: true, value: list });
    this.#resolve = undefined;
  }
}

class FakeSignatureController implements SignatureControllerPort {
  readonly model = Object.freeze({ state: 'ready' as const, request: undefined, signatures: Object.freeze([{ id: 'signature-1', label: 'map(fn)', documentation: 'signature docs', parameters: Object.freeze([]) }]), activeSignature: 0, activeParameter: 0, message: undefined });
  subscribe(_listener: unknown): Disposable { return Object.freeze({ dispose: () => {} }); }
  async request(): Promise<Result<never, { readonly kind: 'stale' | 'unavailable' | 'disposed'; readonly message: string }>> { throw new Error('not used by this fixture'); }
  cancel(): void {}
}

class ReadyLanguageSession implements LanguageServerSessionPort {
  async waitForReady(): Promise<Result<unknown, { readonly message: string }>> { return { ok: true, value: undefined }; }
  supportsRequest(): boolean { return true; }
}

const launchDocumentId = id<DocumentId>('T116-completion-launch-document');
const launchDocument = document(launchDocumentId, 'hello\n');
const session = new WorkbenchSession({ workspaceId: 'T116-completion' });
const launchViewId = id<ViewId>('T116-completion-launch-view');
session.openBuffer(launchDocument, { viewId: launchViewId, path: '/workspace/a.ts' });
const host = new BufferHost(session, launchDocument, {
  openDocument: async () => undefined,
  workspaceRelativePath: (path) => (path.startsWith('/workspace/') ? path.slice('/workspace/'.length) : undefined),
  marker: () => {},
  launchViewId,
});
host.createSession(launchDocument, launchViewId);

const markers: Array<{ readonly name: string; readonly payload: unknown }> = [];
const controller = new CompletionSnippetController({
  host,
  session,
  marker: (name, payload) => { markers.push({ name, payload }); },
  onError: () => {},
  fileUri: (path) => `file://${path}`,
  positionToOffset,
  ensureLanguage: async () => {},
  ensureOptionalServices: async () => {},
  getSnippetSupport: () => undefined,
  autoSignatureHelp: false,
  displaySignatureHelpDocs: false,
});
host.registerPanel('completion', { isOpen: () => controller.isCompletionOpen, close: () => controller.closeCompletion(), alwaysClose: true });

const fakeCompletion = new FakeCompletionController();
const provider = new DeferredCompletionProvider();
controller.attachLanguage(new ReadyLanguageSession(), fakeCompletion, provider, new FakeSignatureController());
assert.equal(controller.signatureRead.model.documentation, undefined, 'T116-LSP-SIGNATURE-DOCS-01 disabled documentation visibility is applied to the signature read model');
assert.equal(controller.isAutoSignatureTrigger(key('x', 'x'), 'insert'), false, 'T116-AUTO-SIGNATURE-HELP-01 false disables automatic signature requests');
const autoSignatureController = new CompletionSnippetController({
  host,
  session,
  marker: () => {},
  onError: () => {},
  fileUri: (path) => `file://${path}`,
  positionToOffset,
  ensureLanguage: async () => {},
  ensureOptionalServices: async () => {},
  getSnippetSupport: () => undefined,
  autoSignatureHelp: true,
});
assert.equal(autoSignatureController.isAutoSignatureTrigger(key('x', 'x'), 'insert'), true, 'T116-AUTO-SIGNATURE-HELP-02 true enables automatic signature requests in insert mode');
assert.equal(autoSignatureController.isAutoSignatureTrigger(key('x', 'x'), 'normal'), false, 'T116-AUTO-SIGNATURE-HELP-03 normal-mode keys do not trigger automatic signature requests');

const previewController = new CompletionSnippetController({
  host,
  session,
  marker: (name, payload) => { markers.push({ name, payload }); },
  onError: (message) => { throw new Error(message); },
  fileUri: (path) => `file://${path}`,
  positionToOffset,
  ensureLanguage: async () => {},
  ensureOptionalServices: async () => {},
  getSnippetSupport: () => ({ expandSnippet, SnippetSession }),
  previewCompletionInsert: true,
  autoSignatureHelp: false,
});
const previewCompletion = new CompletionController();
const previewProvider: CompletionProviderPort = {
  complete: async () => ({ ok: true, value: {
    isIncomplete: false,
    items: [
      { id: 'preview-one', label: 'one', textEdit: { start: { line: 0, utf16: 0 }, end: { line: 0, utf16: 0 }, newText: 'one' } },
      { id: 'preview-two', label: 'two', textEdit: { start: { line: 0, utf16: 0 }, end: { line: 0, utf16: 0 }, newText: 'two' } },
    ],
  } }),
};
previewController.attachLanguage(new ReadyLanguageSession(), previewCompletion, previewProvider, new FakeSignatureController());
await host.activeSession()!.handleKey(key('i', 'i'));
previewController.openCompletion();
await Promise.resolve();
await Promise.resolve();
await previewController.handleCompletionKeypress({ ...key('n', '\u000e'), ctrl: true });
assert.equal(documentText(launchDocument), 'onehello\n', 'T116-PREVIEW-COMPLETION-INSERT-01 selecting a completion applies its preview');
await previewController.handleCompletionKeypress({ ...key('n', '\u000e'), ctrl: true });
assert.equal(documentText(launchDocument), 'twohello\n', 'T116-PREVIEW-COMPLETION-INSERT-02 moving selection replaces the prior preview');
await previewController.handleCompletionKeypress(key('escape', '\u001b'));
assert.equal(documentText(launchDocument), 'hello\n', 'T116-PREVIEW-COMPLETION-INSERT-03 escape restores the pre-completion document');
await host.activeSession()!.handleKey(key('i', 'i'));
previewController.openCompletion();
await Promise.resolve();
await Promise.resolve();
await previewController.handleCompletionKeypress({ ...key('n', '\u000e'), ctrl: true });
await previewController.handleCompletionKeypress(key('tab', '\t'));
assert.equal(documentText(launchDocument), 'onehello\n', 'T116-PREVIEW-COMPLETION-INSERT-04 accepting keeps the selected preview');
previewController.dispose();

const supersedeController = new CompletionSnippetController({
  host,
  session,
  marker: () => {},
  onError: () => {},
  fileUri: (path) => `file://${path}`,
  positionToOffset,
  ensureLanguage: async () => {},
  ensureOptionalServices: async () => {},
  getSnippetSupport: () => undefined,
  smartTabSupersedeMenu: true,
  autoSignatureHelp: false,
});
const supersedeCompletion = new CompletionController();
const supersedeProvider: CompletionProviderPort = {
  complete: async () => ({ ok: true, value: { isIncomplete: false, items: [{ id: 'superseded', label: 'superseded', textEdit: { start: { line: 0, utf16: 0 }, end: { line: 0, utf16: 0 }, newText: 'completion' } }] } }),
};
supersedeController.attachLanguage(new ReadyLanguageSession(), supersedeCompletion, supersedeProvider, new FakeSignatureController());
host.activeSession()!.setInsertCursor(0);
supersedeController.openCompletion();
await Promise.resolve();
await Promise.resolve();
await supersedeController.handleCompletionKeypress(key('tab', '\t'));
assert.equal(documentText(launchDocument), '\tonehello\n', 'T036-SMART-TAB-SUPERSEDE-UNIT-01 smart-tab takes Tab precedence over an open completion menu');
supersedeController.dispose();

// T116-COMPLETION-02: opening completion, then closing it before the (deferred) provider
// resolves, must drop that stale response -- the model must not flip back to "ready" for a
// request nobody is looking at anymore.
controller.openCompletion();
assert.equal(controller.isCompletionOpen, true, 'T116-COMPLETION-02a openCompletion marks the controller open');
await Promise.resolve();
assert.equal(provider.completeCalls.length, 1, 'T116-COMPLETION-02b openCompletion requested completions from the provider');
controller.closeCompletion();
assert.equal(controller.isCompletionOpen, false, 'T116-COMPLETION-02c closeCompletion marks the controller closed');
provider.resolveWith({ isIncomplete: false, items: [{ id: 'stale-item', label: 'stale' }] });
await Promise.resolve();
await Promise.resolve();
assert.equal(fakeCompletion.publishedSerials.length, 0, 'T116-COMPLETION-02d a completion result arriving after close is never published');
assert.equal(controller.completionRead.model.state, 'idle', 'T116-COMPLETION-02e the read model still reports the closed/cancelled state, not a stale "ready"');

// T116-COMPLETION-03: escape closes completion and cancels the completion controller.
controller.openCompletion();
await Promise.resolve();
const handled = await controller.handleCompletionKeypress(key('escape', ''));
assert.equal(handled, true, 'T116-COMPLETION-03a handleCompletionKeypress reports handled');
assert.equal(controller.isCompletionOpen, false, 'T116-COMPLETION-03b escape closes the completion panel');
assert.equal(fakeCompletion.model.state, 'idle', 'T116-COMPLETION-03c escape cancelled the completion controller (state reset to idle)');
assert.ok(markers.some((entry) => entry.name === 'XI_COMPLETION_CLOSED'), 'T116-COMPLETION-03d a closed marker was emitted');
assert.equal(host.activeSession()?.readView(launchViewId)?.session.mode, 'normal', 'T116-COMPLETION-03e escape also leaves Insert mode after dismissing the popup');

controller.dispose();

console.log('T116 CompletionSnippetController passed plan-overlap-rejection, stale-response-drop and escape-close fixtures');
