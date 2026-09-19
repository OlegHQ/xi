import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/session/index';
import { BufferHost } from '../../packages/workbench/host/index';
import {
  GitPanelController,
  type GitMutationContext,
  type GitMutationPort,
  type GitMutationResult,
  type GitPanelFilesystemPort,
  type GitStatusPort,
  type WorkbenchGitSnapshot,
} from '../../packages/workbench/git/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'git-panel-test-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function key(name: string, raw: string, overrides: Partial<{ shift: boolean; ctrl: boolean; meta: boolean; option: boolean }> = {}): { readonly name: string; readonly raw: string; readonly shift: boolean; readonly option: boolean; readonly ctrl: boolean; readonly meta: boolean } {
  return { name, raw, shift: overrides.shift ?? false, option: overrides.option ?? false, ctrl: overrides.ctrl ?? false, meta: overrides.meta ?? false };
}

class FakeGitStatus implements GitStatusPort {
  #snapshot: WorkbenchGitSnapshot | undefined;
  readonly #listeners = new Set<(snapshot: WorkbenchGitSnapshot) => void>();
  refreshCalls = 0;

  get snapshot(): WorkbenchGitSnapshot | undefined { return this.#snapshot; }

  subscribe(listener: (snapshot: WorkbenchGitSnapshot) => void) {
    this.#listeners.add(listener);
    return { dispose: () => { this.#listeners.delete(listener); } };
  }

  publish(snapshot: WorkbenchGitSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of [...this.#listeners]) listener(snapshot);
  }

  async refresh(): Promise<void> { this.refreshCalls += 1; }
}

class FakeGitMutations implements GitMutationPort {
  readonly calls: { readonly kind: 'stage' | 'unstage'; readonly paths: readonly string[] }[] = [];
  async stage(paths: readonly string[], _context: GitMutationContext): Promise<GitMutationResult> {
    this.calls.push({ kind: 'stage', paths });
    return { ok: true, value: undefined };
  }
  async unstage(paths: readonly string[], _context: GitMutationContext): Promise<GitMutationResult> {
    this.calls.push({ kind: 'unstage', paths });
    return { ok: true, value: undefined };
  }
}

class FakeFilesystem implements GitPanelFilesystemPort {
  workspaceRelativePath(root: string, path: string): string | undefined {
    return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  }
  workspaceAbsolutePath(root: string, relativePath: string): string | undefined {
    return `${root}/${relativePath}`;
  }
}

function document(documentId: DocumentId, value: string): TextFileDocument {
  const result = TextFileDocument.create(documentId, value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

const launchDocumentId = id<DocumentId>('git-panel-launch-document');
const launchDocument = document(launchDocumentId, 'alpha\n');
const session = new WorkbenchSession({ workspaceId: 'git-panel-test' });
const launchViewId = id<ViewId>('git-panel-launch-view');
session.openBuffer(launchDocument, { viewId: launchViewId });
const host = new BufferHost(session, launchDocument, {
  openDocument: async () => undefined,
  workspaceRelativePath: (path) => (path.startsWith('/workspace/') ? path.slice('/workspace/'.length) : undefined),
  marker: () => {},
  launchViewId,
});
host.createSession(launchDocument, launchViewId);

const status = new FakeGitStatus();
const mutations = new FakeGitMutations();
const filesystem = new FakeFilesystem();
const markers: { readonly name: string; readonly payload: unknown }[] = [];
const errors: string[] = [];
const openedPaths: string[] = [];

const snapshot: WorkbenchGitSnapshot = Object.freeze({
  root: '/workspace',
  generation: 1,
  branch: 'main',
  entries: Object.freeze([
    { path: 'staged.ts', state: 'modified' as const, staged: true, unstaged: false, conflict: false },
    { path: 'unstaged.ts', state: 'modified' as const, staged: false, unstaged: true, conflict: false },
    { path: 'new.ts', state: 'untracked' as const, staged: false, unstaged: true, conflict: false },
    { path: 'conflicted.ts', state: 'conflicted' as const, staged: true, unstaged: true, conflict: true },
  ]),
});

const controller = new GitPanelController({
  host,
  status,
  mutations,
  filesystem,
  workspaceRoot: '/workspace',
  marker: (name, payload) => { markers.push({ name, payload }); },
  onError: (message) => { errors.push(message); },
  openEntry: (absolutePath) => { openedPaths.push(absolutePath); },
});

// GIT-PANEL-01: open() subscribes, refreshes, and sections group entries by staged/changes/
// untracked/conflicts with correct counts.
controller.open();
assert.equal(controller.isOpen, true, 'GIT-PANEL-01a open() marks the controller open');
assert.equal(status.refreshCalls, 1, 'GIT-PANEL-01b open() triggers a status refresh');
status.publish(snapshot);
let model = controller.readModel();
assert.equal(model.selectedId, 'git:staged.ts', 'GIT-PANEL-01b2 status arrival selects the first actionable file, not a loading-state section header');
const byId = new Map(model.sections.map((section) => [section.id, section]));
assert.equal(byId.get('staged')?.count, 1, 'GIT-PANEL-01c staged section has one entry');
assert.equal(byId.get('changes')?.count, 1, 'GIT-PANEL-01d changes section has one entry');
assert.equal(byId.get('untracked')?.count, 1, 'GIT-PANEL-01e untracked section has one entry');
assert.equal(byId.get('conflicts')?.count, 1, 'GIT-PANEL-01f conflicts section has one entry');
assert.equal(byId.get('staged')?.entries[0]?.letter, 'M', 'GIT-PANEL-01g staged entry uses the M letter');
assert.equal(byId.get('untracked')?.entries[0]?.letter, 'U', 'GIT-PANEL-01h untracked entry uses the U letter');
assert.equal(byId.get('conflicts')?.entries[0]?.letter, 'C', 'GIT-PANEL-01i conflicted entry uses the C letter');
assert.equal(model.branch, 'main', 'GIT-PANEL-01j branch is read from the snapshot');

// GIT-PANEL-02: readModel() is memoized by generation/selection/collapse.
const cached = controller.readModel();
assert.equal(cached, model, 'GIT-PANEL-02 unchanged state returns the identical frozen model');

// GIT-PANEL-03: s/u stage/unstage the selected row with the right git argv (paths).
controller.setSelectedId('git:unstaged.ts');
await controller.handleKeypress(key('s', 's'));
assert.deepEqual(mutations.calls.at(-1), { kind: 'stage', paths: ['unstaged.ts'] }, 'GIT-PANEL-03a s stages the selected path');
controller.setSelectedId('git:staged.ts');
await controller.handleKeypress(key('u', 'u'));
assert.deepEqual(mutations.calls.at(-1), { kind: 'unstage', paths: ['staged.ts'] }, 'GIT-PANEL-03b u unstages the selected path');
assert.equal(status.refreshCalls >= 3, true, 'GIT-PANEL-03c stage/unstage each trigger a refresh');

// GIT-PANEL-03d: list navigation uses the same Vim motions as the other sidebar modules.
controller.setSelectedId('git:staged.ts');
await controller.handleKeypress(key('d', '', { ctrl: true }));
assert.equal(controller.readModel().selectedId, 'git-section:conflicts', 'Ctrl-D moves five visible rows down');
await controller.handleKeypress(key('u', '', { ctrl: true }));
assert.equal(controller.readModel().selectedId, 'git:staged.ts', 'Ctrl-U moves a half-page toward the first visible row');
await controller.handleKeypress(key('g', 'g'));
await controller.handleKeypress(key('g', 'g'));
assert.equal(controller.readModel().selectedId, 'git-section:staged', 'gg selects the first visible row');
await controller.handleKeypress(key('g', 'G', { shift: true }));
assert.equal(controller.readModel().selectedId, 'git:conflicted.ts', 'G selects the last visible row');

// GIT-PANEL-04: without a diff provider, Enter does not silently switch to the Files view.
controller.setSelectedId('git:unstaged.ts');
await controller.handleKeypress(key('enter', '\r'));
assert.deepEqual(openedPaths, [], 'GIT-PANEL-04a Enter never falls back to opening a plain file');
assert.equal(controller.isOpen, true, 'GIT-PANEL-04b Enter keeps the Git panel open');

// GIT-PANEL-05: l, Enter, and pointer activation open the selected change diff.
const diffCalls: { readonly path: string; readonly target: 'index' | 'worktree' }[] = [];
const diffController = new GitPanelController({
  host,
  status,
  mutations,
  filesystem,
  workspaceRoot: '/workspace',
  marker: () => {},
  onError: (message) => { errors.push(message); },
  openDiff: async (relativePath, target) => { diffCalls.push({ path: relativePath, target }); },
});
diffController.open();
diffController.setSelectedId('git:staged.ts');
await diffController.handleKeypress(key('l', 'l'));
assert.deepEqual(diffCalls, [{ path: 'staged.ts', target: 'index' }], 'GIT-PANEL-05a l opens a fully-staged entry against the index');
diffController.setSelectedId('git:unstaged.ts');
await diffController.handleKeypress(key('enter', '\r'));
assert.deepEqual(diffCalls[1], { path: 'unstaged.ts', target: 'worktree' }, 'GIT-PANEL-05b Enter opens an unstaged entry against the worktree');
diffController.onPointerActivate('git:unstaged.ts');
await Promise.resolve();
assert.deepEqual(diffCalls[2], { path: 'unstaged.ts', target: 'worktree' }, 'GIT-PANEL-05c clicking a file previews its diff');
assert.equal(diffController.isOpen, true, 'GIT-PANEL-05d clicking a file keeps the Git panel docked');
diffController.dispose();

// GIT-PANEL-06: collapsing a section via a header toggle hides its rows from navigation.
controller.onPointer('git-section:staged');
model = controller.readModel();
assert.equal(byIdFrom(model, 'staged').collapsed, true, 'GIT-PANEL-06a header click collapses the section');
controller.onPointer('git-section:staged');
model = controller.readModel();
assert.equal(byIdFrom(model, 'staged').collapsed, false, 'GIT-PANEL-06b a second click expands it again');

function byIdFrom(readModel: ReturnType<typeof controller.readModel>, sectionId: string) {
  const found = readModel.sections.find((section) => section.id === sectionId);
  if (found === undefined) throw new Error(`missing section ${sectionId}`);
  return found;
}

// GIT-PANEL-07: q/Escape closes the panel.
await controller.handleKeypress(key('q', 'q'));
assert.equal(controller.isOpen, false, 'GIT-PANEL-07 q closes the panel');
assert.equal(errors.length, 0, `no controller errors expected: ${errors.join('; ')}`);
assert.ok(markers.some((entry) => entry.name === 'XI_GIT_PANEL_OPEN'), 'GIT-PANEL-08a open() emits XI_GIT_PANEL_OPEN');
assert.ok(markers.some((entry) => entry.name === 'XI_GIT_STAGE'), 'GIT-PANEL-08b staging emits XI_GIT_STAGE');
assert.ok(markers.some((entry) => entry.name === 'XI_GIT_UNSTAGE'), 'GIT-PANEL-08c unstaging emits XI_GIT_UNSTAGE');

controller.dispose();

console.log('T-GIT-PANEL GitPanelController passed section grouping, memoized readModel, stage/unstage argv, openDiff routing, collapse toggling and close fixtures');
