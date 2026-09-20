import { compileConfig, DEFAULT_CONFIG_TOML } from '../../packages/services/config';
import { strict as assert } from 'node:assert';
import type { ClockPort, Disposable } from '../../packages/contracts/src/index';
import { CommandRegistry } from '../../packages/workbench/commands/registry';
import {
  WorkbenchInputRouter,
  type RouterBindingConfig,
  type RouterCompletionPort,
  type RouterExplorerPort,
  type RouterKeyEvent,
  type RouterOverlayPort,
  type RouterProblemsPort,
  type RouterSearchPort,
  type RouterWorkspaceEditsPort,
} from '../../packages/workbench/input/router';

function key(name: string, raw: string, overrides: Partial<{ shift: boolean; ctrl: boolean; meta: boolean; option: boolean }> = {}): RouterKeyEvent {
  return { name, raw, shift: overrides.shift ?? false, option: overrides.option ?? false, ctrl: overrides.ctrl ?? false, meta: overrides.meta ?? false };
}

const defaults = compileConfig([{ name: 'defaults', kind: 'defaults', source: DEFAULT_CONFIG_TOML }]);
assert.ok(defaults.ok);
const defaultBindings = defaults.value.bindings;

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
  isSnippetActive: false,
  openCompletion: () => true,
  openSignature: () => true,
  handleSnippetKeypress: async () => true,
};
const noopOverlays: RouterOverlayPort = { isOutlineOpen: false, openOutline: () => {}, openHover: () => {} };
const noopWorkspaceEdits: RouterWorkspaceEditsPort = { requestCodeActions: async () => true };
const noopProblems: RouterProblemsPort = { isProblemsOpen: false, openProblems: () => {} };

class FakeExplorer implements RouterExplorerPort {
  opened = false;
  isOpen = false;
  handledKeys: RouterKeyEvent[] = [];
  open(): void { this.opened = true; this.isOpen = true; }
  close(): void { this.isOpen = false; }
  handleKeypress(event: RouterKeyEvent): boolean { this.handledKeys.push(event); return true; }
}

class FakeSearch implements RouterSearchPort {
  isOpen = false;
  open(): void { this.isOpen = true; }
  close(): void { this.isOpen = false; }
  handleKeypress(): boolean { return true; }
  startReplace(): void {}
}

class FakeVimSession {
  ghostClears = 0;
  clearMotionGhost(): void { this.ghostClears += 1; }
  commandLineActive = false;
  prefixHelp = { pendingKeys: [] as string[] };
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

/** Enough of `WorkbenchSession`'s `readView`/`setViewScroll` surface for `scrollViewBy` (no
 * selections, so the cursor-follow branch is skipped and no vim-session stub is needed). */
class FakeScrollSession {
  activeViewId: string | undefined = 'view-1';
  mode = 'normal';
  scrollTop = 5;
  scrollLeft = 0;
  readonly setViewScrollCalls: { readonly viewId: string; readonly scrollTop: number; readonly scrollLeft: number }[] = [];
  readView(viewId: string): unknown {
    if (viewId !== this.activeViewId) return undefined;
    return {
      session: { mode: this.mode },
      scrollTop: this.scrollTop,
      scrollLeft: this.scrollLeft,
      document: { lineCount: 100 },
      selections: { members: [], primaryId: undefined },
    };
  }
  setViewScroll(viewId: string, scrollTop: number, scrollLeft: number): { readonly ok: true } {
    this.scrollTop = scrollTop;
    this.scrollLeft = scrollLeft;
    this.setViewScrollCalls.push({ viewId, scrollTop, scrollLeft });
    return { ok: true };
  }
}

function makeRouter(
  explorer: FakeExplorer,
  search: FakeSearch,
  host: FakeHost,
  session: FakeSession,
  bindings: readonly RouterBindingConfig[] = defaultBindings,
  git?: { readonly panel: { readonly isOpen: () => boolean; readonly onKeypress: (event: RouterKeyEvent) => boolean }; readonly diff: { readonly isOpen: () => boolean; readonly onKeypress: (event: RouterKeyEvent) => boolean } },
): WorkbenchInputRouter {
  return new WorkbenchInputRouter({
    host: host as never,
    session: session as never,
    marker: () => {},
    onError: () => {},
    commandRegistry: new CommandRegistry({ nativeExNames: ['q'] }),
    picker: { isOpen: false, close: async () => {}, open: () => {} },
    explorer,
    search,
    problems: noopProblems,
    overlays: noopOverlays,
    completion: noopCompletion,
    workspaceEdits: noopWorkspaceEdits,
    isExplorerServiceLoaded: () => true,
    isSearchServiceLoaded: () => true,
    ensureOptionalServices: async () => {},
    toggleMouseMode: () => true,
    launchViewId: 'view-1' as never,
    bindings,
    scrollLines: 1,
    getViewportHeight: () => 10,
    clock: testClock,
    overlayExplorer: { isOpen: () => explorer.isOpen, onKeypress: (event) => explorer.handleKeypress(event) },
    ...(git === undefined ? {} : { overlayGit: git.panel, overlayGitDiff: git.diff }),
  });
}

// T116-ROUTER-01: leader (<Space>) then the panel-prefix 'v' then 'f' opens the explorer
// through the injected port, exactly reproducing the original main.ts leader chain's
// panel-prefix 'f' branch.
{
  const explorer = new FakeExplorer();
  const search = new FakeSearch();
  const host = new FakeHost();
  const session = new FakeSession();
  const router = makeRouter(explorer, search, host, session);

  const spaceResult = await router.handleKeypress(key('space', ' '));
  assert.equal(spaceResult, true, 'space enters leader-pending state');
  assert.equal(router.leaderPending, true);

  const vResult = await router.handleKeypress(key('v', 'v'));
  assert.equal(vResult, true, 'leader v enters the panel-prefix sub-state');
  assert.equal(router.leaderPending, true, 'still pending: the panel-prefix chord needs one more key');

  const fResult = await router.handleKeypress(key('f', 'f'));
  assert.equal(fResult, true, 'leader v f is consumed');
  assert.equal(explorer.opened, true, 'T116-ROUTER-01 leader v f opened the explorer through the port');
  assert.equal(router.leaderPending, false, 'leader-pending state clears after the leader chord resolves');

  router.dispose();
}

// Opening a comparison focuses its editor. Ctrl-W remains a window-command prefix.
{
  const explorer = new FakeExplorer();
  const search = new FakeSearch();
  const host = new FakeHost();
  host.session = new FakeVimSession();
  host.sessions.set('view-1', host.session);
  const session = new FakeSession();
  let diffOpen = false;
  const panelKeys: string[] = [];
  const diffKeys: string[] = [];
  const router = makeRouter(explorer, search, host, session, [], {
    panel: { isOpen: () => true, onKeypress: (event) => { panelKeys.push(event.raw); return true; } },
    diff: { isOpen: () => diffOpen, onKeypress: () => false },
  });

  diffOpen = true;
  assert.equal(router.dispatchKey(key('j', 'j')), 'consumed');
  assert.deepEqual(panelKeys, [], 'T116-ROUTER-GIT-01a a newly opened comparison focuses its editor');
  assert.deepEqual(host.session.handledKeys.map(event => event.raw), ['j']);
  assert.deepEqual(diffKeys, []);

  assert.equal(router.dispatchKey(key('w', '\u0017', { ctrl: true })), 'consumed');
  router.schedulePrefixHelp('view-1' as never, ['<C-w>'], [{ kind: 'motions', label: 'Window', keys: ['h', 'j', 'k', 'l'] }]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(router.prefixHelp.model, undefined, 'a sidebar-originated window chord does not paint editor prefix help');
  host.session.prefixHelp.pendingKeys = ['<C-w>'];
  const clearsBeforeVisual = host.session.ghostClears;
  assert.ok(clearsBeforeVisual > 0, 'non-v workbench input invalidates the old ghost');
  assert.equal(router.dispatchKey(key('v', 'v')), 'consumed');
  assert.equal(host.session.ghostClears, clearsBeforeVisual, 'v reaches the engine with its ghost intact');
  assert.deepEqual(diffKeys, [], 'the diff controller does not capture window commands');
  assert.deepEqual(panelKeys, [], 'Git does not consume the Ctrl-W continuation');
  assert.deepEqual(host.session.handledKeys.map(event => event.raw), ['j', '\u0017', 'v']);
  router.dispose();
}

// T116-ROUTER-02: a keypress while the Ex command line is active goes straight to the active
// Vim session, never through the leader chain, even if leaderPending happened to be set.
{
  const explorer = new FakeExplorer();
  const search = new FakeSearch();
  const host = new FakeHost();
  const session = new FakeSession();
  const router = makeRouter(explorer, search, host, session);
  const vim = new FakeVimSession();
  vim.commandLineActive = true;
  host.session = vim;

  const result = await router.handleKeypress(key('a', 'a'));
  assert.equal(result, true);
  assert.equal(vim.handledKeys.length, 1, 'T116-ROUTER-02 the keypress reached the active session directly');
  assert.equal(explorer.opened, false, 'the explorer was never touched while the command line is active');

  router.dispose();
}

// T116-ROUTER-03: an ordinary Normal-mode 'j' and an Insert-mode character reach the active
// vim session synchronously (its own handleKey fast path is sync); the router must return that
// result directly, not wrap it in a promise, or every ordinary keystroke pays a microtask hop.
{
  const explorer = new FakeExplorer();
  const search = new FakeSearch();
  const host = new FakeHost();
  const session = new FakeSession();
  const router = makeRouter(explorer, search, host, session);
  const vim = new FakeVimSession();
  host.sessions.set(session.activeViewId as string, vim);

  const normalResult = router.handleKeypress(key('j', 'j'));
  assert.equal(normalResult instanceof Promise, false, 'T116-ROUTER-03 Normal-mode j returns a non-promise result');
  assert.equal(normalResult, true);

  const insertResult = router.handleKeypress(key('x', 'x'));
  assert.equal(insertResult instanceof Promise, false, 'T116-ROUTER-03 an ordinary character returns a non-promise result');
  assert.equal(insertResult, true);

  assert.equal(vim.handledKeys.length, 2, 'both keys reached the active session');

  router.dispose();
}

// T116-ROUTER-04: <C-Up>/<C-Down> line-scroll are on by default in Normal mode, resolved to
// their `view.scroll-up`/`view.scroll-down` commands before Vim's own key handling ever sees
// the key; a config binding for a plain key resolves the same way, alongside the defaults.
{
  const explorer = new FakeExplorer();
  const search = new FakeSearch();
  const host = new FakeHost();
  const session = new FakeScrollSession();
  const router = makeRouter(explorer, search, host, session as never, [
    { mode: 'normal', keys: ['g'], commandId: 'view.scroll-down' },
  ]);

  const upResult = router.handleKeypress(key('up', '', { ctrl: true }));
  assert.equal(upResult, true, 'T116-ROUTER-04a default <C-Up> is consumed');
  assert.deepEqual(session.setViewScrollCalls[0], { viewId: 'view-1', scrollTop: 4, scrollLeft: 0 }, 'T116-ROUTER-04b <C-Up> scrolls up by scrollLines');

  const configResult = router.handleKeypress(key('g', 'g'));
  assert.equal(configResult, true, 'T116-ROUTER-04c a config-bound plain key is also consumed');
  assert.deepEqual(session.setViewScrollCalls[1], { viewId: 'view-1', scrollTop: 5, scrollLeft: 0 }, 'T116-ROUTER-04d the config binding resolved to view.scroll-down');

  router.dispose();
}

// T116-ROUTER-05: panel leader help comes from that panel's configurable bindings, and the
// resolved command is routed back to the focused panel without moving focus.
{
  const explorer = new FakeExplorer();
  const search = new FakeSearch();
  const host = new FakeHost();
  const session = new FakeSession();
  const router = makeRouter(explorer, search, host, session, [
    { mode: 'files-panel', keys: ['<Space>', 'l'], commandId: 'panel.preview' },
  ]);
  explorer.open();

  assert.equal(await router.dispatchKey(key('space', ' ')), 'consumed');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(router.prefixHelp.model?.hints[0]?.commandId, 'panel.preview', 'T116-ROUTER-05a panel help uses files-panel bindings');
  assert.equal(await router.dispatchKey(key('l', 'l')), 'consumed');
  assert.equal(explorer.handledKeys.at(-1)?.name, 'l', 'T116-ROUTER-05b configurable preview dispatches to the focused panel');
  assert.equal(explorer.isOpen, true, 'T116-ROUTER-05c preview keeps panel focus');

  router.dispose();
}

console.log('T116 WorkbenchInputRouter passed leader-open-explorer, command-line-active, synchronous-fast-path and config-binding fixtures');

// Arbitrary configured leader prefixes replace the previous hard-coded v chain.
{
  const explorer = new FakeExplorer();
  const host = new FakeHost();
  const router = makeRouter(explorer, new FakeSearch(), host, new FakeSession(), [
    { mode: 'normal', keys: ['<Space>', 'x', 'y', 'z'], commandId: 'panel.files.focus' },
  ]);
  for (const raw of [' ', 'v', 'f']) await router.dispatchKey(key(raw === ' ' ? 'space' : raw, raw));
  assert.equal(explorer.opened, false, 'removed default has no hard-coded fallback');
  for (const raw of [' ', 'x', 'y', 'z']) await router.dispatchKey(key(raw === ' ' ? 'space' : raw, raw));
  assert.equal(explorer.opened, true, 'arbitrary configured prefix reaches its command');
  router.dispose();
}

// Single-key application bindings use the same actions as leader mappings, in editor/panel context.
{
  const explorer = new FakeExplorer();
  const search = new FakeSearch();
  const host = new FakeHost();
  const session = new FakeSession();
  const router = makeRouter(explorer, search, host, session, [
    { mode: 'normal', keys: ['<F2>'], commandId: 'panel.files.focus' },
    { mode: 'files-panel', keys: ['<F3>'], commandId: 'search.workspace' },
  ]);
  assert.equal(await router.dispatchKey(key('f2', '')), 'consumed');
  assert.equal(explorer.opened, true);
  assert.equal(await router.dispatchKey(key('f3', '')), 'consumed');
  assert.equal(search.isOpen, true);
  assert.equal(explorer.handledKeys.length, 0, 'mapped key does not also reach panel default handler');
  router.dispose();
}
