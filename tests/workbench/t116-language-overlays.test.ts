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

function range(startLine: number, startUtf16: number, endLine: number, endUtf16: number) { return { startLine, startUtf16, endLine, endUtf16 }; }

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
    this.publish({ state: 'ready', generation: 1, symbols: Object.freeze([{ id: 'file:///a.ts:0', name: 'foo', kind: 5, range: range(0, 0, 1, 4), selection: range(0, 0, 0, 5), children: Object.freeze([{ id: 'file:///a.ts:0.0', name: 'bar', kind: 6, range: range(1, 0, 1, 4), selection: range(1, 1, 1, 3), children: Object.freeze([]) }]) }]), hover: undefined, message: undefined });
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
  isOutlineVisible: () => true,
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
assert.equal(navigation.returnToOriginCalls.length, 0, 'T116-OVERLAY-03c escape only returns focus; the outline is a persistent tree, not a navigation preview');

// T116-OVERLAY-03d..j: the Outline is a VS Code-style tree -- nested rows, keyboard selection,
// collapse/expand, reveal in the editor, and a selection that follows the cursor when unfocused.
assert.deepEqual(controller.outlineRead.model.rows.map((row) => [row.id, row.depth, row.expandable, row.expanded]), [['file:///a.ts:0', 0, true, true], ['file:///a.ts:0.0', 1, false, false]], 'T116-OVERLAY-03d nested symbols flatten into expanded tree rows');
assert.equal(controller.outlineRead.model.activeId, 'file:///a.ts:0', 'T116-OVERLAY-03e the innermost symbol spanning the cursor line is active');
controller.openOutline();
controller.handleOutlineKeypress(key('j', 'j'));
assert.equal(controller.outlineRead.model.selectedId, 'file:///a.ts:0.0', 'T116-OVERLAY-03f j moves the selection down');
controller.handleOutlineKeypress(key('h', 'h'));
assert.equal(controller.outlineRead.model.selectedId, 'file:///a.ts:0', 'T116-OVERLAY-03g h on a leaf moves to its parent');
controller.handleOutlineKeypress(key('h', 'h'));
assert.deepEqual(controller.outlineRead.model.rows.map((row) => row.id), ['file:///a.ts:0'], 'T116-OVERLAY-03h h on an expanded row collapses it');
controller.handleOutlineKeypress(key('l', 'l'));
assert.deepEqual(controller.outlineRead.model.rows.map((row) => row.id), ['file:///a.ts:0', 'file:///a.ts:0.0'], 'T116-OVERLAY-03i l expands a collapsed row (Files-tree semantics)');
controller.handleOutlineKeypress(key('j', 'j'));
controller.handleOutlineKeypress(key('l', 'l'));
assert.equal(controller.isOutlineOpen, true, 'T116-OVERLAY-03i2 l on a leaf previews and keeps focus, like a Files preview');
assert.equal(controller.outlineRead.model.selectedId, 'file:///a.ts:0.0', 'T116-OVERLAY-03i3 the previewed row stays selected');
controller.handleOutlineKeypress({ ...key('u', '\u0015'), ctrl: true });
assert.equal(controller.outlineRead.model.selectedId, 'file:///a.ts:0', 'T116-OVERLAY-03i4 Ctrl-U moves up (clamped at the first row)');
controller.handleOutlineKeypress({ ...key('d', '\u0004'), ctrl: true });
assert.equal(controller.outlineRead.model.selectedId, 'file:///a.ts:0.0', 'T116-OVERLAY-03i5 Ctrl-D moves down (clamped at the last row)');
controller.handleOutlineKeypress(key('return', '\r'));
const revealed = session.readView(launchViewId)?.selections;
assert.equal(controller.isOutlineOpen, false, 'T116-OVERLAY-03j Enter hands focus back to the editor');
assert.equal(Number(revealed?.members[0]?.head.at.offset), 'alpha\n'.length + 1, 'T116-OVERLAY-03k Enter moves the cursor to the symbol name (LSP selectionRange)');
controller.syncOutline();
assert.equal(controller.outlineRead.model.activeId, 'file:///a.ts:0.0', 'T116-OVERLAY-03l the unfocused selection follows the cursor into the child symbol');
assert.equal(controller.outlineRead.model.selectedId, 'file:///a.ts:0.0', 'T116-OVERLAY-03m unfocused selection tracks the active symbol');

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
