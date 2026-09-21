import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { CommandRegistry } from '../../packages/workbench/commands/registry';
import { WorkbenchInputRouter, type RouterCompletionPort, type RouterOverlayPort, type RouterProblemsPort, type RouterWorkspaceEditsPort } from '../../packages/workbench/input/router';
import type { ClockPort, Disposable } from '../../packages/contracts/src/index';

function identifier<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'jump-label-test-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

const clock: ClockPort = {
  monotonicMilliseconds: () => Date.now(),
  schedule: (delayMilliseconds: number, callback: () => void): Disposable => {
    const handle = setTimeout(callback, delayMilliseconds);
    return Object.freeze({ dispose: () => clearTimeout(handle) });
  },
  sleep: async () => ({ ok: true, value: undefined }),
};
const completion: RouterCompletionPort = {
  isCompletionTrigger: () => false,
  isSignatureTrigger: () => false,
  isAutoSignatureTrigger: () => false,
  isSnippetActive: false,
  openCompletion: () => true,
  openSignature: () => true,
  handleSnippetKeypress: async () => true,
};
const overlays: RouterOverlayPort = { isOutlineOpen: false, openOutline: () => {}, openHover: () => {} };
const problems: RouterProblemsPort = { isProblemsOpen: false, openProblems: () => {} };
const workspaceEdits: RouterWorkspaceEditsPort = { requestCodeActions: async () => true };

const created = TextFileDocument.create(identifier<DocumentId>('jump-label-document'), 'alpha beta\ngamma delta\n', ['lf', 'lf'], 'lf');
if (!created.ok) throw new Error(created.error.kind);
const document = created.value;
const viewId = identifier<ViewId>('jump-label-view');
const snapshot = document.snapshot();
const cursorCalls: { readonly line: number; readonly utf16: number }[] = [];
const session = {
  activeViewId: viewId,
  readView: () => ({ session: { mode: 'normal' }, document: snapshot, scrollTop: 0, scrollLeft: 0 }),
};
const vim = {
  commandLineActive: false,
  prefixHelp: { pendingKeys: [] as string[] },
  clearMotionGhost: () => {},
  handleKey: () => true,
  handlePaste: () => {},
  beginMacroRecording: () => true,
  submitCommandLine: async () => 'handled' as const,
  setCommandLineSource: () => {},
  setCursorPosition: (line: number, utf16: number) => { cursorCalls.push({ line, utf16 }); return true; },
};
const markers: { readonly name: string; readonly payload: unknown }[] = [];
const host = {
  sessions: new Map([[viewId, vim]]),
  activeSession: () => vim,
  notifySurfaceChange: () => {},
};
const router = new WorkbenchInputRouter({
  host: host as never,
  session: session as never,
  marker: (name, payload) => { markers.push({ name, payload }); },
  onError: () => {},
  commandRegistry: new CommandRegistry({ nativeExNames: ['q'] }),
  picker: { isOpen: false, close: async () => {}, open: () => {} },
  explorer: { isOpen: false, open: () => {}, close: () => {}, handleKeypress: () => true },
  search: { isOpen: false, open: () => {}, close: () => {}, handleKeypress: () => true, startReplace: () => {} },
  problems,
  overlays,
  completion,
  workspaceEdits,
  isExplorerServiceLoaded: () => true,
  isSearchServiceLoaded: () => true,
  ensureOptionalServices: async () => {},
  toggleMouseMode: () => true,
  launchViewId: viewId,
  bindings: [{ mode: 'normal', keys: ['w'], commandId: 'editor.goto-word' }],
  jumpLabelAlphabet: ['x', 'y'],
  scrollLines: 1,
  getViewportHeight: () => 10,
  clock,
});

// JUMP-LABEL-UNIT-01: the configured alphabet drives labels and selecting the first label
// moves the owned Vim session to the first visible word.
const key = (raw: string) => ({ name: raw, raw, shift: false, option: false, ctrl: false, meta: false });
assert.equal(await router.dispatchKey(key('w')), 'consumed');
const annotations = router.jumpLabelAnnotations(String(snapshot.id), Number(snapshot.version));
assert.deepEqual(annotations.map(annotation => annotation.text).slice(0, 4), ['xx', 'xy', 'yx', 'yy'], 'JUMP-LABEL-UNIT-01 configured alphabet determines label order');
assert.equal(await router.dispatchKey(key('x')), 'consumed');
assert.equal(await router.dispatchKey(key('x')), 'consumed');
assert.deepEqual(cursorCalls, [{ line: 0, utf16: 0 }], 'JUMP-LABEL-UNIT-01 selecting xx moves the owned session to alpha');
assert.equal(markers.some(marker => marker.name === 'XI_JUMP_LABEL_SELECTED'), true, 'JUMP-LABEL-UNIT-01 selection emits the production marker');
router.dispose();
