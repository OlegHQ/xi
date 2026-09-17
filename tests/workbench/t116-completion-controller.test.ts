import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import type { Disposable, Result } from '../../packages/contracts/src/index';
import { positionToOffset } from '../../packages/document/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
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
  readonly model = Object.freeze({ state: 'idle' as const, request: undefined, signatures: Object.freeze([]), activeSignature: 0, activeParameter: undefined, message: undefined });
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
});
host.registerPanel('completion', { isOpen: () => controller.isCompletionOpen, close: () => controller.closeCompletion(), alwaysClose: true });

const fakeCompletion = new FakeCompletionController();
const provider = new DeferredCompletionProvider();
controller.attachLanguage(new ReadyLanguageSession(), fakeCompletion, provider, new FakeSignatureController());

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

controller.dispose();

console.log('T116 CompletionSnippetController passed plan-overlap-rejection, stale-response-drop and escape-close fixtures');
