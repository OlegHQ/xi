import { strict as assert } from 'node:assert';
import { asIdentifier, type DocumentId, type ViewId } from '../../packages/primitives/src/index';
import type { CancellationToken, ClockPort, Disposable, PlatformFailure, Result } from '../../packages/contracts/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/session/index';
import { BufferHost } from '../../packages/workbench/host/index';
import {
  ExplorerController,
  type ExplorerDirectoryOperationPlan,
  type ExplorerFileOperationsPort,
  type ExplorerJournaledOperationsPort,
  type ExplorerNavigationPort,
  type ExplorerTreeModel,
  type ExplorerTreeNode,
  type ExplorerTreePort,
} from '../../packages/workbench/explorer/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T116-explorer-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(documentId: DocumentId, value = 'alpha\n'): TextFileDocument {
  const result = TextFileDocument.create(documentId, value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function key(name: string, raw: string, overrides: Partial<{ shift: boolean; ctrl: boolean; meta: boolean; option: boolean }> = {}): { readonly name: string; readonly raw: string; readonly shift: boolean; readonly option: boolean; readonly ctrl: boolean; readonly meta: boolean } {
  return { name, raw, shift: overrides.shift ?? false, option: overrides.option ?? false, ctrl: overrides.ctrl ?? false, meta: overrides.meta ?? false };
}

const failure: PlatformFailure = { code: 'unsupported', message: 'not found', retryable: false };
const ok = <T>(value: T): Result<T, PlatformFailure> => ({ ok: true, value });
const err = (message: string): Result<never, PlatformFailure> => ({ ok: false, error: { ...failure, message } });

// -- A fake filesystem operations port recording every mutating call. --
class FakeFileOperations implements ExplorerFileOperationsPort {
  readonly existing = new Set<string>();
  readonly calls: string[] = [];
  async stat(path: string, _cancellation: CancellationToken): Promise<Result<unknown, PlatformFailure>> {
    this.calls.push(`stat:${path}`);
    return this.existing.has(path) ? ok({}) : err('missing');
  }
  async renamePath(from: string, to: string, _cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    this.calls.push(`rename:${from}->${to}`);
    this.existing.delete(from);
    this.existing.add(to);
    return ok(undefined);
  }
  async copyPath(from: string, to: string, _cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    this.calls.push(`copy:${from}->${to}`);
    this.existing.add(to);
    return ok(undefined);
  }
  async removePath(path: string, _recursive: boolean, _cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    this.calls.push(`remove:${path}`);
    this.existing.delete(path);
    return ok(undefined);
  }
  async makeDirectory(path: string, _cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    this.calls.push(`mkdir:${path}`);
    return ok(undefined);
  }
  async writeFileAtomic(path: string, _contents: Uint8Array, _cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    this.calls.push(`write:${path}`);
    this.existing.add(path);
    return ok(undefined);
  }
}

// -- A fake tree: enough state to drive open()/handleKeypress() without the real ExplorerTree. --
class FakeTree implements ExplorerTreePort {
  #generation = 0;
  #selectedId: string | undefined;
  #filter = '';
  readonly #listeners = new Set<(model: ExplorerTreeModel) => void>();
  readonly nodes: Map<string, ExplorerTreeNode>;
  readonly calls: string[] = [];

  constructor(nodes: readonly ExplorerTreeNode[], selectedId?: string) {
    this.nodes = new Map(nodes.map((node) => [node.id, node]));
    this.#selectedId = selectedId;
  }

  get model(): ExplorerTreeModel {
    return { generation: this.#generation, roots: ['root'], selectedId: this.#selectedId, filter: this.#filter, state: 'ready', visibleRows: [] };
  }
  subscribe(listener: (model: ExplorerTreeModel) => void) {
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }
  publish(): void {
    this.#generation += 1;
    for (const listener of this.#listeners) listener(this.model);
  }
  focus(): void { this.calls.push('focus'); }
  blur(): void { this.calls.push('blur'); }
  setFilter(filter: string): void { this.#filter = filter; this.calls.push(`filter:${filter}`); }
  async expand(nodeId: string, _force: boolean, _cancellation: CancellationToken): Promise<unknown> { this.calls.push(`expand:${nodeId}`); return undefined; }
  async watchRoot(rootId: string, _cancellation: CancellationToken): Promise<unknown> { this.calls.push(`watch:${rootId}`); return undefined; }
  async reveal(rootId: string, relativePath: string, _cancellation: CancellationToken): Promise<unknown> { this.calls.push(`reveal:${rootId}:${relativePath}`); return undefined; }
  readNode(nodeId: string): ExplorerTreeNode | undefined { return this.nodes.get(nodeId); }
  select(nodeId: string): boolean {
    if (!this.nodes.has(nodeId)) return false;
    this.#selectedId = nodeId;
    return true;
  }
}

// -- A fake journaled-operations port: exercises the same apply()/restoreApplied() shape as
// `JournaledFilesystemOperations` without a real filesystem, recording moves onto the same
// `FakeFileOperations.calls` log the prior direct-filesystem-call assertions already read. --
class FakeJournaledOperations implements ExplorerJournaledOperationsPort {
  #trashCounter = 0;
  constructor(private readonly fs: FakeFileOperations, private readonly trashDirectory: string) {}
  async apply(plan: ExplorerDirectoryOperationPlan, _cancellation: CancellationToken): Promise<Result<{ readonly journal: unknown }, { readonly kind: string; readonly message?: string }>> {
    const operation = plan.operations[0];
    if (operation === undefined) return { ok: false, error: { kind: 'invalid-plan', message: 'empty plan' } };
    if (operation.kind === 'rename') {
      this.fs.calls.push(`rename:${operation.sourcePath}->${operation.destinationPath}`);
      this.fs.existing.delete(operation.sourcePath);
      this.fs.existing.add(operation.destinationPath);
      return { ok: true, value: { journal: { kind: 'rename', from: operation.sourcePath, to: operation.destinationPath } } };
    }
    if (operation.kind === 'copy') {
      this.fs.calls.push(`copy:${operation.sourcePath}->${operation.destinationPath}`);
      this.fs.existing.add(operation.destinationPath);
      return { ok: true, value: { journal: { kind: 'copy', from: operation.sourcePath, to: operation.destinationPath } } };
    }
    this.fs.calls.push(`mkdir:${this.trashDirectory}`);
    this.#trashCounter += 1;
    const to = `${this.trashDirectory}/${this.#trashCounter}-${operation.sourcePath.split('/').pop()}`;
    this.fs.calls.push(`rename:${operation.sourcePath}->${to}`);
    this.fs.existing.delete(operation.sourcePath);
    this.fs.existing.add(to);
    return { ok: true, value: { journal: { kind: 'trash', from: operation.sourcePath, to } } };
  }
  async restoreApplied(journal: unknown, _cancellation: CancellationToken): Promise<Result<unknown, { readonly kind: string; readonly message?: string }>> {
    const entry = journal as { readonly kind: string; readonly from: string; readonly to: string };
    if (entry.kind === 'copy') {
      this.fs.calls.push(`remove:${entry.to}`);
      this.fs.existing.delete(entry.to);
    } else {
      this.fs.calls.push(`rename:${entry.to}->${entry.from}`);
      this.fs.existing.delete(entry.to);
      this.fs.existing.add(entry.from);
    }
    return { ok: true, value: undefined };
  }
}

const testClock: ClockPort = {
  monotonicMilliseconds: () => Date.now(),
  schedule: (delayMilliseconds: number, callback: () => void): Disposable => {
    const handle = setTimeout(callback, delayMilliseconds);
    return Object.freeze({ dispose: () => clearTimeout(handle) });
  },
  sleep: async () => ({ ok: true, value: undefined }),
};

class FakeNavigation implements ExplorerNavigationPort {
  readonly calls: string[] = [];
  disposed = false;
  async handle(action: Parameters<ExplorerNavigationPort['handle']>[0]): Promise<boolean> {
    this.calls.push(action);
    return true;
  }
  dispose(): void { this.disposed = true; }
}

const launchDocumentId = id<DocumentId>('T116-explorer-launch-document');
const launchDocument = document(launchDocumentId);
const session = new WorkbenchSession({ workspaceId: 'T116-explorer' });
const launchViewId = id<ViewId>('T116-explorer-launch-view');
session.openBuffer(launchDocument, { viewId: launchViewId });
const host = new BufferHost(session, launchDocument, {
  openDocument: async () => undefined,
  workspaceRelativePath: () => undefined,
  marker: () => {},
  launchViewId,
});
host.createSession(launchDocument, launchViewId);

const filesystem = new FakeFileOperations();
const markers: Array<{ readonly name: string; readonly payload: unknown }> = [];
const errors: string[] = [];
let ensureServicesCalls = 0;

const fileOperations = new FakeJournaledOperations(filesystem, '/workspace/.xi-trash');

const controller = new ExplorerController({
  host,
  session,
  filesystem,
  fileOperations,
  clock: testClock,
  marker: (name, payload) => { markers.push({ name, payload }); },
  onError: (message) => { errors.push(message); },
  workspaceRelativePath: () => undefined,
  trashDirectory: '/workspace/.xi-trash',
  ensureServices: async () => { ensureServicesCalls += 1; },
});

const fileNode: ExplorerTreeNode = { id: 'file-a', kind: 'file', name: 'a.txt', path: '/workspace/a.txt', relativePath: 'a.txt', expanded: false };
const tree = new FakeTree([fileNode], fileNode.id);
const navigation = new FakeNavigation();
filesystem.existing.add('/workspace/a.txt');

// T116-EXPLORER-01: attaching the tree binds state without requiring ensureServices, and
// open() drives focus/expand/watch through the port.
controller.attachTree(tree, navigation);
controller.open();
assert.equal(controller.isOpen, true, 'T116-EXPLORER-01a open() marks the controller open');
assert.equal(controller.isVisible, true, 'T116-EXPLORER-01a2 open() shows the tree');
assert.equal(ensureServicesCalls, 0, 'T116-EXPLORER-01b a bound tree never triggers ensureServices');
assert.ok(tree.calls.includes('focus'), 'T116-EXPLORER-01c open() focuses the tree');
assert.ok(tree.calls.some((call) => call.startsWith('expand:')), 'T116-EXPLORER-01d open() expands the first root');
assert.ok(tree.calls.some((call) => call.startsWith('watch:')), 'T116-EXPLORER-01e open() watches the first root');

// T116-EXPLORER-02: 'g' then 'g' within the pending window issues a 'first' navigation action;
// a lone 'g' does not.
await controller.handleKeypress(key('g', 'g'));
assert.equal(navigation.calls.includes('first'), false, 'T116-EXPLORER-02a a single g does not navigate yet');
await controller.handleKeypress(key('g', 'g'));
assert.ok(navigation.calls.includes('first'), 'T116-EXPLORER-02b gg navigates to the first row');

// T116-EXPLORER-03: 'r' opens a rename draft; typing and Enter commits it through the
// filesystem port and journals the rename for undo.
await controller.handleKeypress(key('r', 'r'));
for (let index = 0; index < fileNode.name.length; index += 1) await controller.handleKeypress(key('backspace', ''));
for (const character of 'b.txt') await controller.handleKeypress(key(character, character));
await controller.handleKeypress(key('enter', '\r'));
assert.ok(filesystem.calls.includes('rename:/workspace/a.txt->/workspace/b.txt'), 'T116-EXPLORER-03a rename went through the filesystem port');
assert.ok(markers.some((entry) => entry.name === 'XI_EXPLORER_RENAME_APPLIED'), 'T116-EXPLORER-03b a rename-applied marker was emitted');

// A real ExplorerTree would drop the renamed node and publish a fresh one for the new path;
// mirror that here (same node id kept for simplicity) so delete/restore see the post-rename path.
tree.nodes.set(fileNode.id, { ...fileNode, name: 'b.txt', path: '/workspace/b.txt', relativePath: 'b.txt' });
tree.select(fileNode.id);

// T116-EXPLORER-04: 'd' then 'y' confirms a delete, which moves the node into the trash
// directory through makeDirectory + renamePath.
await controller.handleKeypress(key('d', 'd'));
await controller.handleKeypress(key('y', 'y'));
assert.ok(filesystem.calls.includes('mkdir:/workspace/.xi-trash'), 'T116-EXPLORER-04a delete prepares the trash directory');
assert.ok(filesystem.calls.some((call) => call.startsWith('rename:/workspace/b.txt->/workspace/.xi-trash/')), 'T116-EXPLORER-04b delete moves the node into trash');
assert.ok(markers.some((entry) => entry.name === 'XI_EXPLORER_DELETE_APPLIED'), 'T116-EXPLORER-04c a delete-applied marker was emitted');

// T116-EXPLORER-05: 'u' restores the most recent journalled operation (the delete), moving
// the trashed path back to its original location.
filesystem.calls.length = 0;
await controller.handleKeypress(key('u', 'u'));
assert.ok(filesystem.calls.some((call) => call.startsWith('rename:') && call.endsWith('->/workspace/b.txt')), 'T116-EXPLORER-05a restore renames the trashed path back');
assert.ok(markers.some((entry) => entry.name === 'XI_EXPLORER_RESTORE_APPLIED'), 'T116-EXPLORER-05b a restore-applied marker was emitted');

// T116-EXPLORER-06: dispose() clears the pending-g timer without throwing, and close() blurs.
controller.close();
assert.equal(controller.isOpen, false, 'T116-EXPLORER-06a close() marks the controller closed');
assert.equal(controller.isVisible, true, 'T116-EXPLORER-06a2 returning focus to the editor keeps Files visible');
assert.ok(tree.calls.includes('blur'), 'T116-EXPLORER-06b close() blurs the tree');
controller.hide();
assert.equal(controller.isVisible, false, 'T116-EXPLORER-06c only an explicit collapse hides Files');
controller.dispose();

// T116-EXPLORER-07: opening a file from the explorer opens it as a preview buffer (tab-strip
// semantics: a single-click explorer open replaces the preview slot, not a new pinned tab).
let capturedOpenOptions: { readonly preview?: boolean } | undefined;
const originalOpenBufferAtPath = host.openBufferAtPath.bind(host);
host.openBufferAtPath = ((path: string, options?: { readonly preview?: boolean }) => {
  capturedOpenOptions = options;
  return originalOpenBufferAtPath(path, options);
}) as typeof host.openBufferAtPath;
await controller.openNode(tree.readNode(fileNode.id) as ExplorerTreeNode);
assert.equal(capturedOpenOptions?.preview, true, 'T116-EXPLORER-07 explorer opens files as a preview buffer');

// T116-EXPLORER-08: a pointer click on a file row takes keyboard focus for the tree (VS Code
// single-click semantics), previews the file and leaves the panel open -- the cursor stays
// in the sidebar the user just clicked.
controller.attachTree(tree, navigation);
tree.calls.length = 0;
capturedOpenOptions = undefined;
assert.equal(controller.isOpen, false, 'sanity: panel closed before the click');
controller.handlePointerActivate(fileNode.id, tree.model.generation);
assert.equal(controller.isOpen, true, 'T116-EXPLORER-08a a click focuses the explorer');
assert.ok(tree.calls.includes('focus'), 'T116-EXPLORER-08b the tree is focused');
assert.equal((capturedOpenOptions as { readonly preview?: boolean } | undefined)?.preview, true, 'T116-EXPLORER-08c the clicked file opens as a preview');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(controller.isOpen, true, 'T116-EXPLORER-08d the panel stays open after the preview opened');
controller.close();

// F2-13: a rejected ensureServices() must surface via onError instead of an unhandled
// rejection that leaves open() as a silent, permanently unresolved dead panel.
{
  const failingErrors: string[] = [];
  const failingController = new ExplorerController({
    host,
    session,
    filesystem,
    fileOperations,
    clock: testClock,
    marker: () => {},
    onError: (message) => { failingErrors.push(message); },
    workspaceRelativePath: () => undefined,
    trashDirectory: '/workspace/.xi-trash',
    ensureServices: async () => { throw new Error('services unavailable'); },
  });
  failingController.open();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(failingErrors.length > 0, true, 'F2-13: a rejected ensureServices() is surfaced via onError, not swallowed');
  assert.equal(failingController.isOpen, false, 'F2-13: the panel does not stay stuck open after ensureServices() fails');
}

console.log('T116 ExplorerController passed pending-g, rename-commit, delete-confirm, undo-restore, preview-open and ensureServices rejection handling (F2-13) fixtures');
