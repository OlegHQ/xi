import { strict as assert } from 'node:assert';
import type { ClockPort, Disposable } from '../../packages/contracts/src/index';
import { CommandRegistry } from '../../packages/workbench/commands/registry';
import {
  WorkbenchInputRouter,
  type RouterBindingConfig,
  type RouterCompletionPort,
  type RouterContextMenuOverlayPort,
  type RouterDirectoryReviewOverlayPort,
  type RouterExplorerPort,
  type RouterKeyEvent,
  type RouterOverlayKeypressPort,
  type RouterOverlayPort,
  type RouterProblemsPort,
  type RouterSearchPort,
  type RouterVoidOverlayKeypressPort,
  type RouterWorkspaceEditsPort,
} from '../../packages/workbench/input/router';

// H1-7: `WorkbenchInputRouter.dispatchKey` now owns the ordered overlay-focus stack that used
// to be a 13-branch array walked inside `packages/ui/src/terminal.ts`. This test exercises the
// stack directly against the router (no UI layer involved): precedence order, the one
// `directoryReview` fallthrough case, and that a key handled by one overlay never also reaches
// a later one or the router's own fallthrough (`handleKeypress`).

function key(name: string, raw: string): RouterKeyEvent {
  return { name, raw, shift: false, option: false, ctrl: false, meta: false };
}

const testClock: ClockPort = {
  monotonicMilliseconds: () => Date.now(),
  schedule: (delayMilliseconds: number, callback: () => void): Disposable => {
    const handle = setTimeout(callback, delayMilliseconds);
    return Object.freeze({ dispose: () => clearTimeout(handle) });
  },
  sleep: async () => ({ ok: true, value: undefined }),
};

const noopCompletion: RouterCompletionPort = {
  isCompletionTrigger: () => false,
  isSignatureTrigger: () => false,
  isAutoSignatureTrigger: () => false,
  isSnippetActive: false,
  openCompletion: () => true,
  openSignature: () => true,
  handleSnippetKeypress: async () => true,
};
const noopOverlays: RouterOverlayPort = { isOutlineOpen: false, openOutline: () => {}, openHover: () => {} };
const noopWorkspaceEdits: RouterWorkspaceEditsPort = { requestCodeActions: async () => true };
const noopProblems: RouterProblemsPort = { isProblemsOpen: false, openProblems: () => {} };

class FakeExplorer implements RouterExplorerPort {
  isOpen = false;
  open(): void { this.isOpen = true; }
  close(): void { this.isOpen = false; }
  handleKeypress(): boolean { return true; }
}

class FakeSearch implements RouterSearchPort {
  isOpen = false;
  open(): void { this.isOpen = true; }
  close(): void { this.isOpen = false; }
  handleKeypress(): boolean { return true; }
  startReplace(): void {}
}

class FakeVimSession {
  commandLineActive = false;
  handledKeys: RouterKeyEvent[] = [];
  handleKey(event: RouterKeyEvent): boolean { this.handledKeys.push(event); return true; }
  handlePaste(): void {}
  beginMacroRecording(): boolean { return true; }
  async submitCommandLine(): Promise<'handled'> { return 'handled'; }
  setCommandLineSource(): void {}
}

class FakeHost {
  session: FakeVimSession | undefined;
  sessions = new Map<string, FakeVimSession>();
  activeSession(): FakeVimSession | undefined { return this.session; }
}

class FakeSession {
  activeViewId: string | undefined = 'view-1';
  readView(): { readonly session: { readonly mode: string } } | undefined { return { session: { mode: 'normal' } }; }
}

/** Records every call across every overlay port constructed below, so a test can assert a key
 * reached exactly one of them (never two, never zero when one is open). */
function makeRecordingOverlays(): {
  readonly calls: string[];
  readonly contextMenu: RouterContextMenuOverlayPort & { open: boolean };
  readonly picker: RouterVoidOverlayKeypressPort & { isOpenValue: boolean };
  readonly explorer: RouterOverlayKeypressPort & { isOpenValue: boolean };
  readonly search: RouterOverlayKeypressPort & { isOpenValue: boolean };
  readonly problems: RouterOverlayKeypressPort & { isOpenValue: boolean };
  readonly output: RouterOverlayKeypressPort & { isOpenValue: boolean };
  readonly outline: RouterOverlayKeypressPort & { isOpenValue: boolean };
  readonly hierarchy: RouterOverlayKeypressPort & { isOpenValue: boolean };
  readonly hover: RouterOverlayKeypressPort & { isOpenValue: boolean };
  readonly directoryReview: RouterDirectoryReviewOverlayPort & { isOpenValue: boolean; result: 'handled' | 'unhandled' };
  readonly signature: RouterOverlayKeypressPort & { isOpenValue: boolean };
} {
  const calls: string[] = [];
  function keypressPort(name: string): RouterOverlayKeypressPort & { isOpenValue: boolean } {
    const port = { isOpenValue: false, isOpen: () => port.isOpenValue, onKeypress: (): boolean => { calls.push(name); return true; } };
    return port;
  }
  const contextMenu = { open: false, handleKey: (): boolean => { calls.push('contextMenu'); return true; } };
  const picker = { isOpenValue: false, isOpen: (): boolean => picker.isOpenValue, onKeypress: (): void => { calls.push('picker'); } };
  const directoryReview = {
    isOpenValue: false,
    result: 'handled' as 'handled' | 'unhandled',
    isOpen: (): boolean => directoryReview.isOpenValue,
    onKeypress: (): 'handled' | 'unhandled' => { calls.push('directoryReview'); return directoryReview.result; },
  };
  return {
    calls,
    contextMenu,
    picker,
    explorer: keypressPort('explorer'),
    search: keypressPort('search'),
    problems: keypressPort('problems'),
    output: keypressPort('output'),
    outline: keypressPort('outline'),
    hierarchy: keypressPort('hierarchy'),
    hover: keypressPort('hover'),
    directoryReview,
    signature: keypressPort('signature'),
  };
}

function makeRouter(
  overlays: ReturnType<typeof makeRecordingOverlays>,
  bindings: readonly RouterBindingConfig[] = [],
  withoutActiveView = false,
  executeWorkbenchCommand?: (source: string) => 'handled' | 'unhandled' | 'quit',
  reloadConfig?: () => Promise<boolean>,
): { readonly router: WorkbenchInputRouter; readonly vim: FakeVimSession; readonly explorerPort: FakeExplorer; readonly searchPort: FakeSearch } {
  const explorerPort = new FakeExplorer();
  const searchPort = new FakeSearch();
  const host = new FakeHost();
  const session = new FakeSession();
  const vim = new FakeVimSession();
  if (withoutActiveView) session.activeViewId = undefined;
  else host.sessions.set('view-1', vim);
  const router = new WorkbenchInputRouter({
    host: host as never,
    session: session as never,
    marker: () => {},
    onError: () => {},
    commandRegistry: new CommandRegistry({ nativeExNames: ['q'] }),
    picker: { isOpen: false, close: async () => {}, open: () => {} },
    explorer: explorerPort,
    search: searchPort,
    problems: noopProblems,
    overlays: noopOverlays,
    completion: noopCompletion,
    workspaceEdits: noopWorkspaceEdits,
    ...(executeWorkbenchCommand === undefined ? {} : { executeWorkbenchCommand: (source: string) => executeWorkbenchCommand(source) }),
    isExplorerServiceLoaded: () => true,
    isSearchServiceLoaded: () => true,
    ensureOptionalServices: async () => {},
    toggleMouseMode: () => true,
    launchViewId: 'view-1' as never,
    bindings,
    ...(reloadConfig === undefined ? {} : { reloadConfig }),
    scrollLines: 1,
    getViewportHeight: () => 10,
    clock: testClock,
    overlayContextMenu: overlays.contextMenu,
    overlayPicker: overlays.picker,
    overlayExplorer: overlays.explorer,
    overlaySearch: overlays.search,
    overlayProblems: overlays.problems,
    overlayOutput: overlays.output,
    overlayOutline: overlays.outline,
    overlayHierarchy: overlays.hierarchy,
    overlayHover: overlays.hover,
    overlayDirectoryReview: overlays.directoryReview,
    overlaySignature: overlays.signature,
  });
  return { router, vim, explorerPort, searchPort };
}

// ROUTER-CONFIG-RELOAD-01: the production command route invokes the injected atomic reload
// owner instead of reporting the old unavailable-session error.
{
  let calls = 0;
  const overlays = makeRecordingOverlays();
  const { router } = makeRouter(overlays, [{ mode: 'normal', keys: ['x'], commandId: 'config.reload' }], false, undefined, async () => { calls += 1; return true; });
  assert.equal(await resolve(router.dispatchKey(key('x', 'x'))), 'consumed');
  assert.equal(calls, 1, 'ROUTER-CONFIG-RELOAD-01 config.reload reaches the injected reload owner');
  router.dispose();
}

// ROUTER-DISPATCH-06: a workbench with no active editable view still owns a usable Ex prompt.
// Typing and submitting routes workbench commands through the fallback instead of dropping ':'
// and every following key on the floor.
{
  const executed: string[] = [];
  const overlays = makeRecordingOverlays();
  const { router } = makeRouter(overlays, [], true, source => { executed.push(source); return 'quit'; });

  assert.equal(await resolve(router.dispatchKey(key(':', ':'))), 'consumed');
  assert.equal(router.isCommandLineActive(), true);
  assert.equal(await resolve(router.dispatchKey(key('q', 'q'))), 'consumed');
  assert.equal(await resolve(router.dispatchKey(key('enter', '\r'))), 'quit');
  assert.deepEqual(executed, ['q']);
  assert.equal(router.isCommandLineActive(), false);

  router.dispose();
}

async function resolve<T>(value: T | Promise<T>): Promise<T> { return value; }

// ROUTER-DISPATCH-01: precedence order -- when every overlay reports itself open, the
// highest-priority one (contextMenu) consumes the key and nothing else is ever called.
{
  const overlays = makeRecordingOverlays();
  overlays.contextMenu.open = true;
  overlays.picker.isOpenValue = true;
  overlays.explorer.isOpenValue = true;
  const { router } = makeRouter(overlays);

  const outcome = await resolve(router.dispatchKey(key('a', 'a')));
  assert.equal(outcome, 'consumed', 'ROUTER-DISPATCH-01 contextMenu consumes the key');
  assert.deepEqual(overlays.calls, ['contextMenu'], 'ROUTER-DISPATCH-01 only contextMenu was ever called, never picker/explorer');

  router.dispose();
}

// ROUTER-DISPATCH-02: with contextMenu closed, the next-highest open surface (picker) wins,
// and lower-priority explorer/search never see the key.
{
  const overlays = makeRecordingOverlays();
  overlays.picker.isOpenValue = true;
  overlays.explorer.isOpenValue = true;
  overlays.search.isOpenValue = true;
  const { router } = makeRouter(overlays);

  const outcome = await resolve(router.dispatchKey(key('a', 'a')));
  assert.equal(outcome, 'consumed');
  assert.deepEqual(overlays.calls, ['picker'], 'ROUTER-DISPATCH-02 picker precedes explorer and search');

  router.dispose();
}

// ROUTER-DISPATCH-03: directoryReview may decline ('unhandled') and let the key fall through
// to the next entry (signature) -- the one exception in the stack.
{
  const overlays = makeRecordingOverlays();
  overlays.directoryReview.isOpenValue = true;
  overlays.directoryReview.result = 'unhandled';
  overlays.signature.isOpenValue = true;
  const { router } = makeRouter(overlays);

  const outcome = await resolve(router.dispatchKey(key('a', 'a')));
  assert.equal(outcome, 'consumed');
  assert.deepEqual(overlays.calls, ['directoryReview', 'signature'], 'ROUTER-DISPATCH-03 directoryReview declined and signature saw the key next');

  router.dispose();
}

// ROUTER-DISPATCH-04: directoryReview accepting ('handled') consumes the key -- signature
// (lower priority) never sees it.
{
  const overlays = makeRecordingOverlays();
  overlays.directoryReview.isOpenValue = true;
  overlays.directoryReview.result = 'handled';
  overlays.signature.isOpenValue = true;
  const { router } = makeRouter(overlays);

  const outcome = await resolve(router.dispatchKey(key('a', 'a')));
  assert.equal(outcome, 'consumed');
  assert.deepEqual(overlays.calls, ['directoryReview'], 'ROUTER-DISPATCH-04 directoryReview accepted; signature was never called');

  router.dispose();
}

// ROUTER-DISPATCH-05: with every overlay closed, the key falls all the way through to the
// router's own fallthrough (the active Vim session), and no overlay port is ever called.
{
  const overlays = makeRecordingOverlays();
  const { router, vim } = makeRouter(overlays);

  const outcome = await resolve(router.dispatchKey(key('j', 'j')));
  assert.equal(outcome, 'consumed');
  assert.deepEqual(overlays.calls, [], 'ROUTER-DISPATCH-05 no overlay was open, so none was called');
  assert.equal(vim.handledKeys.length, 1, 'ROUTER-DISPATCH-05 the key reached the active Vim session');

  router.dispose();
}

console.log('input-router-dispatch: overlay-focus-stack precedence, directoryReview fallthrough and single-consumer exclusivity fixtures passed');
