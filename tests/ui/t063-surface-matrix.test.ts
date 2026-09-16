import { strict as assert } from 'node:assert';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTestRenderer } from '@opentui/core/testing';
import {
  CompletionRenderable,
  DirectoryReviewRenderable,
  ExplorerRenderable,
  OutlineRenderable,
  PickerRenderable,
  PrefixHelpRenderable,
  ProblemsRenderable,
  SearchRenderable,
  TaskOutputRenderable,
  type CompletionUiReadModel as CompletionReadModel,
  type DirectoryDraftReadModel,
  type DirectoryDraftReadPort,
  type ExplorerReadModel,
  type ExplorerReadPort,
  type OutlineReadModel,
  type OutlineReadPort,
  type PickerReadModel,
  type PickerReadPort,
  type PrefixHelpReadPort,
  type ProblemsReadModel,
  type ProblemsReadPort,
  type TaskOutputReadModel,
  type TaskOutputReadPort,
} from '../../packages/ui/src/index';
import type { SearchReadModel } from '../../packages/ui/search/index';
import type { PrefixHelpReadModel } from '../../packages/workbench/src/index';

/**
 * Render every bounded overlay read-model state through its production
 * renderable. This does not claim screen-reader support; it catches clipped
 * state labels, missing degraded messages and narrow-terminal overflow.
 */
const WIDTH = 48;
const HEIGHT = 8;
const results: Array<{ readonly surface: string; readonly state: string; readonly rows: number; readonly chars: string }> = [];

await runSearchMatrix();
await runProblemsMatrix();
await runTaskOutputMatrix();
await runPickerMatrix();
await runExplorerMatrix();
await runDirectoryMatrix();
await runCompletionMatrix();
await runOutlineMatrix();
await runPrefixHelpMatrix();

const artifact = resolve(process.cwd(), '.artifacts/ui/t063-surface-matrix.json');
await mkdir(resolve(process.cwd(), '.artifacts/ui'), { recursive: true });
await writeFile(artifact, `${JSON.stringify({
  schemaVersion: 1,
  fixture: 'T063-SURFACE-MATRIX-01',
  width: WIDTH,
  height: HEIGHT,
  cases: results,
  coverage: {
    search: ['idle', 'loading', 'ready', 'empty', 'stale', 'error'],
    problems: ['empty', 'diagnostics'],
    taskOutput: ['idle', 'running', 'exited', 'failed', 'cancelled'],
    picker: ['loading', 'ready', 'empty', 'stale', 'error'],
    explorer: ['loading', 'ready', 'empty', 'error'],
    directoryReview: ['edit', 'review', 'error'],
    completion: ['idle', 'loading', 'ready', 'error'],
    outline: ['idle', 'loading', 'ready', 'unavailable', 'error'],
    prefixHelp: ['hidden', 'available-and-unavailable'],
  },
  unproven: ['keyboard-only journeys', 'screen-reader semantics', 'platform accessibility APIs'],
}, null, 2)}\n`, 'utf8');
console.log(`T063 overlay surface matrix passed ${results.length} production renderable states; artifact=${artifact}`);

class MutablePort<T> {
  #model: T;
  readonly #listeners = new Set<(model: T) => void>();

  constructor(model: T) { this.#model = model; }
  get model(): T { return this.#model; }
  setModel(model: T): void {
    this.#model = model;
    for (const listener of [...this.#listeners]) listener(model);
  }
  subscribe(listener: (model: T) => void): { dispose(): void } {
    this.#listeners.add(listener);
    return { dispose: () => { this.#listeners.delete(listener); } };
  }
}

async function capture<T>(surface: string, state: string, port: MutablePort<T>, create: (ctx: ConstructorParameters<typeof SearchRenderable>[0]) => object, model: T, marker: string): Promise<void> {
  port.setModel(model);
  const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT, bufferedOutput: 'memory', gatherStats: true });
  const renderable = create(setup.renderer.root.ctx);
  setup.renderer.root.add(renderable as never);
  await setup.renderOnce();
  const chars = setup.captureCharFrame();
  for (const line of chars.split('\n')) {
    assert.ok([...line].length <= WIDTH, `T063-SURFACE-WIDTH-${surface}-${state} stays within ${WIDTH} cells`);
  }
  assert.doesNotMatch(chars, /undefined|null/u, `T063-SURFACE-CLEAN-${surface}-${state} does not expose missing values`);
  if (marker.length > 0) assert.match(chars, new RegExp(escapeRegExp(marker), 'u'), `T063-SURFACE-MARKER-${surface}-${state} shows state marker`);
  results.push({ surface, state, rows: chars.split('\n').length, chars });
  setup.renderer.destroy();
}

async function runSearchMatrix(): Promise<void> {
  const port = new MutablePort<SearchReadModel>(searchModel('idle'));
  const create = (ctx: ConstructorParameters<typeof SearchRenderable>[0]) => new SearchRenderable(ctx, { search: port, width: WIDTH, height: HEIGHT });
  for (const [state, marker, message] of [
    ['idle', 'Search idle', undefined],
    ['loading', 'Search loading', 'Indexing workspace'],
    ['ready', 'main.ts:3:5', undefined],
    ['empty', 'No matches', 'No matches'],
    ['stale', 'Search stale', 'Results are stale'],
    ['error', 'Search error', 'Search provider failed'],
  ] as const) {
    await capture('search', state, port, create, searchModel(state, message), marker);
  }
}

async function runProblemsMatrix(): Promise<void> {
  const port = new MutablePort<ProblemsReadModel>(problemsModel([]));
  const create = (ctx: ConstructorParameters<typeof SearchRenderable>[0]) => new ProblemsRenderable(ctx, { problems: port, width: WIDTH, height: HEIGHT });
  await capture('problems', 'empty', port, create, problemsModel([]), 'Problems 0');
  await capture('problems', 'diagnostics', port, create, {
    contractVersion: 1, generation: 2,
    all: [problem('T063-error', 'error', 1), problem('T063-warning', 'warning', 3)],
  }, 'Problems 2');
}

async function runTaskOutputMatrix(): Promise<void> {
  const port = new MutablePort<TaskOutputReadModel>(taskOutput('idle'));
  const create = (ctx: ConstructorParameters<typeof SearchRenderable>[0]) => new TaskOutputRenderable(ctx, { output: port, width: WIDTH, height: HEIGHT });
  for (const state of ['idle', 'running', 'exited', 'failed', 'cancelled'] as const) {
    await capture('task-output', state, port, create, taskOutput(state), `T063-task ${state}`);
  }
}

async function runPickerMatrix(): Promise<void> {
  const port = new MutablePort<PickerReadModel>(pickerModel('loading'));
  const create = (ctx: ConstructorParameters<typeof SearchRenderable>[0]) => new PickerRenderable(ctx, { picker: port, width: WIDTH, height: HEIGHT });
  for (const [state, marker, message] of [
    ['loading', 'Files  >TODO', undefined],
    ['ready', 'main.ts', undefined],
    ['empty', 'No files', 'No files'],
    ['stale', 'stale', 'Results are stale'],
    ['error', 'provider failed', 'Picker provider failed'],
  ] as const) {
    await capture('picker', state, port, create, pickerModel(state, message), marker);
  }
}

async function runExplorerMatrix(): Promise<void> {
  const port = new MutablePort<ExplorerReadModel>(explorerModel('loading'));
  const create = (ctx: ConstructorParameters<typeof SearchRenderable>[0]) => new ExplorerRenderable(ctx, { explorer: port, width: WIDTH, height: HEIGHT, maxRows: 6 });
  for (const [state, marker, message] of [
    ['loading', 'Loading', undefined],
    ['ready', 'main.ts', undefined],
    ['empty', 'No files', undefined],
    ['error', 'Permission denied', 'Permission denied'],
  ] as const) {
    await capture('explorer', state, port, create, explorerModel(state, message), marker);
  }
}

async function runDirectoryMatrix(): Promise<void> {
  const port = new MutablePort<DirectoryDraftReadModel>(directoryModel('edit'));
  const create = (ctx: ConstructorParameters<typeof SearchRenderable>[0]) => new DirectoryReviewRenderable(ctx, { draft: port, width: WIDTH, height: HEIGHT, maxRows: 6 });
  await capture('directory-review', 'edit', port, create, directoryModel('edit'), 'Directory');
  await capture('directory-review', 'review', port, create, directoryModel('review'), 'Review');
  await capture('directory-review', 'error', port, create, directoryModel('error'), 'fix row and retry');
}

async function runCompletionMatrix(): Promise<void> {
  const port = new MutablePort<CompletionReadModel>(completionModel('idle'));
  const create = (ctx: ConstructorParameters<typeof SearchRenderable>[0]) => new CompletionRenderable(ctx, { completion: port, width: WIDTH, height: HEIGHT });
  for (const [state, marker] of [['idle', ''], ['loading', 'Loading completions'], ['ready', 'print'], ['error', 'Completion failed']] as const) {
    await capture('completion', state, port, create, completionModel(state), marker);
  }
}

async function runOutlineMatrix(): Promise<void> {
  const port = new MutablePort<OutlineReadModel>(outlineModel('idle'));
  const create = (ctx: ConstructorParameters<typeof SearchRenderable>[0]) => new OutlineRenderable(ctx, { outline: port, width: WIDTH, height: HEIGHT });
  for (const [state, marker] of [['idle', 'Outline'], ['loading', 'Outline loading'], ['ready', 'render'], ['unavailable', 'Outline unavailable'], ['error', 'Outline failed']] as const) {
    await capture('outline', state, port, create, outlineModel(state), marker);
  }
}

async function runPrefixHelpMatrix(): Promise<void> {
  const port = new MutablePort<PrefixHelpReadModel | undefined>(undefined);
  const create = (ctx: ConstructorParameters<typeof SearchRenderable>[0]) => new PrefixHelpRenderable(ctx, { help: port, width: WIDTH, height: HEIGHT });
  await capture('prefix-help', 'hidden', port, create, undefined, '');
  await capture('prefix-help', 'available-and-unavailable', port, create, prefixHelpModel(), 'Prefix');
}

function searchModel(state: SearchReadModel['state'], message: string | undefined = undefined): SearchReadModel {
  return {
    contractVersion: 1,
    query: { rootId: 'T063-root', rootPath: '/workspace', query: 'TODO' },
    generation: 2,
    state,
    matches: state === 'ready' ? [{ id: 'T063-match', rootId: 'T063-root', path: 'main.ts', line: 2, range: { startUtf16: 4, endUtf16: 8 }, lineText: '  // TODO', snippet: '// TODO', source: 'buffer', documentVersion: 3, generation: 2 }] : [],
    totalMatches: state === 'ready' ? 1 : 0,
    truncated: false,
    message,
  };
}

function problem(id: string, message: string, line: number) {
  return { id, uri: 'file:///workspace/main.ts', range: { startLine: line, startUtf16: 2, endLine: line, endUtf16: 4 }, message, severity: 1 as const, source: 'tsc', code: 'TS000', serverId: 'tsserver', documentVersion: 1, generation: 1 };
}

function problemsModel(all: ProblemsReadModel['all']): ProblemsReadModel {
  return { contractVersion: 1, generation: 1, all };
}

function taskOutput(state: TaskOutputReadModel['state']): TaskOutputReadModel {
  return { taskId: `T063-task ${state}`, stdout: state === 'running' ? 'building…' : '', stderr: state === 'failed' ? 'command failed' : '', bytes: 24, truncated: state === 'cancelled', state, exitCode: state === 'exited' ? 0 : state === 'failed' ? 1 : null };
}

function pickerModel(state: PickerReadModel['state'], message: string | undefined = undefined): PickerReadModel {
  return { contractVersion: 1, mode: 'file', query: 'TODO', generation: 3, state, entries: state === 'ready' ? [pickerEntry()] : [], selectedId: state === 'ready' ? 'T063-entry' : undefined, totalMatches: state === 'ready' ? 1 : 0, truncated: false, message };
}

function pickerEntry() {
  return { id: 'T063-entry', mode: 'file' as const, kind: 'file' as const, label: 'main.ts', detail: 'workspace', value: '/workspace/main.ts', rootId: 'T063-root', relativePath: 'main.ts', hidden: false, score: 1 };
}

function explorerModel(state: ExplorerReadModel['state'], message: string | undefined = undefined): ExplorerReadModel {
  const root = { id: 'T063-root-node', rootId: 'T063-root', parentId: undefined, name: 'workspace', relativePath: '.', path: '/workspace', kind: 'root' as const, depth: 0, expanded: true, hidden: false, ignored: false, loadState: 'ready' as const, children: ['T063-file-node'], stableIdentity: 'root:/workspace', sizeBytes: undefined, modifiedMilliseconds: undefined, permissions: 'rwx', symlinkTarget: undefined, git: undefined, message: undefined };
  const file = { id: 'T063-file-node', rootId: 'T063-root', parentId: 'T063-root-node', name: 'main.ts', relativePath: 'main.ts', path: '/workspace/main.ts', kind: 'file' as const, depth: 1, expanded: false, hidden: false, ignored: false, loadState: 'ready' as const, children: [], stableIdentity: 'file:/workspace/main.ts', sizeBytes: 100, modifiedMilliseconds: 1, permissions: 'rw', symlinkTarget: undefined, git: { state: 'modified' as const, label: 'M', colorToken: 'gitModified' }, message: undefined };
  return { contractVersion: 1, generation: 4, roots: ['T063-root'], nodes: state === 'ready' ? [root, file] : [], visibleRows: state === 'ready' ? [{ nodeId: root.id, depth: 0, kind: root.kind, selected: false }, { nodeId: file.id, depth: 1, kind: file.kind, selected: true }] : [], selectedId: state === 'ready' ? file.id : undefined, filter: '', includeHidden: false, includeIgnored: false, focused: false, state, message };
}

function directoryModel(focus: DirectoryDraftReadModel['focus'] | 'error'): DirectoryDraftReadModel {
  return { contractVersion: 1, generation: 4, directoryPath: '/workspace', text: 'main.ts\n', rows: [{ id: 'T063-row', sourceId: 'T063-file', anchor: { id: 'T063-row', offsetUtf16: 0 }, line: 0, escapedName: 'main.ts', rawName: 'main.ts', origin: 'base', metadata: undefined }], dirty: focus !== 'edit', focus: focus === 'error' ? 'edit' : focus, review: focus === 'review' ? { contractVersion: 1, directoryPath: '/workspace', baseGeneration: 4, operations: [{ kind: 'rename', rowId: 'T063-row', sourceId: 'T063-file', from: 'main.ts', to: 'index.ts', sourcePath: '/workspace/main.ts', destinationPath: '/workspace/index.ts' }] } : undefined, error: focus === 'error' ? { rowId: 'T063-row', line: 0, column: 0, kind: 'invalid-name', message: 'Invalid filename' } : undefined };
}

function completionModel(state: CompletionReadModel['state']): CompletionReadModel {
  return { state, items: state === 'ready' ? [{ id: 'print', label: 'print', detail: '(value: unknown) => void', documentation: 'Writes a value' }] : [], selectedId: state === 'ready' ? 'print' : undefined, documentation: undefined, message: state === 'error' ? 'Completion failed' : undefined };
}

function outlineModel(state: OutlineReadModel['state']): OutlineReadModel {
  return { state, symbols: state === 'ready' ? [{ id: 'T063-symbol', name: 'render', detail: 'function', kind: 12, children: [] }] : [], message: state === 'error' ? 'Outline failed' : undefined };
}

function prefixHelpModel(): PrefixHelpReadModel {
  return { registryGeneration: 2, focusGeneration: 3, configGeneration: 4, targetId: 'editor', pendingKeys: ['g'], compactHint: 'Prefix g: j motion', hints: [{ kind: 'mapping', keys: ['j'], keyLabel: 'j', sequence: ['g', 'j'], title: 'Move down', description: 'Move one line down', commandId: 'cursor-down', aliases: [], available: true, disabledReason: undefined }, { kind: 'mapping', keys: ['q'], keyLabel: 'q', sequence: ['g', 'q'], title: 'Unavailable', description: 'Requires capability', commandId: 'gq', aliases: [], available: false, disabledReason: 'unsupported' }] };
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
