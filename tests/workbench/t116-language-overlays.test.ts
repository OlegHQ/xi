import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import type { Disposable, Result } from '../../packages/contracts/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/session/index';
import { BufferHost } from '../../packages/workbench/host/index';
import {
  LanguageOverlayController,
  type NavigationControllerPort,
  type LanguageServerSessionPort,
  type WorkbenchNavigationModel,
} from '../../packages/workbench/language/overlays';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T116-overlay-id');
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

const IDLE_MODEL: WorkbenchNavigationModel = Object.freeze({ state: 'idle', generation: 0, symbols: Object.freeze([]), hover: undefined, message: undefined });

// -- A fake navigation controller recording every `loadOutline`/`returnToOrigin` call. --
class FakeNavigationController implements NavigationControllerPort {
  #model: WorkbenchNavigationModel = IDLE_MODEL;
  readonly loadOutlineRequests: unknown[] = [];
  readonly returnToOriginCalls: number[] = [];
  readonly #listeners = new Set<(model: WorkbenchNavigationModel) => void>();
  get model(): WorkbenchNavigationModel { return this.#model; }
  subscribe(listener: (model: WorkbenchNavigationModel) => void): Disposable {
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }
  publish(model: WorkbenchNavigationModel): void {
    this.#model = model;
    for (const listener of [...this.#listeners]) listener(model);
  }
  async loadOutline(request: unknown): Promise<unknown> {
    this.loadOutlineRequests.push(request);
    this.publish({ state: 'ready', generation: 1, symbols: Object.freeze([{ id: 's1', name: 'foo', kind: 12, children: Object.freeze([]) }]), hover: undefined, message: undefined });
    return { ok: true, value: [] };
  }
  async references(): Promise<unknown> { return { ok: true, value: [] }; }
  async requestHover(): Promise<unknown> { return { ok: true, value: '' }; }
  returnToOrigin(): unknown { this.returnToOriginCalls.push(1); return undefined; }
}

class FakeLanguageSession implements LanguageServerSessionPort {
  constructor(readonly supported = true) {}
  async waitForReady(): Promise<Result<unknown, { readonly message: string }>> { return { ok: true, value: undefined }; }
  supportsRequest(): boolean { return this.supported; }
}

const launchDocumentId = id<DocumentId>('T116-overlay-launch-document');
const launchDocument = document(launchDocumentId, 'alpha\nbeta\n');
const session = new WorkbenchSession({ workspaceId: 'T116-overlay' });
const launchViewId = id<ViewId>('T116-overlay-launch-view');
session.openBuffer(launchDocument, { viewId: launchViewId, path: '/workspace/a.ts' });
const host = new BufferHost(session, launchDocument, {
  openDocument: async () => undefined,
  workspaceRelativePath: (path) => (path.startsWith('/workspace/') ? path.slice('/workspace/'.length) : undefined),
  marker: () => {},
  launchViewId,
});
host.createSession(launchDocument, launchViewId);

const markers: Array<{ readonly name: string; readonly payload: unknown }> = [];
const controller = new LanguageOverlayController({
  host,
  session,
  fileUri: (path) => `file://${path}`,
  marker: (name, payload) => { markers.push({ name, payload }); },
  ensureLanguage: async () => {},
});
host.registerPanel('outline', { isOpen: () => controller.isOutlineOpen, close: () => controller.closeOutline() });
host.registerPanel('hover', { isOpen: () => controller.isHoverOpen, close: () => controller.closeHover() });

// T116-OVERLAY-01: before `attachNavigation`, the read port reports "unavailable" and opening
// never throws (the panel just stays loading forever, matching the original ensureLanguage-gated
// behavior for a file with no language server).
assert.equal(controller.outlineRead.model.state, 'unavailable', 'T116-OVERLAY-01a unattached outline read is unavailable');
assert.equal(controller.hoverRead.model.state, 'unavailable', 'T116-OVERLAY-01b unattached hover read is unavailable');
let subscribedOutlineState = 'unavailable';
const earlyReadSubscription = controller.outlineRead.subscribe((model) => { subscribedOutlineState = model.state; });

// T116-OVERLAY-02: `attachNavigation` binds the navigation controller; `openOutline` then
// requests an outline for the current view and the read port reflects the published model.
const navigation = new FakeNavigationController();
const languageSession = new FakeLanguageSession();
const subscription = controller.attachNavigation(navigation, languageSession);
controller.openOutline();
assert.equal(controller.isOutlineOpen, true, 'T116-OVERLAY-02a openOutline marks the controller open');
await Promise.resolve();
await Promise.resolve();
assert.equal(navigation.loadOutlineRequests.length, 1, 'T116-OVERLAY-02b openOutline requested an outline through the navigation controller');
assert.equal(controller.outlineRead.model.state, 'ready', 'T116-OVERLAY-02c the outline read reflects the published ready model');
assert.equal(controller.outlineRead.model.symbols.length, 1, 'T116-OVERLAY-02d the outline read carries the published symbol');
assert.ok(markers.some((entry) => entry.name === 'XI_OUTLINE_STATE' && (entry.payload as { readonly state: string }).state === 'ready'), 'T116-OVERLAY-02e a ready XI_OUTLINE_STATE marker was emitted while the outline panel is open');
assert.equal(subscribedOutlineState, 'ready', 'T116-OVERLAY-02f reads subscribed before language startup receive the attached model');

// T116-OVERLAY-03: escape closes the outline panel and returns to the navigation origin.
const closed = controller.handleOutlineKeypress(key('escape', ''));
assert.equal(closed, true, 'T116-OVERLAY-03a handleOutlineKeypress reports handled');
assert.equal(controller.isOutlineOpen, false, 'T116-OVERLAY-03b escape closes the outline panel');
assert.equal(navigation.returnToOriginCalls.length, 1, 'T116-OVERLAY-03c escape returns to the navigation origin');

// T116-OVERLAY-04: opening hover while outline is open closes outline through the shared panel
// registry (`host.closeAllPanels`), matching every other overlay pair's mutual exclusivity.
controller.openOutline();
assert.equal(controller.isOutlineOpen, true, 'sanity: outline reopened');
controller.openHover();
await Promise.resolve();
await Promise.resolve();
assert.equal(controller.isHoverOpen, true, 'T116-OVERLAY-04a openHover marks hover open');
assert.equal(controller.isOutlineOpen, false, 'T116-OVERLAY-04b opening hover closed the mutually exclusive outline panel');

// T116-OVERLAY-05: the hover popup is transient -- Escape closes it and is consumed; any other
// key closes it and is reported unhandled so the router forwards the motion to the editor.
assert.equal(controller.isHoverOpen, true, 'sanity: hover still open');
assert.equal(controller.handleHoverKeypress({ name: 'j', raw: 'j', shift: false, option: false, ctrl: false, meta: false }), false, 'T116-OVERLAY-05a a motion key closes hover and falls through');
assert.equal(controller.isHoverOpen, false, 'T116-OVERLAY-05b hover closed on the motion');
controller.openHover();
await Promise.resolve();
await Promise.resolve();
assert.equal(controller.handleHoverKeypress({ name: 'up', raw: '', shift: false, option: false, ctrl: false, meta: false }), false, 'T116-OVERLAY-05c an arrow closes hover and falls through');
assert.equal(controller.isHoverOpen, false, 'T116-OVERLAY-05d hover closed on an arrow');
controller.openHover();
await Promise.resolve();
await Promise.resolve();
assert.equal(controller.handleHoverKeypress({ name: 'escape', raw: '\x1b', shift: false, option: false, ctrl: false, meta: false }), true, 'T116-OVERLAY-05e Escape closes hover and is consumed');
assert.equal(controller.isHoverOpen, false, 'T116-OVERLAY-05f hover closed on Escape');

controller.openHover();
await Promise.resolve();
await Promise.resolve();
navigation.publish({ ...IDLE_MODEL, state: 'ready', hover: '   ' });
assert.equal(controller.isHoverOpen, false, 'empty successful hover closes without a no-information popup');
navigation.publish({ ...IDLE_MODEL, state: 'ready', hover: 'late response' });
assert.equal(controller.isHoverOpen, false, 'a late result cannot reopen a dismissed hover');

// T116-OVERLAY-06: do not open an empty or "unavailable" popup when the active language
// server does not advertise hover support.
const unsupportedSubscription = controller.attachNavigation(navigation, new FakeLanguageSession(false));
controller.openHover();
await Promise.resolve();
await Promise.resolve();
assert.equal(controller.isHoverOpen, false, 'T116-OVERLAY-06 hover remains absent without provider support');

controller.dispose();
earlyReadSubscription.dispose();
unsupportedSubscription.dispose();
subscription.dispose();

console.log('T116 LanguageOverlayController passed unavailable-read, attach/request, escape-close and panel-exclusivity fixtures');
