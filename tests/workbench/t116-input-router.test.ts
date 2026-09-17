import { strict as assert } from 'node:assert';
import { CommandRegistry } from '../../packages/workbench/commands/registry';
import {
  WorkbenchInputRouter,
  type RouterCompletionPort,
  type RouterExplorerPort,
  type RouterKeyEvent,
  type RouterOverlayPort,
  type RouterProblemsPort,
  type RouterSearchPort,
  type RouterWorkspaceEditsPort,
} from '../../packages/workbench/input/router';

function key(name: string, raw: string): RouterKeyEvent {
  return { name, raw, shift: false, option: false, ctrl: false, meta: false };
}

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

function makeRouter(explorer: FakeExplorer, search: FakeSearch, host: FakeHost, session: FakeSession): WorkbenchInputRouter {
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

console.log('T116 WorkbenchInputRouter passed leader-open-explorer and command-line-active fixtures');
