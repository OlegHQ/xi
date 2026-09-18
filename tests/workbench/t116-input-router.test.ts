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
  open(): void { this.opened = true; this.isOpen = true; }
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

function makeRouter(explorer: FakeExplorer, search: FakeSearch, host: FakeHost, session: FakeSession, bindings: readonly RouterBindingConfig[] = []): WorkbenchInputRouter {
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

console.log('T116 WorkbenchInputRouter passed leader-open-explorer, command-line-active, synchronous-fast-path and config-binding fixtures');
