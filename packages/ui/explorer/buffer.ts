import type { ExplorerBufferModel } from '../../workbench/src/entrypoints/launch';
import type { ExplorerNode, ExplorerReadModel, ExplorerReadPort } from './index';

/** Projection only: modes, edits, registers and cursor coordinates stay in workbench. */
export function createDirectoryExplorerRead(read: { readonly model: ExplorerBufferModel; subscribe(listener: (model: ExplorerBufferModel) => void): { dispose(): void } }): ExplorerReadPort {
  const project = (model: ExplorerBufferModel): ExplorerReadModel => {
    const node = (id: string, name: string, kind: ExplorerNode['kind'], path: string): ExplorerNode => ({ id, name, kind, path, rootId: 'directory-header', parentId: undefined, relativePath: name, depth: 0, expanded: false, hidden: false, ignored: false, loadState: 'ready', children: [], stableIdentity: id, sizeBytes: undefined, modifiedMilliseconds: undefined, permissions: undefined, symlinkTarget: undefined, git: undefined, message: kind === 'state' ? name : undefined });
    const entries = model.reviewLines === undefined ? model.rows.map((row) => node(row.id, row.name, row.kind, row.sourcePath ?? `${model.directoryPath}/${row.name}`)) : model.reviewLines.map((line, index) => node(`directory-row-${index}`, line, 'state', model.directoryPath));
    const selectedId = entries[model.selectedIndex]?.id;
    const nodes = [node('directory-header', model.reviewLines === undefined ? `${model.mode.toUpperCase()} ${model.dirty ? '[+] ' : ''}${model.directoryPath}` : 'Review · y / Enter apply · Esc cancel', 'root', model.directoryPath), ...entries, node('directory-footer', model.prompt, 'state', model.directoryPath)];
    return { contractVersion: 1, generation: model.generation, roots: ['directory-header'], nodes,
      visibleRows: nodes.map((value) => ({ nodeId: value.id, depth: 0, kind: value.kind, selected: value.id === selectedId })),
      selectedId, filter: '', includeHidden: true, includeIgnored: true, followSymlinks: false, flattenDirs: false, focused: true, state: 'ready', message: undefined,
      edit: { mode: model.mode, cursorColumn: model.cursorColumn, visualIds: model.visualIndices.map((index) => `directory-row-${index}`) },
    };
  };
  let generation = -1;
  let cached: ExplorerReadModel;
  return { get model() { const current = read.model; if (current.generation !== generation) { generation = current.generation; cached = project(current); } return cached; }, subscribe: (listener) => read.subscribe((model) => listener(project(model))) };
}
