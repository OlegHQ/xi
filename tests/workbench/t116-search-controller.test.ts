import { strict as assert } from 'node:assert';
import { asIdentifier, asUtf16Offset, type DocumentId, type UndoGroupId, type ViewId } from '../../packages/primitives/src/index';
import type { CancellationToken, PlatformFailure, Result } from '../../packages/contracts/src/index';
import { TextFileDocument } from '../../packages/document/src/index';
import { WorkbenchSession } from '../../packages/workbench/session/index';
import { BufferHost } from '../../packages/workbench/host/index';
import {
  SearchController,
  type ReplaceServicePort,
  type SearchFilesystemPort,
  type SearchServicePort,
  type WorkbenchReplaceFailure,
  type WorkbenchReplacementEdit,
  type WorkbenchReplacePlan,
  type WorkbenchSearchMatch,
  type WorkbenchSearchModel,
} from '../../packages/workbench/search/index';

function id<T extends string>(value: string): T {
  const result = asIdentifier<T>(value, 'T116-search-id');
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function document(documentId: DocumentId, value: string): TextFileDocument {
  const result = TextFileDocument.create(documentId, value, Array.from({ length: value.split('\n').length - 1 }, () => 'lf' as const), 'lf');
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function key(name: string, raw: string, overrides: Partial<{ shift: boolean; ctrl: boolean; meta: boolean; option: boolean }> = {}): { readonly name: string; readonly raw: string; readonly shift: boolean; readonly option: boolean; readonly ctrl: boolean; readonly meta: boolean } {
  return { name, raw, shift: overrides.shift ?? false, option: overrides.option ?? false, ctrl: overrides.ctrl ?? false, meta: overrides.meta ?? false };
}

function textOf(document: TextFileDocument): string {
  const snapshot = document.snapshot();
  const start = asUtf16Offset(0);
  const end = asUtf16Offset(snapshot.lengthUtf16);
  if (!start.ok || !end.ok) throw new Error('bad offset');
  const content = snapshot.slice(start.value, end.value);
  if (!content.ok) throw new Error(content.error.kind);
  return content.value;
}

function matchFixture(matchId: string): WorkbenchSearchMatch {
  return { id: matchId, rootId: 'workspace', path: `${matchId}.txt`, line: 0, range: { startUtf16: 0, endUtf16: 1 }, source: 'disk', generation: 0 };
}

const failure: PlatformFailure = { code: 'unsupported', message: 'not implemented in this fixture', retryable: false };

// -- A fake search service: `query()` never resolves on its own; the test resolves a specific
// generation explicitly, mirroring the real service's own stale-generation drop so a late
// resolution for an outdated keystroke can never clobber a newer one. --
class FakeSearchService implements SearchServicePort {
  #model: WorkbenchSearchModel = { generation: 0, query: { rootId: '', rootPath: '', query: '' }, state: 'idle', matches: [], totalMatches: 0, message: undefined };
  #generation = 0;
  readonly queries: string[] = [];
  readonly cancels: number[] = [];
  readonly #listeners = new Set<(model: WorkbenchSearchModel) => void>();
  readonly #pending = new Map<number, () => void>();

  get model(): WorkbenchSearchModel { return this.#model; }
  subscribe(listener: (model: WorkbenchSearchModel) => void) {
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }
  query(query: { readonly query: string }): Promise<unknown> {
    this.queries.push(query.query);
    this.#generation += 1;
    const generation = this.#generation;
    return new Promise<void>((resolve) => { this.#pending.set(generation, resolve); });
  }
  cancel(): void { this.cancels.push(this.#generation); }
  // Test-only: publishes a result for `generation` (1-based, matching `queries.length` at the
  // time it was issued) unless a later query has since superseded it.
  resolve(generation: number, matches: readonly WorkbenchSearchMatch[]): void {
    this.#pending.get(generation)?.();
    this.#pending.delete(generation);
    if (generation !== this.#generation) return;
    this.#model = Object.freeze({
      generation,
      query: { rootId: 'workspace', rootPath: '/workspace', query: this.queries[generation - 1] ?? '' },
      state: matches.length === 0 ? 'empty' : 'ready',
      matches,
      totalMatches: matches.length,
      message: undefined,
    });
    for (const listener of [...this.#listeners]) listener(this.#model);
  }
}

class FakeReplaceService implements ReplaceServicePort {
  preview(): Result<WorkbenchReplacePlan, WorkbenchReplaceFailure> {
    throw new Error('not used by this fixture');
  }
  async apply(): Promise<Result<never, WorkbenchReplaceFailure>> {
    throw new Error('not used by this fixture');
  }
}

// -- A fake filesystem port recording every read/write call. --
class FakeFilesystem implements SearchFilesystemPort {
  readonly calls: string[] = [];
  workspaceRelativePath(root: string, path: string): string | undefined {
    return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
  }
  workspaceAbsolutePath(root: string, path: string): string | undefined {
    return `${root}/${path}`;
  }
  async readFile(path: string, _cancellation: CancellationToken): Promise<Result<Uint8Array, PlatformFailure>> {
    this.calls.push(`read:${path}`);
    return { ok: false, error: failure };
  }
  async writeFileAtomic(path: string, _contents: Uint8Array, _cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    this.calls.push(`write:${path}`);
    return { ok: true, value: undefined };
  }
}

function applyReplacementEditsFn(text: string, edits: readonly WorkbenchReplacementEdit[]): Result<string, WorkbenchReplaceFailure> {
  const ordered = [...edits].sort((left, right) => right.startUtf16 - left.startUtf16);
  let output = text;
  for (const edit of ordered) {
    if (text.slice(edit.startUtf16, edit.endUtf16) !== edit.original) return { ok: false, error: { kind: 'stale', message: `source changed for ${edit.path}` } };
    output = `${output.slice(0, edit.startUtf16)}${edit.replacement}${output.slice(edit.endUtf16)}`;
  }
  return { ok: true, value: output };
}

const launchDocumentId = id<DocumentId>('T116-search-launch-document');
const launchDocument = document(launchDocumentId, 'alpha\n');
const session = new WorkbenchSession({ workspaceId: 'T116-search' });
const launchViewId = id<ViewId>('T116-search-launch-view');
session.openBuffer(launchDocument, { viewId: launchViewId });
const host = new BufferHost(session, launchDocument, {
  openDocument: async () => undefined,
  workspaceRelativePath: (path) => (path.startsWith('/workspace/') ? path.slice('/workspace/'.length) : undefined),
  marker: () => {},
  launchViewId,
});
host.createSession(launchDocument, launchViewId);

const filesystem = new FakeFilesystem();
const markers: Array<{ readonly name: string; readonly payload: unknown }> = [];
const errors: string[] = [];
let ensureServicesCalls = 0;

const controller = new SearchController({
  host,
  session,
  filesystem,
  marker: (name, payload) => { markers.push({ name, payload }); },
  onError: (message) => { errors.push(message); },
  workspaceRoot: '/workspace',
  ensureServices: async () => { ensureServicesCalls += 1; },
});

const search = new FakeSearchService();
controller.attachServices(search, new FakeReplaceService(), applyReplacementEditsFn);

// T116-SEARCH-01: opening runs the empty query; each keystroke re-queries with the full text.
// A stale generation's result must never override a newer one even when it resolves later.
controller.open();
assert.equal(controller.isOpen, true, 'T116-SEARCH-01a open() marks the controller open');
assert.equal(ensureServicesCalls, 0, 'T116-SEARCH-01b bound services never trigger ensureServices');
assert.deepEqual(search.queries, [''], 'T116-SEARCH-01c open() issues the initial empty query');
await controller.handleKeypress(key('a', 'a'));
await controller.handleKeypress(key('b', 'b'));
assert.deepEqual(search.queries, ['', 'a', 'ab'], 'T116-SEARCH-01d each keystroke re-queries with the accumulated text');
search.resolve(2, [matchFixture('stale')]);
search.resolve(3, [matchFixture('fresh')]);
assert.equal(search.model.matches.length, 1, 'T116-SEARCH-01e only one result is visible');
assert.equal(search.model.matches[0]?.id, 'fresh', 'T116-SEARCH-01f the stale generation-2 result never overwrote generation 3');

// T116-SEARCH-02: up/down (and ctrl-n/ctrl-p) selection clamps to [0, matchCount - 1].
await controller.handleKeypress(key('backspace', ''));
assert.equal(controller.selectedIndex, 0, 'T116-SEARCH-02a a fresh query resets the selection to 0');
search.resolve(4, [matchFixture('m0'), matchFixture('m1'), matchFixture('m2')]);
await controller.handleKeypress(key('down', ''));
await controller.handleKeypress(key('down', ''));
assert.equal(controller.selectedIndex, 2, 'T116-SEARCH-02b moving down twice reaches the last match');
await controller.handleKeypress(key('down', ''));
assert.equal(controller.selectedIndex, 2, 'T116-SEARCH-02c moving down past the last match clamps');
await controller.handleKeypress(key('up', ''));
await controller.handleKeypress(key('up', ''));
await controller.handleKeypress(key('up', ''));
assert.equal(controller.selectedIndex, 0, 'T116-SEARCH-02d moving up past the first match clamps at 0');

// T116-SEARCH-03: escape closes the panel and cancels the search service.
assert.equal(controller.isOpen, true, 'sanity: still open before escape');
await controller.handleKeypress(key('escape', ''));
assert.equal(controller.isOpen, false, 'T116-SEARCH-03a escape closes the controller');
assert.ok(search.cancels.length > 0, 'T116-SEARCH-03b escape cancels the search service');
assert.ok(markers.some((entry) => entry.name === 'XI_SEARCH_CANCELLED'), 'T116-SEARCH-03c a cancelled marker was emitted');

// T116-SEARCH-04: replacing a match in a dirty open buffer goes through the document/edit
// coordinator (`session.applyDocumentEdits`), never the filesystem -- even though a closed
// file's replacement would use exactly that filesystem port.
const bufferDocumentId = id<DocumentId>('T116-search-buffer-document');
const bufferDocument = document(bufferDocumentId, 'hello');
const bufferViewId = id<ViewId>('T116-search-buffer-view');
const openedBuffer = session.openBuffer(bufferDocument, { path: '/workspace/a.txt', viewId: bufferViewId });
if (!openedBuffer.ok) throw new Error(`T116-search-open-buffer:${openedBuffer.error.kind}`);
host.documents.set(bufferDocument.id, bufferDocument);
const editStart = asUtf16Offset(5);
const editEnd = asUtf16Offset(5);
if (!editStart.ok || !editEnd.ok) throw new Error('T116-search-bad-offset');
const dirtyGroup = asIdentifier<UndoGroupId>('T116-search-dirty-group', 'undoGroupId');
if (!dirtyGroup.ok) throw new Error(dirtyGroup.error.message);
// Dirty the buffer through the session's own edit path (not a direct `document.apply`) so the
// coordinator's cached state stays in step with the document's revision.
const dirtied = await session.applyTextEdits(bufferViewId, [{ start: editStart.value, end: editEnd.value, text: '!' }], dirtyGroup.value, 'vim');
if (!dirtied.ok) throw new Error(`T116-search-dirty:${dirtied.error.kind}`);
assert.equal(textOf(bufferDocument), 'hello!', 'sanity: the buffer now reads "hello!"');
const dirtyBuffer = session.buffers().find((candidate) => candidate.bufferId === bufferDocument.id);
assert.equal(dirtyBuffer?.dirty, true, 'sanity: the buffer is dirty after the direct edit');

const plan: WorkbenchReplacePlan = Object.freeze({
  query: { rootId: 'workspace', rootPath: '/workspace', query: 'hello' },
  replacement: 'HELLO',
  edits: Object.freeze([{ path: 'a.txt', startUtf16: 0, endUtf16: 5, replacement: 'HELLO', original: 'hello' }]),
  targets: Object.freeze([{ path: 'a.txt', rootId: 'workspace', text: 'hello!', source: 'buffer' as const, version: bufferDocument.version }]),
  generation: 1,
});
const replacePort = controller.createReplacePort();
const applied = await replacePort.apply(plan);
assert.ok(applied.ok, `T116-SEARCH-04a replace applied through the document port: ${applied.ok ? '' : applied.error.message}`);
assert.equal(textOf(bufferDocument), 'HELLO!', 'T116-SEARCH-04b the dirty buffer was edited through applyDocumentEdits');
assert.deepEqual(filesystem.calls, [], 'T116-SEARCH-04c a dirty buffer replacement never touches the filesystem port');

controller.dispose();

console.log('T116 SearchController passed generation-drop, selection-clamp, escape-close and dirty-buffer-replace fixtures');
