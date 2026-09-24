import type { OpenTuiWorkbenchOptions } from '../../packages/ui/src/options';
import { ContextMenuStore } from '../../packages/ui/src/context-menu';
import { CommandRegistry } from '../../packages/workbench/commands/registry';
import { ExCommandLineSession } from '../../packages/workbench/commands/ex-command-line';

const read = <T>(model: T) => ({ model, subscribe: () => ({ dispose() {} }) });
const open = () => true;
const menu = new ContextMenuStore();
menu.openAt(40, 8, [
  { id: 'selected', label: 'auditMenu selected', enabled: true },
  { id: 'normal', label: 'auditMenu normal', enabled: true },
  { id: 'disabled', label: 'auditMenu disabled', enabled: false },
], () => {});
const commandLine = new ExCommandLineSession({ registry: new CommandRegistry({ nativeExNames: ['write', 'quit'] }), source: ':w', cursorOffset: 2 });
const names = ['selected', 'normal', 'inactive'];
export const themeScenes: Record<string, { readonly options: Omit<OpenTuiWorkbenchOptions, 'dispatchKey'>; readonly marker: string }> = {
  files: { marker: 'selected.ts', options: { explorer: { isOpen: open, read: read({
    contractVersion: 1, generation: 1, roots: [], selectedId: 'selected', filter: '', includeHidden: true, includeIgnored: true, followSymlinks: false, flattenDirs: true, focused: true, state: 'ready', message: undefined,
    nodes: names.map(name => ({ id: name, rootId: 'workspace', parentId: undefined, name: `${name}.ts`, relativePath: `${name}.ts`, path: `/workspace/${name}.ts`, kind: 'file', depth: 0, expanded: false, hidden: false, ignored: name === 'inactive', loadState: 'ready', children: [], stableIdentity: name, sizeBytes: 10, modifiedMilliseconds: 0, permissions: undefined, symlinkTarget: undefined, git: undefined, message: undefined })),
    visibleRows: names.map(name => ({ nodeId: name, depth: 0, kind: 'file', selected: name === 'selected' })),
  }) } } },
  search: { marker: 'auditSearch', options: { search: { isOpen: open, selectedId: () => 'selected', read: read({
    contractVersion: 1, generation: 1, state: 'ready', query: { rootId: 'workspace', rootPath: '.', query: 'auditSearch' }, totalMatches: 3, truncated: false, message: undefined,
    matches: names.map((name, line) => ({ id: name, rootId: 'workspace', path: 'search.ts', line, range: { startUtf16: 0, endUtf16: 11 }, lineText: `auditSearch ${name}`, snippet: `auditSearch ${name}`, source: 'disk', generation: 1 })),
  }) } } },
  git: { marker: 'selected.ts', options: { git: { isOpen: open, read: read({
    contractVersion: 1, generation: 1, branch: 'auditBranch', state: 'ready', message: undefined, selectedId: 'selected',
    sections: [{ id: 'changes', label: 'Changes', count: 3, collapsed: false, entries: names.map(name => ({ id: name, path: `${name}.ts`, state: 'modified', letter: 'M' })) }],
  }) } } },
  picker: { marker: 'auditPicker', options: { picker: { isOpen: open, read: read({
    contractVersion: 1, generation: 1, mode: 'file', query: 'audit', state: 'ready', selectedId: 'selected', totalMatches: 3, truncated: false, message: undefined,
    entries: names.map(name => ({ id: name, mode: 'file', kind: 'file', label: `auditPicker ${name}`, detail: 'source detail', value: name, rootId: 'workspace', relativePath: `${name}.ts`, hidden: false, score: 1 })),
  }) } } },
  problems: { marker: 'auditProblem', options: { problems: { isOpen: open, selectedId: () => 'selected', read: read({
    contractVersion: 1, generation: 1, all: names.map((name, index) => ({ id: name, uri: 'file.ts', range: { startLine: index, startUtf16: 0, endLine: index, endUtf16: 1 }, message: `auditProblem ${name}`, severity: index === 0 ? 1 : 2, source: 'audit', code: 'E1', serverId: 'audit', documentVersion: 1, generation: 1 })),
  }) } } },
  outline: { marker: 'auditOutline', options: { outline: { isOpen: open, read: read({ state: 'ready', message: undefined, generation: 1, rows: [{ id: 'symbol', name: 'auditOutline', detail: 'function', kind: 12, depth: 0, expandable: false, expanded: false }], selectedId: 'symbol', activeId: 'symbol', focused: true }) } } },
  hierarchy: { marker: 'auditHierarchy', options: { hierarchy: { isOpen: open, read: read({ state: 'ready', nodes: [{ id: 'node', name: 'auditHierarchy', detail: 'caller', kind: 12, children: [] }], links: [], message: undefined }) } } },
  hover: { marker: 'auditHover', options: { hover: { isOpen: open, read: read({ state: 'ready', hover: 'auditHover documentation\n```typescript\nconst value = "hello";\n```', message: undefined }) } } },
  completion: { marker: 'auditCompletion', options: { completion: { isOpen: open, read: read({ state: 'ready', items: names.map(id => ({ id, label: `auditCompletion ${id}`, detail: 'function' })), selectedId: 'selected', documentation: 'documentation', message: undefined }) } } },
  signature: { marker: 'auditSignature', options: { signature: { isOpen: open, read: read({ state: 'ready', label: 'auditSignature(value: string): void', documentation: 'Function documentation', activeParameter: 0, message: undefined }) } } },
  directory: { marker: 'auditRename', options: { directoryReview: { isOpen: open, read: read({ contractVersion: 1, generation: 1, directoryPath: '/workspace', text: '', rows: [], dirty: true, focus: 'review', error: undefined, review: { contractVersion: 1, directoryPath: '/workspace', baseGeneration: 1, operations: [{ kind: 'rename', rowId: 'row', sourceId: 'file', from: 'before.ts', to: 'auditRename.ts', sourcePath: '/workspace/before.ts', destinationPath: '/workspace/auditRename.ts' }] } }) } } },
  output: { marker: 'auditOutput', options: { output: { isOpen: open, read: read({ taskId: 'auditOutput', state: 'exited', stdout: 'Build successful\n', stderr: 'Example warning\n', bytes: 34, truncated: false, exitCode: 0 }) } } },
  command: { marker: ':w', options: { commandLine: { isOpen: open, read: read(commandLine.readModel()) } } },
  prefix: { marker: 'auditPrefix', options: { prefixHelp: read({ registryGeneration: 1, focusGeneration: 1, configGeneration: 1, targetId: 'view', pendingKeys: ['<Space>'], compactHint: 'auditPrefix', hints: names.map(name => ({ kind: 'mapping', keys: [name[0]!], keyLabel: name[0]!, sequence: ['<Space>', name[0]!], title: 'Example action', description: `auditPrefix ${name}`, commandId: 'files.pick', aliases: [], available: name !== 'inactive', disabledReason: name === 'inactive' ? 'Unavailable here' : undefined })) }) } },
  comparison: { marker: 'auditRemoved', options: {} },
  'comparison-wide': { marker: 'auditRemoved', options: {} },
  status: { marker: 'auditStatus', options: { statusMessage: { read: read({ text: 'auditStatus save failed', kind: 'error' }) } } },
  context: { marker: 'auditMenu', options: { contextMenu: menu } },
};
