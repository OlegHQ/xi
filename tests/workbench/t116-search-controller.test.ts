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
  readonly caseSensitive: boolean[] = [];
  readonly visibility: Array<{ readonly hidden: boolean; readonly ignored: boolean }> = [];
  readonly cancels: number[] = [];
  readonly #listeners = new Set<(model: WorkbenchSearchModel) => void>();
  readonly #pending = new Map<number, () => void>();

  get model(): WorkbenchSearchModel { return this.#model; }
  subscribe(listener: (model: WorkbenchSearchModel) => void) {
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }
  query(query: { readonly query: string; readonly caseSensitive?: boolean; readonly includeHidden?: boolean; readonly includeIgnored?: boolean }): Promise<unknown> {
    this.queries.push(query.query);
    this.caseSensitive.push(query.caseSensitive === true);
    this.visibility.push({ hidden: query.includeHidden === true, ignored: query.includeIgnored === true });
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
  readonly contents = new Map<string, string>();
  workspaceRelativePath(root: string, path: string): string | undefined {
    return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
  }
  workspaceAbsolutePath(root: string, path: string): string | undefined {
    return `${root}/${path}`;
  }
  async readFile(path: string, _cancellation: CancellationToken): Promise<Result<Uint8Array, PlatformFailure>> {
    this.calls.push(`read:${path}`);
    const content = this.contents.get(path);
    return content === undefined ? { ok: false, error: failure } : { ok: true, value: new TextEncoder().encode(content) };
  }
  async writeFileAtomic(path: string, contents: Uint8Array, _cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    this.calls.push(`write:${path}`);
    this.contents.set(path, new TextDecoder().decode(contents));
    return { ok: true, value: undefined };
  }
  async makeDirectory(path: string, _cancellation: CancellationToken): Promise<Result<void, PlatformFailure>> {
    this.calls.push(`mkdir:${path}`);
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
  searchSmartCase: true,
  searchWrapAround: true,
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
assert.deepEqual(search.caseSensitive, [false, false, false], 'T116-SEARCH-01e lowercase queries remain case-insensitive under smart-case');
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
assert.equal(controller.selectedIndex, 0, 'T116-SEARCH-02c moving down past the last match wraps to the first match');
await controller.handleKeypress(key('up', ''));
await controller.handleKeypress(key('up', ''));
await controller.handleKeypress(key('up', ''));
assert.equal(controller.selectedIndex, 0, 'T116-SEARCH-02d moving up past the first match clamps at 0');

// T116-SEARCH-03: escape leaves insert mode for normal mode without closing; a second
// escape closes the panel and cancels the search service.
assert.equal(controller.isOpen, true, 'sanity: still open before escape');
assert.equal(controller.mode, 'insert', 'sanity: still in insert mode before escape');
await controller.handleKeypress(key('escape', ''));
assert.equal(controller.isOpen, true, 'T116-SEARCH-03a a single escape only leaves insert mode');
assert.equal(controller.mode, 'normal', 'T116-SEARCH-03b the first escape lands in normal mode');
await controller.handleKeypress(key('d', '', { ctrl: true }));
assert.equal(controller.selectedIndex, 2, 'T116-SEARCH-03b2 Ctrl-D uses sidebar half-page navigation in normal mode');
await controller.handleKeypress(key('u', '', { ctrl: true }));
assert.equal(controller.selectedIndex, 0, 'T116-SEARCH-03b3 Ctrl-U uses sidebar half-page navigation in normal mode');
await controller.handleKeypress(key('escape', ''));
assert.equal(controller.isOpen, false, 'T116-SEARCH-03c a second escape closes the controller');
assert.ok(search.cancels.length > 0, 'T116-SEARCH-03d escape cancels the search service');
assert.ok(markers.some((entry) => entry.name === 'XI_SEARCH_CANCELLED'), 'T116-SEARCH-03e a cancelled marker was emitted');

// T116-SEARCH-05: after reopening, mode starts 'insert' -- typed letters (including j/k,
// which are Vim navigation letters in `normal` mode) edit the query instead of moving the
// selection; Tab/Shift-Tab move focus between the query and replace fields.
controller.open();
assert.equal(controller.mode, 'insert', 'T116-SEARCH-05a open() starts in insert mode');
const queriesBeforeJ = search.queries.length;
await controller.handleKeypress(key('j', 'j'));
assert.equal(search.queries.length, queriesBeforeJ + 1, 'T116-SEARCH-05b "j" in insert mode re-queries (it edited the query)');
assert.ok(search.queries[search.queries.length - 1]?.endsWith('j'), 'T116-SEARCH-05c "j" was appended to the query text, not treated as a motion');
await controller.handleKeypress(key('tab', '	'));
assert.equal(controller.mode, 'replace', 'T116-SEARCH-05d Tab moves focus to the replace field');
await controller.handleKeypress(key('tab', '	', { shift: true }));
assert.equal(controller.mode, 'insert', 'T116-SEARCH-05e Shift-Tab moves focus back to the query field');
await controller.handleKeypress(key('escape', ''));
assert.equal(controller.mode, 'normal', 'T116-SEARCH-05f Esc from insert leaves for normal mode without closing');
assert.equal(controller.isOpen, true, 'T116-SEARCH-05g the panel is still open after the first Esc');
await controller.handleKeypress(key('escape', ''));
assert.equal(controller.isOpen, false, 'T116-SEARCH-05h a second Esc closes the panel');

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
  edits: Object.freeze([{ path: 'a.txt', rootId: 'workspace', startUtf16: 0, endUtf16: 5, replacement: 'HELLO', original: 'hello' }]),
  targets: Object.freeze([{ path: 'a.txt', rootId: 'workspace', text: 'hello!', source: 'buffer' as const, version: bufferDocument.version }]),
  generation: 1,
});
const replacePort = controller.createReplacePort();
const applied = await replacePort.apply(plan);
assert.ok(applied.ok, `T116-SEARCH-04a replace applied through the document port: ${applied.ok ? '' : applied.error.message}`);
assert.equal(textOf(bufferDocument), 'HELLO!', 'T116-SEARCH-04b the dirty buffer was edited through applyDocumentEdits');
assert.equal(filesystem.calls.length, 0, 'T116-SEARCH-04c a dirty buffer replacement never touches the filesystem port');

// F2-3: a disk-target replace must write a durable pre-mutation journal (paths + before text)
// before the first disk mutation, so a crash between two file mutations still leaves a
// restore record -- mirroring JournaledFilesystemOperations.
filesystem.calls.length = 0;
filesystem.contents.set('/workspace/disk.txt', 'hello disk');
const diskTargetRead = await replacePort.readTarget('disk.txt');
assert.ok(diskTargetRead.ok, 'F2-3 sanity: the seeded disk file reads back');
if (!diskTargetRead.ok) throw new Error('unreachable');
filesystem.calls.length = 0;
const diskPlan: WorkbenchReplacePlan = Object.freeze({
  query: { rootId: 'workspace', rootPath: '/workspace', query: 'hello' },
  replacement: 'HELLO',
  edits: Object.freeze([{ path: 'disk.txt', rootId: 'workspace', startUtf16: 0, endUtf16: 5, replacement: 'HELLO', original: 'hello' }]),
  targets: Object.freeze([diskTargetRead.value]),
  generation: 2,
});
const diskApplied = await replacePort.apply(diskPlan);
assert.ok(diskApplied.ok, `F2-3 sanity: disk replace applies: ${diskApplied.ok ? '' : diskApplied.error.message}`);
const journalCallIndex = filesystem.calls.findIndex((call) => call.includes('.xi/replace/') && call.startsWith('write:'));
const diskWriteIndex = filesystem.calls.findIndex((call) => call === 'write:/workspace/disk.txt');
assert.ok(journalCallIndex >= 0, 'F2-3: a durable journal is written to .xi/replace before the disk mutation');
assert.ok(journalCallIndex < diskWriteIndex, 'F2-3: the durable journal is written before the first disk mutation, not after');
assert.equal(filesystem.contents.get('/workspace/disk.txt'), 'HELLO disk', 'sanity: the disk file was actually replaced');

controller.toggleIncludeHidden();
controller.toggleIncludeIgnored();
assert.deepEqual(search.visibility.slice(-2), [{ hidden: true, ignored: false }, { hidden: true, ignored: true }], 'T116-SEARCH-VISIBILITY-01 hidden and ignored toggles rerun the query with the active visibility policy');

controller.dispose();

// T036-SEARCH: production controller wiring applies smart-case to uppercase queries and wraps
// result navigation when the Helix settings are enabled.
{
  const smartController = new SearchController({
    host,
    session,
    filesystem,
    marker: () => {},
    onError: (message) => { errors.push(message); },
    workspaceRoot: '/workspace',
    searchSmartCase: true,
    searchWrapAround: true,
    ensureServices: async () => {},
  });
  const smartService = new FakeSearchService();
  smartController.attachServices(smartService, new FakeReplaceService(), applyReplacementEditsFn);
  smartController.open();
  await smartController.handleKeypress(key('A', 'A'));
  assert.equal(smartService.caseSensitive.at(-1), true, 'T036-SEARCH-SMART-CASE-UNIT-01 uppercase query enables case-sensitive search');
  smartService.resolve(2, [matchFixture('s0'), matchFixture('s1')]);
  await smartController.handleKeypress(key('down', ''));
  await smartController.handleKeypress(key('down', ''));
  assert.equal(smartController.selectedIndex, 0, 'T036-SEARCH-WRAP-AROUND-UNIT-01 result navigation wraps at the end');
  smartController.dispose();
}

// The explicit false settings remain meaningful: uppercase search is not promoted to
// case-sensitive matching and result navigation clamps at the final row.
{
  const clampedController = new SearchController({
    host,
    session,
    filesystem,
    marker: () => {},
    onError: (message) => { errors.push(message); },
    workspaceRoot: '/workspace',
    searchSmartCase: false,
    searchWrapAround: false,
    ensureServices: async () => {},
  });
  const clampedService = new FakeSearchService();
  clampedController.attachServices(clampedService, new FakeReplaceService(), applyReplacementEditsFn);
  clampedController.open();
  await clampedController.handleKeypress(key('A', 'A'));
  assert.equal(clampedService.caseSensitive.at(-1), false, 'T036-SEARCH-SMART-CASE-UNIT-02 disabled smart-case keeps uppercase search case-insensitive');
  clampedService.resolve(2, [matchFixture('c0'), matchFixture('c1')]);
  await clampedController.handleKeypress(key('down', ''));
  await clampedController.handleKeypress(key('down', ''));
  assert.equal(clampedController.selectedIndex, 1, 'T036-SEARCH-WRAP-AROUND-UNIT-02 disabled wrap-around clamps at the last result');
  clampedController.dispose();
}

// F2-13: a rejected ensureServices() must not leave open()/query() as a silent, permanently
// unresolved dead panel -- it must surface via onError instead of an unhandled rejection.
{
  const failingErrors: string[] = [];
  const failingController = new SearchController({
    host,
    session,
    filesystem,
    marker: () => {},
    onError: (message) => { failingErrors.push(message); },
    workspaceRoot: '/workspace',
    ensureServices: async () => { throw new Error('services unavailable'); },
  });
  failingController.open();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(failingErrors.length > 0, true, 'F2-13: a rejected ensureServices() is surfaced via onError, not swallowed');
  assert.equal(failingController.isOpen, false, 'F2-13: the panel does not stay stuck open after ensureServices() fails');
  failingController.dispose();
}

console.log('T116 SearchController passed generation-drop, smart-case, wrap-around, selection-clamp, escape-close, dirty-buffer-replace, durable disk-replace journal (F2-3) and ensureServices rejection handling (F2-13) fixtures');
